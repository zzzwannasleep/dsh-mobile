import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import {
  CloudflaredController,
  isCloudflaredRegistration,
  type CloudflaredStatus,
} from '../src/cloudflared.js'
import type { CloudflaredTunnelSettings } from '../src/cloudflared-tunnel.js'
import type { MobileAccessGateway } from '../src/gateway.js'

const temporaryDirectories: string[] = []
const controllers: CloudflaredController[] = []
const releaseBarriers: Array<() => void> = []

afterEach(async () => {
  for (const release of releaseBarriers.splice(0)) release()
  const results = await Promise.allSettled(controllers.splice(0).map(controller => controller.close()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
})

class MemoryControlStore implements MobileAccessControlStore {
  state: MobileAccessControlState = { version: 1, enabled: true }

  async load(): Promise<MobileAccessControlState> { return this.state }
  async save(state: MobileAccessControlState): Promise<void> { this.state = state }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  kill(): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.exitCode = 0
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
    setImmediate(() => { this.emit('close', 0) })
    return true
  }
}

class StatusJournal {
  readonly values: CloudflaredStatus[] = []
  private readonly listeners = new Set<(status: CloudflaredStatus) => void>()

  readonly publish = (status: CloudflaredStatus): void => {
    this.values.push(status)
    for (const listener of [...this.listeners]) listener(status)
  }

  waitFor(predicate: (status: CloudflaredStatus) => boolean): Promise<CloudflaredStatus> {
    const current = this.values.findLast(predicate)
    if (current !== undefined) return Promise.resolve(current)
    return new Promise(resolve => {
      const listener = (status: CloudflaredStatus): void => {
        if (!predicate(status)) return
        this.listeners.delete(listener)
        resolve(status)
      }
      this.listeners.add(listener)
    })
  }
}

interface FakeGateway extends MobileAccessGateway {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function gateway(origin: string, port: number, close: () => Promise<void> = async () => undefined): FakeGateway {
  return {
    address: () => ({ host: '127.0.0.1', port, origin }),
    close: vi.fn(close),
  } as unknown as FakeGateway
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  const resolve = (): void => { resolvePromise?.() }
  releaseBarriers.push(resolve)
  return { promise, resolve }
}

async function fixture(
  createGateway: (origin: string, port: number) => Promise<MobileAccessGateway>,
  settings: CloudflaredTunnelSettings | undefined,
): Promise<{
  readonly child: FakeChild
  readonly controller: CloudflaredController
  readonly journal: StatusJournal
  readonly args: () => readonly string[]
  readonly environment: () => NodeJS.ProcessEnv
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-'))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'component', 'cloudflared.exe')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'fake-cloudflared')
  const child = new FakeChild()
  let startedArgs: readonly string[] = []
  let startedEnvironment: NodeJS.ProcessEnv = {}
  const journal = new StatusJournal()
  const controller = new CloudflaredController({
    store: new MemoryControlStore(),
    executable,
    createGateway,
    tunnel: { settings: () => settings },
    onStatus: journal.publish,
    spawnProcess: (_executable, args, environment) => {
      startedArgs = [...args]
      startedEnvironment = environment
      return child as unknown as ChildProcessWithoutNullStreams
    },
  })
  controllers.push(controller)
  await controller.initialize()
  return { child, controller, journal, args: () => startedArgs, environment: () => startedEnvironment }
}

describe('cloudflared named-only provider', () => {
  it('reports an uninstalled component instead of launching anything', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-missing-'))
    temporaryDirectories.push(directory)
    const spawnProcess = vi.fn() as unknown as (
      executable: string,
      args: readonly string[],
      environment: NodeJS.ProcessEnv,
    ) => ChildProcessWithoutNullStreams
    const controller = new CloudflaredController({
      store: new MemoryControlStore(),
      executable: join(directory, 'component', 'cloudflared.exe'),
      createGateway: async () => gateway('https://never.example.com', 1),
      tunnel: { settings: () => undefined },
      spawnProcess,
    })
    controllers.push(controller)
    await controller.initialize()

    expect(spawnProcess).not.toHaveBeenCalled()
    expect(controller.status()).toEqual({
      enabled: true,
      state: 'unavailable',
      errorCode: 'cloudflared_component_missing',
    })
  })

  it('stays unavailable while the named tunnel is not configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-unset-'))
    temporaryDirectories.push(directory)
    const spawnProcess = vi.fn() as unknown as (
      executable: string,
      args: readonly string[],
      environment: NodeJS.ProcessEnv,
    ) => ChildProcessWithoutNullStreams
    const executable = join(directory, 'component', 'cloudflared.exe')
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, 'fake-cloudflared')
    const controller = new CloudflaredController({
      store: new MemoryControlStore(),
      executable,
      createGateway: async () => gateway('https://never.example.com', 1),
      tunnel: { settings: () => undefined },
      spawnProcess,
    })
    controllers.push(controller)
    await controller.initialize()

    expect(spawnProcess).not.toHaveBeenCalled()
    expect(controller.status()).toEqual({
      enabled: true,
      state: 'unavailable',
      errorCode: 'cloudflared_tunnel_config_missing',
    })
  })
})

