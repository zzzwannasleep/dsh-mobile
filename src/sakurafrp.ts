import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { isIP } from './ip.js'
import { restrictPrivateFile } from './private-file.js'
import { assertManagedParents, removeManagedTree, writeManagedPrivateFile } from './managed-files.js'
import type { MobileAccessControlStore } from './control.js'
import type { MobileAccessGateway } from './gateway.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController } from './remote.js'

/**
 * SakuraFrp (natfrp.com) provider.
 *
 * SakuraFrp is an frp-based tunnel service: the plugin talks to the official
 * v4 API with the user's 访问密钥 (access token), points an existing TCP tunnel
 * at the local DSH remote gateway, fetches a ready-to-run upstream frpc config
 * from `/tunnel/config`, and runs the pinned upstream frpc the component manager
 * already installs. The gateway terminates TLS itself with the pairing-CA-signed
 * ingress certificate, so the Android app can pin the CA exactly as it did for
 * the removed self-hosted FRP channel.
 */

export const SAKURAFRP_API_BASE = 'https://api.natfrp.com/v4'
/** Token management lives in the SakuraFrp user panel. */
export const SAKURAFRP_LOGIN_URL = 'https://www.natfrp.com/user/'
/** Upstream frpc build the component manager pins; the config endpoint must match it. */
export const SAKURAFRP_FRPC_VERSION = '0.70.1'

const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_LOG_BUFFER_BYTES = 64 * 1024
const API_TIMEOUT_MS = 15_000
/**
 * frpc retries the SakuraFrp server on its own; a rebooted PC often starts DSH
 * before the network is usable, so a live client gets several 60 s rounds before
 * the provider gives up. An exited client still fails fast on the first round.
 */
const START_TIMEOUT_MS = 60_000
const STARTUP_ROUNDS = 3
const MAX_TOKEN_LENGTH = 512

/** Product-facing states, shared with the other remote providers. */
export type SakuraFrpState = 'off' | 'unavailable' | 'starting' | 'connecting' | 'ready' | 'error'

/** Safe SakuraFrp state returned only through the loopback DSH control route. */
export interface SakuraFrpStatus {
  readonly enabled: boolean
  readonly state: SakuraFrpState
  readonly origin?: string
  readonly loginUrl?: string
  readonly errorCode?: string
}

/** One tunnel as returned by `GET /tunnels`; only the fields we consume are typed. */
export interface SakuraFrpTunnel {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly node: number
  readonly online: boolean
  readonly status: number
  readonly remote: string
  readonly localIp?: string
  readonly localPort?: number
  readonly export?: string
  readonly lockEdit?: boolean
}

/** Configuration metadata safe to hand to the desktop panel; never the token. */
export interface SakuraFrpConfiguration {
  readonly tokenSet: boolean
  readonly tunnelId?: number
  readonly storagePath: string
}

/** Validate an access token before durable storage. */
export function validateSakuraFrpToken(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim()
    || value.length < 8 || value.length > MAX_TOKEN_LENGTH
    || !/^[A-Za-z0-9_.=-]+$/u.test(value)) {
    throw new Error('sakurafrp_token_invalid')
  }
  return value
}

/** Validate the tunnel id selected in the desktop panel. */
export function validateSakuraFrpTunnelId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('sakurafrp_tunnel_id_invalid')
  }
  return Number(value)
}

function tunnelType(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseTunnel(raw: Record<string, unknown>): SakuraFrpTunnel | undefined {
  const id = typeof raw.id === 'number' ? raw.id : undefined
  if (id === undefined || !Number.isSafeInteger(id) || id < 1) return undefined
  if (typeof raw.remote !== 'string') return undefined
  return Object.freeze({
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    type: tunnelType(raw.type),
    node: typeof raw.node === 'number' ? raw.node : -1,
    online: raw.online === true,
    status: typeof raw.status === 'number' ? raw.status : -1,
    remote: raw.remote,
    ...(typeof raw.local_ip === 'string' ? { localIp: raw.local_ip } : {}),
    ...(typeof raw.local_port === 'number' ? { localPort: raw.local_port } : {}),
    ...(typeof raw.export === 'string' ? { export: raw.export } : {}),
    ...(typeof raw.locks === 'object' && raw.locks !== null
      && (raw.locks as Record<string, unknown>).edit === true ? { lockEdit: true } : {}),
  })
}

/** Parse the tunnel list at the API boundary, dropping entries we cannot consume. */
export function parseSakuraFrpTunnels(value: unknown): readonly SakuraFrpTunnel[] {
  if (!Array.isArray(value)) throw new Error('sakurafrp_api_error')
  const tunnels = value.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const parsed = parseTunnel(entry as Record<string, unknown>)
    return parsed === undefined ? [] : [parsed]
  })
  return Object.freeze(tunnels)
}

