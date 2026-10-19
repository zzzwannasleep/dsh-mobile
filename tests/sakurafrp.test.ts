import { EventEmitter } from 'node:events'
import { createServer as createHttpsServer } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MobileAccessGateway } from '../src/gateway.js'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestTlsChain } from './tls-fixtures.js'
import {
  createSakuraFrpApiClient,
  deriveSakuraFrpEntry,
  deriveSakuraFrpNodeEntry,
  parseSakuraFrpNodes,
  isSakuraFrpRegistration,
  parseSakuraFrpExportAddress,
  parseSakuraFrpTunnels,
  patchSakuraFrpConfigTarget,
  probeSakuraFrpTrustedCertificate,
  SakuraFrpController,
  SakuraFrpSettingsStore,
  validateSakuraFrpBoundDomain,
  validateSakuraFrpEntryMode,
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

  it('validates the entry mode', () => {
    expect(validateSakuraFrpEntryMode('tls')).toBe('tls')
    expect(validateSakuraFrpEntryMode('autoHttps')).toBe('autoHttps')
    for (const value of ['', 'automatic', 'AUTOHTTPS', 'auto_https', 42, true, null, undefined]) {
      expect(() => validateSakuraFrpEntryMode(value), String(value)).toThrow('sakurafrp_entry_mode_invalid')
    }
  })

  it('validates the bound subdomain as a lowercase DNS name', () => {
    expect(validateSakuraFrpBoundDomain('dsh.nyat.app')).toBe('dsh.nyat.app')
    expect(validateSakuraFrpBoundDomain('a-b.c-d.nyat.app')).toBe('a-b.c-d.nyat.app')
    expect(validateSakuraFrpBoundDomain(`${'a'.repeat(63)}.nyat.app`)).toBe(`${'a'.repeat(63)}.nyat.app`)
    const rejected: readonly unknown[] = [
      '',
      'nyat',
      'dsh.nyat.app.',
      'DSH.nyat.app',
      'dsh..nyat.app',
      '.nyat.app',
      '-dsh.nyat.app',
      'dsh-.nyat.app',
      `a.${'b'.repeat(64)}`,
      `${'a'.repeat(64)}.nyat.app`,
      `${'a'.repeat(249)}.nyat.app`,
      'dsh_1.nyat.app',
      'dsh 1.nyat.app',
      'dsh.中文.app',
      42,
      null,
      undefined,
    ]
    for (const value of rejected) {
      expect(() => validateSakuraFrpBoundDomain(value), JSON.stringify(value)).toThrow('sakurafrp_bound_domain_invalid')
    }
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

describe('sakurafrp config target patching', () => {
  it('rewrites the TOML https2http plugin address of the pinned upstream frpc', () => {
    const config = [
      'serverAddr = "frp.example.com"',
      'serverPort = 7000',
      '',
      '[[proxies]]',
      'name = "dsh"',
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      'localPort = 45321',
      'remotePort = 1919',
      '',
      '[proxies.plugin]',
      'type = "https2http"',
      'localAddr = "127.0.0.1:45321"',
      '',
    ].join('\n')
    const patched = patchSakuraFrpConfigTarget(config, 28411)
    expect(patched).toContain('localAddr = "127.0.0.1:28411"')
    expect(patched).toContain('serverAddr = "frp.example.com"')
    // The plugin address wins; the proxy's own local target is left alone.
    expect(patched).toContain('localPort = 45321')
    expect(patched.endsWith('\n')).toBe(true)
  })

  it('rewrites the INI plugin address of the SakuraFrp frpc', () => {
    const config = [
      '[common]',
      'server_addr = frp.example.com',
      '',
      '[dsh]',
      'type = tcp',
      'local_ip = 127.0.0.1',
      'local_port = 45321',
      'remote_port = 1919',
      'plugin = https2http',
      'plugin_local_addr = 127.0.0.1:45321',
      '',
    ].join('\n')
    const patched = patchSakuraFrpConfigTarget(config, 28411)
    expect(patched).toContain('plugin_local_addr = 127.0.0.1:28411')
    expect(patched).toContain('local_port = 45321')
  })

  it('keeps indentation, quoting and a trailing comment', () => {
    const config = '  plugin_local_addr = "10.0.0.5:8080"   # forwarded plaintext\n'
    expect(patchSakuraFrpConfigTarget(config, 9000)).toBe('  plugin_local_addr = "127.0.0.1:9000"   # forwarded plaintext\n')
    expect(patchSakuraFrpConfigTarget('plugin_local_addr = 10.0.0.5:8080\n', 9000)).toBe('plugin_local_addr = 127.0.0.1:9000\n')
    expect(patchSakuraFrpConfigTarget('\tlocalAddr = "10.0.0.5:8080" # comment\n', 9000))
      .toBe('\tlocalAddr = "127.0.0.1:9000" # comment\n')
  })

  it('rewrites local_ip and local_port in both spellings', () => {
    const ini = '[common]\nserver_addr = frp.example.com\n\n[dsh]\ntype = tcp\nlocal_ip = 192.168.1.20\nlocal_port = 45321\nremote_port = 1919\n'
    const patchedIni = patchSakuraFrpConfigTarget(ini, 28411)
    expect(patchedIni).toContain('local_ip = 127.0.0.1')
    expect(patchedIni).toContain('local_port = 28411')
    expect(patchedIni).toContain('remote_port = 1919')

    const toml = 'serverAddr = "frp.example.com"\n\n[[proxies]]\nname = "dsh"\ntype = "tcp"\nlocalIP = "192.168.1.20"\nlocalPort = 45321\nremotePort = 1919\n'
    const patchedToml = patchSakuraFrpConfigTarget(toml, 28411)
    expect(patchedToml).toContain('localIP = "127.0.0.1"')
    expect(patchedToml).toContain('localPort = 28411')
    expect(patchedToml).toContain('remotePort = 1919')
  })

  it('rewrites only local_port when the config omits local_ip', () => {
    expect(patchSakuraFrpConfigTarget('local_port = 45321\n', 28411)).toBe('local_port = 28411\n')
    expect(patchSakuraFrpConfigTarget('localPort = 45321\n', 28411)).toBe('localPort = 28411\n')
  })

  it('preserves CRLF line endings', () => {
    const config = 'server_addr = frp.example.com\r\nlocal_ip = 192.168.1.20\r\nlocal_port = 45321\r\n'
    expect(patchSakuraFrpConfigTarget(config, 28411))
      .toBe('server_addr = frp.example.com\r\nlocal_ip = 127.0.0.1\r\nlocal_port = 28411\r\n')
  })

  it('fails explicitly when the config exposes no local target', () => {
    expect(() => patchSakuraFrpConfigTarget('server_addr = frp.example.com\n', 28411)).toThrow('sakurafrp_config_unsupported')
    expect(() => patchSakuraFrpConfigTarget('local_ip = 192.168.1.20\n', 28411)).toThrow('sakurafrp_config_unsupported')
    expect(() => patchSakuraFrpConfigTarget('local_port = 45321\n', 0)).toThrow('sakurafrp_config_unsupported')
    expect(() => patchSakuraFrpConfigTarget('local_port = 45321\n', 70_000)).toThrow('sakurafrp_config_unsupported')
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

  it('defaults to tls mode and round-trips the entry mode with the bound subdomain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-store-'))
    temporaryDirectories.push(root)
    const directory = join(root, 'sakurafrp')
    const store = new SakuraFrpSettingsStore(directory, root)
    await store.initialize()
    // An install written before the field existed keeps the raw-TCP entry.
    expect(store.settings().entryMode).toBe('tls')
    expect(store.status()).toMatchObject({ tokenSet: false, entryMode: 'tls' })
    expect(store.status()).not.toHaveProperty('boundDomain')

    await store.configure({ token: 'sk-access-token-01', tunnelId: 114514, entryMode: 'autoHttps', boundDomain: 'dsh.nyat.app' })
    expect(store.status()).toMatchObject({ entryMode: 'autoHttps', boundDomain: 'dsh.nyat.app' })
    const saved = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({ entryMode: 'autoHttps', boundDomain: 'dsh.nyat.app' })
    expect(saved.token).toBe('sk-access-token-01')

    const reloaded = new SakuraFrpSettingsStore(directory, root)
    await reloaded.initialize()
    expect(reloaded.settings()).toMatchObject({ entryMode: 'autoHttps', boundDomain: 'dsh.nyat.app' })
    // A blank field keeps the stored value; switching back to tls keeps the domain.
    await reloaded.configure({ entryMode: '', boundDomain: '' })
    expect(reloaded.settings()).toMatchObject({ entryMode: 'autoHttps', boundDomain: 'dsh.nyat.app' })
    await reloaded.configure({ entryMode: 'tls' })
    expect(reloaded.settings()).toMatchObject({ entryMode: 'tls', boundDomain: 'dsh.nyat.app' })

    await reloaded.purge()
    expect(reloaded.settings().entryMode).toBe('tls')
    expect(reloaded.settings().boundDomain).toBeUndefined()
  })

  it('rejects an invalid entry mode or bound domain before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-store-'))
    temporaryDirectories.push(root)
    const store = new SakuraFrpSettingsStore(join(root, 'sakurafrp'), root)
    await store.initialize()
    await expect(store.configure({ entryMode: 'automatic' })).rejects.toThrow('sakurafrp_entry_mode_invalid')
    await expect(store.configure({ boundDomain: 'Dsh.nyat.app' })).rejects.toThrow('sakurafrp_bound_domain_invalid')
    await expect(store.configure({ entryMode: 'autoHttps', boundDomain: 'nyat' })).rejects.toThrow('sakurafrp_bound_domain_invalid')
    expect(store.settings().entryMode).toBe('tls')
  })

  it('refuses a persisted settings file with an invalid entry mode or an unknown field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-store-'))
    temporaryDirectories.push(root)
    const directory = join(root, 'sakurafrp')
    const store = new SakuraFrpSettingsStore(directory, root)
    await store.initialize()
    await store.configure({ token: 'sk-access-token-01', tunnelId: 114514 })

    const invalidModes: readonly unknown[] = ['automatic', '', 7, null]
    for (const entryMode of invalidModes) {
      await writeFile(join(directory, 'settings.json'), `${JSON.stringify({ version: 1, token: 'sk-access-token-01', entryMode })}\n`)
      await store.initialize()
      expect(store.settings().entryMode, JSON.stringify(entryMode)).toBe('tls')
      expect(store.settings().token).toBeUndefined()
    }

    await writeFile(join(directory, 'settings.json'), `${JSON.stringify({ version: 1, token: 'sk-access-token-01', entryPath: '/tmp' })}\n`)
    await store.initialize()
    expect(store.settings().token).toBeUndefined()
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
  probeCertificate?: () => Promise<'trusted' | 'untrusted' | 'unreachable'>
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
  const createTrustedGateway = vi.fn(async () => gateway)
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
    createTrustedGateway: createTrustedGateway as unknown as (publicOrigin: string, listenPort: number) => Promise<MobileAccessGateway>,
    ...(options.probeCertificate === undefined ? {} : { probeCertificate: options.probeCertificate }),
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
    createTrustedGateway,
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

