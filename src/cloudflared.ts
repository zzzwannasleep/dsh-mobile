import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { isAbsolute } from 'node:path'
import type { CloudflaredTunnelSettings } from './cloudflared-tunnel.js'
import type { MobileAccessControlStore } from './control.js'
import type { MobileAccessGateway } from './gateway.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController } from './remote.js'

const MAX_LOG_BUFFER_BYTES = 64 * 1024
/**
 * Named connectors keep retrying the Cloudflare edge on their own; a rebooted PC
 * often autostarts DSH before Wi-Fi / VPN / DNS is usable. Killing the process
 * after a single 60 s window would turn a slow boot into a manual reconnect
 * loop. An exited connector (bad token, bad config) still fails fast on the
 * first round.
 */
const START_TIMEOUT_MS = 60_000
/** How many startup-timeout rounds a live connector may wait through. */
const NAMED_STARTUP_ROUNDS = 5

/** Product-facing states for the optional cloudflared remote transport. */
export type CloudflaredState = 'off' | 'unavailable' | 'starting' | 'connecting' | 'ready' | 'error'

/** Safe cloudflared state returned only through the loopback DSH control route. */
export interface CloudflaredStatus {
  readonly enabled: boolean
  readonly state: CloudflaredState
  readonly origin?: string
  readonly errorCode?: string
}

/** Inputs for one cloudflared process and its authenticated DSH gateway. */
export interface CloudflaredControllerOptions {
  readonly store: MobileAccessControlStore
  readonly executable: string
  /** Named-tunnel configuration; an absent value keeps the provider unavailable. */
  readonly tunnel: { settings(): CloudflaredTunnelSettings | undefined }
  readonly createGateway: (origin: string, listenPort: number) => Promise<MobileAccessGateway>
  readonly onStatus?: (status: CloudflaredStatus) => void
  /** Liveness bound for one startup-timeout round; defaults to the product timeout. */
  readonly startupTimeoutMs?: number
  /** Total startup-timeout rounds before a live connector is given up on. */
  readonly maxStartupRounds?: number
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams
}

interface PortReservation {
  readonly port: number
  readonly release: () => Promise<void>
}

function publicStatus(status: CloudflaredStatus): CloudflaredStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}

/**
 * Whether one cloudflared log line reports an established edge connection.
 *
 * A named tunnel prints no banner, so registration is the only signal that the
 * connector reached Cloudflare and the public hostname can serve traffic. Both
 * the current and the older wording are accepted; anything else is ignored so a
 * chatty log line cannot be mistaken for readiness.
 */
export function isCloudflaredRegistration(line: string): boolean {
  return /registered tunnel connection/iu.test(line)
    || /connection\s+[0-9a-f][0-9a-f-]{7,}\s+registered/iu.test(line)
}

async function reserveLoopbackPort(requestedPort?: number): Promise<PortReservation> {
  const server: Server = createServer(socket => { socket.destroy() })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(requestedPort ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('cloudflared_port_reservation_failed')
  }
  let released = false
  return {
    port: address.port,
    release: async () => {
      if (released) return
      released = true
      await new Promise<void>(resolveClose => { server.close(() => resolveClose()) })
    },
  }
}

function spawnCloudflaredProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawn(executable, [...args], {
    env: environment,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function withoutProxyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !blocked.has(name.toUpperCase())))
}

/**
 * Owns an installed cloudflared client and a provider-specific DSH remote gateway.
 *
 * The named tunnel reads an account token and a stable public hostname from the
 * tunnel store, forwards to the configured loopback port, and learns readiness
 * from the connector's registration line rather than a banner.
 */
