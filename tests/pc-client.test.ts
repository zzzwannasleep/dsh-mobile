/**
 * Independent route-level verification of the PC client change (PC-CLIENT-SPEC.md).
 *
 * This file owns no product source. It boots a real MobileAccessGateway against a
 * throwaway upstream, serves the loopback admin surface the way `src/plugin.ts`
 * registers it, and asserts the frozen route contract from the outside: status,
 * headers, bodies, ZIP contents and the pairing/replay rejection paths.
 *
 * The browser-level evidence (Playwright network capture, real HTTPS, PowerShell
 * `Expand-Archive`) lives in `scripts/smoke-pc-client.mjs`; this file is the fast
 * in-process guard that runs in `npm test`.
 */
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer as createHttpsServer, request as requestHttps } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizePairingToken } from '../src/access.js'
import { extractPairingToken } from '../src/auth-pages.js'
import { HOST_DEVICE_COOKIE } from '../src/browser-auth-cookies.js'
import { diagnosticControllerAction, MOBILE_CONTROL_MESSAGES } from '../src/client.js'
import { Config, parseGatewayConfig, type PluginConfig } from '../src/config.js'
import { MAX_ENTRY_LINKS } from '../src/entry-link.js'
import { MobileAccessService } from '../src/extensions.js'
import { MobileAccessGateway, type PcClientChannel, type PcClientSource } from '../src/gateway.js'
import { assertLocalAdminTrust, LOCAL_ADMIN_PREFIX, DEVICE_COOKIE, SESSION_COOKIE } from '../src/http-security.js'
import { apply as applyPlugin, inject as pluginInject } from '../src/plugin.js'
import {
  isSakuraFrpRegistration,
  patchSakuraFrpConfigTarget,
  probeSakuraFrpTrustedCertificate,
  SakuraFrpController,
  SakuraFrpSettingsStore,
  validateSakuraFrpBoundDomain,
  validateSakuraFrpEntryMode,
  type SakuraFrpCertificateProbe,
  type SakuraFrpTunnel,
} from '../src/sakurafrp.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { createTestTlsChain } from './tls-fixtures.js'

const PC_ENTRY_PATH = '/mobile-access/pc'
const PC_ENTRY_SCRIPT_PATH = '/mobile-access/pc.js'
const PAIR_PATH = '/mobile-access/pair'
const MANIFEST_PATH = '/mobile-access/manifest.webmanifest'
const SERVICE_WORKER_PATH = '/mobile-access/pc-sw.js'
const PC_INFO_PATH = `${LOCAL_ADMIN_PREFIX}/pc/info`
const PC_PACKAGE_PATH = `${LOCAL_ADMIN_PREFIX}/pc/package`
const PAIRING_OPEN_PATH = `${LOCAL_ADMIN_PREFIX}/lan/pairing/open`
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface HttpResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  readonly rawBody: Buffer
}

interface PcFixture {
  readonly gateway: MobileAccessGateway
  readonly origin: string
  readonly port: number
  readonly adminPort: number
  readonly directory: string
  readonly desktopCssFile: string
  readonly desktopScriptFile: string
  readonly pcOrigin: string
  /** True when the external listener terminates TLS, which is what issues `__Host-` cookies. */
  readonly tls: boolean
}

interface PcFixtureOptions {
  readonly channels?: readonly PcClientChannel[]
  readonly certificate?: { readonly name: string; readonly body: Buffer }
  /** Pairing attempts allowed per loopback source; raised for the multi-form tests. */
  readonly maxPairingAttempts?: number
  /** Device cap, lowered to prove the durable link still respects it. */
  readonly maxDevices?: number
  /** Terminate TLS with a throwaway leaf, which is what makes the `__Host-` cookies apply. */
  readonly tls?: boolean
}

interface OpenedPairing {
  readonly token: string
  readonly appKey: string
  readonly pairUrl: string
  readonly expiresAt: number
}

interface ZipEntryRead {
  readonly name: string
  readonly body: Buffer
  readonly crc: number
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>(resolve => { server.close(() => resolve()) })
}

async function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; tls?: boolean } = {},
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const body = options.body
    const headers = { ...options.headers }
    if (body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const target = { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false }
    // The TLS-facing fixture uses a throwaway leaf, so the client skips verification.
    const outgoing = options.tls === true
      ? requestHttps({ ...target, rejectUnauthorized: false }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
        response.once('error', reject)
        response.once('end', () => {
          const rawBody = Buffer.concat(chunks)
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: rawBody.toString('utf8'), rawBody })
        })
      })
      : requestHttp(target, (response) => {
        const chunks: Buffer[] = []
        response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
        response.once('error', reject)
        response.once('end', () => {
          const rawBody = Buffer.concat(chunks)
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: rawBody.toString('utf8'), rawBody })
        })
      })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

function cookiesByName(headers: IncomingHttpHeaders): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of headers['set-cookie'] ?? []) {
    const pair = line.split(';', 1)[0]
    if (pair === undefined) continue
    const equals = pair.indexOf('=')
    if (equals > 0) result.set(pair.slice(0, equals), pair.slice(equals + 1))
  }
  return result
}

function crc32(body: Buffer): number {
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Parse a STORE-only ZIP from its central directory without using product code. */
function readStoredZip(archive: Buffer): readonly ZipEntryRead[] {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end, 'ZIP end-of-central-directory record').toBeGreaterThanOrEqual(0)
  const total = archive.readUInt16LE(end + 10)
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryOffset = archive.readUInt32LE(end + 16)
  expect(directoryOffset + directorySize).toBe(end)
  const entries: ZipEntryRead[] = []
  let cursor = directoryOffset
  for (let index = 0; index < total; index++) {
    expect(archive.readUInt32LE(cursor), `central directory header ${String(index)}`).toBe(0x02014b50)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    expect(archive.readUInt32LE(localOffset), `local header for ${name}`).toBe(0x04034b50)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const body = archive.subarray(start, start + compressedSize)
    expect(method, `${name} method`).toBe(0)
    expect(uncompressedSize, `${name} stored size`).toBe(compressedSize)
    expect(crc32(body), `${name} CRC-32`).toBe(crc)
    entries.push({ name, body, crc })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  expect(cursor).toBe(end)
  return entries
}

function pngSize(body: Buffer): { readonly width: number; readonly height: number } {
  expect(body.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature').toBe(true)
  expect(body.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) }
}

function baseGatewayOptions(directory: string, upstreamPort: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(directory, 'devices.json'),
    tls: { mode: 'disabled' },
    ...extra,
  }
}

