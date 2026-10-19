import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { createServer, request as requestHttp, type IncomingMessage } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generate } from 'selfsigned'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, parseGatewayConfig, type PluginConfig } from '../src/config.js'
import { parseCidr, RequestTrustPolicy } from '../src/network.js'
import {
  apply,
  inject,
  readTlsIngressTrustAnchor,
  remoteGatewayConfig,
  settleCleanupSteps,
  tlsIngressGatewayConfig,
  upstreamAuthenticatedUrl,
} from '../src/plugin.js'
import { ensureTlsIngressCertificate, tlsIngressPaths } from '../src/tls-ingress.js'
import { FrpComponentManager } from '../src/frp-component.js'
import { DSH_MOBILE_VERSION, MINIMUM_ANDROID_APP_VERSION } from '../src/version.js'
import { DESKTOP_ADMIN_HEADER, DESKTOP_ADMIN_MARKER } from '../src/local-admin-host.js'
import { buildExtensionWorkerEntry } from './helpers/extension-worker-build.js'
import { parseUnavailableExtensionHosts } from '../src/extension-recovery-ui.js'

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function invoke(
  route: WebRoute,
  method: 'GET' | 'POST',
  path: string,
  body = '',
  hostHostname = '127.0.0.1',
  requestHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const server = createServer((request, response) => { void route.handler(request, response) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const authority = `${hostHostname}:${String(port)}`
  try {
    return await new Promise((resolve, reject) => {
      const request = requestHttp({
        host: '127.0.0.1',
        port,
        method,
        path,
        // Keep-alive sockets parked in the global agent hold loopback ports from
        // the same ephemeral range this fixture probes for the gateway listeners.
        agent: false,
        headers: {
          host: authority,
          ...(method === 'POST' ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          } : {}),
          ...(requestHeaders ?? (method === 'POST' ? {
            origin: `http://${authority}`,
            'sec-fetch-site': 'same-origin',
          } : {})),
        },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      request.once('error', reject)
      if (body !== '') request.write(body)
      request.end()
    })
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
}

async function mount(
  initiallyEnabled = false,
  webServerPort = 3080,
  config: Partial<PluginConfig> = {},
  requestRejection: (request: IncomingMessage) => 401 | 403 | undefined = () => 401,
  indexInjections: readonly { kind: string; text?: string }[] = [],
): Promise<{ context: Context; route: WebRoute; command: CommandDefinition; upstreamBase: string | undefined; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-plugin-'))
  temporaryDirectories.push(directory)
  let route: WebRoute | undefined
  let command: CommandDefinition | undefined
  let upstreamBase: string | undefined
  const context = new Context()
  contexts.push(context)
  context.provide('webServer', {
    port: webServerPort,
    collectIndexInjections: () => indexInjections,
    register(candidate: WebRoute) {
      route = candidate
      return () => { if (route === candidate) route = undefined }
    },
  } as WebServer)
  context.provide('commands', {
    register(definition: CommandDefinition) {
      command = definition
      return () => { if (command === definition) command = undefined }
    },
  } as never)
  context.provide('connection', {
    authenticatedUrl(baseUrl: string) {
      upstreamBase = baseUrl
      return `${baseUrl}/?token=test-launch-token`
    },
    requestRejection,
  } as never)
  await context.plugin({ Config, inject, apply }, {
    listenPort: 0,
    stateFile: join(directory, 'devices.json'),
    controlFile: join(directory, 'control.json'),
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
    initiallyEnabled,
    tls: { mode: 'disabled' },
    ...config,
  })
  if (route === undefined) throw new Error('plugin did not register its control route')
  if (command === undefined) throw new Error('plugin did not register its /mobile command')
  return { context, route, command, upstreamBase, directory }
}

async function managedSetupFile(upstreamOrigin: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-managed-plugin-'))
  temporaryDirectories.push(directory)
  const generated = await generate([{ name: 'commonName', value: 'DSH Mobile test CA' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true, critical: true }],
  })
  const caCertFile = join(directory, 'ca.pem')
  await writeFile(caCertFile, generated.cert)
  const setupFile = join(directory, 'setup.json')
  await writeFile(setupFile, JSON.stringify({
    version: 2,
    networkInterface: 'unused-while-disabled',
    listenPort: 3443,
    upstreamOrigin,
    tls: {
      mode: 'managed',
      caCertFile,
      caKeyFile: join(directory, 'ca-key.pem'),
      certFile: join(directory, 'server.pem'),
      keyFile: join(directory, 'server-key.pem'),
    },
  }))
  return setupFile
}

describe('upstream browser authentication', () => {
  const upstreamOrigin = new URL('http://127.0.0.1:3080')
  const withConnection = (connection: unknown): Context => ({ connection } as unknown as Context)

  it('keeps the launch-token URL a stock DSH connection returns', () => {
    const authenticatedUrl = upstreamAuthenticatedUrl(withConnection({
      authenticatedUrl: (baseUrl: string) => `${baseUrl}/?token=launch-token`,
    }), upstreamOrigin)
    expect(authenticatedUrl).toBe('http://127.0.0.1:3080/?token=launch-token')
  })

  it('reports no upstream URL when browser authentication is disabled, so the gateway proxies without a cookie', () => {
    // dsh-lan-access `noAuth: true` replaces `authenticatedUrl` with one that
    // returns the bare origin. Handing that URL to the gateway made its cookie
    // exchange reject every proxied route with `upstream_unavailable`.
    const authenticatedUrl = upstreamAuthenticatedUrl(withConnection({
      authenticatedUrl: (baseUrl: string) => baseUrl,
    }), upstreamOrigin)
    expect(authenticatedUrl).toBeUndefined()
  })

  it('reports no upstream URL when the connection service exposes no browser authentication', () => {
    expect(upstreamAuthenticatedUrl(withConnection(undefined), upstreamOrigin)).toBeUndefined()
    expect(upstreamAuthenticatedUrl(withConnection({}), upstreamOrigin)).toBeUndefined()
    expect(upstreamAuthenticatedUrl(withConnection({ authenticatedUrl: 'not-a-function' }), upstreamOrigin)).toBeUndefined()
  })

  it('reports no upstream URL when the connection service returns a malformed URL', () => {
    expect(upstreamAuthenticatedUrl(withConnection({
      authenticatedUrl: () => 'not a url',
    }), upstreamOrigin)).toBeUndefined()
  })

  it('does not swallow a failing connection service', () => {
    // Only parsing the returned URL is guarded. A broken connection service must
    // keep failing plugin activation instead of silently proxying unauthenticated.
    expect(() => upstreamAuthenticatedUrl(withConnection({
      authenticatedUrl: () => { throw new Error('connection unavailable') },
    }), upstreamOrigin)).toThrow('connection unavailable')
  })
})

describe('remote gateway configuration', () => {
  it('keeps public HTTPS on 443 when the private listener uses an ephemeral port', () => {
    const template = parseGatewayConfig({
      listenHost: '127.0.0.1',
      listenPort: 0,
      publicAuthorities: ['127.0.0.1'],
      allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(tmpdir(), 'dsh-mobile-remote-template.json'),
      tls: { mode: 'disabled' },
    })
    const publicHost = 'dsh-gateway.example.net'
    const config = remoteGatewayConfig(
      template,
      `https://${publicHost}`,
      join(tmpdir(), 'dsh-mobile-remote-devices.json'),
      'a'.repeat(64),
    )
    const policy = new RequestTrustPolicy(
      config.authorities,
      58_916,
      [parseCidr('127.0.0.0/8')],
      config.publicTls,
    )

    expect(config.authorities).toEqual([{ hostname: publicHost, port: 443 }])
    expect([...policy.origins]).toEqual([`https://${publicHost}`])
    expect(policy.acceptsHost(publicHost)).toBe(true)
    expect(policy.acceptsOrigin(`https://${publicHost}`)).toBe(true)
    expect(policy.acceptsHost(`${publicHost}:58916`)).toBe(false)
    expect(policy.acceptsOrigin(`https://${publicHost}:58916`)).toBe(false)
  })

  it('allows a transport-owned fixed loopback port without changing the public authority', () => {
    const template = parseGatewayConfig({
      listenHost: '127.0.0.1',
      listenPort: 0,
      publicAuthorities: ['127.0.0.1'],
      allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(tmpdir(), 'dsh-mobile-remote-template.json'),
      excludedClientModules: ['@example/optional-client'],
      tls: { mode: 'disabled' },
    })
    const config = remoteGatewayConfig(
      template,
      'https://dsh.example.net',
      join(tmpdir(), 'dsh-mobile-remote-fixed-devices.json'),
      'b'.repeat(64),
      45_321,
    )

    expect(config.listenPort).toBe(45_321)
    expect(config.authorities).toEqual([{ hostname: 'dsh.example.net', port: 443 }])
    expect(config.excludedClientModules).toEqual(['@example/optional-client'])
  })
})

describe('TLS ingress gateway configuration', () => {
  const stateFile = join(tmpdir(), 'dsh-mobile-ingress-devices.json')
  const paths = tlsIngressPaths(stateFile)
  const ingress = { paths, caFingerprint: 'a'.repeat(64) }

  function ingressTemplate(): ReturnType<typeof parseGatewayConfig> {
    return parseGatewayConfig({
      listenHost: '127.0.0.1',
      listenPort: 0,
      publicAuthorities: ['127.0.0.1'],
      allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(tmpdir(), 'dsh-mobile-ingress-template.json'),
      // The LAN pairing CA must not leak into the remote channel: the gateway
      // serves the ingress CA the phone pins for this channel.
      pairingCaFile: join(tmpdir(), 'unused-lan-ca.pem'),
      tls: { mode: 'disabled' },
    })
  }

  it('terminates TLS with the pairing CA and pins the CA fingerprint as the instance id', () => {
    const template = ingressTemplate()
    const config = tlsIngressGatewayConfig(template, 'https://192.0.2.10', stateFile, ingress, 45_321)

    expect(config.listenPort).toBe(45_321)
    // A bare HTTPS origin keeps the canonical public HTTPS port.
    expect(config.authorities).toEqual([{ hostname: '192.0.2.10', port: 443 }])
    // The app validates `instance` against the CA it pins, so this channel uses
    // the CA fingerprint, not the plugin-wide installation id.
    expect(config.instanceId).toBe(ingress.caFingerprint)
    expect(config.pairingCaFile).toBe(paths.caCertFile)
    expect(config.tls).toEqual({ mode: 'provided', certFile: paths.certFile, keyFile: paths.keyFile })
    expect(config.publicTls).toBe(true)
    expect(config.discovery).toBe(false)
    expect(config.listenHost).toBe('127.0.0.1')
    expect(config.stateFile).toBe(stateFile)
    expect(config.allowedCidrs.map(cidr => cidr.source)).toEqual(['127.0.0.0/8'])
    // The LAN template keeps its own pairing CA and listener port untouched.
    expect(template.pairingCaFile).toBe(join(tmpdir(), 'unused-lan-ca.pem'))
    expect(template.listenPort).toBe(0)
  })

  it('keeps an explicit public TLS port instead of forcing 443', () => {
    const config = tlsIngressGatewayConfig(ingressTemplate(), 'https://192.0.2.10:8443', stateFile, ingress)
    expect(config.authorities).toEqual([{ hostname: '192.0.2.10', port: 8443 }])
    expect(config.listenPort).toBe(0)
  })

  it.each([
    'http://192.0.2.10',
    'https://user:secret@192.0.2.10',
    'https://192.0.2.10/mobile-access',
    'https://192.0.2.10/?device=1',
    'https://192.0.2.10/#pair',
  ])('rejects a public origin that is not a bare HTTPS origin: %s', origin => {
    expect(() => tlsIngressGatewayConfig(ingressTemplate(), origin, stateFile, ingress))
      .toThrow('tls_ingress_public_origin_invalid')
  })
})

describe('TLS ingress trust anchor', () => {
  it('reads the pairing CA the start-up self-check must pin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-trust-anchor-'))
    temporaryDirectories.push(root)
    const stateFile = join(root, 'devices.json')
    const ingress = await ensureTlsIngressCertificate(
      { publicOrigin: 'https://192.0.2.10' }, stateFile, Date.now(), undefined, root,
    )
    const anchor = await readTlsIngressTrustAnchor(stateFile, root)
    expect(anchor).toBe(await readFile(ingress.paths.caCertFile, 'utf8'))
    expect(anchor).toMatch(/^-----BEGIN CERTIFICATE-----/u)
  })

  it('fails closed when the anchor file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-trust-anchor-'))
    temporaryDirectories.push(root)
    await expect(readTlsIngressTrustAnchor(join(root, 'devices.json'), root))
      .rejects.toThrow('tls_ingress_ca_invalid')
  })

  it('fails closed when the anchor is not a regular CA file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-trust-anchor-'))
    temporaryDirectories.push(root)
    const stateFile = join(root, 'devices.json')
    await mkdir(tlsIngressPaths(stateFile).caCertFile, { recursive: true })
    await expect(readTlsIngressTrustAnchor(stateFile, root)).rejects.toThrow('tls_ingress_ca_invalid')
  })
})