/** Convert the export field's packed IPv4 (dotted or uint32) into dotted form. */
export function parseSakuraFrpExportAddress(value: string): string | undefined {
  const trimmed = value.trim()
  if (isIP(trimmed) === 4) return trimmed
  if (!/^\d{1,10}$/u.test(trimmed)) return undefined
  const packed = Number(trimmed)
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > 0xFFFFFFFF) return undefined
  return [(packed >>> 24) & 255, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255].join('.')
}

/**
 * Derive the public TCP entry the phone connects to.
 *
 * `remote` (the assigned remote port) is the canonical port. The host comes
 * first from the `export` field (`类型|IP地址|端口`, packed IPv4 or dotted);
 * the field is provider-owned and often just `false`, in which case the caller
 * resolves the host from the node list via {@link deriveSakuraFrpNodeEntry}.
 */
export function deriveSakuraFrpEntry(tunnel: SakuraFrpTunnel): { readonly host: string; readonly port: number } | undefined {
  if (tunnel.type !== 'tcp') return undefined
  const remotePort = Number(tunnel.remote)
  if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65_535) return undefined
  const parts = (tunnel.export ?? '').split('|')
  const host = parts.length >= 3 ? parseSakuraFrpExportAddress(parts[1] ?? '') : undefined
  if (host === undefined) return undefined
  return Object.freeze({ host, port: remotePort })
}

/**
 * Resolve the public entry from the node list when `export` carries no address.
 *
 * `GET /nodes` is keyed by node id and each value carries the node's public
 * `host`; the tunnel's `node` id selects it.
 */
export function deriveSakuraFrpNodeEntry(
  tunnel: SakuraFrpTunnel,
  nodes: Readonly<Record<string, string>>,
): { readonly host: string; readonly port: number } | undefined {
  if (tunnel.type !== 'tcp') return undefined
  const remotePort = Number(tunnel.remote)
  if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65_535) return undefined
  const host = nodes[String(tunnel.node) as string]
  if (typeof host !== 'string' || host.trim() === '') return undefined
  return Object.freeze({ host: host.trim(), port: remotePort })
}

/** Parse the node list into an id-to-host map, dropping unusable entries. */
export function parseSakuraFrpNodes(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('sakurafrp_api_error')
  }
  const hosts: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const host = (raw as Record<string, unknown>).host
    if (typeof host === 'string' && host.trim() !== '') hosts[key] = host.trim()
  }
  return Object.freeze(hosts)
}

interface ApiErrorShape { readonly code?: unknown; readonly msg?: unknown }

async function readApiError(response: Response): Promise<Error> {
  let message = 'sakurafrp_api_error'
  try {
    const parsed = await response.json() as ApiErrorShape
    if (parsed.code === 401 || parsed.code === 403 || response.status === 401 || response.status === 403) {
      message = 'sakurafrp_token_invalid'
    }
  } catch { /* a non-JSON error body keeps the generic code */ }
  return new Error(message)
}

/** Minimal official v4 API surface the provider needs, injectable for tests. */
export interface SakuraFrpApiClient {
  listTunnels(token: string): Promise<readonly SakuraFrpTunnel[]>
  listNodes(token: string): Promise<Readonly<Record<string, string>>>
  editTunnelTarget(token: string, tunnelId: number, localIp: string, localPort: number): Promise<void>
  fetchTunnelConfig(token: string, tunnelId: number, frpcVersion: string): Promise<string>
}