async function createFixture(options: PcFixtureOptions = {}): Promise<PcFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-pc-client-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}\n')
  })
  const upstreamPort = await listen(upstream)
  cleanups.push(() => closeServer(upstream))
  const context = new Context()
  cleanups.push(async () => { context.fiber.dispose() })
  const desktopCssFile = join(directory, 'desktop.css')
  const desktopScriptFile = join(directory, 'desktop.js')
  await writeFile(desktopCssFile, ':root { --pc-layer-fixture: first; }\n', 'utf8')
  await writeFile(desktopScriptFile, 'window.dshMobile?.registerDesktop?.(() => undefined)\n', 'utf8')
  // A TLS-facing fixture issues the `__Host-` cookies; the client-only fixture stays
  // plain HTTP, which is the documented local-network shape.
  let tlsFiles: { readonly certFile: string; readonly keyFile: string } | undefined
  if (options.tls === true) {
    const { leafCert, leafKey } = createTestTlsChain()
    const certFile = join(directory, 'fixture-cert.pem')
    const keyFile = join(directory, 'fixture-key.pem')
    await writeFile(certFile, leafCert, 'utf8')
    await writeFile(keyFile, leafKey, { mode: 0o600 })
    tlsFiles = { certFile, keyFile }
  }
  const gateway = new MobileAccessGateway(parseGatewayConfig(baseGatewayOptions(directory, upstreamPort, {
    // The pairing-form tests open many windows from one loopback address.
    maxPairingAttempts: options.maxPairingAttempts ?? 50,
    ...(options.maxDevices === undefined ? {} : { maxDevices: options.maxDevices }),
    ...(tlsFiles === undefined ? {} : { tls: { mode: 'provided', certFile: tlsFiles.certFile, keyFile: tlsFiles.keyFile } }),
  })), new MemoryDeviceStore(), new MobileAccessService(context))
  await gateway.start()
  cleanups.push(() => gateway.close())
  // Mirror src/plugin.ts: the LAN control prefix, the PC prefix and the bare
  // admin prefix are registered separately, and the longest matching prefix owns
  // the request. The PC route receives the plugin's runtime channel source.
  const pcOrigin = options.channels?.[0]?.origin ?? 'https://192.0.2.10:3443'
  const pcClient: PcClientSource = {
    channels: async () => options.channels ?? [{ channel: 'lan', origin: pcOrigin }],
    certificate: async () => options.certificate,
  }
  const routes = [
    { prefix: `${LOCAL_ADMIN_PREFIX}/lan`, handler: gateway.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/lan`).handler },
    { prefix: `${LOCAL_ADMIN_PREFIX}/pc`, handler: gateway.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/pc`, () => true, pcClient).handler },
    { prefix: LOCAL_ADMIN_PREFIX, handler: gateway.localAdminRoute(LOCAL_ADMIN_PREFIX).handler },
  ]
  const admin = createServer((incoming, response) => {
    const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find(candidate => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`))
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not_found"}')
      return
    }
    Promise.resolve(route.handler(incoming, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{"error":"handler_failed"}')
    })
  })
  const adminPort = await listen(admin)
  cleanups.push(() => closeServer(admin))
  const address = gateway.address()
  return {
    gateway,
    origin: address.origin,
    port: address.port,
    adminPort,
    directory,
    desktopCssFile,
    desktopScriptFile,
    pcOrigin,
    tls: tlsFiles !== undefined,
  }
}

interface ChannelFixture {
  readonly adminPort: number
  readonly lan: { readonly gateway: MobileAccessGateway; readonly origin: string; readonly port: number }
  readonly remote: { readonly gateway: MobileAccessGateway; readonly origin: string; readonly port: number }
}

/**
 * Two gateways with their own state directories, mounted the way `src/plugin.ts`
 * mounts them: `/lan` for the local-network gateway and `/remote` for the public
 * one, plus the shared `/pc` prefix answered by the LAN gateway. This is the shape
 * the panel talks to, so the per-channel link answer can be checked for real.
 */
async function createChannelFixture(): Promise<ChannelFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-pc-channels-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}\n')
  })
  const upstreamPort = await listen(upstream)
  cleanups.push(() => closeServer(upstream))
  const build = async (name: 'lan' | 'remote'): Promise<ChannelFixture['lan']> => {
    const stateDirectory = join(directory, name)
    await mkdir(stateDirectory, { recursive: true })
    const context = new Context()
    cleanups.push(async () => { context.fiber.dispose() })
    const gateway = new MobileAccessGateway(parseGatewayConfig(baseGatewayOptions(stateDirectory, upstreamPort, {
      maxPairingAttempts: 50,
    })), new MemoryDeviceStore(), new MobileAccessService(context))
    await gateway.start()
    cleanups.push(() => gateway.close())
    return { gateway, origin: gateway.address().origin, port: gateway.address().port }
  }
  const lan = await build('lan')
  const remote = await build('remote')
  const pcClient: PcClientSource = {
    channels: async () => [
      { channel: 'lan', origin: lan.origin },
      { channel: 'remote', origin: remote.origin },
    ],
    certificate: async () => undefined,
  }
  const routes = [
    { prefix: `${LOCAL_ADMIN_PREFIX}/lan`, handler: lan.gateway.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/lan`, () => true).handler },
    { prefix: `${LOCAL_ADMIN_PREFIX}/remote`, handler: remote.gateway.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/remote`, () => true).handler },
    { prefix: `${LOCAL_ADMIN_PREFIX}/pc`, handler: lan.gateway.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/pc`, () => true, pcClient).handler },
    { prefix: LOCAL_ADMIN_PREFIX, handler: lan.gateway.localAdminRoute(LOCAL_ADMIN_PREFIX, () => true).handler },
  ]
  const admin = createServer((incoming, response) => {
    const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find(candidate => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`))
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not_found"}')
      return
    }
    Promise.resolve(route.handler(incoming, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{"error":"handler_failed"}')
    })
  })
  const adminPort = await listen(admin)
  cleanups.push(() => closeServer(admin))
  return { adminPort, lan, remote }
}

/** A frpc config with a plugin target, so the trusted mode has something to rewrite. */
const PATCHABLE_CONFIG = '[common]\nserver_addr = frp.example.com\n\n[proxy]\nplugin_local_addr = 127.0.0.1:3443\n'

interface SakuraControllerFixture {
  readonly controller: SakuraFrpController
  readonly plainGateway: ReturnType<typeof vi.fn>
  readonly trustedGateway: ReturnType<typeof vi.fn>
  readonly probe: ReturnType<typeof vi.fn>
  readonly editTarget: ReturnType<typeof vi.fn>
}

/**
 * A SakuraFrp controller with a fake natfrp API and a fake frpc process, so the
 * start-up decisions (entry mode, origin, config rewrite, certificate probe) can be
 * observed without an account, a tunnel or a network.
 */
async function createSakuraController(settings: SakuraFrpSettingsStore, options: {
  readonly remote: string
  readonly config: string
  readonly probe: () => Promise<SakuraFrpCertificateProbe>
}): Promise<SakuraControllerFixture> {
  const executable = join(settings.stateRoot, 'frpc.exe')
  await writeFile(executable, 'fake-frpc', 'utf8')
  const gateway = { close: async () => undefined }
  const plainGateway = vi.fn(async () => gateway)
  const trustedGateway = vi.fn(async () => gateway)
  const probe = vi.fn(options.probe)
  const editTarget = vi.fn(async () => undefined)
  const api = {
    listTunnels: async (): Promise<readonly SakuraFrpTunnel[]> => [{
      id: 9,
      name: 'dsh',
      type: 'tcp',
      node: 5,
      online: true,
      status: 1,
      remote: options.remote,
    }],
    listNodes: async () => ({ '5': 'node-5.example.com' }),
    editTunnelTarget: editTarget,
    fetchTunnelConfig: async () => options.config,
  }
  const controller = new SakuraFrpController({
    store: {
      load: async () => ({ version: 1 as const, enabled: false }),
      save: async () => undefined,
    },
    settings,
    component: { executable },
    createGateway: plainGateway as unknown as (origin: string, port: number) => Promise<MobileAccessGateway>,
    createTrustedGateway: trustedGateway as unknown as (origin: string, port: number) => Promise<MobileAccessGateway>,
    probeCertificate: probe,
    api,
    maxStartupRounds: 1,
    startupTimeoutMs: 4_000,
    spawnProcess: (): ChildProcessWithoutNullStreams => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams
      const stdout = new EventEmitter() as ChildProcessWithoutNullStreams['stdout']
      const stderr = new EventEmitter() as ChildProcessWithoutNullStreams['stderr']
      stdout.setEncoding = vi.fn() as unknown as ChildProcessWithoutNullStreams['stdout']['setEncoding']
      stderr.setEncoding = vi.fn() as unknown as ChildProcessWithoutNullStreams['stderr']['setEncoding']
      child.stdout = stdout
      child.stderr = stderr
      Object.assign(child, { exitCode: null, kill: () => true })
      // frpc reports a successful registration on stdout; that line is what makes
      // the controller confirm readiness.
      setTimeout(() => { stdout.emit('data', 'start proxy success\n') }, 20)
      return child
    },
  })
  cleanups.push(() => controller.close())
  return { controller, plainGateway, trustedGateway, probe, editTarget }
}

interface MountedPlugin {
  readonly route: WebRoute
  readonly directory: string
}

/** Boot the real plugin once and keep its admin route, as `tests/plugin.test.ts` does. */
async function mountPlugin(): Promise<MountedPlugin> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-pc-plugin-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  let route: WebRoute | undefined
  const context = new Context()
  cleanups.push(async () => { context.fiber.dispose() })
  context.provide('webServer', {
    port: 3080,
    collectIndexInjections: () => [],
    register(candidate: WebRoute) {
      route = candidate
      return () => { if (route === candidate) route = undefined }
    },
  } as never)
  context.provide('commands', { register() { return () => undefined } } as never)
  context.provide('connection', {
    authenticatedUrl: (baseUrl: string) => `${baseUrl}/?token=test-launch-token`,
    requestRejection: () => 401,
  } as never)
  await context.plugin({ Config, inject: pluginInject, apply: applyPlugin }, {
    listenPort: 0,
    stateFile: join(directory, 'devices.json'),
    controlFile: join(directory, 'control.json'),
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
    initiallyEnabled: false,
    tls: { mode: 'disabled' },
  } satisfies Partial<PluginConfig>)
  if (route === undefined) throw new Error('the plugin did not register its admin route')
  return { route, directory }
}

/** One request through the plugin's real admin route on a throwaway listener. */
async function invokeRoute(mounted: MountedPlugin, method: 'GET' | 'POST', path: string, body = ''): Promise<{ status: number; body: string }> {
  const server = createServer((incoming, response) => { void mounted.route.handler(incoming, response) })
  const port = await listen(server)
  try {
    const result = await request(port, path, {
      method,
      headers: {
        host: `127.0.0.1:${String(port)}`,
        ...(method === 'POST'
          ? { origin: `http://127.0.0.1:${String(port)}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
          : {}),
      },
      ...(body === '' ? {} : { body }),
    })
    return { status: result.status, body: result.body }
  } finally {
    await closeServer(server)
  }
}

function adminHeaders(target: { readonly adminPort: number }, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${String(target.adminPort)}`,
    origin: `http://127.0.0.1:${String(target.adminPort)}`,
    'sec-fetch-site': 'same-origin',
    ...extra,
  }
}

/** One loopback admin request, as the DSH desktop panel sends it. */
function adminPost(target: { readonly adminPort: number }, path: string, body = '{}'): Promise<HttpResult> {
  return request(target.adminPort, path, {
    method: 'POST',
    headers: adminHeaders(target, { 'content-type': 'application/json' }),
    body,
  })
}

function adminGet(target: { readonly adminPort: number }, path: string): Promise<HttpResult> {
  return request(target.adminPort, path, { headers: adminHeaders(target) })
}

async function openPairing(fixture: PcFixture): Promise<OpenedPairing> {
  const result = await request(fixture.adminPort, PAIRING_OPEN_PATH, {
    method: 'POST',
    headers: adminHeaders(fixture, { 'content-type': 'application/json' }),
    body: '{}',
  })
  expect(result.status, `pairing open body: ${result.body}`).toBe(201)
  return JSON.parse(result.body) as OpenedPairing
}

/** Open a window with an explicit requested TTL, for the configured-ceiling probe. */
async function openPairingWithTtl(fixture: PcFixture, ttlMs: number): Promise<HttpResult> {
  return request(fixture.adminPort, PAIRING_OPEN_PATH, {
    method: 'POST',
    headers: adminHeaders(fixture, { 'content-type': 'application/json' }),
    body: JSON.stringify({ ttlMs }),
  })
}

/** The instance id inside `dsh<N>.<instance>.<token>`. */
function appKeyInstance(appKey: string): string {
  return appKey.split('.')[1] ?? ''
}

/** The secret inside `dsh<N>.<instance>.<token>`. */
function appKeySecret(appKey: string): string {
  return appKey.split('.').slice(2).join('.')
}

async function pairBrowser(
  fixture: { readonly port: number; readonly origin: string; readonly tls?: boolean },
  token: string,
  extra: Record<string, string> = {},
): Promise<HttpResult> {
  return request(fixture.port, '/mobile-access/auth/pair', {
    tls: fixture.tls === true,
    method: 'POST',
    headers: {
      host: new URL(fixture.origin).host,
      origin: fixture.origin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...extra,
    },
    body: JSON.stringify({ token, label: 'PC client fixture' }),
  })
}

async function downloadPackage(fixture: PcFixture, query = '', extra: Record<string, string> = {}): Promise<HttpResult> {
  return request(fixture.adminPort, `${PC_PACKAGE_PATH}${query}`, { headers: adminHeaders(fixture, extra) })
}