describe('stock DSH lifecycle', () => {
  it('requires the WebServer, commands, and Connection services', () => {
    expect(inject).toEqual(['webServer', 'commands', 'connection'])
  })

  it('rejects late admin reads and writes after the plugin generation closes', async () => {
    const mounted = await mount()
    await mounted.context.fiber.dispose()
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(status.status).toBe(503)
    const saved = await invoke(mounted.route, 'POST', '/api/mobile-access/lan/trusted-networks', JSON.stringify({ extraAllowedCidrs: ['10.80.0.0/24'] }))
    expect(saved.status).toBe(503)
  })

  it('continues ordered teardown after failures and aggregates them', async () => {
    const completed: string[] = []
    let failure: unknown
    try {
      await settleCleanupSteps([
        () => { completed.push('route') },
        async () => { completed.push('remote'); throw new Error('remote close failed') },
        async () => { completed.push('lan') },
        async () => { completed.push('extensions'); throw new Error('extension close failed') },
        () => { completed.push('builtin') },
      ])
    } catch (error) { failure = error }
    expect(completed).toEqual(['route', 'remote', 'lan', 'extensions', 'builtin'])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
  })

  it('keeps a loopback control route available while the LAN listener is stopped', async () => {
    const mounted = await mount()
    expect(mounted.route).toMatchObject({ kind: 'prefix', path: '/api/mobile-access' })
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/control')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({ running: false })
    const remote = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(remote.status).toBe(200)
    expect(JSON.parse(remote.body)).toMatchObject({
      provider: 'sakurafrp',
      running: false,
      state: 'off',
      providers: {
        cloudflared: {
          bundled: false,
          running: false,
          state: 'off',
          component: { supported: true, installed: false },
          configuration: { mode: 'named', configured: false },
        },
        sakurafrp: {
          bundled: false,
          running: false,
          state: 'off',
          component: { supported: true, installed: false, version: '0.70.1' },
          configuration: { tokenSet: false },
        },
      },
    })
    const diagnostics = await invoke(mounted.route, 'GET', '/api/mobile-access/diagnostics')
    expect(diagnostics.status).toBe(200)
    expect(JSON.parse(diagnostics.body)).toMatchObject({
      version: 1,
      overall: expect.stringMatching(/^(?:ok|attention|error)$/),
      versions: { plugin: DSH_MOBILE_VERSION, minimumAndroidApp: MINIMUM_ANDROID_APP_VERSION },
      checks: expect.any(Array),
      report: expect.stringContaining('DSH Mobile 诊断报告'),
    })
  })

  it('requires confirmation before downloading the frpc component', async () => {
    const mounted = await mount()
    const refused = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/component/install', '{}')
    expect(refused.status).toBe(400)
    expect(JSON.parse(refused.body)).toEqual({ error: 'bad_request' })
  })

  it('follows the active WebServer port when no setup upstream is configured', async () => {
    const mounted = await mount(false, 43120)
    expect(mounted.upstreamBase).toBe('http://127.0.0.1:43120')
  })

  it('reports a live third-party remote boot conflict through the desktop diagnostic route', async () => {
    const mounted = await mount(false, 3080, {}, undefined, [
      { kind: 'script', text: '(function(){w["__DSH_REMOTE_CHANNEL_BOOT__"]=seat})();' },
    ])
    const response = await invoke(mounted.route, 'GET', '/api/mobile-access/diagnostics')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      checks: expect.arrayContaining([expect.objectContaining({ reason: 'competing-remote-channel', status: 'warning' })]),
    })
  })

  it('allows a private LAN Host on the loopback desktop admin route', async () => {
    const mounted = await mount()
    const allowed = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', '192.168.50.23')
    expect(allowed.status).toBe(200)
    expect(JSON.parse(allowed.body)).toMatchObject({ running: false })
  })

  it('requires an authenticated Host session for official Desktop Origin-less writes', async () => {
    const requestRejection = vi.fn((request: IncomingMessage) => request.headers.cookie === 'dsh-session=valid' ? undefined : 401)
    const mounted = await mount(false, 3080, {}, requestRejection)
    const path = '/api/mobile-access/remote/provider'
    const body = JSON.stringify({ provider: 'cloudflared' })
    const desktopHeaders = { [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER, cookie: 'dsh-session=valid' }

    const unmarked = await invoke(mounted.route, 'POST', path, body, '127.0.0.1', { cookie: 'dsh-session=valid' })
    expect(unmarked.status).toBe(403)
    const unauthenticated = await invoke(mounted.route, 'POST', path, body, '127.0.0.1', { [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER })
    expect(unauthenticated.status).toBe(403)
    const browserMetadata = await invoke(mounted.route, 'POST', path, body, '127.0.0.1', { ...desktopHeaders, 'sec-fetch-site': 'same-origin' })
    expect(browserMetadata.status).toBe(403)
    const allowed = await invoke(mounted.route, 'POST', path, body, '127.0.0.1', desktopHeaders)
    expect(allowed.status).toBe(200)
    expect(JSON.parse(allowed.body)).toMatchObject({ provider: 'cloudflared' })
    expect(requestRejection).toHaveBeenCalledTimes(2)
  })

  it.each([
    '/api/mobile-access/lan/pairing/open',
    '/api/mobile-access/pairing/open',
  ])('keeps authenticated official Desktop writes trusted through %s', async path => {
    const requestRejection = vi.fn((request: IncomingMessage) => request.headers.cookie === 'dsh-session=valid' ? undefined : 401)
    const mounted = await mount(true, 3080, {}, requestRejection)
    const invalidBody = JSON.stringify({ ttlMs: 'not a duration' })
    const marker = { [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER }

    const unmarked = await invoke(mounted.route, 'POST', path, invalidBody, '127.0.0.1', { cookie: 'dsh-session=valid' })
    expect(unmarked.status).toBe(403)
    const unauthenticated = await invoke(mounted.route, 'POST', path, invalidBody, '127.0.0.1', { ...marker, cookie: 'dsh-session=invalid' })
    expect(unauthenticated.status).toBe(403)
    const allowed = await invoke(mounted.route, 'POST', path, invalidBody, '127.0.0.1', { ...marker, cookie: 'dsh-session=valid' })
    expect(allowed.status).toBe(400)
    expect(JSON.parse(allowed.body)).toEqual({ error: 'bad_request' })
  })

  it('rejects DNS-rebinding and public Host values on the desktop admin route', async () => {
    const mounted = await mount()
    const rebound = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', 'evil.example')
    expect(rebound.status).toBe(403)
    expect(JSON.parse(rebound.body)).toEqual({ error: 'forbidden' })
    const publicHost = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', '8.8.8.8')
    expect(publicHost.status).toBe(403)
    const cgnat = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', '100.64.1.8')
    expect(cgnat.status).toBe(403)
  })

  it('does not present the loopback fallback as LAN access when managed setup is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-unconfigured-plugin-'))
    temporaryDirectories.push(directory)
    const mounted = await mount(false, 3080, { setupFile: join(directory, 'missing-setup.json') })

    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toMatchObject({ configured: false, restartRequired: false, running: false })
    expect(status.body).not.toContain('127.0.0.1:3443')

    const setup = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/setup')
    expect(setup.status).toBe(200)
    expect(JSON.parse(setup.body)).toMatchObject({ configured: false, listenPort: 3443, networks: expect.any(Array) })

    const started = await invoke(mounted.route, 'POST', '/api/mobile-access/lan/control', JSON.stringify({ running: true }))
    expect(started.status).toBe(409)
    expect(JSON.parse(started.body)).toEqual({ error: 'lan_setup_required' })
  })

  it('follows the active WebServer port instead of a managed setup snapshot', async () => {
    const setupFile = await managedSetupFile('http://127.0.0.1:3080')
    const mounted = await mount(false, 43120, { setupFile })
    expect(mounted.upstreamBase).toBe('http://127.0.0.1:43120')
  })

  it('ignores a legacy setup upstream snapshot when DSH selects another port', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-legacy-plugin-'))
    temporaryDirectories.push(directory)
    const setupFile = join(directory, 'setup.json')
    await writeFile(setupFile, JSON.stringify({ version: 1, upstreamOrigin: 'http://127.0.0.1:3080' }))
    const mounted = await mount(false, 43120, { setupFile })
    expect(mounted.upstreamBase).toBe('http://127.0.0.1:43120')
  })

  it('starts and stops the gateway through the local control route', async () => {
    const mounted = await mount()
    const started = await invoke(mounted.route, 'POST', '/api/mobile-access/control', JSON.stringify({ running: true }))
    expect(started.status).toBe(200)
    expect(JSON.parse(started.body)).toMatchObject({ running: true })
    const stopped = await invoke(mounted.route, 'POST', '/api/mobile-access/control', JSON.stringify({ running: false }))
    expect(stopped.status).toBe(200)
    expect(JSON.parse(stopped.body)).toEqual({ running: false })
  })

  it('registers a /mobile command that steers the agent with the customization guide', async () => {
    const mounted = await mount()
    expect(mounted.command).toMatchObject({
      name: 'mobile',
      description: '定制手机端或电脑端界面，或添加电脑能力',
      input: { hint: expect.any(String) },
    })
    const steered: { text: string; source: unknown }[] = []
    const agent = {
      steer: (message: { content: readonly { readonly text?: string }[]; source: unknown }) => {
        steered.push({ text: message.content[0]?.text ?? '', source: message.source })
      },
      whenIdle: async (): Promise<void> => undefined,
    }
    const invokeCommand = (rawInput: string) => mounted.command.handler({
      agent,
      commandId: 'id' as never,
      signal: new AbortController().signal,
      rawInput,
    } as never)
    const empty = await invokeCommand('  ')
    expect(empty).toMatchObject({ kind: 'error' })
    expect(steered).toEqual([])
    const result = await invokeCommand(' 把手机端改成深色主题')
    expect(result).toMatchObject({ kind: 'success' })
    expect(steered.length).toBe(1)
    const [steeredMessage] = steered
    expect(steeredMessage).toBeDefined()
    expect(steeredMessage!.text).toContain('mobile-access')
    expect(steeredMessage!.text).toContain('把手机端改成深色主题')
    // The guide rides as a plugin-source context injection, not a user bubble.
    expect(steeredMessage!.source).toMatchObject({
      kind: 'plugin:dsh-mobile',
      form: 'notice',
      summary: '/mobile 把手机端改成深色主题',
    })
  })
})