export function createSakuraFrpApiClient(options: { readonly fetchImpl?: typeof fetch } = {}): SakuraFrpApiClient {
  const fetchImpl = options.fetchImpl ?? fetch
  // GET endpoints accept the Bearer header; POST endpoints answer 401 without
  // the `token` query parameter, so POSTs carry both to stay inside the two
  // documented auth schemes.
  const post = async (token: string, path: string, body: Record<string, string>): Promise<Response> => {
    try {
      return await fetchImpl(`${SAKURAFRP_API_BASE}${path}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error('sakurafrp_api_unreachable', { cause: error })
    }
  }
  const get = async (token: string, path: string): Promise<Response> => {
    try {
      return await fetchImpl(`${SAKURAFRP_API_BASE}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error('sakurafrp_api_unreachable', { cause: error })
    }
  }
  return {
    async listTunnels(token) {
      const response = await get(token, '/tunnels')
      if (!response.ok) throw await readApiError(response)
      try { return parseSakuraFrpTunnels(JSON.parse(await response.text()) as unknown) } catch (error) {
        if (error instanceof Error && error.message === 'sakurafrp_api_error') throw error
        throw new Error('sakurafrp_api_error', { cause: error })
      }
    },
    async listNodes(token) {
      const response = await get(token, '/nodes')
      if (!response.ok) throw await readApiError(response)
      try { return parseSakuraFrpNodes(JSON.parse(await response.text()) as unknown) } catch (error) {
        if (error instanceof Error && error.message === 'sakurafrp_api_error') throw error
        throw new Error('sakurafrp_api_error', { cause: error })
      }
    },
    async editTunnelTarget(token, tunnelId, localIp, localPort) {
      const response = await post(token, '/tunnel/edit', { id: String(tunnelId), local_ip: localIp, local_port: String(localPort) })
      if (!response.ok) throw await readApiError(response)
    },
    async fetchTunnelConfig(token, tunnelId, frpcVersion) {
      const response = await post(token, '/tunnel/config', { query: String(tunnelId), frpc: frpcVersion })
      if (!response.ok) throw await readApiError(response)
      const text = await response.text()
      if (text.trim().length === 0 || text.length > MAX_CONFIG_BYTES) {
        throw new Error('sakurafrp_config_fetch_failed')
      }
      return text
    },
  }
}

const MAX_SETTINGS_BYTES = 4 * 1024

/** Persisted provider settings: the access token and the selected tunnel id. */
export interface SakuraFrpSettings {
  readonly token?: string
  readonly tunnelId?: number
}

function parseSakuraFrpSettings(value: unknown): SakuraFrpSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('sakurafrp_settings_invalid')
  }
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some(key => key !== 'version' && key !== 'token' && key !== 'tunnelId')) {
    throw new Error('sakurafrp_settings_invalid')
  }
  if (record.version !== undefined && record.version !== 1) throw new Error('sakurafrp_settings_invalid')
  const token = record.token === undefined || record.token === '' ? undefined : validateSakuraFrpToken(record.token)
  const tunnelId = record.tunnelId === undefined ? undefined : validateSakuraFrpTunnelId(record.tunnelId)
  return Object.freeze({
    ...(token === undefined ? {} : { token }),
    ...(tunnelId === undefined ? {} : { tunnelId }),
  })
}

/** Owns the private SakuraFrp settings for one DSH installation. */
export class SakuraFrpSettingsStore {
  readonly stateRoot: string
  readonly settingsFile: string
  readonly configFile: string
  private settingsValue: SakuraFrpSettings = Object.freeze({})
  private errorCode: string | undefined

  constructor(stateDirectory: string, private readonly ownedRoot = stateDirectory) {
    if (!isAbsolute(stateDirectory)) throw new Error('sakurafrp state directory must be absolute')
    this.stateRoot = resolve(stateDirectory)
    this.settingsFile = join(this.stateRoot, 'settings.json')
    this.configFile = join(this.stateRoot, 'frpc.toml')
  }

  /** Load private settings while rejecting links, oversized files and unknown fields. */
  async initialize(): Promise<void> {
    this.settingsValue = Object.freeze({})
    this.errorCode = undefined
    try { await assertManagedParents(this.ownedRoot, this.settingsFile, 'sakurafrp') } catch {
      this.errorCode = 'sakurafrp_settings_invalid'
      return
    }
    let entry
    try { entry = await lstat(this.settingsFile) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SETTINGS_BYTES) {
      this.errorCode = 'sakurafrp_settings_invalid'
      return
    }
    await restrictPrivateFile(this.settingsFile)
    try {
      this.settingsValue = parseSakuraFrpSettings(JSON.parse(await readFile(this.settingsFile, 'utf8')) as unknown)
      this.errorCode = undefined
    } catch {
      this.settingsValue = Object.freeze({})
      this.errorCode = 'sakurafrp_settings_invalid'
    }
  }