describe('sakurafrp trusted entry mode', () => {
  async function trustedStore(partial: { entryMode?: unknown; boundDomain?: unknown } = {}): Promise<SakuraFrpSettingsStore> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-trusted-'))
    temporaryDirectories.push(root)
    const settings = new SakuraFrpSettingsStore(join(root, 'sakurafrp'), root)
    await settings.initialize()
    await settings.configure({
      token: 'sk-access-token-01',
      tunnelId: 114514,
      entryMode: 'autoHttps',
      boundDomain: 'dsh.nyat.app',
      ...partial,
    })
    return settings
  }

  function register(fixture: { child: () => FakeChild | undefined }): void {
    fixture.child()?.stdout.emit('data', 'login to server success, get run id [abc]\n')
  }

  /** Minimal natfrp answer that carries a local target the plugin can rewrite. */
  const patchableConfig = '[[proxies]]\nlocalPort = 45321\n'

  it('builds the bound-subdomain origin and uses the plaintext ingress', async () => {
    const settings = await trustedStore()
    const fixture = await controllerFixture(settings, { config: patchableConfig })
    await fixture.controller.initialize()
    await fixture.controller.setEnabled(true)
    expect(fixture.controller.status()).toMatchObject({ trustedEntry: true })
    expect(fixture.createGateway).not.toHaveBeenCalled()
    expect(fixture.createTrustedGateway).toHaveBeenCalledWith('https://dsh.nyat.app:1919', expect.any(Number))
    const listenPort = (fixture.createTrustedGateway.mock.calls[0] as unknown[])[1] as number
    // The fetched config is rewritten onto the same loopback port the plaintext
    // ingress listens on, and nothing else in it changes.
    expect(await readFile(settings.configFile, 'utf8')).toBe(`[[proxies]]\nlocalPort = ${String(listenPort)}\n`)
    expect(fixture.api.editTunnelTarget).toHaveBeenCalledWith('sk-access-token-01', 114514, '127.0.0.1', listenPort)
    await fixture.controller.close()
  })

  it('omits the default port when the bound entry listens on 443', async () => {
    const settings = await trustedStore()
    const fixture = await controllerFixture(settings, { tunnels: [tunnel({ remote: '443' })] })
    await fixture.controller.initialize()
    await fixture.controller.setEnabled(true)
    expect(fixture.createTrustedGateway).toHaveBeenCalledWith('https://dsh.nyat.app', expect.any(Number))
    await fixture.controller.close()
  })

  it('requires a bound subdomain before touching the API', async () => {
    // autoHttps without a bound domain is a valid stored combination (the owner
    // may fill the panel in two steps), so the controller must fail closed
    // instead of guessing a host.
    const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-trusted-'))
    temporaryDirectories.push(root)
    const bare = new SakuraFrpSettingsStore(join(root, 'sakurafrp'), root)
    await bare.initialize()
    await bare.configure({ token: 'sk-access-token-01', tunnelId: 114514, entryMode: 'autoHttps' })
    expect(bare.settings().boundDomain).toBeUndefined()
    const fixture = await controllerFixture(bare, {})
    await fixture.controller.initialize()
    await fixture.controller.setEnabled(true)
    expect(fixture.controller.status()).toMatchObject({ state: 'unavailable', errorCode: 'sakurafrp_bound_domain_missing' })
    expect(fixture.api.listTunnels).not.toHaveBeenCalled()
    expect(fixture.createTrustedGateway).not.toHaveBeenCalled()
  })

  it('fails explicitly when the fetched config carries no local target', async () => {
    const settings = await trustedStore()
    const fixture = await controllerFixture(settings, { config: 'serverAddr = "frp.example.com"\n' })
    await fixture.controller.initialize()
    await fixture.controller.setEnabled(true)
    expect(fixture.controller.status()).toMatchObject({ state: 'error', errorCode: 'sakurafrp_config_unsupported' })
  })

  it('publishes trustedCertificate only when the public handshake verifies', async () => {
    const settings = await trustedStore()
    const fixture = await controllerFixture(settings, { config: patchableConfig, probeCertificate: async () => 'trusted' })
    await fixture.controller.initialize()
    await fixture.controller.setEnabled(true)
    register(fixture)
    await vi.waitFor(() => expect(fixture.controller.status().state).toBe('ready'))
    expect(fixture.controller.status()).toMatchObject({
      state: 'ready',
      origin: 'https://dsh.nyat.app:1919',
      trustedEntry: true,
      trustedCertificate: true,
    })
    await fixture.controller.close()
  })

  it('reports an untrusted entry certificate with its own code', async () => {
    const settings = await trustedStore()
    const fixture = await controllerFixture(settings, { config: patchableConfig, probeCertificate: async () => 'untrusted' })
    await fixture.controller.initialize()
    await fixture.controller.setEnabled(true)
    register(fixture)
    await vi.waitFor(() => expect(fixture.controller.status().state).toBe('error'))
    expect(fixture.controller.status()).toMatchObject({
      state: 'error',
      errorCode: 'sakurafrp_certificate_untrusted',
      trustedEntry: true,
    })
  })

  it('keeps a ready entry unverified when the probe itself could not complete', async () => {
    const settings = await trustedStore()
    const fixture = await controllerFixture(settings, { config: patchableConfig, probeCertificate: async () => 'unreachable' })
    await fixture.controller.initialize()
    await fixture.controller.setEnabled(true)
    register(fixture)
    await vi.waitFor(() => expect(fixture.controller.status().state).toBe('ready'))
    expect(fixture.controller.status()).not.toHaveProperty('trustedCertificate')
    await fixture.controller.close()
  })

  it('never probes or rewrites the config in the default tls mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-trusted-'))
    temporaryDirectories.push(root)
    const settings = new SakuraFrpSettingsStore(join(root, 'sakurafrp'), root)
    await settings.initialize()
    await settings.configure({ token: 'sk-access-token-01', tunnelId: 114514 })
    const probeCertificate = vi.fn(async () => 'trusted' as const)
    const fetched = '[common]\nserver_addr = frp.example.com\nlocal_port = 45321\n'
    const fixture = await controllerFixture(settings, { config: fetched, probeCertificate })
    await fixture.controller.initialize()
    await fixture.controller.setEnabled(true)
    expect(fixture.createGateway).toHaveBeenCalledWith('https://1.2.3.4:1919', expect.any(Number))
    expect(fixture.createTrustedGateway).not.toHaveBeenCalled()
    // Byte-identical to what natfrp answered, exactly as before this mode existed.
    expect(await readFile(settings.configFile, 'utf8')).toBe(fetched)
    register(fixture)
    await vi.waitFor(() => expect(fixture.controller.status().state).toBe('ready'))
    expect(probeCertificate).not.toHaveBeenCalled()
    expect(fixture.controller.status()).toMatchObject({ trustedEntry: false })
    expect(fixture.controller.status()).not.toHaveProperty('trustedCertificate')
    await fixture.controller.close()
  })
})

describe('sakurafrp trusted certificate probe', () => {
  it('rejects a self-signed entry and reports an unreachable one as unverified', async () => {
    const chain = createTestTlsChain()
    const server = createHttpsServer({ cert: chain.leafCert, key: chain.leafKey }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    server.on('tlsClientError', () => {})
    await new Promise<void>(resolveListen => { server.listen(0, '127.0.0.1', resolveListen) })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('fixture TLS server did not bind')
      // The fixture chain is not in the system trust store, which is exactly the
      // answer a friend's browser would give for the plugin's own CA.
      expect(await probeSakuraFrpTrustedCertificate(`https://127.0.0.1:${String(address.port)}`)).toBe('untrusted')
    } finally {
      await new Promise<void>(resolveClose => { server.close(() => resolveClose()) })
    }
    expect(await probeSakuraFrpTrustedCertificate('https://127.0.0.1:1')).toBe('unreachable')
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