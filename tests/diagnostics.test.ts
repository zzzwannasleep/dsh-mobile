import { describe, expect, it, vi } from 'vitest'
import {
  collectConnectionDiagnostics,
  configuredProxyFor,
  hasCompetingRemoteChannelBoot,
  probeRemoteHealth,
  remoteDiagnosticTimeoutMs,
  type DiagnosticSnapshot,
} from '../src/diagnostics.js'

const healthy: DiagnosticSnapshot = {
  dshVersion: '0.1.1-rc.2',
  lan: {
    running: true,
    origin: 'https://192.168.0.101:3443',
    configuredInterface: 'Wi-Fi',
    interfaceName: 'Wi-Fi',
    port: 3443,
  },
  remote: {
    provider: 'cloudflared',
    running: true,
    state: 'ready',
    origin: 'https://dsh.example.com',
  },
}

describe('connection diagnostics', () => {
  it('recognizes only an active third-party remote boot script row', () => {
    expect(hasCompetingRemoteChannelBoot([{ kind: 'script', text: '(function(){w["__DSH_REMOTE_CHANNEL_BOOT__"]=seat})();' }])).toBe(true)
    const externalScript = [{ kind: 'script-src', src: '/plugins/remote.js' }]
    expect(hasCompetingRemoteChannelBoot(externalScript)).toBe(false)
    expect(hasCompetingRemoteChannelBoot([{ kind: 'script', text: 'window.__DSH_TRANSPORT__={ownsHost:true}' }])).toBe(false)
    expect(hasCompetingRemoteChannelBoot([])).toBe(false)
  })

  it('explains a competing remote pairing flow without treating its code as a DSH Mobile token', async () => {
    const result = await collectConnectionDiagnostics({ ...healthy, competingRemoteChannelBoot: true }, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'ready', latencyMs: 86 }),
    })
    expect(result.overall).toBe('attention')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'remote-plugin-conflict', status: 'warning', reason: 'competing-remote-channel', action: expect.stringContaining('不要混用两种配对码') }),
    ]))
  })

  it('reports missing LAN setup as an actionable blocking problem', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      lan: { configured: false, running: false },
      remote: { provider: 'cloudflared', running: false, state: 'off' },
    }, {
      firewall: async () => ({ state: 'not-applicable' }),
      remote: async () => ({ state: 'not-applicable' }),
    })

    expect(result.overall).toBe('error')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'network', status: 'error', reason: 'lan-setup-required', action: expect.stringContaining('选择网卡') }),
    ]))
  })

  it('fits direct and relay attempts inside the desktop diagnostic request budget', () => {
    expect(remoteDiagnosticTimeoutMs('https://dsh.example.com')).toBe(6_000)
    expect(remoteDiagnosticTimeoutMs('https://example.com')).toBe(6_000)
  })

  it('summarizes healthy LAN and remote paths without copying exact addresses', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'ready', latencyMs: 86 }),
    })

    expect(result.overall).toBe('ok')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lan', status: 'ok', reason: 'lan-ready', facts: { endpointSuffix: 'https://192.168.0.x:3443' } }),
      expect.objectContaining({ id: 'network', reason: 'network-interface', facts: { interfaceName: 'Wi-Fi' } }),
      expect.objectContaining({ id: 'remote', status: 'ok', reason: 'remote-ready', facts: { provider: 'cloudflared', endpointSuffix: '公共 HTTPS 地址', latencyMs: 86 }, detail: expect.stringContaining('86 ms') }),
    ]))
    expect(result.report).toContain('https://192.168.0.x:3443')
    expect(result.report).not.toContain('192.168.0.101')
  })

  it('turns missing firewall rules and provider errors into shortest recovery actions', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'cloudflared', running: true, state: 'error', errorCode: 'cloudflared_start_timeout' },
    }, {
      firewall: async () => ({ state: 'missing' }),
      remote: async () => ({ state: 'not-applicable' }),
    })

    expect(result.overall).toBe('error')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'firewall', status: 'warning', action: expect.stringContaining('setup') }),
      expect.objectContaining({ id: 'remote', status: 'error', reason: 'remote-controller-error', facts: { provider: 'cloudflared', controllerCode: 'cloudflared_start_timeout' }, action: '检查网络后点击“重新连接”。' }),
    ]))
  })

  it('reports observed provider throttling without claiming an account quota', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'rate-limited', latencyMs: 210 }),
    })

    expect(result.overall).toBe('attention')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'remote', status: 'warning', reason: 'remote-rate-limited', facts: { provider: 'cloudflared', endpointSuffix: '公共 HTTPS 地址', latencyMs: 210 }, detail: expect.stringContaining('观察到服务限流') }),
    ]))
  })

  it('emits stable reasons for off, connecting, and unreachable remote variants', async () => {
    const probe = { firewall: async () => ({ state: 'ready' as const }), remote: async () => ({ state: 'unreachable' as const }) }
    const off = await collectConnectionDiagnostics({ ...healthy, remote: { provider: 'cloudflared', running: false, state: 'off' } }, probe)
    const connecting = await collectConnectionDiagnostics({ ...healthy, remote: { provider: 'cloudflared', running: true, state: 'connecting' } }, probe)
    const unreachable = await collectConnectionDiagnostics(healthy, probe)
    expect(off.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'remote', reason: 'remote-off', facts: { provider: 'cloudflared' } })]))
    expect(connecting.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'remote', reason: 'remote-connecting', facts: { provider: 'cloudflared' } })]))
    expect(unreachable.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'remote', reason: 'remote-unreachable', facts: { provider: 'cloudflared', endpointSuffix: '公共 HTTPS 地址' } })]))
  })

  it('surfaces sakurafrp controller errors with their recovery guidance', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'sakurafrp', running: true, state: 'error', errorCode: 'sakurafrp_tunnel_banned' },
    }, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'not-applicable' }),
    })
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'remote',
        status: 'error',
        reason: 'remote-controller-error',
        facts: { provider: 'sakurafrp', controllerCode: 'sakurafrp_tunnel_banned' },
        action: '该隧道已被封禁，请在 SakuraFrp 面板处理后重新选择。',
      }),
    ]))
  })
})

