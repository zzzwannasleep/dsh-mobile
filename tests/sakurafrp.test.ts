import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MobileAccessGateway } from '../src/gateway.js'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSakuraFrpApiClient,
  deriveSakuraFrpEntry,
  deriveSakuraFrpNodeEntry,
  parseSakuraFrpNodes,
  isSakuraFrpRegistration,
  parseSakuraFrpExportAddress,
  parseSakuraFrpTunnels,
  SakuraFrpController,
  SakuraFrpSettingsStore,
  validateSakuraFrpToken,
  validateSakuraFrpTunnelId,
  type SakuraFrpTunnel,
} from '../src/sakurafrp.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function tunnel(overrides: Partial<SakuraFrpTunnel> = {}): SakuraFrpTunnel {
  return Object.freeze({
    id: 114514,
    name: 'SampleTunnel',
    type: 'tcp',
    node: 5,
    online: false,
    status: 0,
    remote: '1919',
    export: '0|16909060|1919',
    ...overrides,
  })
}

describe('sakurafrp inputs', () => {
  it('validates the access token and the tunnel id', () => {
    expect(validateSakuraFrpToken('sk-tr-AccessToken_123=-')).toBe('sk-tr-AccessToken_123=-')
    expect(() => validateSakuraFrpToken(' short ')).toThrow('sakurafrp_token_invalid')
    expect(() => validateSakuraFrpToken('bad token with spaces')).toThrow('sakurafrp_token_invalid')
    expect(() => validateSakuraFrpToken('x'.repeat(513))).toThrow('sakurafrp_token_invalid')
    expect(validateSakuraFrpTunnelId(114514)).toBe(114514)
    expect(() => validateSakuraFrpTunnelId(0)).toThrow('sakurafrp_tunnel_id_invalid')
    expect(() => validateSakuraFrpTunnelId('114514')).toThrow('sakurafrp_tunnel_id_invalid')
  })

  it('parses the tunnel list and drops unusable entries', () => {
    const tunnels = parseSakuraFrpTunnels([
      tunnel(),
      { id: 'not-a-number', remote: '1' },
      null,
      { id: 2, remote: 8080 },
    ])
    expect(tunnels).toHaveLength(1)
    expect(tunnels[0]?.id).toBe(114514)
    expect(tunnels[0]?.lockEdit).toBeUndefined()
    expect(() => parseSakuraFrpTunnels({ nope: true })).toThrow('sakurafrp_api_error')
  })

  it('parses packed and dotted export addresses', () => {
    expect(parseSakuraFrpExportAddress('16909060')).toBe('1.2.3.4')
    expect(parseSakuraFrpExportAddress('1.2.3.4')).toBe('1.2.3.4')
    expect(parseSakuraFrpExportAddress('nope')).toBeUndefined()
    expect(parseSakuraFrpExportAddress('4294967296')).toBeUndefined()
  })

  it('derives the TCP entry from the export address and the remote port', () => {
    expect(deriveSakuraFrpEntry(tunnel())).toEqual({ host: '1.2.3.4', port: 1919 })
    expect(deriveSakuraFrpEntry(tunnel({ type: 'http' }))).toBeUndefined()
    expect(deriveSakuraFrpEntry(tunnel({ remote: '0' }))).toBeUndefined()
    expect(deriveSakuraFrpEntry(tunnel({ export: '' }))).toBeUndefined()
  })
})

describe('sakurafrp entry derivation', () => {
  it('resolves the entry from the node list when export carries no address', () => {
    const offline = tunnel({ export: '' })
    expect(deriveSakuraFrpEntry(offline)).toBeUndefined()
    expect(deriveSakuraFrpNodeEntry(offline, { '5': 'frp-ski.com' })).toEqual({ host: 'frp-ski.com', port: 1919 })
    expect(deriveSakuraFrpNodeEntry(offline, {})).toBeUndefined()
    expect(deriveSakuraFrpNodeEntry(offline, { '5': '  ' })).toBeUndefined()
    expect(deriveSakuraFrpNodeEntry(tunnel({ type: 'http', export: '' }), { '5': 'frp-ski.com' })).toBeUndefined()
  })

  it('parses the node map into an id-to-host table and drops unusable rows', () => {
    const nodes = parseSakuraFrpNodes({ '62': { name: '东莞双线PLUS2', host: ' frp-ski.com ' }, bad: { name: 'x' }, junk: null })
    expect(nodes).toEqual({ '62': 'frp-ski.com' })
    expect(() => parseSakuraFrpNodes([])).toThrow('sakurafrp_api_error')
  })
})