describe('PC client routes', () => {
  it('serves the PC entry page and its script before the auth gate while no pairing window is open', async () => {
    const fixture = await createFixture()
    expect(fixture.gateway.access.pairingStatus().open).toBe(false)

    const page = await request(fixture.port, PC_ENTRY_PATH, {
      headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' },
    })
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.headers.vary).toBe('Accept-Language')
    expect(page.body).toContain('<html lang="zh-CN"')
    expect(page.body).toContain(PC_ENTRY_SCRIPT_PATH)
    expect(page.body).toContain(MANIFEST_PATH)
    expect(page.body).toContain(SERVICE_WORKER_PATH)
    expect(page.headers['content-security-policy']).toContain("default-src 'self'")
    // No external asset may be referenced from a gateway document.
    expect(page.body).not.toMatch(/(?:src|href)="https?:\/\//u)
    // A hostile Accept-Language must never be reflected into the document.
    const hostile = await request(fixture.port, PC_ENTRY_PATH, {
      headers: { accept: 'text/html', 'accept-language': 'en"><script>alert(1)</script>' },
    })
    expect(hostile.status).toBe(200)
    expect(hostile.body).not.toContain('alert(1)')

    for (const [language, expected] of [['zh-CN', 'zh-CN'], ['en-US', 'en'], ['it-IT', 'it-IT']] as const) {
      const localized = await request(fixture.port, PC_ENTRY_PATH, {
        headers: { accept: 'text/html', 'accept-language': language },
      })
      expect(localized.status, language).toBe(200)
      expect(localized.body, language).toContain(`<html lang="${expected}"`)
      const script = await request(fixture.port, PC_ENTRY_SCRIPT_PATH, {
        headers: { accept: 'text/javascript', 'accept-language': language },
      })
      expect(script.status, language).toBe(200)
      expect(script.headers['content-type'], language).toBe('text/javascript; charset=utf-8')
      expect(script.body, language).toContain('/mobile-access/auth/pair')
      // The closed pairing window (HTTP 403/404) has its own message path.
      expect(script.body, language).toContain('403')
      expect(script.body, language).toContain('404')
      expect(script.body, language).not.toContain('alert(1)')
    }

    // /mobile-access/pair keeps its open-window condition and URL.
    const closedPair = await request(fixture.port, PAIR_PATH, { headers: { accept: 'text/html' } })
    expect(closedPair.status).toBe(404)
    await fixture.gateway.access.openPairing()
    const openPair = await request(fixture.port, PAIR_PATH, { headers: { accept: 'text/html' } })
    expect(openPair.status).toBe(200)
    expect(openPair.body).not.toBe(page.body)
  })

  it('serves a valid manifest and real PNG icons with their declared sizes', async () => {
    const fixture = await createFixture()
    const manifest = await request(fixture.port, MANIFEST_PATH)
    expect(manifest.status).toBe(200)
    expect(String(manifest.headers['content-type'])).toMatch(/^application\/manifest\+json(?:; charset=utf-8)?$/u)
    const parsed = JSON.parse(manifest.body) as {
      name?: string
      short_name?: string
      start_url?: string
      scope?: string
      display?: string
      background_color?: string
      theme_color?: string
      icons?: ReadonlyArray<{ src?: string; sizes?: string; type?: string; purpose?: string }>
    }
    expect(parsed.name).toBe('DSH Mobile')
    expect(parsed.short_name).toBe('DSH')
    expect(parsed.start_url).toBe('/')
    expect(parsed.scope).toBe('/')
    expect(parsed.display).toBe('standalone')
    expect(typeof parsed.background_color).toBe('string')
    expect(typeof parsed.theme_color).toBe('string')
    expect(manifest.body).not.toMatch(/https?:\/\//u)
    const icons = parsed.icons ?? []
    expect(icons.map(icon => `${String(icon.sizes)}:${String(icon.purpose)}`).sort())
      .toEqual(['192x192:any', '512x512:any', '512x512:maskable'])
    for (const icon of icons) {
      expect(icon.type, String(icon.src)).toBe('image/png')
      expect(icon.src?.startsWith('/'), String(icon.src)).toBe(true)
      const response = await request(fixture.port, String(icon.src))
      expect(response.status, String(icon.src)).toBe(200)
      expect(response.headers['content-type'], String(icon.src)).toBe('image/png')
      const [width, height] = String(icon.sizes).split('x').map(Number)
      expect(pngSize(response.rawBody), String(icon.src)).toEqual({ width, height })
      expect(response.rawBody.byteLength, `${String(icon.src)} size`).toBeLessThan(200 * 1024)
    }
    const repeated = await request(fixture.port, MANIFEST_PATH)
    expect(repeated.rawBody.equals(manifest.rawBody)).toBe(true)
  })

  it('serves the pass-through service worker with root scope and valid JavaScript', async () => {
    const fixture = await createFixture()
    const response = await request(fixture.port, SERVICE_WORKER_PATH)
    expect(response.status).toBe(200)
    expect(String(response.headers['content-type'])).toMatch(/^text\/javascript(?:; charset=utf-8)?$/u)
    expect(response.headers['service-worker-allowed']).toBe('/')
    expect(response.body).toContain('skipWaiting')
    expect(response.body).toContain('claim')
    // The service worker must never answer a fetch itself: DSH's own caches stay
    // authoritative and authenticated responses must not be cached by this layer.
    expect(response.body).not.toMatch(/respondWith\s*\(/u)
    const scriptFile = join(fixture.directory, 'pc-sw-check.js')
    await writeFile(scriptFile, response.body, 'utf8')
    const checked = spawnSync(process.execPath, ['--check', scriptFile], { encoding: 'utf8' })
    expect(checked.status, `node --check stderr: ${checked.stderr}`).toBe(0)
  })

  it('serves the desktop customization layer with the custom.css validator contract', async () => {
    const fixture = await createFixture()
    const opened = await openPairing(fixture)
    const paired = await pairBrowser(fixture, opened.token)
    expect(paired.status).toBe(201)
    const session = cookiesByName(paired.headers).get(SESSION_COOKIE) ?? ''
    const headers = {
      host: new URL(fixture.origin).host,
      'sec-fetch-site': 'same-origin',
      cookie: `${SESSION_COOKIE}=${session}`,
    }
    // The PC layer stays behind the authentication gate like custom.css.
    const anonymous = await request(fixture.port, '/mobile-access/desktop.css')
    expect(anonymous.status).toBe(401)
    const first = await request(fixture.port, '/mobile-access/desktop.css', { headers })
    expect(first.status).toBe(200)
    expect(first.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.headers.etag).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.headers['last-modified']).toBeDefined()
    expect(first.body).toContain('--pc-layer-fixture: first')
    const cached = await request(fixture.port, '/mobile-access/desktop.css', {
      headers: { ...headers, 'if-none-match': String(first.headers.etag) },
    })
    expect(cached.status).toBe(304)
    expect(cached.body).toBe('')
    await writeFile(fixture.desktopCssFile, ':root { --pc-layer-fixture: second; }\n', 'utf8')
    const updated = await request(fixture.port, '/mobile-access/desktop.css', { headers })
    expect(updated.status).toBe(200)
    expect(updated.body).toContain('--pc-layer-fixture: second')
    expect(updated.headers.etag).not.toBe(first.headers.etag)

    const script = await request(fixture.port, '/mobile-access/desktop.js', { headers })
    expect(script.status).toBe(200)
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(script.headers['cache-control']).toBe('no-store')
    expect(script.body).toContain('registerDesktop')

    await rm(fixture.desktopCssFile, { force: true })
    const fallback = await request(fixture.port, '/mobile-access/desktop.css', { headers })
    expect(fallback.status).toBe(200)
    expect(fallback.body).toContain('desktop.css')
  })

  it('reports the PC channels and package route only through the loopback admin surface', async () => {
    const fixture = await createFixture()
    const info = await request(fixture.adminPort, PC_INFO_PATH, { headers: adminHeaders(fixture) })
    expect(info.status, `info body: ${info.body}`).toBe(200)
    const parsed = JSON.parse(info.body) as {
      entryPath?: string
      packagePath?: string
      certificate?: { available?: boolean; url?: string }
      channels?: ReadonlyArray<{ channel?: string; origin?: string; entryUrl?: string }>
    }
    expect(parsed.entryPath).toBe(PC_ENTRY_PATH)
    expect(parsed.packagePath).toBe(PC_PACKAGE_PATH)
    expect(parsed.certificate?.available).toBe(false)
    expect(String(parsed.certificate?.url).endsWith('/mobile-access/ca.cer')).toBe(true)
    const channels = parsed.channels ?? []
    expect(channels.length).toBe(1)
    expect(channels[0]).toEqual({ channel: 'lan', origin: fixture.pcOrigin, entryUrl: `${fixture.pcOrigin}${PC_ENTRY_PATH}` })

    // The external listener refuses the whole loopback admin prefix.
    const external = await request(fixture.port, PC_INFO_PATH)
    expect(external.status).toBe(404)
    const externalPackage = await request(fixture.port, PC_PACKAGE_PATH)
    expect(externalPackage.status).toBe(404)
    // DNS-rebinding and cross-site callers stay refused.
    const rebound = await request(fixture.adminPort, PC_INFO_PATH, {
      headers: adminHeaders(fixture, { host: 'attacker.example' }),
    })
    expect(rebound.status).toBe(403)
    const crossSite = await request(fixture.adminPort, PC_INFO_PATH, {
      headers: adminHeaders(fixture, { 'sec-fetch-site': 'cross-site' }),
    })
    expect(crossSite.status).toBe(403)
    const foreignOrigin = await request(fixture.adminPort, PC_INFO_PATH, {
      headers: adminHeaders(fixture, { origin: 'https://attacker.example' }),
    })
    expect(foreignOrigin.status).toBe(403)
    const mutation = await request(fixture.adminPort, PC_PACKAGE_PATH, {
      method: 'POST',
      headers: adminHeaders(fixture, { 'content-type': 'application/json' }),
      body: '{}',
    })
    expect(mutation.status).toBeGreaterThanOrEqual(400)
    expect(mutation.status).toBeLessThan(500)
  })

  it('packages the PC client without secrets, with ASCII CRLF launchers and a clean inventory', async () => {
    const fixture = await createFixture()
    const opened = await openPairing(fixture)
    const paired = await pairBrowser(fixture, opened.token)
    expect(paired.status).toBe(201)
    const deviceToken = cookiesByName(paired.headers).get(DEVICE_COOKIE) ?? ''
    const sessionToken = cookiesByName(paired.headers).get(SESSION_COOKIE) ?? ''
    expect(deviceToken).not.toBe('')
    expect(sessionToken).not.toBe('')

    const response = await downloadPackage(fixture, '?channel=lan')
    expect(response.status, `package body: ${response.body.slice(0, 200)}`).toBe(200)
    expect(response.headers['content-type']).toBe('application/zip')
    expect(response.headers['content-disposition']).toBe('attachment; filename="dsh-mobile-pc.zip"')
    const entries = readStoredZip(response.rawBody)
    const names = entries.map(entry => entry.name)
    expect(names.filter(name => name.startsWith('README-'))).toHaveLength(1)
    expect(names).toContain('2-open-dsh.cmd')
    expect(names).toContain('open-dsh.url')
    expect(names.some(name => name.endsWith('.cer'))).toBe(false)
    expect(names.every(name => /^[\x20-\x7e]+$/u.test(name))).toBe(true)
    expect(names.every(name => !name.includes('/') && !name.includes('\\'))).toBe(true)

    const readme = entries.find(entry => entry.name.startsWith('README-'))
    expect(readme?.body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'README UTF-8 BOM').toBe(true)
    const launcher = entries.find(entry => entry.name === '2-open-dsh.cmd')
    const launcherText = launcher?.body.toString('ascii') ?? ''
    expect(launcherText).toMatch(/^[\x09\x0d\x0a\x20-\x7e]*$/u)
    expect(launcherText).toContain('\r\n')
    expect(launcherText.replaceAll('\r\n', '')).not.toContain('\n')
    const shortcut = entries.find(entry => entry.name === 'open-dsh.url')
    expect(shortcut?.body.toString('ascii')).toContain('[InternetShortcut]')
    expect(shortcut?.body.toString('ascii')).toContain(`${fixture.pcOrigin}${PC_ENTRY_PATH}`)

    // Nothing secret and no owner-local absolute path may travel in the package.
    const forbidden = [
      Buffer.from(opened.token), Buffer.from(opened.appKey),
      Buffer.from(deviceToken), Buffer.from(sessionToken),
      Buffer.from(fixture.directory),
    ]
    for (const entry of entries) {
      for (const needle of forbidden) {
        expect(entry.body.includes(needle), `${entry.name} leaks ${needle.toString('utf8').slice(0, 12)}`).toBe(false)
      }
      expect(/[A-Za-z]:\\/u.test(entry.body.toString('latin1')), `${entry.name} contains a Windows absolute path`).toBe(false)
    }

    const defaultChannel = await downloadPackage(fixture)
    expect(defaultChannel.status).toBe(200)
    expect(defaultChannel.rawBody.equals(response.rawBody)).toBe(true)
    const remote = await downloadPackage(fixture, '?channel=remote')
    expect(remote.status).toBe(409)
    expect(JSON.parse(remote.body)).toEqual({ error: 'channel_unavailable' })
    const invalid = await downloadPackage(fixture, '?channel=carrier-pigeon')
    expect(invalid.status).toBe(400)
    const infoWithQuery = await request(fixture.adminPort, `${PC_INFO_PATH}?channel=lan`, { headers: adminHeaders(fixture) })
    expect(infoWithQuery.status).toBe(400)
  })

  it('localizes the packaged README from the download request language', async () => {
    const fixture = await createFixture()
    const bodies = new Map<string, Buffer>()
    for (const [language, expected] of [
      ['zh-CN,zh;q=0.9', 'README-zh.txt'],
      ['en-US,en;q=0.9', 'README-en.txt'],
      ['it-IT,it;q=0.9', 'README-it.txt'],
    ] as const) {
      const response = await downloadPackage(fixture, '?channel=lan', { 'accept-language': language })
      expect(response.status, `package body: ${response.body.slice(0, 200)}`).toBe(200)
      const entries = readStoredZip(response.rawBody)
      const readmes = entries.filter(entry => entry.name.startsWith('README-')).map(entry => entry.name)
      expect(readmes, language).toEqual([expected])
      const body = entries.find(entry => entry.name === expected)?.body ?? Buffer.alloc(0)
      expect(body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${expected} UTF-8 BOM`).toBe(true)
      expect(body.toString('utf8')).toContain(`${fixture.pcOrigin}${PC_ENTRY_PATH}`)
      bodies.set(expected, body)
    }
    // Each language really renders its own copy instead of one shared body.
    const unique = new Set([...bodies.values()].map(body => body.toString('utf8')))
    expect(unique.size).toBe(3)
  })

  it('adds the trust script and the CA only when the channel carries one', async () => {
    const certificate = { name: 'dsh-mobile-ca.cer', body: Buffer.from('fixture-der-certificate-bytes') }
    const fixture = await createFixture({ certificate })
    const info = await request(fixture.adminPort, PC_INFO_PATH, { headers: adminHeaders(fixture) })
    expect(info.status).toBe(200)
    const parsed = JSON.parse(info.body) as { certificate?: { available?: boolean; url?: string } }
    expect(parsed.certificate?.available).toBe(true)
    expect(parsed.certificate?.url).toBe(`${fixture.pcOrigin}/mobile-access/ca.cer`)
    const response = await downloadPackage(fixture, '?channel=lan')
    expect(response.status).toBe(200)
    const entries = readStoredZip(response.rawBody)
    const names = entries.map(entry => entry.name).sort()
    expect(names).toContain('1-trust-certificate.cmd')
    expect(names).toContain('dsh-mobile-ca.cer')
    const ca = entries.find(entry => entry.name === 'dsh-mobile-ca.cer')
    expect(ca?.body.equals(certificate.body)).toBe(true)
    const trust = entries.find(entry => entry.name === '1-trust-certificate.cmd')
    const trustText = trust?.body.toString('ascii') ?? ''
    expect(trustText).toMatch(/^[\x09\x0d\x0a\x20-\x7e]*$/u)
    expect(trustText).toContain('certutil -user -addstore Root "%~dp0dsh-mobile-ca.cer"')
    expect(trustText.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('reports channel_unavailable when no channel is reachable', async () => {
    const fixture = await createFixture({ channels: [] })
    const info = await request(fixture.adminPort, PC_INFO_PATH, { headers: adminHeaders(fixture) })
    expect(info.status).toBe(200)
    const parsed = JSON.parse(info.body) as { channels?: readonly unknown[]; certificate?: { available?: boolean } }
    expect(parsed.channels).toEqual([])
    expect(parsed.certificate?.available).toBe(false)
    const response = await downloadPackage(fixture)
    expect(response.status).toBe(409)
    expect(JSON.parse(response.body)).toEqual({ error: 'channel_unavailable' })
  })

  it('exposes the desktop revisions the client layer needs and pairs a browser exactly once', async () => {
    const fixture = await createFixture()
    const opened = await openPairing(fixture)
    const paired = await pairBrowser(fixture, opened.token)
    expect(paired.status).toBe(201)
    const session = cookiesByName(paired.headers).get(SESSION_COOKIE) ?? ''
    expect(session).not.toBe('')

    const manifest = await request(fixture.port, '/mobile-access/extensions/manifest', {
      headers: { host: new URL(fixture.origin).host, 'sec-fetch-site': 'same-origin', cookie: `${SESSION_COOKIE}=${session}` },
    })
    expect(manifest.status).toBe(200)
    const parsed = JSON.parse(manifest.body) as { legacy?: Record<string, unknown> }
    expect(typeof parsed.legacy?.desktopScriptRevision).toBe('string')
    expect(typeof parsed.legacy?.desktopStyleRevision).toBe('string')

    // The window is single-use: the same window cannot pair a second device, and
    // the app key carries the same secret, so it is only a second *form*, not a
    // second credential.
    const replay = await pairBrowser(fixture, opened.token)
    expect(replay.status).toBe(401)
    expect(cookiesByName(replay.headers).has(SESSION_COOKIE)).toBe(false)
    const appKeyReplay = await pairBrowser(fixture, opened.appKey)
    expect(appKeyReplay.status).toBe(401)
    expect(cookiesByName(appKeyReplay.headers).has(SESSION_COOKIE)).toBe(false)
  })

  it('pairs with the app key, a whole entry link or a wrapped code, each exactly once', async () => {
    const fixture = await createFixture()
    const forms: ReadonlyArray<{ readonly name: string; readonly code: (opened: OpenedPairing) => string }> = [
      { name: 'raw token', code: opened => opened.token },
      { name: 'app key', code: opened => opened.appKey },
      { name: 'entry link with #key', code: opened => `${fixture.origin}${PC_ENTRY_PATH}#key=${opened.appKey}` },
      { name: 'entry link with #instance and #token', code: opened => `${fixture.origin}/mobile-access/pair#instance=${appKeyInstance(opened.appKey)}&token=${opened.token}` },
      { name: 'query link', code: opened => `${fixture.origin}${PC_ENTRY_PATH}?token=${opened.token}` },
      { name: 'quoted app key', code: opened => `"${opened.appKey}"` },
      { name: 'padded app key', code: opened => `  ${opened.appKey}\n` },
    ]
    for (const form of forms) {
      const opened = await openPairing(fixture)
      const paired = await pairBrowser(fixture, form.code(opened))
      expect(paired.status, `${form.name}: ${paired.body}`).toBe(201)
      expect(cookiesByName(paired.headers).has(SESSION_COOKIE), form.name).toBe(true)
      expect(cookiesByName(paired.headers).has(DEVICE_COOKIE), form.name).toBe(true)
      const replay = await pairBrowser(fixture, form.code(opened))
      expect(replay.status, `${form.name} replay: ${replay.body}`).toBe(401)
    }
  })

  it('treats the instance id as a label and the secret as the credential', async () => {
    const fixture = await createFixture()
    const opened = await openPairing(fixture)
    const wrongSecret = await pairBrowser(fixture, `dsh1.${appKeyInstance(opened.appKey)}.${'A'.repeat(43)}`)
    expect(wrongSecret.status, `wrong secret: ${wrongSecret.body}`).toBe(401)
    // A failed attempt must not consume the window that is still open.
    expect((await pairBrowser(fixture, opened.token)).status).toBe(201)

    const other = await openPairing(fixture)
    const foreignInstance = await pairBrowser(fixture, `dsh9.some-other-instance.${appKeySecret(other.appKey)}`)
    expect(foreignInstance.status, `foreign instance: ${foreignInstance.body}`).toBe(201)
    expect(cookiesByName(foreignInstance.headers).has(SESSION_COOKIE)).toBe(true)
  })

  it('answers repeated pairing attempts with a 429 the entry page can explain', async () => {
    const fixture = await createFixture({ maxPairingAttempts: 2 })
    await openPairing(fixture)
    expect((await pairBrowser(fixture, 'wrong-code-one')).status).toBe(401)
    expect((await pairBrowser(fixture, 'wrong-code-two')).status).toBe(401)
    expect((await pairBrowser(fixture, 'wrong-code-three')).status).toBe(429)
    for (const [language, message] of [['zh-CN', '尝试次数过多'], ['en-US', 'Too many attempts'], ['it-IT', 'Troppi tentativi']] as const) {
      const script = await request(fixture.port, PC_ENTRY_SCRIPT_PATH, {
        headers: { host: new URL(fixture.origin).host, 'accept-language': language },
      })
      expect(script.status).toBe(200)
      expect(script.body, language).toContain('429')
      expect(script.body, language).toContain(message)
    }
  })

  it('pins the five-minute pairing window and the configured ceiling', async () => {
    const defaults = parseGatewayConfig(baseGatewayOptions(tmpdir(), 1)) as { pairingTtlMs: number }
    expect(defaults.pairingTtlMs).toBe(300_000)
    expect(() => parseGatewayConfig(baseGatewayOptions(tmpdir(), 1, { pairingTtlMs: 9_999 }))).toThrow()
    expect(() => parseGatewayConfig(baseGatewayOptions(tmpdir(), 1, { pairingTtlMs: 900_001 }))).toThrow()
    expect((parseGatewayConfig(baseGatewayOptions(tmpdir(), 1, { pairingTtlMs: 900_000 })) as { pairingTtlMs: number }).pairingTtlMs).toBe(900_000)

    const fixture = await createFixture()
    const opened = await openPairing(fixture)
    const remaining = opened.expiresAt - Date.now()
    expect(remaining).toBeGreaterThan(4.5 * 60_000)
    expect(remaining).toBeLessThanOrEqual(5 * 60_000 + 5_000)
    // A request may shorten the window but never exceed the configured value.
    expect((await openPairingWithTtl(fixture, 300_000)).status).toBe(201)
    expect((await openPairingWithTtl(fixture, 300_001)).status).toBe(400)
    expect((await openPairingWithTtl(fixture, 9_999)).status).toBe(400)
  })

  it('extracts the code from every paste form and normalizes it server-side', () => {
    const token = 'Zm9vYmFyLXRva2VuLTAxMjM0NTY3ODlBQkNERUY'
    const appKey = `dsh1.${'a'.repeat(64)}.${token}`
    const link = `https://192.168.1.7:3443${PC_ENTRY_PATH}#key=${appKey}`
    expect(extractPairingToken(token)).toBe(token)
    expect(extractPairingToken(appKey)).toBe(token)
    expect(extractPairingToken(link)).toBe(token)
    expect(extractPairingToken(`  ${link}\n`)).toBe(token)
    expect(extractPairingToken(`"${appKey}"`)).toBe(token)
    expect(extractPairingToken(`dsh2.${'b'.repeat(64)}.${token}`)).toBe(token)
    // A link without a code yields nothing, so the page explains instead of posting.
    expect(extractPairingToken(`https://192.168.1.7:3443${PC_ENTRY_PATH}`)).toBe('')
    expect(extractPairingToken('')).toBe('')
    expect(extractPairingToken('   ')).toBe('')
    expect(normalizePairingToken(appKey)).toBe(token)
    expect(normalizePairingToken(link)).toBe(token)
    expect(normalizePairingToken(`<${link}>`)).toBe(token)
    expect(normalizePairingToken(token)).toBe(token)
    // An unrelated string is returned unchanged so the digest compare still fails.
    expect(normalizePairingToken('not-a-code')).toBe('not-a-code')
  })

  it('keeps a revoked device refused on the mobile gateway origin', async () => {
    const fixture = await createFixture()
    const opened = await openPairing(fixture)
    const paired = await pairBrowser(fixture, opened.token)
    expect(paired.status).toBe(201)
    const { deviceId } = JSON.parse(paired.body) as { deviceId: string }
    const session = cookiesByName(paired.headers).get(SESSION_COOKIE) ?? ''
    const authenticated = (): Promise<HttpResult> => request(fixture.port, '/mobile-access/custom.css', {
      headers: {
        host: new URL(fixture.origin).host,
        'sec-fetch-site': 'same-origin',
        cookie: `${SESSION_COOKIE}=${session}`,
      },
    })
    expect((await authenticated()).status).toBe(200)
    const revoked = await request(fixture.adminPort, `${LOCAL_ADMIN_PREFIX}/lan/devices/revoke`, {
      method: 'POST',
      headers: adminHeaders(fixture, { 'content-type': 'application/json' }),
      body: JSON.stringify({ deviceId }),
    })
    expect(revoked.status, `revoke body: ${revoked.body}`).toBe(200)
    expect((await authenticated()).status).toBe(401)
  })

  it('ships non-empty PC panel copy in every supported language', async () => {
    const { MOBILE_CONTROL_MESSAGES } = await import('../src/client-messages.js')
    const locales = ['zh', 'en', 'it'] as const
    const keys = Object.keys(MOBILE_CONTROL_MESSAGES.en).filter(key => key.startsWith('pc'))
    expect(keys.length).toBeGreaterThan(10)
    for (const locale of locales) {
      const copy = MOBILE_CONTROL_MESSAGES[locale] as Record<string, string>
      for (const key of keys) expect(copy[key], `${locale}.${key}`).toBeTruthy()
    }
    // The three languages really differ, so no locale silently reuses English.
    const rendered = locales.map(locale => JSON.stringify(MOBILE_CONTROL_MESSAGES[locale]))
    expect(new Set(rendered).size).toBe(3)
  })
})

describe('durable PC entry links (task-13 + task-16 + task-23)', () => {
  const LINKS_PATH = `${LOCAL_ADMIN_PREFIX}/lan/links`
  const LINK_PATH = `${LOCAL_ADMIN_PREFIX}/lan/link`
  const LINK_REVOKE_PATH = `${LOCAL_ADMIN_PREFIX}/lan/link/revoke`
  const LAN_STATUS_PATH = `${LOCAL_ADMIN_PREFIX}/lan/status`
  const LAN_DEVICES_PATH = `${LOCAL_ADMIN_PREFIX}/lan/devices`

  /** One row of the owner's link list, as `GET /links` returns it. */
  interface LinkView {
    readonly id: string
    readonly label: string
    readonly createdAt: number
    readonly lastUsedAt?: number
    readonly deviceCount: number
    readonly appKey: string
    readonly entryUrl: string
  }

  interface LinkCreated {
    readonly created: boolean
    readonly appKey: string
    readonly entryUrl: string
    readonly link: LinkView
  }

  const listLinks = async (fixture: { readonly adminPort: number }): Promise<readonly LinkView[]> =>
    (JSON.parse((await adminGet(fixture, LINKS_PATH)).body) as { links: LinkView[] }).links

  const createLink = async (fixture: { readonly adminPort: number }, body = '{}'): Promise<LinkCreated> => {
    const response = await adminPost(fixture, LINK_PATH, body)
    expect(response.status, response.body).toBe(201)
    return JSON.parse(response.body) as LinkCreated
  }

  /**
   * The list once the best-effort last-used write has landed.
   *
   * `handlePair` records the touch without delaying the pair response, so the panel
   * sees it a moment later; polling is what the panel's own refresh does.
   */
  const waitForLinks = async (
    fixture: { readonly adminPort: number },
    predicate: (links: readonly LinkView[]) => boolean,
  ): Promise<readonly LinkView[]> => {
    let links: readonly LinkView[] = []
    await vi.waitFor(async () => {
      links = await listLinks(fixture)
      expect(predicate(links)).toBe(true)
    })
    return links
  }

  it('appends one link per call and revokes one without touching the other', async () => {
    const fixture = await createFixture()
    expect(await listLinks(fixture)).toStrictEqual([])

    const owner = await createLink(fixture, JSON.stringify({ label: 'Owner laptop' }))
    expect(owner.created).toBe(true)
    // The app key is the durable secret itself, in the same shape as a pairing token.
    expect(owner.appKey).toMatch(/^dsh1\.[a-f\d]{64}\.[A-Za-z0-9_-]{43}$/u)
    expect(owner.entryUrl).toBe(`${fixture.origin}${PC_ENTRY_PATH}#key=${owner.appKey}`)
    expect(owner.link.id).toMatch(/^[a-f\d]{16}$/u)
    expect(owner.link).toMatchObject({ label: 'Owner laptop', deviceCount: 0, appKey: owner.appKey, entryUrl: owner.entryUrl })
    expect(typeof owner.link.createdAt).toBe('number')
    expect(owner.link).not.toHaveProperty('lastUsedAt')

    // A second call appends rather than replacing: two links, two secrets.
    const friend = await createLink(fixture, JSON.stringify({ label: 'Friend' }))
    expect(friend.link.id).not.toBe(owner.link.id)
    expect(appKeySecret(friend.appKey)).not.toBe(appKeySecret(owner.appKey))
    const listed = await listLinks(fixture)
    expect(listed.map(link => link.id)).toStrictEqual([owner.link.id, friend.link.id])
    expect(listed.map(link => link.label)).toStrictEqual(['Owner laptop', 'Friend'])
    expect(JSON.parse((await adminGet(fixture, LAN_STATUS_PATH)).body).entryLink).toStrictEqual({ active: true, count: 2 })

    // Pairing through one link is recorded on that link only.
    expect((await pairBrowser(fixture, friend.appKey)).status).toBe(201)
    const touched = await waitForLinks(fixture, links => links.find(link => link.id === friend.link.id)?.lastUsedAt !== undefined)
    expect(touched.find(link => link.id === friend.link.id)?.deviceCount).toBe(1)
    expect(touched.find(link => link.id === owner.link.id)?.deviceCount).toBe(0)

    // Revoking one link leaves the other working.
    const revoked = await adminPost(fixture, LINK_REVOKE_PATH, JSON.stringify({ linkId: owner.link.id }))
    expect(revoked.status, revoked.body).toBe(200)
    expect(JSON.parse(revoked.body)).toStrictEqual({ revoked: true, devicesRevoked: 0 })
    expect((await pairBrowser(fixture, owner.appKey)).status).toBe(401)
    expect((await pairBrowser(fixture, friend.appKey)).status).toBe(201)
    expect(JSON.parse((await adminGet(fixture, LAN_STATUS_PATH)).body).entryLink).toStrictEqual({ active: true, count: 1 })
    expect((await listLinks(fixture)).map(link => link.id)).toStrictEqual([friend.link.id])

    // Revoking the link that was used removes the devices that entered through it.
    const last = await adminPost(fixture, LINK_REVOKE_PATH, JSON.stringify({ linkId: friend.link.id }))
    expect(last.status, last.body).toBe(200)
    expect(JSON.parse(last.body)).toStrictEqual({ revoked: true, devicesRevoked: 2 })
    expect((await pairBrowser(fixture, friend.appKey)).status).toBe(401)
    const drained = JSON.parse((await adminGet(fixture, LAN_STATUS_PATH)).body) as { entryLink: unknown; deviceCount: number }
    expect(drained.entryLink).toStrictEqual({ active: false, count: 0 })
    expect(drained.deviceCount).toBe(0)
  })

  it('caps the list, validates the label and ignores the retired regenerate flag', async () => {
    const fixture = await createFixture()
    // A label that is not a string, and one the store refuses, are both bad requests.
    expect((await adminPost(fixture, LINK_PATH, JSON.stringify({ label: 42 }))).status).toBe(400)
    expect((await adminPost(fixture, LINK_PATH, JSON.stringify({ label: 'x'.repeat(65) }))).status).toBe(400)
    expect((await adminPost(fixture, LINK_PATH, JSON.stringify({ label: 'bad\u0000label' }))).status).toBe(400)
    // An absent or empty name takes the default.
    expect((await createLink(fixture)).link.label).toBe('Access link')
    expect((await createLink(fixture, JSON.stringify({ label: '' }))).link.label).toBe('Access link')
    // `regenerate` is retired: it is not a replacement switch, it appends like any
    // other call, so the previously issued link keeps working.
    const before = await listLinks(fixture)
    const appended = await createLink(fixture, JSON.stringify({ regenerate: true }))
    expect(appended.link.id).not.toBe(before[0]?.id)
    expect((await listLinks(fixture)).map(link => link.id)).toStrictEqual([...before.map(link => link.id), appended.link.id])

    for (let index = before.length + 1; index < MAX_ENTRY_LINKS; index += 1) {
      expect((await createLink(fixture, JSON.stringify({ label: `Link ${String(index)}` }))).link.label).toBe(`Link ${String(index)}`)
    }
    expect(await listLinks(fixture)).toHaveLength(MAX_ENTRY_LINKS)
    const overflow = await adminPost(fixture, LINK_PATH)
    expect(overflow.status, overflow.body).toBe(409)
    expect(JSON.parse(overflow.body)).toStrictEqual({ error: 'entry_link_limit' })
    expect(await listLinks(fixture)).toHaveLength(MAX_ENTRY_LINKS)

    // One call can clear the whole list.
    const all = await adminPost(fixture, LINK_REVOKE_PATH, JSON.stringify({ all: true }))
    expect(all.status, all.body).toBe(200)
    expect(JSON.parse(all.body)).toStrictEqual({ revoked: true, devicesRevoked: 0, revokedLinks: MAX_ENTRY_LINKS })
    expect(await listLinks(fixture)).toStrictEqual([])
    expect(JSON.parse((await adminGet(fixture, LAN_STATUS_PATH)).body).entryLink).toStrictEqual({ active: false, count: 0 })

    // An unknown id was a valid request; a malformed one never was.
    expect((await adminPost(fixture, LINK_REVOKE_PATH, JSON.stringify({ linkId: 'a'.repeat(16) }))).status).toBe(404)
    expect((await adminPost(fixture, LINK_REVOKE_PATH, JSON.stringify({ linkId: 'nope' }))).status).toBe(400)
    expect((await adminPost(fixture, LINK_REVOKE_PATH, '{}')).status).toBe(400)
  })

  it('reuses a bound device on a durable open and never consumes the link', async () => {
    const fixture = await createFixture({ tls: true })
    const { appKey } = JSON.parse((await adminPost(fixture, LINK_PATH)).body) as { appKey: string }

    const first = await pairBrowser(fixture, appKey)
    expect(first.status, first.body).toBe(201)
    const firstBody = JSON.parse(first.body) as { deviceId: string; reused?: boolean }
    expect(firstBody.reused).toBeUndefined()
    const issued = cookiesByName(first.headers)
    const deviceToken = issued.get(DEVICE_COOKIE) ?? ''
    const deviceId = issued.get(HOST_DEVICE_COOKIE) ?? ''
    expect(deviceToken, 'the narrow device cookie is issued').not.toBe('')
    expect(deviceId, 'the __Host- device id binding is issued').toBe(firstBody.deviceId)

    // The shape a browser actually sends to /auth/pair: the `__Host-` device id, and
    // never the token cookie, whose Path is /mobile-access/auth/renew. This is the
    // path scripts/smoke-pc-client.mjs measures in Chromium.
    const viaId = await pairBrowser(fixture, appKey, { cookie: `${HOST_DEVICE_COOKIE}=${deviceId}` })
    expect(viaId.status, viaId.body).toBe(200)
    expect(JSON.parse(viaId.body)).toMatchObject({ paired: true, reused: true, deviceId: firstBody.deviceId })
    expect(cookiesByName(viaId.headers).has(SESSION_COOKIE)).toBe(true)
    expect(JSON.parse((await adminGet(fixture, LAN_STATUS_PATH)).body).deviceCount).toBe(1)

    // A caller that really does present the narrow token (the renewal-path client)
    // reuses through the same branch.
    const viaToken = await pairBrowser(fixture, appKey, {
      cookie: `${HOST_DEVICE_COOKIE}=${deviceId}; ${DEVICE_COOKIE}=${deviceToken}`,
    })
    expect(viaToken.status, viaToken.body).toBe(200)
    expect(JSON.parse(viaToken.body)).toMatchObject({ paired: true, reused: true, deviceId: firstBody.deviceId })
    expect(JSON.parse((await adminGet(fixture, LAN_STATUS_PATH)).body).deviceCount).toBe(1)

    // A one-time code never takes the reuse path, even carrying the same binding.
    const opened = await openPairing(fixture)
    const byCode = await pairBrowser(fixture, opened.token, { cookie: `${HOST_DEVICE_COOKIE}=${deviceId}` })
    expect(byCode.status, byCode.body).toBe(201)
    expect((JSON.parse(byCode.body) as { reused?: boolean }).reused).toBeUndefined()

    // A stale binding falls through to a normal pair, never a 401: an id that no
    // device has, and an id whose device was revoked.
    const stale = await pairBrowser(fixture, appKey, { cookie: `${HOST_DEVICE_COOKIE}=stale-device-id` })
    expect(stale.status, stale.body).toBe(201)
    expect((JSON.parse(stale.body) as { reused?: boolean }).reused).toBeUndefined()
    const revokedId = (JSON.parse(stale.body) as { deviceId: string }).deviceId
    expect((await adminPost(fixture, `${LOCAL_ADMIN_PREFIX}/lan/devices/revoke`, JSON.stringify({ deviceId: revokedId }))).status).toBe(200)
    const afterRevoke = await pairBrowser(fixture, appKey, { cookie: `${HOST_DEVICE_COOKIE}=${revokedId}` })
    expect(afterRevoke.status, afterRevoke.body).toBe(201)
    expect((JSON.parse(afterRevoke.body) as { reused?: boolean }).reused).toBeUndefined()
    expect((JSON.parse(afterRevoke.body) as { deviceId: string }).deviceId).not.toBe(revokedId)

    // The link itself was never consumed: the original binding still reuses.
    expect((await pairBrowser(fixture, appKey, { cookie: `${HOST_DEVICE_COOKIE}=${deviceId}` })).status).toBe(200)

    // The token path also treats a revoked device as unauthorised and pairs again
    // instead of surfacing the controller's 401 (`AccessError`, not `HttpError`).
    expect((await adminPost(fixture, `${LOCAL_ADMIN_PREFIX}/lan/devices/revoke`, JSON.stringify({ deviceId }))).status).toBe(200)
    const revokedToken = await pairBrowser(fixture, appKey, { cookie: `${DEVICE_COOKIE}=${deviceToken}` })
    expect(revokedToken.status, revokedToken.body).toBe(201)
    expect((JSON.parse(revokedToken.body) as { reused?: boolean }).reused).toBeUndefined()
  })

  it('cannot reuse a device on a plain-HTTP entry, which issues no binding', async () => {
    // The documented local-network limitation, pinned here rather than left to the
    // smoke: a non-secure origin sets no `__Host-` cookie, so the repeat request a
    // browser can make carries nothing the reuse branch could use and it pairs again.
    const plain = await createFixture()
    const { appKey } = JSON.parse((await adminPost(plain, LINK_PATH)).body) as { appKey: string }
    const first = await pairBrowser(plain, appKey)
    expect(first.status, first.body).toBe(201)
    const issued = cookiesByName(first.headers)
    expect(issued.has(HOST_DEVICE_COOKIE), 'a plain-HTTP entry issues no __Host- binding').toBe(false)
    // The token exists but only on the narrow renewal path, which /auth/pair never sees.
    expect(issued.get(DEVICE_COOKIE), 'the token is issued on the narrow path only').not.toBe('')
    const repeat = await pairBrowser(plain, appKey)
    expect(repeat.status, repeat.body).toBe(201)
    expect((JSON.parse(repeat.body) as { reused?: boolean }).reused).toBeUndefined()
    expect(JSON.parse((await adminGet(plain, LAN_STATUS_PATH)).body).deviceCount).toBe(2)
  })

  it('keeps the device cap and the rate limit in front of the durable link', async () => {
    const capped = await createFixture({ maxDevices: 1 })
    const { appKey } = JSON.parse((await adminPost(capped, LINK_PATH)).body) as { appKey: string }
    expect((await pairBrowser(capped, appKey)).status).toBe(201)
    // A second, unbound open would be a new device, so the cap answers 409.
    const overCap = await pairBrowser(capped, appKey)
    expect(overCap.status, overCap.body).toBe(409)
    expect(JSON.parse(overCap.body)).toStrictEqual({ error: 'device_limit' })

    const limited = await createFixture({ maxPairingAttempts: 2 })
    const limitedKey = (JSON.parse((await adminPost(limited, LINK_PATH)).body) as { appKey: string }).appKey
    expect((await pairBrowser(limited, limitedKey)).status).toBe(201)
    // A wrong token is still 401, and the third attempt from the same source is 429:
    // the durable link shares the pairing budget and never bypasses it.
    expect((await pairBrowser(limited, `${appKeyInstance(limitedKey)}.${'A'.repeat(43)}`)).status).toBe(401)
    expect((await pairBrowser(limited, limitedKey)).status).toBe(429)
  })

  it('reports the link per channel while the shared pc/info carries none', async () => {
    const channels = await createChannelFixture()
    const remoteStatus = (): Promise<Record<string, unknown>> =>
      adminGet(channels, `${LOCAL_ADMIN_PREFIX}/remote/status`).then(result => JSON.parse(result.body) as Record<string, unknown>)
    expect(JSON.parse((await adminGet(channels, `${LOCAL_ADMIN_PREFIX}/remote/status`)).body).entryLink).toStrictEqual({ active: false, count: 0 })

    const lanLink = JSON.parse((await adminPost(channels, LINK_PATH)).body) as { appKey: string; entryUrl: string }
    expect(JSON.parse((await adminGet(channels, LAN_STATUS_PATH)).body).entryLink).toStrictEqual({ active: true, count: 1 })
    // Each channel owns its own link file, so the other answer is untouched.
    expect((await remoteStatus()).entryLink).toStrictEqual({ active: false, count: 0 })

    // The deviation from the task text: pc/info is answered by whichever gateway is
    // active, so it cannot report the selected channel's link and must not pretend to.
    const info = JSON.parse((await adminGet(channels, PC_INFO_PATH)).body) as Record<string, unknown>
    expect(info).not.toHaveProperty('link')
    expect(info).not.toHaveProperty('entryLink')
    expect(Object.keys(info).sort()).toStrictEqual(['certificate', 'channels', 'entryPath', 'packagePath'])
    expect(info.channels).toStrictEqual([
      { channel: 'lan', origin: channels.lan.origin, entryUrl: `${channels.lan.origin}${PC_ENTRY_PATH}` },
      { channel: 'remote', origin: channels.remote.origin, entryUrl: `${channels.remote.origin}${PC_ENTRY_PATH}` },
    ])

    // A link created on the local network never opens the public entry.
    expect((await pairBrowser(channels.remote, lanLink.appKey)).status).toBe(401)
    const remoteLink = JSON.parse((await adminPost(channels, `${LOCAL_ADMIN_PREFIX}/remote/link`)).body) as { appKey: string }
    expect(appKeySecret(remoteLink.appKey)).not.toBe(appKeySecret(lanLink.appKey))
    expect((await pairBrowser(channels.remote, remoteLink.appKey)).status).toBe(201)
    expect((await pairBrowser(channels.lan, remoteLink.appKey)).status).toBe(401)
    expect(JSON.parse((await adminGet(channels, LAN_STATUS_PATH)).body).entryLink).toStrictEqual({ active: true, count: 1 })
  })

  it('keeps the durable secret on the loopback route and out of every other surface', async () => {
    const fixture = await createFixture()
    const link = JSON.parse((await adminPost(fixture, LINK_PATH)).body) as { appKey: string; entryUrl: string }
    const secret = appKeySecret(link.appKey)
    expect((await pairBrowser(fixture, link.appKey)).status).toBe(201)

    const surfaces = [
      (await adminGet(fixture, LAN_STATUS_PATH)).body,
      (await adminGet(fixture, LAN_DEVICES_PATH)).body,
      (await adminGet(fixture, PC_INFO_PATH)).body,
      // The external listener proxies the admin path upstream: it must never answer it.
      (await request(fixture.port, LINK_PATH, {
        method: 'POST',
        headers: {
          host: new URL(fixture.origin).host,
          origin: fixture.origin,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: '{}',
      })).body,
      // The list route is loopback-only too, even as a plain GET.
      (await request(fixture.port, LINKS_PATH, { headers: { host: new URL(fixture.origin).host } })).body,
    ]
    for (const body of surfaces) {
      expect(body).not.toContain(secret)
      expect(body).not.toContain('"links"')
    }
    const zip = await downloadPackage(fixture, '?channel=lan')
    expect(zip.rawBody.includes(Buffer.from(secret)), 'the package carries no secret').toBe(false)

    // On disk the raw secret exists only in the owner-only link file.
    const holders: string[] = []
    const walk = async (directory: string, prefix = ''): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) { await walk(join(directory, entry.name), name); continue }
        if ((await readFile(join(directory, entry.name))).includes(Buffer.from(secret))) holders.push(name)
      }
    }
    await walk(fixture.directory)
    expect(holders).toStrictEqual(['entry-link.json'])

    // The route itself is loopback-only and refuses a foreign authority, a
    // cross-site fetch, an Origin-less write and an unexpected query.
    expect((await request(fixture.adminPort, LINK_PATH, {
      method: 'POST',
      headers: { ...adminHeaders(fixture, { 'content-type': 'application/json' }), host: 'public.example.test' },
      body: '{}',
    })).status).toBe(403)
    expect((await request(fixture.adminPort, LINK_PATH, {
      method: 'POST',
      headers: { ...adminHeaders(fixture, { 'content-type': 'application/json' }), 'sec-fetch-site': 'cross-site' },
      body: '{}',
    })).status).toBe(403)
    expect((await request(fixture.adminPort, LINK_PATH, {
      method: 'POST',
      headers: { host: `127.0.0.1:${String(fixture.adminPort)}`, 'content-type': 'application/json' },
      body: '{}',
    })).status).toBe(403)
    expect((await request(fixture.adminPort, `${LINK_PATH}?x=1`, {
      method: 'POST',
      headers: adminHeaders(fixture, { 'content-type': 'application/json' }),
      body: '{}',
    })).status).toBe(400)

    // A non-loopback peer never reaches the handler at all.
    const forge = (remoteAddress: string, host: string, browser = true): void => assertLocalAdminTrust({
      method: 'POST',
      headers: browser
        ? { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }
        : { host },
      socket: { remoteAddress },
    } as unknown as IncomingMessage, true)
    expect(() => { forge('203.0.113.9', `127.0.0.1:${String(fixture.adminPort)}`) }).toThrow(/forbidden/u)
    expect(() => { forge('::ffff:127.0.0.1', 'public.example.test') }).toThrow(/forbidden/u)
    expect(() => { forge('127.0.0.1', `127.0.0.1:${String(fixture.adminPort)}`, false) }).toThrow(/forbidden/u)
    expect(() => { forge('127.0.0.1', `127.0.0.1:${String(fixture.adminPort)}`) }).not.toThrow()
  })
})