export class CloudflaredController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private child: ChildProcessWithoutNullStreams | undefined
  private gatewayValue: MobileAccessGateway | undefined
  private reservation: PortReservation | undefined
  private generation = 0
  private buffer = ''
  private namedOrigin: string | undefined
  private latest: CloudflaredStatus = publicStatus({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()
  private startupTimer: NodeJS.Timeout | undefined
  private startupRounds = 0

  constructor(private readonly options: CloudflaredControllerOptions) {
    if (!isAbsolute(options.executable)) {
      throw new Error('cloudflared executable path must be absolute')
    }
  }

  /** Restore the remembered cloudflared switch independently from LAN and other providers. */
  async initialize(): Promise<void> {
    const state = await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
    else this.publish({ enabled: false, state: 'off' })
  }

  /** Return the active cloudflared-backed DSH gateway. */
  gateway(): MobileAccessGateway | undefined {
    return this.gatewayValue
  }

  /** Return state safe for the desktop control UI. */
  status(): CloudflaredStatus {
    return publicStatus(this.latest)
  }

  /** Enable or disable cloudflared without changing LAN or other provider state. */
  async setEnabled(enabled: boolean): Promise<CloudflaredStatus> {
    if (!this.initialized || this.disposed) throw new Error('cloudflared controller is unavailable')
    await this.enqueue(async () => {
      if (this.enabled === enabled && (enabled === false || this.child !== undefined)) return
      if (!enabled) await this.stop()
      this.enabled = enabled
      await this.options.store.save({ version: 1, enabled })
      if (enabled) await this.start()
      else this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Restart cloudflared with the current named-tunnel configuration. */
  async reconnect(): Promise<CloudflaredStatus> {
    if (!this.initialized || this.disposed) throw new Error('cloudflared controller is unavailable')
    await this.enqueue(async () => {
      if (!this.enabled) {
        this.enabled = true
        await this.options.store.save({ version: 1, enabled: true })
      }
      await this.stop()
      await this.start()
    })
    return this.status()
  }

  /** Disable cloudflared without deleting the installed component. */
  async reset(): Promise<CloudflaredStatus> {
    if (!this.initialized || this.disposed) throw new Error('cloudflared controller is unavailable')
    await this.enqueue(async () => {
      await this.stop()
      this.enabled = false
      await this.options.store.save({ version: 1, enabled: false })
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Stop owned resources without changing the remembered switch. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.enqueue(() => this.stop())
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private publish(status: CloudflaredStatus): void {
    this.latest = publicStatus(status)
    try { this.options.onStatus?.(this.status()) } catch { /* UI observation cannot own runtime state. */ }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    let executableEntry
    try { executableEntry = await lstat(this.options.executable) } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'cloudflared_component_missing' })
      return
    }
    if (!executableEntry.isFile() || executableEntry.isSymbolicLink()) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'cloudflared_component_invalid' })
      return
    }

    const settings = this.options.tunnel.settings()
    if (settings === undefined) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'cloudflared_tunnel_config_missing' })
      return
    }
    this.namedOrigin = `https://${settings.hostname}`

    let reservation: PortReservation
    try {
      reservation = await reserveLoopbackPort(settings.port)
    } catch (error) {
      // A bind conflict is the user's to resolve; anything else is an internal
      // reservation failure and must not be reported as a busy port.
      const conflict = (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
      this.publish({
        enabled: true,
        state: 'error',
        errorCode: conflict ? 'cloudflared_tunnel_port_unavailable' : 'cloudflared_port_reservation_failed',
      })
      return
    }
    this.reservation = reservation
    this.buffer = ''
    this.startupRounds = 0
    this.publish({ enabled: true, state: 'starting' })

    // Cloudflare already routes the public hostname to this exact port, so the
    // gateway must be listening before the connector registers; the port has to
    // survive restarts, which is why it is configuration rather than a choice.
    const origin = this.namedOrigin as string
    this.publish({ enabled: true, state: 'connecting', origin })
    await reservation.release()
    if (this.reservation === reservation) this.reservation = undefined
    let gateway: MobileAccessGateway
    try {
      gateway = await this.options.createGateway(origin, reservation.port)
    } catch (error) {
      // Only a real bind conflict is a port problem; anything else (certificate,
      // configuration, permissions) must not send the user chasing the port.
      const conflict = (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
      this.publish({
        enabled: true,
        state: 'error',
        errorCode: conflict ? 'cloudflared_tunnel_port_unavailable' : 'gateway_start_failed',
      })
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed) {
      await gateway.close()
      return
    }
    this.gatewayValue = gateway

    // The local DSH remote gateway speaks plain HTTP, so no origin TLS override
    // is needed. The tunnel takes its token from the environment so the
    // credential never appears in the process command line.
    const environment = withoutProxyEnvironment(process.env)
    environment.TUNNEL_TOKEN = settings.token
    const child = (this.options.spawnProcess ?? spawnCloudflaredProcess)(
      this.options.executable,
      ['tunnel', '--no-autoupdate', 'run'],
      environment,
    )
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { this.consume(generation, String(chunk)) })
    child.stderr.on('data', chunk => { this.consume(generation, String(chunk)) })
    child.once('error', () => { void this.enqueue(() => this.failGeneration(generation, 'cloudflared_launch_failed')) })
    child.once('close', code => {
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (this.enabled) void this.enqueue(() => this.failGeneration(generation, code === 0 ? 'cloudflared_stopped' : 'cloudflared_exited'))
    })
    this.armStartupTimer(generation)
  }

  private armStartupTimer(generation: number): void {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = setTimeout(() => {
      void this.enqueue(() => this.checkStartupTimeout(generation))
    }, this.options.startupTimeoutMs ?? START_TIMEOUT_MS)
    this.startupTimer.unref()
  }

  /**
   * Give a live connector more time instead of killing it: it retries the edge
   * on its own and usually registers once the rebooted network is usable. A dead
   * connector, or an exhausted budget, fails the generation as before.
   */
  private async checkStartupTimeout(generation: number): Promise<void> {
    if (generation !== this.generation || !this.enabled || this.disposed) return
    if (this.latest.state === 'ready') return
    const childAlive = this.child !== undefined && this.child.exitCode === null
    const budget = this.options.maxStartupRounds ?? NAMED_STARTUP_ROUNDS
    if (childAlive && this.startupRounds + 1 < budget) {
      this.startupRounds += 1
      this.armStartupTimer(generation)
      return
    }
    await this.failGeneration(generation, 'cloudflared_start_timeout')
  }

  private consume(generation: number, chunk: string): void {
    if (generation !== this.generation) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LOG_BUFFER_BYTES && !this.buffer.includes('\n')) {
      void this.enqueue(() => this.failGeneration(generation, 'cloudflared_invalid_output'))
      return
    }
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      // The public origin is configuration here, so the log is only read for the
      // registration that proves the connector reached Cloudflare.
      if (isCloudflaredRegistration(line)) void this.enqueue(() => this.confirmNamedReady(generation))
    }
  }

  /** Mark the named tunnel ready once the connector has registered with the edge. */
  private async confirmNamedReady(generation: number): Promise<void> {
    if (generation !== this.generation || !this.enabled || this.disposed) return
    if (this.gatewayValue === undefined || this.latest.state === 'ready') return
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.publish({ enabled: true, state: 'ready', ...(this.namedOrigin === undefined ? {} : { origin: this.namedOrigin }) })
  }

  private async failGeneration(generation: number, code: string): Promise<void> {
    if (generation !== this.generation) return
    await this.stopProcessAndGateway()
    if (this.enabled) this.publish({ enabled: true, state: 'error', errorCode: code })
  }

  private async stop(): Promise<void> {
    ++this.generation
    await this.stopProcessAndGateway()
  }

  private async stopProcessAndGateway(): Promise<void> {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    const reservation = this.reservation
    this.reservation = undefined
    const child = this.child
    this.child = undefined
    const gateway = this.gatewayValue
    this.gatewayValue = undefined
    await settleRemoteResources([
      () => reservation?.release(),
      () => child !== undefined && child.exitCode === null ? terminateRemoteProcess(child) : undefined,
      () => gateway?.close(),
    ], 'cloudflared resource cleanup failed')
  }
}