  /** Return configuration metadata without exposing the access token. */
  status(): SakuraFrpConfiguration {
    const settings = this.settingsValue
    return Object.freeze({
      tokenSet: settings.token !== undefined,
      ...(settings.tunnelId === undefined ? {} : { tunnelId: settings.tunnelId }),
      storagePath: this.stateRoot,
    })
  }

  /** Return private settings only to the provider lifecycle. */
  settings(): SakuraFrpSettings {
    return this.settingsValue
  }

  /** Merge a partial write; an empty string keeps the stored value. */
  async configure(partial: { readonly token?: unknown; readonly tunnelId?: unknown }): Promise<SakuraFrpConfiguration> {
    const token = partial.token === '' || partial.token === undefined ? this.settingsValue.token : validateSakuraFrpToken(partial.token)
    const tunnelId = partial.tunnelId === undefined || partial.tunnelId === ''
      ? this.settingsValue.tunnelId
      : validateSakuraFrpTunnelId(partial.tunnelId)
    const settings = Object.freeze({
      ...(token === undefined ? {} : { token }),
      ...(tunnelId === undefined ? {} : { tunnelId }),
    })
    await writeManagedPrivateFile(this.ownedRoot, this.settingsFile, `${JSON.stringify(settings)}\n`, 'sakurafrp')
    this.settingsValue = settings
    this.errorCode = undefined
    return this.status()
  }

  /** Forget the token, the tunnel selection and the generated frpc config. */
  async purge(): Promise<SakuraFrpConfiguration> {
    await removeManagedTree(this.ownedRoot, this.settingsFile, 'sakurafrp')
    await removeManagedTree(this.ownedRoot, this.configFile, 'sakurafrp')
    this.settingsValue = Object.freeze({})
    this.errorCode = undefined
    return this.status()
  }
}

interface PortReservation {
  readonly port: number
  readonly release: () => Promise<void>
}