describe('sakurafrp settings store', () => {
  it('persists the token and tunnel id without ever exposing the token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-store-'))
    temporaryDirectories.push(root)
    const store = new SakuraFrpSettingsStore(join(root, 'sakurafrp'), root)
    await store.initialize()
    expect(store.status()).toMatchObject({ tokenSet: false })
    expect(store.settings().token).toBeUndefined()
    await store.configure({ token: 'sk-access-token-01', tunnelId: 114514 })
    expect(store.status()).toMatchObject({ tokenSet: true, tunnelId: 114514 })
    const saved = JSON.parse(await readFile(join(root, 'sakurafrp', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(saved.token).toBe('sk-access-token-01')
    await store.initialize()
    expect(store.status()).toMatchObject({ tokenSet: true, tunnelId: 114514 })
    await store.purge()
    expect(store.status()).toMatchObject({ tokenSet: false })
  })

  it('keeps the stored value when a blank token is submitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-store-'))
    temporaryDirectories.push(root)
    const store = new SakuraFrpSettingsStore(join(root, 'sakurafrp'), root)
    await store.initialize()
    await store.configure({ token: 'sk-access-token-01' })
    await store.configure({ token: '', tunnelId: 114514 })
    expect(store.settings()).toMatchObject({ token: 'sk-access-token-01', tunnelId: 114514 })
  })
})

type FakeChild = ChildProcessWithoutNullStreams & EventEmitter

function fakeChild(): { child: FakeChild; stdout: (line: string) => void } {
  const child = new EventEmitter() as FakeChild
  const stdout = new EventEmitter() as FakeChild['stdout']
  const stderr = new EventEmitter() as FakeChild['stderr']
  stdout.setEncoding = vi.fn()
  stderr.setEncoding = vi.fn()
  child.stdout = stdout
  child.stderr = stderr
  Object.assign(child, { exitCode: null, kill: vi.fn(() => true) })
  return { child, stdout: line => stdout.emit('data', `${line}\n`) }
}

async function controllerFixture(settings: SakuraFrpSettingsStore, options: {
  tunnels?: readonly SakuraFrpTunnel[] | Error
  config?: string | Error
  spawn?: (child: FakeChild) => void
  maxStartupRounds?: number
}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-exec-'))
  temporaryDirectories.push(root)
  const executable = join(root, 'frpc.exe')
  await writeFile(executable, 'fake-frpc')
  let child: FakeChild | undefined
  const store = {
    load: async () => ({ version: 1 as const, enabled: false }),
    save: vi.fn(async () => {}),
  }
  const gateway = { close: vi.fn(async () => {}) }
  const createGateway = vi.fn(async () => gateway)
  const api = {
    listTunnels: vi.fn(async () => {
      if (options.tunnels instanceof Error) throw options.tunnels
      return options.tunnels ?? [tunnel()]
    }),
    listNodes: vi.fn(async () => ({ '5': 'node-5.example.com' })),
    editTunnelTarget: vi.fn(async () => {}),
    fetchTunnelConfig: vi.fn(async () => {
      if (options.config instanceof Error) throw options.config
      return options.config ?? '[common]\nserver_addr = frp.example.com\n'
    }),
  }
  const controller = new SakuraFrpController({
    store,
    settings,
    component: { executable },
    createGateway: createGateway as unknown as (publicOrigin: string, listenPort: number) => Promise<MobileAccessGateway>,
    api,
    maxStartupRounds: options.maxStartupRounds ?? 1,
    spawnProcess: () => {
      const fake = fakeChild()
      child = fake.child
      options.spawn?.(fake.child)
      return fake.child
    },
  })
  const owned: (() => Promise<void>)[] = []
  return {
    controller,
    store,
    gateway,
    createGateway,
    api,
    child: () => child,
    owned,
  }
}