// Shaped like the connector token Cloudflare issues: base64url of a JSON blob.
const NAMED_TOKEN = 'eyJhIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJ0IjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAwIiwicyI6Ik1EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREEifQ'
const NAMED_HOSTNAME = 'dsh.example.com'

/**
 * A named tunnel binds one fixed forward port, so the test must claim a port that
 * is actually free. Hardcoding the product default (3444) makes the suite fail
 * whenever the developer is running the real tunnel on it.
 */
async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no loopback port was assigned')
  const port = address.port
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  return port
}

function namedSettings(port: number): CloudflaredTunnelSettings {
  return { version: 1, token: NAMED_TOKEN, hostname: NAMED_HOSTNAME, port }
}

const NAMED_ORIGIN = `https://${NAMED_HOSTNAME}`

describe('cloudflared named tunnel', () => {
  it('recognizes the registration line real cloudflared prints', () => {
    expect(isCloudflaredRegistration('2026-09-16T11:18:10Z INF Registered tunnel connection connIndex=0 connection=645e1fe2-9ac7-4a17-bc65-4cc7be9d7d67 event=0 ip=198.18.0.181 location=sin08 protocol=quic')).toBe(true)
    expect(isCloudflaredRegistration('INF Connection 1f2035b6-c61f-401b-86fc-260e9955f6ae registered connIndex=1')).toBe(true)
    // Everything else in the startup log must not be mistaken for readiness.
    for (const line of [
      'INF Starting tunnel tunnelID=11111111-2222-4333-8444-555555555555',
      'INF Initial protocol quic',
      'INF precheck complete hard_fail=false run_id=2bde4ed7 suggested_protocol=quic',
      'INF Updated to new configuration config="{\\"ingress\\":[...]}"',
    ]) expect(isCloudflaredRegistration(line), line).toBe(false)
  })

  it('runs the connector with the token in the environment and a stable port', async () => {
    const port = await freeLoopbackPort()
    const seen: Array<{ origin: string; port: number }> = []
    const { child, controller, journal, args, environment } = await fixture(async (origin, listenPort) => {
      seen.push({ origin, port: listenPort })
      return gateway(origin, listenPort)
    }, namedSettings(port))

    // A named tunnel prints no banner, so the process starts in `connecting` and
    // only a real registration line may promote it.
    expect(controller.status()).toMatchObject({ enabled: true, state: 'connecting', origin: NAMED_ORIGIN })
    child.stderr.write('INF Starting tunnel tunnelID=11111111-2222-4333-8444-555555555555\n')
    child.stderr.write('INF precheck complete hard_fail=false run_id=2bde4ed7 suggested_protocol=quic\n')
    child.stderr.write(`INF Updated to new configuration config="{\\"ingress\\":[{\\"service\\":\\"http://127.0.0.1:${String(port)}\\"}]}"\n`)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(controller.status().state).toBe('connecting')

    child.stderr.write('2026-09-16T11:18:10Z INF Registered tunnel connection connIndex=0 connection=645e1fe2-9ac7-4a17-bc65-4cc7be9d7d67 location=sin08 protocol=quic\n')
    const ready = await journal.waitFor(status => status.state === 'ready')
    expect(ready).toEqual({ enabled: true, state: 'ready', origin: NAMED_ORIGIN })

    // Cloudflare's ingress already points at this exact port, so it is bound as
    // configured rather than allocated.
    expect(seen).toEqual([{ origin: NAMED_ORIGIN, port }])
    // `cloudflared tunnel run` reads TUNNEL_TOKEN; the credential must not appear
    // in the command line, where any local process could read it.
    expect(args()).toEqual(['tunnel', '--no-autoupdate', 'run'])
    expect(args().join(' ')).not.toContain(NAMED_TOKEN)
    expect(environment().TUNNEL_TOKEN).toBe(NAMED_TOKEN)
    expect(controller.gateway()?.address()).toMatchObject({ origin: NAMED_ORIGIN, port })
  })

  it('requires a fresh registration after the connector restarts', async () => {
    const port = await freeLoopbackPort()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-named-restart-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'component', 'cloudflared.exe')
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, 'fake-cloudflared')
    const children: FakeChild[] = []
    const journal = new StatusJournal()
    const controller = new CloudflaredController({
      store: new MemoryControlStore(),
      executable,
      createGateway: async (origin, listenPort) => gateway(origin, listenPort),
      tunnel: { settings: () => namedSettings(port) },
      onStatus: journal.publish,
      spawnProcess: () => {
        const child = new FakeChild()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    controllers.push(controller)
    await controller.initialize()

    children[0]!.stderr.write('INF Registered tunnel connection connIndex=0 connection=645e1fe2-9ac7-4a17-bc65-4cc7be9d7d67\n')
    await journal.waitFor(status => status.state === 'ready')

    // A restart is a new generation with a new process: readiness from the old
    // connector must not carry over.
    await controller.reconnect()
    expect(children).toHaveLength(2)
    expect(controller.status()).toMatchObject({ enabled: true, state: 'connecting' })

    children[1]!.stderr.write('INF Registered tunnel connection connIndex=0 connection=1f2035b6-c61f-401b-86fc-260e9955f6ae\n')
    const ready = await journal.waitFor(status => status.state === 'ready')
    expect(ready).toMatchObject({ state: 'ready', origin: NAMED_ORIGIN })
  })

  it('fails the generation when the configured port cannot be bound', async () => {
    // A named tunnel cannot fall back to another port: the edge routes the public
    // hostname to exactly one local port, so a taken port is a hard failure.
    const port = await freeLoopbackPort()
    const conflict = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })
    const { controller, journal, args } = await fixture(async () => {
      throw conflict
    }, namedSettings(port))
    const failed = await journal.waitFor(status => status.state === 'error')
    expect(failed).toEqual({ enabled: true, state: 'error', errorCode: 'cloudflared_tunnel_port_unavailable' })
    expect(controller.gateway()).toBeUndefined()
    expect(args()).toEqual([])
  })

  it('does not blame the port when the gateway fails for another reason', async () => {
    // A certificate, configuration, or permission failure reported as "port
    // unavailable" would send the user hunting for a conflict that does not exist.
    const port = await freeLoopbackPort()
    const { controller, journal } = await fixture(async () => {
      throw new Error('mobile_frontend_unavailable')
    }, namedSettings(port))
    const failed = await journal.waitFor(status => status.state === 'error')
    expect(failed).toEqual({ enabled: true, state: 'error', errorCode: 'gateway_start_failed' })
    expect(controller.gateway()).toBeUndefined()
  })

  it('does not report ready when the connector never registers', async () => {
    const port = await freeLoopbackPort()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-named-timeout-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'component', 'cloudflared.exe')
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, 'fake-cloudflared')
    const child = new FakeChild()
    const journal = new StatusJournal()
    const controller = new CloudflaredController({
      store: new MemoryControlStore(),
      executable,
      createGateway: async (origin, listenPort) => gateway(origin, listenPort),
      tunnel: { settings: () => namedSettings(port) },
      onStatus: journal.publish,
      startupTimeoutMs: 20,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    })
    controllers.push(controller)
    await controller.initialize()

    const failed = await journal.waitFor(status => status.state === 'error')
    expect(failed).toEqual({ enabled: true, state: 'error', errorCode: 'cloudflared_start_timeout' })
    expect(controller.gateway()).toBeUndefined()
  })

  it('keeps waiting while a live named connector has not registered yet', async () => {
    const port = await freeLoopbackPort()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-named-slow-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'component', 'cloudflared.exe')
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, 'fake-cloudflared')
    const child = new FakeChild()
    const journal = new StatusJournal()
    const controller = new CloudflaredController({
      store: new MemoryControlStore(),
      executable,
      createGateway: async (origin, listenPort) => gateway(origin, listenPort),
      tunnel: { settings: () => namedSettings(port) },
      onStatus: journal.publish,
      startupTimeoutMs: 20,
      maxStartupRounds: 5,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    })
    controllers.push(controller)
    await controller.initialize()

    // Two timeout rounds pass with the connector still alive: no error, no kill.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(child.exitCode).toBeNull()
    expect(controller.status().state).toBe('connecting')

    // A late registration (rebooted network finally usable) still promotes to ready.
    child.stderr.write('2026-09-16T11:18:10Z INF Registered tunnel connection connIndex=0 connection=645e1fe2-9ac7-4a17-bc65-4cc7be9d7d67 location=sin08 protocol=quic\n')
    const ready = await journal.waitFor(status => status.state === 'ready')
    expect(ready).toEqual({ enabled: true, state: 'ready', origin: NAMED_ORIGIN })
    expect(child.exitCode).toBeNull()
  })
})