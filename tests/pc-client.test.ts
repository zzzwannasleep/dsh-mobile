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
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizePairingToken } from '../src/access.js'
import { extractPairingToken } from '../src/auth-pages.js'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessService } from '../src/extensions.js'
import { MobileAccessGateway, type PcClientChannel, type PcClientSource } from '../src/gateway.js'
import { LOCAL_ADMIN_PREFIX, DEVICE_COOKIE, SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'

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
}

interface PcFixtureOptions {
  readonly channels?: readonly PcClientChannel[]
  readonly certificate?: { readonly name: string; readonly body: Buffer }
  /** Pairing attempts allowed per loopback source; raised for the multi-form tests. */
  readonly maxPairingAttempts?: number
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
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const body = options.body
    const headers = { ...options.headers }
    if (body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const outgoing = requestHttp({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers,
      agent: false,
    }, (response) => {
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
  const gateway = new MobileAccessGateway(parseGatewayConfig(baseGatewayOptions(directory, upstreamPort, {
    // The pairing-form tests open many windows from one loopback address.
    maxPairingAttempts: options.maxPairingAttempts ?? 50,
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
  }
}

function adminHeaders(fixture: PcFixture, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${String(fixture.adminPort)}`,
    origin: `http://127.0.0.1:${String(fixture.adminPort)}`,
    'sec-fetch-site': 'same-origin',
    ...extra,
  }
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

async function pairBrowser(fixture: PcFixture, token: string): Promise<HttpResult> {
  return request(fixture.port, '/mobile-access/auth/pair', {
    method: 'POST',
    headers: {
      host: new URL(fixture.origin).host,
      origin: fixture.origin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
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