describe('remote provider selection routes', () => {
  it('switches remote providers without changing the LAN runtime', async () => {
    const mounted = await mount()
    const selected = await invoke(
      mounted.route,
      'POST',
      '/api/mobile-access/remote/provider',
      JSON.stringify({ provider: 'sakurafrp' }),
    )
    expect(selected.status).toBe(200)
    expect(JSON.parse(selected.body)).toMatchObject({ provider: 'sakurafrp', running: false, state: 'off' })
    const lan = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(JSON.parse(lan.body)).toEqual({ running: false })
  })

  it.each(['tailscale', 'cpolar', 'frp', 'origin'])('rejects removed provider selections with bad_request: %s', async provider => {
    const mounted = await mount()
    const rejected = await invoke(
      mounted.route,
      'POST',
      '/api/mobile-access/remote/provider',
      JSON.stringify({ provider }),
    )
    expect(rejected.status).toBe(400)
    expect(JSON.parse(rejected.body)).toEqual({ error: 'bad_request' })
  })

  it('does not create control files for remote providers that were never enabled', async () => {
    const mounted = await mount()
    for (const provider of ['cloudflared', 'sakurafrp']) {
      await expect(lstat(join(mounted.directory, 'remote', provider, 'control.json')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it.each([
    { kind: 'enabled', contents: '{"version":1,"enabled":true}' },
    { kind: 'malformed', contents: 'invalid JSON' },
    { kind: 'oversized', contents: 'x'.repeat(4097) },
  ])('disables an existing $kind nonselected provider before initialization', async ({ contents }) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-stale-remote-'))
    temporaryDirectories.push(directory)
    // SakuraFrp is the default selected provider, so the nonselected legacy
    // surface these cases guard is cloudflared.
    const file = join(directory, 'remote', 'cloudflared', 'control.json')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents)
    const mounted = await mount(false, 3080, { stateFile: join(directory, 'devices.json') })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, enabled: false })
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(JSON.parse(status.body)).toMatchObject({ provider: 'sakurafrp', providers: { cloudflared: { running: false, state: 'off' } } })
  })
})

describe('SakuraFrp remote channel routes', () => {
  const token = 'sk-access-token-01'

  it('stores the access token without ever returning it', async () => {
    const mounted = await mount()
    const saved = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/token', JSON.stringify({ token }))
    expect(saved.status).toBe(200)
    expect(saved.body).not.toContain(token)
    const configuration = (JSON.parse(saved.body) as {
      providers: { sakurafrp: { configuration: Record<string, unknown> } }
    }).providers.sakurafrp.configuration
    expect(configuration).toMatchObject({ tokenSet: true })
    // No tunnel has been selected yet, so the snapshot omits the field entirely.
    expect(configuration).not.toHaveProperty('tunnelId')
    const stored = JSON.parse(await readFile(
      join(mounted.directory, 'remote', 'sakurafrp', 'settings.json'), 'utf8',
    )) as { token?: string }
    expect(stored.token).toBe(token)
  })

  it.each(['short', 'has space', 42, ' padded ', 'a'.repeat(513)])('rejects an invalid access token with 400: %j', async badToken => {
    const mounted = await mount()
    const rejected = await invoke(
      mounted.route,
      'POST',
      '/api/mobile-access/remote/sakurafrp/token',
      JSON.stringify({ token: badToken }),
    )
    expect(rejected.status).toBe(400)
    expect(JSON.parse(rejected.body)).toEqual({ error: 'sakurafrp_token_invalid' })
  })

  it('stores the selected tunnel id in the control snapshot', async () => {
    const mounted = await mount()
    const saved = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/configure', JSON.stringify({ tunnelId: 7 }))
    expect(saved.status).toBe(200)
    expect(JSON.parse(saved.body)).toMatchObject({
      providers: { sakurafrp: { configuration: { tokenSet: false, tunnelId: 7 } } },
    })
  })

  it('starts the saved tunnel through "save and connect" even when the provider was disabled', async () => {
    // The button promises a connection, so configure must enable the provider:
    // a disabled controller used to stay off after saving, and the user saw
    // every click land as a no-op. The absent frpc component ends the attempt
    // here with a published state instead of a thrown route error.
    const mounted = await mount()
    await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/token', JSON.stringify({ token }))
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify([
      { id: 7, name: 'DSH Mobile', type: 'tcp', node: 12, online: true, status: 1, remote: '33080' },
    ]), { status: 200 })))
    const saved = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/configure', JSON.stringify({ tunnelId: 7 }))
    expect(saved.status).toBe(200)
    expect(JSON.parse(saved.body)).toMatchObject({
      running: true,
      state: 'unavailable',
      errorCode: 'sakurafrp_component_missing',
    })
    expect(JSON.parse(await readFile(
      join(mounted.directory, 'remote', 'sakurafrp', 'control.json'), 'utf8',
    ))).toEqual({ version: 1, enabled: true })
  })

  it.each([0, -1, '7', 1.5, true])('rejects an invalid tunnel id with 400 sakurafrp_tunnel_id_invalid: %j', async badTunnelId => {
    const mounted = await mount()
    const rejected = await invoke(
      mounted.route,
      'POST',
      '/api/mobile-access/remote/sakurafrp/configure',
      JSON.stringify({ tunnelId: badTunnelId }),
    )
    expect(rejected.status).toBe(400)
    expect(JSON.parse(rejected.body)).toEqual({ error: 'sakurafrp_tunnel_id_invalid' })
  })

  it('reports a missing token on the tunnel listing with 409', async () => {
    const mounted = await mount()
    const refused = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/sakurafrp/tunnels')
    expect(refused.status).toBe(409)
    expect(JSON.parse(refused.body)).toEqual({ error: 'sakurafrp_token_missing' })
  })

  it('lists tunnels without exposing the access token', async () => {
    const mounted = await mount()
    await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/token', JSON.stringify({ token }))
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify([
      {
        id: 7, name: 'DSH Mobile', type: 'tcp', node: 12, online: true, status: 1,
        remote: '33080', local_ip: '127.0.0.1', local_port: 45321, locks: { edit: true },
      },
      { id: 8, name: 'UDP tunnel', type: 'udp', node: 12, online: true, status: 1, remote: '33081' },
    ]), { status: 200 })))
    const listed = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/sakurafrp/tunnels')
    expect(listed.status).toBe(200)
    expect(listed.body).not.toContain(token)
    expect(JSON.parse(listed.body)).toMatchObject({ tokenSet: true, tunnels: [
      expect.objectContaining({
        id: 7, name: 'DSH Mobile', type: 'tcp', node: 12, online: true, status: 1,
        remote: '33080', localPort: 45321, lockEdit: true,
      }),
      expect.objectContaining({ id: 8, type: 'udp' }),
    ] })
  })

  it('maps an unreachable SakuraFrp API to a 409 instead of a generic 500', async () => {
    const mounted = await mount()
    await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/token', JSON.stringify({ token }))
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    const failed = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/sakurafrp/tunnels')
    expect(failed.status).toBe(409)
    expect(JSON.parse(failed.body)).toEqual({ error: 'sakurafrp_api_unreachable' })
  })

  it('maps a rejected SakuraFrp API token to a 400 sakurafrp_token_invalid', async () => {
    const mounted = await mount()
    await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/token', JSON.stringify({ token }))
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ code: 401, msg: 'invalid token' }), { status: 401 })))
    const failed = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/sakurafrp/tunnels')
    expect(failed.status).toBe(400)
    expect(JSON.parse(failed.body)).toEqual({ error: 'sakurafrp_token_invalid' })
  })

  it('maps a frpc component launch failure to a 409 remote_component_launch_failed', async () => {
    const mounted = await mount()
    // The route handler only sees the component manager's rejection; a Windows
    // frpc launch failure surfaces as `spawn UNKNOWN` at that boundary.
    const install = vi.spyOn(FrpComponentManager.prototype, 'install')
      .mockRejectedValue(new Error('spawn UNKNOWN'))
    const failed = await invoke(
      mounted.route,
      'POST',
      '/api/mobile-access/remote/sakurafrp/component/install',
      JSON.stringify({ confirm: true }),
    )
    expect(install).toHaveBeenCalledTimes(1)
    expect(failed.status).toBe(409)
    expect(JSON.parse(failed.body)).toEqual({ error: 'remote_component_launch_failed' })
  })

  it('purges the saved SakuraFrp settings, frpc config and TLS ingress through the control route', async () => {
    const mounted = await mount()
    await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/token', JSON.stringify({ token }))
    await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/configure', JSON.stringify({ tunnelId: 7 }))
    const settingsFile = join(mounted.directory, 'remote', 'sakurafrp', 'settings.json')
    const frpcConfigFile = join(mounted.directory, 'remote', 'sakurafrp', 'frpc.toml')
    const ingressPaths = tlsIngressPaths(join(mounted.directory, 'remote', 'devices.json'))
    await mkdir(ingressPaths.directory, { recursive: true })
    await writeFile(ingressPaths.statusFile, '{"version":1,"caFingerprint":"' + 'a'.repeat(64) + '"}\n')

    const purged = await invoke(
      mounted.route,
      'POST',
      '/api/mobile-access/remote/sakurafrp/component/purge',
      JSON.stringify({ confirm: true }),
    )
    expect(purged.status).toBe(200)
    expect(JSON.parse(purged.body)).toMatchObject({ providers: { sakurafrp: { configuration: { tokenSet: false } } } })
    await expect(lstat(settingsFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(frpcConfigFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(ingressPaths.statusFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires confirmation before purging the frpc component', async () => {
    const mounted = await mount()
    const refused = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/sakurafrp/component/purge', '{}')
    expect(refused.status).toBe(400)
    expect(JSON.parse(refused.body)).toEqual({ error: 'bad_request' })
  })
})

describe('local worker recovery control routes', () => {
  it('uses authenticated exact-origin admin routes and recovers an unchanged stopped worker', async () => {
    const mounted = await mount(false, 3080, { hostExecution: { mode: 'worker', extensions: ['recoverable'], maxWorkers: 2 } })
    const extensionRoot = join(mounted.directory, 'extensions')
    const directory = join(extensionRoot, 'recoverable'); await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'recoverable', name: 'Recoverable', version: '1' }))
    await writeFile(join(directory, 'host.mjs'), 'export default api => { api.action("probe", {run: () => ({ok:true})}) }')
    await mounted.context.mobileAccess.startLocal(extensionRoot, mounted.context, { hostExecution: { mode: 'worker', extensions: ['recoverable'], maxWorkers: 2, workerModule: await buildExtensionWorkerEntry() } })
    const active = mounted.context.mobileAccess.extension('recoverable') as { readonly worker: {terminate(reason: string): Promise<void>} }
    const running = await invoke(mounted.route, 'GET', '/api/mobile-access/extensions/hosts')
    expect(running.status).toBe(200)
    expect(JSON.parse(running.body)).toMatchObject({hosts:[{id:'recoverable', mode:'worker', state:'ready'}], limits:{workers:1,maxWorkers:2}})
    expect(parseUnavailableExtensionHosts(JSON.parse(running.body))).toEqual([])
    expect(running.body).not.toContain(directory)
    const ready = await invoke(mounted.route, 'POST', '/api/mobile-access/extensions/recover', JSON.stringify({id:'recoverable',confirm:true}))
    expect(ready.status).toBe(409)
    expect(JSON.parse(ready.body)).toEqual({error:'extension_host_running'})
    await active.worker.terminate('test-offline')
    const stopped = await invoke(mounted.route, 'GET', '/api/mobile-access/extensions/hosts')
    expect(parseUnavailableExtensionHosts(JSON.parse(stopped.body))).toEqual([{ id: 'recoverable', name: 'Recoverable', generation: expect.stringMatching(/^[a-f\d]{64}$/u) }])
    const blocked = await invoke(mounted.route, 'POST', '/api/mobile-access/extensions/recover', JSON.stringify({id:'recoverable',confirm:true}), '127.0.0.1', {origin:'https://evil.example','sec-fetch-site':'cross-site'})
    expect(blocked.status).toBe(403)
    expect(mounted.context.mobileAccess.hostStatus().hosts[0]?.state).toBe('unavailable')
    const noConfirmation = await invoke(mounted.route, 'POST', '/api/mobile-access/extensions/recover', JSON.stringify({id:'recoverable'}))
    expect(noConfirmation.status).toBe(400)
    const recovered = await invoke(mounted.route, 'POST', '/api/mobile-access/extensions/recover', JSON.stringify({id:'recoverable',confirm:true}))
    expect(recovered.status).toBe(200)
    expect(JSON.parse(recovered.body)).toMatchObject({hosts:[{id:'recoverable',state:'ready'}]})
    expect(parseUnavailableExtensionHosts(JSON.parse(recovered.body))).toEqual([])
  })
})