describe('SakuraFrp trusted entry (子域绑定 + 自动 HTTPS)', () => {
  async function settingsFixture(): Promise<{ readonly settings: SakuraFrpSettingsStore; readonly directory: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-sakura-settings-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const settings = new SakuraFrpSettingsStore(join(directory, 'sakurafrp'), directory)
    await settings.initialize()
    return { settings, directory }
  }

  it('round-trips the entry mode and the bound subdomain without exposing the token', async () => {
    const { settings, directory } = await settingsFixture()
    expect(settings.status()).toStrictEqual({
      tokenSet: false,
      entryMode: 'tls',
      storagePath: join(directory, 'sakurafrp'),
    })
    await settings.configure({ token: 'sk-token-abcdefgh', tunnelId: 42 })
    expect(settings.status()).toMatchObject({ tokenSet: true, tunnelId: 42, entryMode: 'tls' })
    expect(settings.status()).not.toHaveProperty('boundDomain')

    const auto = await settings.configure({ entryMode: 'autoHttps', boundDomain: 'dsh.demo.nyat.app' })
    expect(auto).toMatchObject({ entryMode: 'autoHttps', boundDomain: 'dsh.demo.nyat.app' })
    expect(JSON.stringify(auto)).not.toContain('sk-token-abcdefgh')
    expect(settings.status()).not.toHaveProperty('token')

    // A fresh store on the same directory reads the same settings back.
    const reloaded = new SakuraFrpSettingsStore(join(directory, 'sakurafrp'), directory)
    await reloaded.initialize()
    expect(reloaded.settings()).toStrictEqual({
      token: 'sk-token-abcdefgh',
      tunnelId: 42,
      entryMode: 'autoHttps',
      boundDomain: 'dsh.demo.nyat.app',
    })
    // Switching back to the default mode keeps the binding but not the mode.
    expect(await reloaded.configure({ entryMode: 'tls' }))
      .toMatchObject({ entryMode: 'tls', boundDomain: 'dsh.demo.nyat.app' })
    expect(await reloaded.purge()).toMatchObject({ entryMode: 'tls', tokenSet: false })

    // A settings file written before the field existed keeps the raw-TCP behaviour.
    await mkdir(join(directory, 'legacy'), { recursive: true })
    const legacy = new SakuraFrpSettingsStore(join(directory, 'legacy'), directory)
    await writeFile(join(directory, 'legacy', 'settings.json'), JSON.stringify({ version: 1, token: 'sk-legacy-token-01', tunnelId: 7 }), 'utf8')
    await legacy.initialize()
    expect(legacy.status()).toMatchObject({ tokenSet: true, tunnelId: 7, entryMode: 'tls' })
  })

  it('rejects an unsupported mode and a malformed bound subdomain', async () => {
    const { settings } = await settingsFixture()
    await expect(settings.configure({ entryMode: 'https' })).rejects.toThrow(/sakurafrp_entry_mode_invalid/u)
    await expect(settings.configure({ entryMode: 'autohttps' })).rejects.toThrow(/sakurafrp_entry_mode_invalid/u)
    for (const domain of [
      'UPPER.nyat.app', 'nyat.app.', '-bad.nyat.app', 'bad-.nyat.app', 'nodot',
      'a..b', `${'x'.repeat(64)}.nyat.app`, 'under_score.nyat.app', 'https://dsh.nyat.app',
      'dsh.nyat.app:443', 'dsh .nyat.app',
    ]) {
      await expect(settings.configure({ boundDomain: domain }), domain).rejects.toThrow(/sakurafrp_bound_domain_invalid/u)
    }
    expect(validateSakuraFrpEntryMode('tls')).toBe('tls')
    expect(validateSakuraFrpEntryMode('autoHttps')).toBe('autoHttps')
    expect(() => validateSakuraFrpEntryMode(undefined)).toThrow(/sakurafrp_entry_mode_invalid/u)
    expect(validateSakuraFrpBoundDomain('dsh.demo.nyat.app')).toBe('dsh.demo.nyat.app')
    expect(validateSakuraFrpBoundDomain('a.bc')).toBe('a.bc')
    // A blank field means "leave it as it was", never a silent mode change.
    expect(settings.status().entryMode).toBe('tls')
  })

  it('rewrites both fetched frpc config shapes and refuses an unsupported one', () => {
    expect(patchSakuraFrpConfigTarget('[common]\nserver_addr = frp.example.com\n\n[proxy]\nplugin_local_addr = 127.0.0.1:3443\n', 41_000))
      .toBe('[common]\nserver_addr = frp.example.com\n\n[proxy]\nplugin_local_addr = 127.0.0.1:41000\n')
    expect(patchSakuraFrpConfigTarget('serverAddr = "frp.example.com"\n[[proxies]]\nlocalAddr = "127.0.0.1:3443" # natfrp\n', 41_000))
      .toBe('serverAddr = "frp.example.com"\n[[proxies]]\nlocalAddr = "127.0.0.1:41000" # natfrp\n')
    // Without a plugin address the proxy's own local target is moved instead.
    expect(patchSakuraFrpConfigTarget('[proxy]\nlocal_ip = 192.168.1.5\nlocal_port = 3443\r\n', 41_000))
      .toBe('[proxy]\nlocal_ip = 127.0.0.1\nlocal_port = 41000\r\n')
    // A config that forwards nowhere is a named failure, never a silent no-op.
    expect(() => patchSakuraFrpConfigTarget('serverAddr = "frp.example.com"\n', 41_000)).toThrow(/sakurafrp_config_unsupported/u)
    expect(() => patchSakuraFrpConfigTarget('[proxy]\nlocal_port = 3443\n', 0)).toThrow(/sakurafrp_config_unsupported/u)
    expect(() => patchSakuraFrpConfigTarget('[proxy]\nlocal_port = 3443\n', 70_000)).toThrow(/sakurafrp_config_unsupported/u)
  })

  it('derives the public origin from the bound subdomain, collapsing port 443', async () => {
    for (const [remote, expected] of [['443', 'https://dsh.demo.nyat.app'], ['1919', 'https://dsh.demo.nyat.app:1919']] as const) {
      const { settings } = await settingsFixture()
      await settings.configure({ token: 'sk-token-abcdefgh', tunnelId: 9, entryMode: 'autoHttps', boundDomain: 'dsh.demo.nyat.app' })
      const fixture = await createSakuraController(settings, { remote, config: PATCHABLE_CONFIG, probe: async () => 'trusted' })
      await fixture.controller.initialize()
      await fixture.controller.setEnabled(true)
      await vi.waitFor(() => expect(fixture.controller.status().state).toBe('ready'))
      expect(fixture.controller.status().origin, `remote port ${remote}`).toBe(expected)
      expect(fixture.controller.status()).toMatchObject({ trustedEntry: true, trustedCertificate: true })
      // The trusted mode terminates TLS in frpc, so the plaintext ingress is used.
      expect(fixture.plainGateway).not.toHaveBeenCalled()
      // The fetched config is rewritten onto that ingress, and the tunnel's local
      // target is moved there through the official edit API.
      const patched = await readFile(settings.configFile, 'utf8')
      const target = /plugin_local_addr = 127\.0\.0\.1:(\d{4,5})/u.exec(patched)
      expect(target, patched).not.toBeNull()
      const ingressPort = Number((target as RegExpExecArray)[1])
      expect(fixture.trustedGateway).toHaveBeenCalledWith(expected, ingressPort)
      expect(fixture.editTarget).toHaveBeenCalledWith('sk-token-abcdefgh', 9, '127.0.0.1', ingressPort)
      await fixture.controller.close()
    }
  })

  it('claims a trusted certificate only when the public handshake verifies', async () => {
    const outcomes = [
      { probe: async (): Promise<SakuraFrpCertificateProbe> => 'trusted', state: 'ready', extra: { trustedCertificate: true } },
      { probe: async (): Promise<SakuraFrpCertificateProbe> => 'unreachable', state: 'ready', extra: {} },
    ] as const
    for (const outcome of outcomes) {
      const { settings } = await settingsFixture()
      await settings.configure({ token: 'sk-token-abcdefgh', tunnelId: 9, entryMode: 'autoHttps', boundDomain: 'dsh.demo.nyat.app' })
      const fixture = await createSakuraController(settings, { remote: '443', config: PATCHABLE_CONFIG, probe: outcome.probe })
      await fixture.controller.initialize()
      await fixture.controller.setEnabled(true)
      await vi.waitFor(() => expect(fixture.controller.status().state).toBe(outcome.state))
      expect(fixture.controller.status()).toMatchObject({ origin: 'https://dsh.demo.nyat.app', trustedEntry: true, ...outcome.extra })
      if (Object.keys(outcome.extra).length === 0) {
        expect(fixture.controller.status()).not.toHaveProperty('trustedCertificate')
      }
      await fixture.controller.close()
    }

    // An untrusted public certificate fails the entry with its own code, and the
    // configured (not probed) trusted claim stays visible so the panel can say why.
    const { settings } = await settingsFixture()
    await settings.configure({ token: 'sk-token-abcdefgh', tunnelId: 9, entryMode: 'autoHttps', boundDomain: 'dsh.demo.nyat.app' })
    const untrusted = await createSakuraController(settings, { remote: '443', config: PATCHABLE_CONFIG, probe: async () => 'untrusted' })
    await untrusted.controller.initialize()
    await untrusted.controller.setEnabled(true)
    await vi.waitFor(() => expect(untrusted.controller.status().state).toBe('error'))
    expect(untrusted.controller.status()).toMatchObject({
      state: 'error',
      errorCode: 'sakurafrp_certificate_untrusted',
      trustedEntry: true,
    })
    expect(untrusted.controller.status()).not.toHaveProperty('trustedCertificate')
    expect(untrusted.controller.status()).not.toHaveProperty('origin')
    await untrusted.controller.close()

    // autoHttps without a subdomain is refused before frpc is ever launched.
    const missing = await settingsFixture()
    await missing.settings.configure({ token: 'sk-token-abcdefgh', tunnelId: 9, entryMode: 'autoHttps' })
    const noDomain = await createSakuraController(missing.settings, { remote: '443', config: PATCHABLE_CONFIG, probe: async () => 'trusted' })
    await noDomain.controller.initialize()
    await noDomain.controller.setEnabled(true)
    expect(noDomain.controller.status()).toMatchObject({ state: 'unavailable', errorCode: 'sakurafrp_bound_domain_missing' })
    expect(noDomain.trustedGateway).not.toHaveBeenCalled()

    // The default mode never probes and writes the fetched config byte for byte.
    const plain = await settingsFixture()
    await plain.settings.configure({ token: 'sk-token-abcdefgh', tunnelId: 9 })
    const tlsMode = await createSakuraController(plain.settings, { remote: '443', config: PATCHABLE_CONFIG, probe: async () => 'trusted' })
    await tlsMode.controller.initialize()
    await tlsMode.controller.setEnabled(true)
    await vi.waitFor(() => expect(tlsMode.controller.status().state).toBe('ready'))
    // The raw-TCP entry is derived from the node list, and the tunnel target keeps
    // pointing at the plugin's own TLS listener.
    expect(tlsMode.controller.status()).toMatchObject({ origin: 'https://node-5.example.com', trustedEntry: false })
    expect(tlsMode.controller.status()).not.toHaveProperty('trustedCertificate')
    expect(tlsMode.probe).not.toHaveBeenCalled()
    expect(tlsMode.trustedGateway).not.toHaveBeenCalled()
    // The fixture tunnel has no reusable local port, so the target is moved through
    // the official API on a reserved loopback port; the config text itself is not
    // rewritten in the raw-TCP mode.
    expect(tlsMode.editTarget).toHaveBeenCalledTimes(1)
    const editedPort = (tlsMode.editTarget.mock.calls[0] as unknown[])[3] as number
    expect(tlsMode.editTarget).toHaveBeenCalledWith('sk-token-abcdefgh', 9, '127.0.0.1', editedPort)
    expect(editedPort).toBeGreaterThanOrEqual(1024)
    expect(editedPort).toBeLessThanOrEqual(65_535)
    expect(editedPort).not.toBe(3443)
    expect(await readFile(plain.settings.configFile, 'utf8')).toBe(PATCHABLE_CONFIG)
    await tlsMode.controller.close()
  })

  it('ships no certificate for the trusted entry and says so in the package', async () => {
    // Mirrors src/plugin.ts: in trusted mode the public certificate is natfrp's, so
    // the package must not carry the plugin CA.
    const trusted = await createFixture({
      channels: [{ channel: 'remote', origin: 'https://dsh.demo.nyat.app' }],
    })
    const trustedInfo = JSON.parse((await adminGet(trusted, PC_INFO_PATH)).body) as { certificate: { available: boolean } }
    expect(trustedInfo.certificate.available).toBe(false)
    const trustedZip = await downloadPackage(trusted, '?channel=remote')
    expect(trustedZip.status, trustedZip.body.slice(0, 200)).toBe(200)
    const trustedNames = readStoredZip(trustedZip.rawBody).map(entry => entry.name)
    expect(trustedNames).not.toContain('dsh-mobile-ca.cer')
    expect(trustedNames).not.toContain('1-trust-certificate.cmd')
    const readme = readStoredZip(trustedZip.rawBody).find(entry => /^README-.*\.txt$/u.test(entry.name))
    expect(readme, 'the package carries a README').toBeDefined()
    const readmeText = (readme as ZipEntryRead).body.toString('utf8')
    expect(readmeText).toContain('https://dsh.demo.nyat.app')
    expect(readmeText).toMatch(/no certificate/i)
    expect(readmeText).not.toContain('dsh-mobile-ca.cer')
    // The trust step is omitted entirely, so no step number points at a missing file.
    expect(readmeText).not.toContain('1-trust-certificate.cmd')

    // The raw-TCP channel still ships the CA and its trust script.
    const certificate = { name: 'dsh-mobile-ca.cer', body: Buffer.from('der-fixture') }
    const tlsChannel = await createFixture({
      channels: [{ channel: 'remote', origin: 'https://192.0.2.10:3443' }],
      certificate,
    })
    const tlsZip = await downloadPackage(tlsChannel, '?channel=remote')
    expect(readStoredZip(tlsZip.rawBody).map(entry => entry.name)).toContain('dsh-mobile-ca.cer')
  })

  it('never reports a real handshake as trusted when the certificate is not', async () => {
    // The probe is the only thing that turns a configured 自动 HTTPS into a trusted
    // claim, so drive it against a live TLS listener with a certificate no platform
    // trusts: an untrusted leaf must come back as 'untrusted', and a closed port as
    // 'unreachable' — never as 'trusted'.
    const { leafCert, leafKey } = createTestTlsChain({ dnsNames: ['dsh.demo.nyat.app'] })
    const secure = createHttpsServer({ cert: leafCert, key: leafKey }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    const securePort = await listen(secure)
    cleanups.push(() => closeServer(secure))
    expect(await probeSakuraFrpTrustedCertificate(`https://127.0.0.1:${String(securePort)}`)).toBe('untrusted')

    const closed = createServer(() => undefined)
    const closedPort = await listen(closed)
    await closeServer(closed)
    expect(await probeSakuraFrpTrustedCertificate(`https://127.0.0.1:${String(closedPort)}`, 1_000)).toBe('unreachable')
    expect(await probeSakuraFrpTrustedCertificate('not a url', 1_000)).toBe('unreachable')
  })

  it('names every new failure code in the panel and the diagnostics', () => {
    const codes = [
      'sakurafrp_bound_domain_missing',
      'sakurafrp_bound_domain_invalid',
      'sakurafrp_entry_mode_invalid',
      'sakurafrp_config_unsupported',
      'sakurafrp_certificate_untrusted',
    ] as const
    for (const code of codes) {
      for (const locale of ['zh', 'en', 'it'] as const) {
        const text = diagnosticControllerAction(code, locale, 'fallback')
        expect(text, `${code} ${locale}`).not.toBe('fallback')
        expect(text.length, `${code} ${locale}`).toBeGreaterThan(10)
      }
      // The zh guidance exists and is Chinese, not an English fallback.
      expect(diagnosticControllerAction(code, 'zh', 'fallback')).toMatch(/[\u4e00-\u9fff]/u)
    }
    expect(diagnosticControllerAction('not_a_code', 'zh', 'fallback')).toBe('fallback')
    expect(isSakuraFrpRegistration('start proxy success')).toBe(true)
    expect(isSakuraFrpRegistration('login to server error: dial tcp failed')).toBe(false)
  })

  it('offers durable, independently revocable links, not a countdown, on the PC tab', () => {
    for (const locale of ['zh', 'en', 'it'] as const) {
      const copy = MOBILE_CONTROL_MESSAGES[locale] as Record<string, string>
      const pcCopy = Object.entries(copy).filter(([key]) => key.startsWith('pc'))
      expect(pcCopy.length).toBeGreaterThan(10)
      for (const [key, value] of pcCopy) {
        expect(value.trim(), `${locale}.${key}`).not.toBe('')
        // No five-minute or expiry-countdown wording survives on this tab.
        expect(value, `${locale}.${key}`).not.toMatch(/5\s*(分钟|minutes?|minuti)|五分钟|five[-\s]minutes?/iu)
      }
      // The list model: a create button, a per-link name and a two-step revoke.
      expect(copy.pcGenerateLink, locale).toBeTruthy()
      expect(copy.pcLinkLabelPlaceholder, locale).toBeTruthy()
      expect(copy.pcLinkRevoke, locale).toBeTruthy()
      expect(copy.pcLinkRevokeConfirm, locale).toBeTruthy()
      expect(copy.pcLinkDurable, locale).toMatch(/长期有效|stays valid|resta valido/iu)
      expect(copy.pcLinkDurable, locale).toMatch(/撤销|revok|revoc/iu)
      expect(copy.pcLinkReady, locale).toMatch(/已复制|copied|copiato/iu)
    }
    // The frozen strings the docs quote, and the retired single-link copy.
    expect(MOBILE_CONTROL_MESSAGES.zh.pcGenerateLink).toBe('生成新链接')
    expect(MOBILE_CONTROL_MESSAGES.zh.pcLinkDefaultLabel).toBe('访问链接')
    expect(MOBILE_CONTROL_MESSAGES.zh.pcLinkRevoke).toBe('撤销')
    expect(MOBILE_CONTROL_MESSAGES.zh.pcLinkRevokeConfirm).toBe('确认撤销')
    expect(MOBILE_CONTROL_MESSAGES.zh.pcLinkLimit).toContain('{max}')
    expect(MOBILE_CONTROL_MESSAGES.zh.pcLinkRevokedDevices).toContain('{count}')
    for (const retired of ['pcRegenerateLink', 'pcCopyLink', 'pcLinkRegenerated'] as const) {
      for (const locale of ['zh', 'en', 'it'] as const) {
        expect(MOBILE_CONTROL_MESSAGES[locale], `${locale}.${retired}`).not.toHaveProperty(retired)
      }
    }
    expect(MOBILE_CONTROL_MESSAGES.zh.sakuraEntryMode).toBe('公网入口证书')
    expect(MOBILE_CONTROL_MESSAGES.zh.sakuraEntryModeTls).toBe('插件自签证书（需在电脑上安装）')
    expect(MOBILE_CONTROL_MESSAGES.zh.sakuraEntryModeAutoHttps).toBe('SakuraFrp 自动 HTTPS（无需安装）')
    expect(MOBILE_CONTROL_MESSAGES.zh.sakuraBoundDomain).toBe('已绑定的子域名')
    // The trusted and untrusted notes are distinct, so the card can pick by the probe.
    for (const locale of ['zh', 'en', 'it'] as const) {
      const copy = MOBILE_CONTROL_MESSAGES[locale] as Record<string, string>
      expect(copy.sakuraTrustedNote, locale).not.toBe(copy.sakuraUntrustedNote)
      expect(copy.sakuraUntrustedNote, locale).toMatch(/尚未|not verified|non risulta/iu)
    }
  })

  it('answers the SakuraFrp configure route with the triple and never the token', async () => {
    const mounted = await mountPlugin()
    const token = 'sk-route-token-0123456789'
    const saved = await invokeRoute(mounted, 'POST', `${LOCAL_ADMIN_PREFIX}/remote/sakurafrp/token`, JSON.stringify({ token }))
    expect(saved.status, saved.body).toBe(200)
    expect(saved.body).not.toContain(token)

    const configured = await invokeRoute(mounted, 'POST', `${LOCAL_ADMIN_PREFIX}/remote/sakurafrp/configure`, JSON.stringify({
      tunnelId: 114_514,
      entryMode: 'autoHttps',
      boundDomain: 'dsh.demo.nyat.app',
    }))
    expect(configured.status, configured.body).toBe(200)
    const payload = JSON.parse(configured.body) as { providers: { sakurafrp: Record<string, unknown> } }
    expect(payload.providers.sakurafrp).toMatchObject({
      entryMode: 'autoHttps',
      boundDomain: 'dsh.demo.nyat.app',
      trustedEntry: true,
    })
    expect(payload.providers.sakurafrp.configuration).toMatchObject({
      tokenSet: true,
      tunnelId: 114_514,
      entryMode: 'autoHttps',
      boundDomain: 'dsh.demo.nyat.app',
    })
    expect(configured.body).not.toContain(token)
    expect(configured.body).not.toContain('sk-route-token')

    // A panel typo is a 400 with the code the card already translates.
    const badDomain = await invokeRoute(mounted, 'POST', `${LOCAL_ADMIN_PREFIX}/remote/sakurafrp/configure`, JSON.stringify({
      tunnelId: 114_514,
      entryMode: 'autoHttps',
      boundDomain: 'Not A Domain',
    }))
    expect(badDomain.status).toBe(400)
    expect(JSON.parse(badDomain.body)).toStrictEqual({ error: 'sakurafrp_bound_domain_invalid' })
    const badMode = await invokeRoute(mounted, 'POST', `${LOCAL_ADMIN_PREFIX}/remote/sakurafrp/configure`, JSON.stringify({
      tunnelId: 114_514,
      entryMode: 'https',
    }))
    expect(badMode.status).toBe(400)
    expect(JSON.parse(badMode.body)).toStrictEqual({ error: 'sakurafrp_entry_mode_invalid' })
    // A blank field keeps the stored value instead of resetting the mode.
    const kept = await invokeRoute(mounted, 'POST', `${LOCAL_ADMIN_PREFIX}/remote/sakurafrp/configure`, JSON.stringify({ tunnelId: 114_514 }))
    expect(kept.status).toBe(200)
    expect((JSON.parse(kept.body) as { providers: { sakurafrp: Record<string, unknown> } }).providers.sakurafrp)
      .toMatchObject({ entryMode: 'autoHttps', boundDomain: 'dsh.demo.nyat.app' })
    // The tunnel listing never echoes the token either.
    const tunnels = await invokeRoute(mounted, 'GET', `${LOCAL_ADMIN_PREFIX}/remote/sakurafrp/tunnels`)
    expect(tunnels.body).not.toContain(token)
    // Booting the real plugin and then making six admin calls outlives the default
    // budget once the rest of the suite is competing for the same machine.
  }, 25_000)
})