describe('remote reachability relay fallback', () => {
  const remoteOrigin = 'https://dsh.example.com'
  /** The relay addresses this machine actually configures in the environment. */
  const relayEnv = { HTTP_PROXY: 'http://127.0.0.1:7897' } satisfies NodeJS.ProcessEnv
  const directGone = async (): Promise<{ state: 'unreachable' }> => ({ state: 'unreachable' })

  it('picks the configured relay unless NO_PROXY covers the target', () => {
    expect(configuredProxyFor(remoteOrigin, { HTTPS_PROXY: 'http://relay:7897', ALL_PROXY: 'http://all:1', HTTP_PROXY: 'http://generic:2' })?.host).toBe('relay:7897')
    expect(configuredProxyFor(remoteOrigin, { https_proxy: 'http://relay:7897' })?.host).toBe('relay:7897')
    expect(configuredProxyFor(remoteOrigin, { HTTP_PROXY: 'http://relay:7897' })?.host).toBe('relay:7897')
    expect(configuredProxyFor(remoteOrigin, {})).toBeUndefined()
    expect(configuredProxyFor(remoteOrigin, { HTTPS_PROXY: 'socks5://relay:1080' })).toBeUndefined()
  })

  it('honors NO_PROXY without losing the localhost exclusions this machine sets', () => {
    const env = { HTTP_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1,::1' }
    expect(configuredProxyFor(remoteOrigin, env)?.host).toBe('127.0.0.1:7897')
    expect(configuredProxyFor(remoteOrigin, { ...env, NO_PROXY: 'example.com' })).toBeUndefined()
    expect(configuredProxyFor(remoteOrigin, { ...env, NO_PROXY: '.dsh.example.com' })).toBeUndefined()
    expect(configuredProxyFor(remoteOrigin, { HTTP_PROXY: 'http://127.0.0.1:7897', NO_PROXY: '*' })).toBeUndefined()
    expect(configuredProxyFor('https://other.example.com', { HTTP_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'dsh.example.com' })?.host).toBe('127.0.0.1:7897')
    expect(configuredProxyFor(remoteOrigin, { ...env, NO_PROXY: 'example.com:80' })?.host).toBe('127.0.0.1:7897')
    expect(configuredProxyFor(remoteOrigin, { ...env, NO_PROXY: 'example.com:443' })).toBeUndefined()
    expect(configuredProxyFor('https://[::1]', { ...env, NO_PROXY: '[::1]:443' })).toBeUndefined()
  })

  it('answers ready through the relay when the direct hairpin cannot', async () => {
    const tunnel = vi.fn(async () => ({ status: 200, latencyMs: 96 }))
    const observation = await probeRemoteHealth(remoteOrigin, { env: relayEnv, direct: directGone, tunnel })
    expect(observation).toEqual({ state: 'ready', latencyMs: 96, viaProxy: true })
    expect(tunnel).toHaveBeenCalledOnce()
  })

  it('threads the relay egress into the localized remote-ready facts', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'ready', latencyMs: 8, viaProxy: true }),
    })
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'remote',
        status: 'warning',
        reason: 'remote-ready',
        facts: { provider: 'cloudflared', endpointSuffix: '公共 HTTPS 地址', latencyMs: 8, viaProxy: true },
      }),
    ]))
    expect(result.checks.find(entry => entry.id === 'remote')?.detail).toContain('尚未验证手机能否连接')
    expect(result.overall).toBe('attention')
  })

  it('keeps the direct failure when the relay refuses, times out, or is not configured', async () => {
    const refused = vi.fn(async () => ({ status: 502, latencyMs: 4 }))
    expect(await probeRemoteHealth(remoteOrigin, { env: relayEnv, direct: directGone, tunnel: refused })).toEqual({ state: 'unreachable' })
    const threw = vi.fn(async () => { throw new Error('proxy_tunnel_closed') })
    expect(await probeRemoteHealth(remoteOrigin, { env: relayEnv, direct: directGone, tunnel: threw })).toEqual({ state: 'unreachable' })
    const unused = vi.fn(async () => ({ status: 200, latencyMs: 1 }))
    expect(await probeRemoteHealth(remoteOrigin, { env: { NO_PROXY: '*' }, direct: directGone, tunnel: unused })).toEqual({ state: 'unreachable' })
    expect(unused).not.toHaveBeenCalled()
  })

  it('maps a relay-side throttling answer without inventing a readiness claim', async () => {
    const observation = await probeRemoteHealth(remoteOrigin, {
      env: relayEnv,
      direct: directGone,
      tunnel: async () => ({ status: 429, latencyMs: 17 }),
    })
    expect(observation).toEqual({ state: 'rate-limited', latencyMs: 17, viaProxy: true })
  })

  it('preserves the Fake-IP verdict when both the direct and relay attempts fail', async () => {
    const observation = await probeRemoteHealth(remoteOrigin, {
      env: relayEnv,
      direct: async () => ({ state: 'unreachable' as const, fakeIp: true }),
      tunnel: async () => { throw new Error('proxy_tunnel_timeout') },
    })
    expect(observation).toEqual({ state: 'unreachable', fakeIp: true })
  })

  it('leaves absent origins and probe answers untouched', async () => {
    expect(await probeRemoteHealth(undefined)).toEqual({ state: 'not-applicable' })
    const direct = async (): Promise<{ state: 'ready'; latencyMs: number }> => ({ state: 'ready', latencyMs: 3 })
    expect(await probeRemoteHealth(remoteOrigin, { env: relayEnv, direct, tunnel: async () => ({ status: 200, latencyMs: 9 }) })).toEqual({ state: 'ready', latencyMs: 3 })
  })
})