async function reserveLoopbackPort(requestedPort?: number): Promise<PortReservation> {
  const server = createServer(socket => { socket.destroy() })
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
    throw new Error('sakurafrp_port_reservation_failed')
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

function spawnSakuraFrpProcess(
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

/** Whether one upstream frpc log line proves the tunnel registered. */
export function isSakuraFrpRegistration(line: string): boolean {
  return /login to server success/iu.test(line)
    || /start proxy success/iu.test(line)
    || /proxy added/iu.test(line)
}

/** Controller inputs; the API client and process spawn are injectable for tests. */
export interface SakuraFrpControllerOptions {
  readonly store: MobileAccessControlStore
  readonly settings: SakuraFrpSettingsStore
  /** The pinned upstream frpc owned by the component manager. */
  readonly component: { readonly executable: string }
  /** Creates the DSH remote gateway; TLS termination mode is the factory's choice. */
  readonly createGateway: (publicOrigin: string, listenPort: number) => Promise<MobileAccessGateway>
  readonly api?: SakuraFrpApiClient
  readonly frpcVersion?: string
  readonly onStatus?: (status: SakuraFrpStatus) => void
  readonly startupTimeoutMs?: number
  readonly maxStartupRounds?: number
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams
}

/**
 * Owns one SakuraFrp tunnel and its DSH remote gateway.
 *
 * Startup order matters: the tunnel's local target is confirmed first, the
 * gateway starts listening before frpc registers, and only then does frpc run.
 * A generation counter mirrors the cloudflared controller so stale log lines,
 * timers and close events from a previous start can never publish readiness.
 */
export class SakuraFrpController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private child: ChildProcessWithoutNullStreams | undefined
  private gatewayValue: MobileAccessGateway | undefined
  private reservation: PortReservation | undefined
  private generation = 0
  private buffer = ''
  private originValue: string | undefined
  private latest: SakuraFrpStatus = publicStatus({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()
  private startupTimer: NodeJS.Timeout | undefined
  private startupRounds = 0

  constructor(private readonly options: SakuraFrpControllerOptions) {
    if (!isAbsolute(options.component.executable)) {
      throw new Error('sakurafrp component path must be absolute')
    }
  }

  /** Restore the remembered SakuraFrp switch independently from LAN and other providers. */
  async initialize(): Promise<void> {
    const state = await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
    else this.publish({ enabled: false, state: 'off' })
  }

  /** Return the active SakuraFrp-backed DSH gateway. */
  gateway(): MobileAccessGateway | undefined {
    return this.gatewayValue
  }

  /** Return state safe for the desktop control UI. */
  status(): SakuraFrpStatus {
    return publicStatus(this.latest)
  }

  /** Enable or disable SakuraFrp without changing LAN or other provider state. */
  async setEnabled(enabled: boolean): Promise<SakuraFrpStatus> {
    if (!this.initialized || this.disposed) throw new Error('sakurafrp controller is unavailable')
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

  /** Restart frpc and the gateway with the current configuration. */
  async reconnect(): Promise<SakuraFrpStatus> {
    if (!this.initialized || this.disposed) throw new Error('sakurafrp controller is unavailable')
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

  /** Disable SakuraFrp without deleting the installed component or settings. */
  async reset(): Promise<SakuraFrpStatus> {
    if (!this.initialized || this.disposed) throw new Error('sakurafrp controller is unavailable')
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

  private publish(status: SakuraFrpStatus): void {
    this.latest = publicStatus(status)
    try { this.options.onStatus?.(this.status()) } catch { /* UI observation cannot own runtime state. */ }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    const settings = this.options.settings.settings()
    if (settings.token === undefined) {
      this.publish({ enabled: true, state: 'unavailable', loginUrl: SAKURAFRP_LOGIN_URL, errorCode: 'sakurafrp_token_missing' })
      return
    }
    if (settings.tunnelId === undefined) {
      this.publish({ enabled: true, state: 'unavailable', loginUrl: SAKURAFRP_LOGIN_URL, errorCode: 'sakurafrp_tunnel_missing' })
      return
    }
    let executableEntry
    try { executableEntry = await lstat(this.options.component.executable) } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'sakurafrp_component_missing' })
      return
    }
    if (!executableEntry.isFile() || executableEntry.isSymbolicLink()) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'sakurafrp_component_invalid' })
      return
    }

    const api = this.options.api ?? createSakuraFrpApiClient()
    const frpcVersion = this.options.frpcVersion ?? SAKURAFRP_FRPC_VERSION
    let tunnel: SakuraFrpTunnel
    try {
      const tunnels = await api.listTunnels(settings.token)
      const found = tunnels.find(entry => entry.id === settings.tunnelId)
      if (found === undefined) { await this.failGeneration(generation, 'sakurafrp_tunnel_missing'); return }
      tunnel = found
    } catch (error) {
      await this.failGeneration(generation, error instanceof Error ? error.message : 'sakurafrp_api_error')
      return
    }
    if (tunnel.status === 2) { await this.failGeneration(generation, 'sakurafrp_tunnel_banned'); return }
    if (tunnel.type !== 'tcp') { await this.failGeneration(generation, 'sakurafrp_tunnel_type_unsupported'); return }
    // The entry host prefers the tunnel's export field; the common case is
    // export=false, so the node list (keyed by node id) provides the public host.
    const entry = deriveSakuraFrpEntry(tunnel) ?? await (async () => {
      try { return deriveSakuraFrpNodeEntry(tunnel, await api.listNodes(settings.token as string)) }
      catch (error) {
        await this.failGeneration(generation, error instanceof Error ? error.message : 'sakurafrp_api_error')
        return undefined
      }
    })()
    if (entry === undefined) { await this.failGeneration(generation, 'sakurafrp_entry_unknown'); return }
    const origin = new URL(`https://${entry.host}:${String(entry.port)}`).origin
    this.originValue = origin

    // Prefer the port the tunnel already forwards to so an existing dedicated
    // tunnel needs no edit at all; otherwise bind an ephemeral port and point
    // the tunnel at it through the API.
    const savedPort = tunnel.localPort
    const usableSavedPort = savedPort !== undefined && Number.isSafeInteger(savedPort)
      && savedPort >= 1024 && savedPort <= 65_535 && savedPort !== 3443
    let reservation: PortReservation
    try {
      reservation = await reserveLoopbackPort(usableSavedPort ? savedPort : undefined)
    } catch (error) {
      const conflict = (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
      await this.failGeneration(generation, conflict ? 'sakurafrp_tunnel_port_unavailable' : 'sakurafrp_port_reservation_failed')
      return
    }
    this.reservation = reservation
    if (!usableSavedPort && tunnel.lockEdit === true) {
      await this.failGeneration(generation, 'sakurafrp_tunnel_locked')
      return
    }
    if (!usableSavedPort) {
      try {
        await api.editTunnelTarget(settings.token, tunnel.id, '127.0.0.1', reservation.port)
      } catch (error) {
        await this.releaseReservation(reservation)
        await this.failGeneration(generation, error instanceof Error && error.message === 'sakurafrp_tunnel_locked'
          ? 'sakurafrp_tunnel_locked'
          : 'sakurafrp_api_error')
        return
      }
    }

    this.buffer = ''
    this.startupRounds = 0
    this.publish({ enabled: true, state: 'connecting', origin })
    await this.releaseReservation(reservation)
    let gateway: MobileAccessGateway
    try {
      gateway = await this.options.createGateway(origin, reservation.port)
    } catch (error) {
      const conflict = (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
      await this.failGeneration(generation, conflict ? 'sakurafrp_tunnel_port_unavailable' : 'gateway_start_failed')
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed) {
      await gateway.close()
      return
    }
    this.gatewayValue = gateway

    let config: string
    try {
      config = await api.fetchTunnelConfig(settings.token, tunnel.id, frpcVersion)
    } catch (error) {
      await this.failGeneration(generation, error instanceof Error ? error.message : 'sakurafrp_config_fetch_failed')
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed) return
    try {
      await writeManagedPrivateFile(this.options.settings.stateRoot, this.options.settings.configFile, config, 'sakurafrp')
    } catch {
      await this.failGeneration(generation, 'sakurafrp_config_fetch_failed')
      return
    }

    this.publish({ enabled: true, state: 'starting', origin })
    const child = (this.options.spawnProcess ?? spawnSakuraFrpProcess)(
      this.options.component.executable,
      ['-c', this.options.settings.configFile],
      process.env,
    )
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { this.consume(generation, String(chunk)) })
    child.stderr.on('data', chunk => { this.consume(generation, String(chunk)) })
    child.once('error', () => { void this.enqueue(() => this.failGeneration(generation, 'sakurafrp_launch_failed')) })
    child.once('close', code => {
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (this.enabled) void this.enqueue(() => this.failGeneration(generation, code === 0 ? 'sakurafrp_stopped' : 'sakurafrp_exited'))
    })
    this.armStartupTimer(generation)
  }

  private async releaseReservation(reservation: PortReservation): Promise<void> {
    await reservation.release()
    if (this.reservation === reservation) this.reservation = undefined
  }

  private armStartupTimer(generation: number): void {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = setTimeout(() => {
      void this.enqueue(() => this.checkStartupTimeout(generation))
    }, this.options.startupTimeoutMs ?? START_TIMEOUT_MS)
    this.startupTimer.unref()
  }

  private async checkStartupTimeout(generation: number): Promise<void> {
    if (generation !== this.generation || !this.enabled || this.disposed) return
    if (this.latest.state === 'ready') return
    const childAlive = this.child !== undefined && this.child.exitCode === null
    const budget = this.options.maxStartupRounds ?? STARTUP_ROUNDS
    if (childAlive && this.startupRounds + 1 < budget) {
      this.startupRounds += 1
      this.armStartupTimer(generation)
      return
    }
    await this.failGeneration(generation, 'sakurafrp_start_timeout')
  }

  private consume(generation: number, chunk: string): void {
    if (generation !== this.generation) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LOG_BUFFER_BYTES && !this.buffer.includes('\n')) {
      void this.enqueue(() => this.failGeneration(generation, 'sakurafrp_invalid_output'))
      return
    }
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (isSakuraFrpRegistration(line)) void this.enqueue(() => this.confirmReady(generation))
    }
  }

  private async confirmReady(generation: number): Promise<void> {
    if (generation !== this.generation || !this.enabled || this.disposed) return
    if (this.gatewayValue === undefined || this.latest.state === 'ready') return
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.publish({ enabled: true, state: 'ready', ...(this.originValue === undefined ? {} : { origin: this.originValue }), loginUrl: SAKURAFRP_LOGIN_URL })
  }

  private async failGeneration(generation: number, code: string): Promise<void> {
    if (generation !== this.generation) return
    await this.stopProcessAndGateway()
    if (this.enabled) this.publish({ enabled: true, state: 'error', errorCode: code, loginUrl: SAKURAFRP_LOGIN_URL })
  }

  private async stop(): Promise<void> {
    ++this.generation
    this.originValue = undefined
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
    ], 'sakurafrp resource cleanup failed')
  }
}

function publicStatus(status: SakuraFrpStatus): SakuraFrpStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.loginUrl === undefined ? {} : { loginUrl: status.loginUrl }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}