describe('sakurafrp controller', () => {
  async function configuredStore(): Promise<SakuraFrpSettingsStore> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-ctrl-'))
    temporaryDirectories.push(root)
    const settings = new SakuraFrpSettingsStore(join(root, 'sakurafrp'), root)
    await settings.initialize()
    await settings.configure({ token: 'sk-access-token-01', tunnelId: 114514 })
    return settings
  }

  it('publishes readiness after frpc registers and cleans up on close', async () => {
    const settings = await configuredStore()
    const fixture = await controllerFixture(settings, {})
    await fixture.controller.initialize()
    expect(fixture.controller.status()).toMatchObject({ enabled: false, state: 'off' })
    await fixture.controller.setEnabled(true)
    // The tunnel has no usable local target yet, so the plugin points it at the
    // gateway's freshly reserved loopback port before starting frpc.
    expect(fixture.api.editTunnelTarget).toHaveBeenCalledWith('sk-access-token-01', 114514, '127.0.0.1', expect.any(Number))
    expect(fixture.createGateway).toHaveBeenCalledWith('https://1.2.3.4:1919', expect.any(Number))
    expect(fixture.controller.status()).toMatchObject({ enabled: true, state: 'starting' })
    const written = await readFile(settings.configFile, 'utf8')
    expect(written).toContain('server_addr')
    fixture.child()?.emit('close', 0)
    await vi.waitFor(() => expect(fixture.controller.status().state).toBe('error'))
  })

  it('resolves the entry host from the node list when the tunnel export is unusable', async () => {
    const settings = await configuredStore()
    const fixture = await controllerFixture(settings, { tunnels: [tunnel({ export: '' })] })
    await fixture.controller.initialize()
    await fixture.controller.setEnabled(true)
    expect(fixture.api.listNodes).toHaveBeenCalledWith('sk-access-token-01')
    expect(fixture.createGateway).toHaveBeenCalledWith('https://node-5.example.com:1919', expect.any(Number))
    await fixture.controller.close()
  })

  it('rejects unsupported tunnel types and unknown tunnels with a stable error code', async () => {
    const settings = await configuredStore()
    const httpFixture = await controllerFixture(settings, { tunnels: [tunnel({ type: 'http' })] })
    await httpFixture.controller.initialize()
    await httpFixture.controller.setEnabled(true)
    expect(httpFixture.controller.status()).toMatchObject({ state: 'error', errorCode: 'sakurafrp_tunnel_type_unsupported' })
    expect(httpFixture.createGateway).not.toHaveBeenCalled()

    const missingFixture = await controllerFixture(settings, { tunnels: [] })
    await missingFixture.controller.initialize()
    await missingFixture.controller.reconnect()
    expect(missingFixture.controller.status()).toMatchObject({ state: 'error', errorCode: 'sakurafrp_tunnel_missing' })
  })

  it('fails fast when the tunnel is banned, locked or the token is invalid', async () => {
    const settings = await configuredStore()

    const banned = await controllerFixture(settings, { tunnels: [tunnel({ status: 2 })] })
    await banned.controller.initialize()
    await banned.controller.setEnabled(true)
    expect(banned.controller.status()).toMatchObject({ state: 'error', errorCode: 'sakurafrp_tunnel_banned' })

    const locked = await controllerFixture(settings, { tunnels: [tunnel({ lockEdit: true })] })
    await locked.controller.initialize()
    await locked.controller.setEnabled(true)
    expect(locked.controller.status()).toMatchObject({ state: 'error', errorCode: 'sakurafrp_tunnel_locked' })

    const invalid = await controllerFixture(settings, { tunnels: new Error('sakurafrp_token_invalid') })
    await invalid.controller.initialize()
    await invalid.controller.setEnabled(true)
    expect(invalid.controller.status()).toMatchObject({ state: 'error', errorCode: 'sakurafrp_token_invalid' })
  })

  it('times out a live frpc that never registers', async () => {
    vi.useFakeTimers()
    try {
      const settings = await configuredStore()
      const fixture = await controllerFixture(settings, {})
      await fixture.controller.initialize()
      const enabling = fixture.controller.setEnabled(true)
      await vi.advanceTimersByTimeAsync(60_000)
      await enabling
      // The timer callback enqueues its own failGeneration step; flush the queue.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fixture.controller.status()).toMatchObject({ state: 'error', errorCode: 'sakurafrp_start_timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('detects frpc registration lines from either stream wording', () => {
    expect(isSakuraFrpRegistration('2024/01/01 login to server success, get run id [abc]')).toBe(true)
    expect(isSakuraFrpRegistration('start proxy success')).toBe(true)
    expect(isSakuraFrpRegistration('proxy added: [dsh]')).toBe(true)
    expect(isSakuraFrpRegistration('login to server error: dial tcp failed')).toBe(false)
  })
})

describe('sakurafrp api client', () => {
  it('sends bearer auth and maps HTTP failures to stable codes', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      if (String(url).endsWith('/tunnels')) {
        return new Response(JSON.stringify([tunnel()]), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 403, msg: '无权访问' }), { status: 403 })
    })
    const api = createSakuraFrpApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const tunnels = await api.listTunnels('sk-access-token-01')
    expect(tunnels[0]?.id).toBe(114514)
    const headers = new Headers(seen[0]?.init?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer sk-access-token-01')
    await expect(api.fetchTunnelConfig('sk-access-token-01', 114514, '0.70.1')).rejects.toThrow('sakurafrp_token_invalid')
  })
})