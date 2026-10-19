/**
 * Independent PC client smoke (PC-CLIENT-SPEC.md).
 *
 * Boots a real MobileAccessGateway over TLS in front of a fake upstream DSH,
 * mounts the plugin's three loopback admin prefixes exactly the way
 * `src/plugin.ts` registers them, and drives Chromium through a CONNECT proxy
 * (the pattern of scripts/smoke-browser-auth-cookies.mjs) so TLS and Cookies stay
 * the browser's own work.
 *
 * Evidence produced here, none of it asserted from intent:
 *   1. PC entry page / PWA assets / desktop layer over the real HTTPS listener.
 *   2. The customization layer a desktop client and a touch client actually fetch,
 *      captured from real network requests.
 *   3. A pairing submitted on the PC entry page, the Cookie it sets, and the
 *      second use of the same key.
 *   4. The install package downloaded from the admin route, parsed, extracted with
 *      PowerShell Expand-Archive and scanned for secrets and local paths.
 *
 * Set `DSH_PC_SMOKE_KEEP_PACKAGE=<directory>` to keep a copy of the downloaded
 * package (CI uploads it as the desktop artifact); the copy carries the fixture
 * origin and is evidence, not a package to send to a friend.
 *
 * Requires `npm run build` first (it imports lib/index.mjs) and
 * `npx playwright install chromium --only-shell`.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { chromium } from 'playwright'
import selfsigned from 'selfsigned'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const { MobileAccessGateway, MobileAccessService, MemoryDeviceStore, parseGatewayConfig } =
  await import(pathToFileURL(resolve(mobileRoot, 'lib/index.mjs')).href)

const hostname = 'dsh.pc-client.test'
const AUTH = '/mobile-access'
const ADMIN = '/api/mobile-access'
const PC_ENTRY = `${AUTH}/pc`
const PC_SCRIPT = `${AUTH}/pc.js`
const PAIR_PATH = `${AUTH}/pair`
const MANIFEST_PATH = `${AUTH}/manifest.webmanifest`
const SERVICE_WORKER_PATH = `${AUTH}/pc-sw.js`
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SESSION_COOKIE_NAMES = ['__Host-dsh_ma_session', 'dsh_ma_session']

const directory = await mkdtemp(resolve(tmpdir(), 'dsh-mobile-pc-client-smoke-'))
const extracted = join(directory, 'extracted')
const packageFile = join(directory, 'dsh-mobile-pc.zip')
const proxySockets = new Set()
let gateway
let upstream
let admin
let browserProxy
let browser
let cases = 0

function crc32(body) {
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Parse a STORE-only ZIP from its central directory without using product code. */
function readStoredZip(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'ZIP end-of-central-directory record is missing')
  const total = archive.readUInt16LE(end + 10)
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryOffset = archive.readUInt32LE(end + 16)
  assert.equal(directoryOffset + directorySize, end, 'ZIP central directory does not end at the EOCD')
  const entries = []
  let cursor = directoryOffset
  for (let index = 0; index < total; index++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, `central directory header ${String(index)}`)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, `local header for ${name}`)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const body = archive.subarray(start, start + compressedSize)
    assert.equal(method, 0, `${name} is not stored`)
    assert.equal(uncompressedSize, compressedSize, `${name} stored size`)
    assert.equal(crc32(body), crc, `${name} CRC-32`)
    entries.push({ name, body })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  assert.equal(cursor, end, 'ZIP central directory entry count')
  return entries
}

function pngSize(body) {
  assert.ok(body.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature')
  assert.equal(body.subarray(12, 16).toString('ascii'), 'IHDR')
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) }
}

function httpsRequest(port, path, options = {}) {
  return new Promise((resolveRequest, reject) => {
    const outgoing = requestHttps({
      hostname: '127.0.0.1',
      port,
      servername: hostname,
      path,
      method: options.method ?? 'GET',
      headers: { host: `${hostname}:${String(port)}`, ...(options.headers ?? {}) },
      rejectUnauthorized: false,
      agent: false,
    }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolveRequest({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: rawBody.toString('utf8'),
          rawBody,
        })
      })
    })
    outgoing.once('error', reject)
    outgoing.end(options.body)
  })
}

function adminRequest(port, path, options = {}) {
  return new Promise((resolveRequest, reject) => {
    const body = options.body
    const headers = {
      host: `127.0.0.1:${String(port)}`,
      origin: `http://127.0.0.1:${String(port)}`,
      'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
      ...(options.headers ?? {}),
    }
    const outgoing = requestHttp({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false,
    }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolveRequest({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: rawBody.toString('utf8'),
          rawBody,
        })
      })
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

async function listFiles(root, prefix = '') {
  const found = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...await listFiles(root, name))
    else found.push(name)
  }
  return found
}

function sessionCookieFrom(headers) {
  for (const line of headers['set-cookie'] ?? []) {
    const pair = line.split(';', 1)[0] ?? ''
    const equals = pair.indexOf('=')
    if (equals > 0 && SESSION_COOKIE_NAMES.includes(pair.slice(0, equals))) {
      return { name: pair.slice(0, equals), value: pair.slice(equals + 1) }
    }
  }
  return undefined
}

async function openPairing(adminPort) {
  const response = await adminRequest(adminPort, `${ADMIN}/lan/pairing/open`, { method: 'POST', body: '{}' })
  assert.equal(response.status, 201, `pairing open returned ${String(response.status)}: ${response.body}`)
  const payload = JSON.parse(response.body)
  assert.equal(typeof payload.appKey, 'string')
  assert.equal(typeof payload.token, 'string')
  return payload
}

try {
  // ---------------------------------------------------------------- fixture --
  const graph = {
    rev: 'pc-client-smoke',
    entries: [{
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/plugins/layout.js',
      rev: 'pc-client-smoke',
      inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
    }],
  }
  const index = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"]=${JSON.stringify(graph)};</script></head><body><main>PC client upstream fixture</main></body></html>`
  upstream = createServer((request, response) => {
    if (new URL(request.url ?? '/', 'http://upstream.invalid').pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(index) })
      response.end(index)
      return
    }
    const body = 'globalThis.__pcSmokeFixture = true\n'
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  })
  await new Promise((resolveListen, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolveListen)
  })
  const upstreamPort = upstream.address().port
  const certificate = await selfsigned.generate([{ name: 'commonName', value: hostname }], { keyType: 'ec', algorithm: 'sha256' })
  const certFile = resolve(directory, 'certificate.pem')
  const keyFile = resolve(directory, 'key.pem')
  await writeFile(certFile, certificate.cert)
  await writeFile(keyFile, certificate.private, { mode: 0o600 })
  const desktopCssFile = resolve(directory, 'desktop.css')
  const desktopScriptFile = resolve(directory, 'desktop.js')
  const customCssFile = resolve(directory, 'mobile.css')
  const customScriptFile = resolve(directory, 'mobile.js')
  await writeFile(desktopCssFile, ':root { --pc-smoke-layer: desktop; }\n')
  await writeFile(desktopScriptFile, 'window.dshMobile?.registerDesktop?.(() => undefined)\n')
  await writeFile(customCssFile, ':root { --pc-smoke-layer: mobile; }\n')
  await writeFile(customScriptFile, 'window.dshMobile?.register?.(() => undefined)\n')
  const cordisContext = new Context()
  gateway = new MobileAccessGateway(parseGatewayConfig({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    publicAuthorities: [hostname],
    allowedCidrs: ['127.0.0.0/8'],
    stateFile: resolve(directory, `${randomUUID()}.json`),
    // The scenarios below open many pairing windows from one loopback address, so
    // the per-source attempt limit is raised for the fixture only.
    maxPairingAttempts: 50,
    customCssFile,
    customScriptFile,
    desktopCssFile,
    desktopScriptFile,
    tls: { mode: 'provided', certFile, keyFile },
  }), new MemoryDeviceStore(), new MobileAccessService(cordisContext))
  await gateway.start()
  const origin = gateway.address().origin
  const port = gateway.address().port
  await httpsRequest(port, `${AUTH}/health`)

  // The plugin registers the LAN prefix, the PC prefix (with its runtime channel
  // source) and the bare admin prefix; the longest match owns the request.
  const pcClient = {
    channels: async () => [{ channel: 'lan', origin }],
    certificate: async () => undefined,
  }
  const routes = [
    { prefix: `${ADMIN}/lan`, handler: gateway.localAdminRoute(`${ADMIN}/lan`).handler },
    { prefix: `${ADMIN}/pc`, handler: gateway.localAdminRoute(`${ADMIN}/pc`, () => true, pcClient).handler },
    { prefix: ADMIN, handler: gateway.localAdminRoute(ADMIN).handler },
  ]
  admin = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find(candidate => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`))
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not_found"}')
      return
    }
    Promise.resolve(route.handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{"error":"handler_failed"}')
    })
  })
  await new Promise((resolveListen, reject) => {
    admin.once('error', reject)
    admin.listen(0, '127.0.0.1', resolveListen)
  })
  const adminPort = admin.address().port

  // ------------------------------------------ 1. routes over real HTTPS ------
  assert.equal(gateway.access.pairingStatus().open, false, 'pairing window must start closed')
  const pcPage = await httpsRequest(port, PC_ENTRY, { headers: { accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' } })
  assert.equal(pcPage.status, 200, `GET ${PC_ENTRY} with no pairing window`)
  assert.equal(pcPage.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(pcPage.headers.vary, 'Accept-Language')
  assert.ok(pcPage.body.includes(`<html lang="zh-CN"`), 'PC page is localized from Accept-Language')
  assert.ok(pcPage.body.includes(PC_SCRIPT), 'PC page loads its own script route')
  assert.ok(pcPage.body.includes(MANIFEST_PATH), 'PC page links the manifest')
  assert.ok(pcPage.body.includes('pair-form'), 'PC page keeps the shared pairing form id')
  assert.ok(pcPage.headers['content-security-policy']?.includes("default-src 'self'"), 'PC page carries the strict CSP')
  assert.ok(!/(?:src|href)="https?:\/\//u.test(pcPage.body), 'PC page references no external asset')
  const pcScript = await httpsRequest(port, PC_SCRIPT, { headers: { accept: 'text/javascript', 'accept-language': 'en-US' } })
  assert.equal(pcScript.status, 200)
  assert.equal(pcScript.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.ok(pcScript.body.includes('/mobile-access/auth/pair'), 'PC script posts to the pairing route')
  assert.ok(pcScript.body.includes('403') && pcScript.body.includes('404'), 'PC script handles a closed pairing window')
  cases++

  const manifestResponse = await httpsRequest(port, MANIFEST_PATH)
  assert.equal(manifestResponse.status, 200)
  assert.ok(String(manifestResponse.headers['content-type']).startsWith('application/manifest+json'))
  const manifest = JSON.parse(manifestResponse.body)
  assert.equal(manifest.name, 'DSH Mobile')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.display, 'standalone')
  assert.deepEqual(manifest.icons.map(icon => `${icon.sizes}:${icon.purpose}`).sort(), ['192x192:any', '512x512:any', '512x512:maskable'])
  for (const icon of manifest.icons) {
    const iconResponse = await httpsRequest(port, icon.src)
    assert.equal(iconResponse.status, 200, `GET ${icon.src}`)
    assert.equal(iconResponse.headers['content-type'], 'image/png')
    const [width, height] = icon.sizes.split('x').map(Number)
    assert.deepEqual(pngSize(iconResponse.rawBody), { width, height }, icon.src)
  }
  cases++

  const serviceWorker = await httpsRequest(port, SERVICE_WORKER_PATH)
  assert.equal(serviceWorker.status, 200)
  assert.ok(String(serviceWorker.headers['content-type']).startsWith('text/javascript'))
  assert.equal(serviceWorker.headers['service-worker-allowed'], '/')
  assert.ok(!/respondWith\s*\(/u.test(serviceWorker.body), 'the fetch listener never calls respondWith')
  const serviceWorkerFile = resolve(directory, 'pc-sw-check.js')
  await writeFile(serviceWorkerFile, serviceWorker.body)
  const syntax = spawnSync(process.execPath, ['--check', serviceWorkerFile], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, `node --check: ${syntax.stderr}`)
  cases++

  const closedPair = await httpsRequest(port, PAIR_PATH, { headers: { accept: 'text/html' } })
  assert.equal(closedPair.status, 404, `${PAIR_PATH} stays 404 while no window is open`)
  cases++

  // --------------------------------------- 2 + 3. browser layers and pairing --
  // Route only this synthetic hostname to the loopback TLS fixture. The browser
  // still owns TLS and Cookie serialization; no machine DNS or proxy changes.
  browserProxy = createServer((_request, response) => { response.writeHead(403).end() })
  browserProxy.on('connect', (request, client, head) => {
    if (request.url !== `${hostname}:${String(port)}`) { client.destroy(); return }
    const remote = connect(port, '127.0.0.1')
    for (const socket of [client, remote]) {
      proxySockets.add(socket)
      socket.on('error', () => { client.destroy(); remote.destroy() })
      socket.once('close', () => { proxySockets.delete(socket); client.destroy(); remote.destroy() })
    }
    remote.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) remote.write(head)
      client.pipe(remote).pipe(client)
    })
  })
  await new Promise((resolveListen, reject) => {
    browserProxy.once('error', reject)
    browserProxy.listen(0, '127.0.0.1', resolveListen)
  })
  browser = await chromium.launch({
    headless: true,
    // 127.0.0.1 bypasses the proxy: the loopback origin is its own secure context
    // and needs no synthetic hostname.
    proxy: { server: `http://127.0.0.1:${String(browserProxy.address().port)}`, bypass: '127.0.0.1' },
  })
  const clientSource = await readFile(resolve(mobileRoot, 'lib/client.js'), 'utf8')
  const installLoaderShim = () => {
    window.__pcSmokeModules = {}
    window.__ModuleLoader__ = {
      load(entry) {
        window.__pcSmokeModules[entry.id] = entry.factory
        window.__pcSmokeLastFactory = entry.factory
      },
    }
  }
  const mountClient = async page => {
    await page.addScriptTag({ content: clientSource })
    return page.evaluate(() => {
      const factory = window.__pcSmokeModules['dsh-mobile'] ?? window.__pcSmokeLastFactory
      if (typeof factory !== 'function') throw new Error('the client bundle did not register a module factory')
      const cleanup = []
      const client = factory(name => (name === 'react' ? {} : {}))
      // The dedicated frontend always has a `connection` service; the bundle marks
      // it loopback-trusted on this origin, so the fixture supplies the same shape.
      const connection = { isLoopback: false }
      client.apply({
        effect: effect => { const dispose = effect(); if (typeof dispose === 'function') cleanup.push(dispose) },
        get: name => (name === 'connection' ? connection : undefined),
        slots: { inject: () => () => {}, register: () => () => {} },
      })
      window.__pcSmokeCleanup = cleanup
      return { isLoopback: connection.isLoopback }
    })
  }
  /** Wait for the entry page's service worker registration and report its scope. */
  const waitForServiceWorker = async page => {
    const deadline = Date.now() + 10_000
    let state = { supported: false, scopes: [], reason: '' }
    while (Date.now() < deadline) {
      state = await page.evaluate(async () => {
        if (navigator.serviceWorker === undefined) return { supported: false, scopes: [], reason: 'no navigator.serviceWorker' }
        const registrations = await navigator.serviceWorker.getRegistrations()
        return { supported: true, scopes: registrations.map(registration => registration.scope), reason: '' }
      })
      if (state.scopes.length > 0) return state
      await new Promise(resolveWait => setTimeout(resolveWait, 150))
    }
    // Report the browser's own reason instead of only the missing scope.
    state.reason = await page.evaluate(async () => {
      const path = document.documentElement.dataset.serviceWorkerPath
      try {
        await navigator.serviceWorker.register(path, { scope: '/' })
        return 'a manual register(path, { scope: \'/\' }) succeeded, so the entry page never registered it'
      } catch (error) {
        return String(error)
      }
    })
    return state
  }

  const observations = []
  for (const mode of ['desktop', 'touch']) {
    const context = await browser.newContext(mode === 'desktop'
      ? { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } }
      : { ignoreHTTPSErrors: true, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
    try {
      await context.addInitScript(installLoaderShim)
      const page = await context.newPage()
      const requests = []
      let documentStatus = 0
      page.on('request', request => {
        try { requests.push(new URL(request.url()).pathname) } catch { /* data: or about: */ }
      })
      page.on('response', response => {
        try {
          if (new URL(response.url()).pathname === '/') documentStatus = response.status()
        } catch { /* ignore */ }
      })
      const opened = await openPairing(adminPort)
      const entryUrl = `${origin}${PC_ENTRY}#key=${opened.appKey}`
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded' })
      await page.locator('#pair-form').waitFor({ state: 'visible', timeout: 15_000 })
      // The PC page is desktop-first: two columns at >=720 px, one column below.
      const layout = await page.evaluate(() => {
        const grid = document.querySelector('.grid')
        const cards = [...(grid?.children ?? [])]
        const guide = cards[0]?.getBoundingClientRect()
        const form = cards[1]?.getBoundingClientRect()
        return {
          columns: grid === null ? '' : getComputedStyle(grid).gridTemplateColumns,
          guideRight: guide?.right ?? -1,
          formLeft: form?.left ?? -1,
          guideBottom: guide?.bottom ?? -1,
          formTop: form?.top ?? -1,
          width: window.innerWidth,
        }
      })
      const touchPrimary = await page.evaluate(() => window.matchMedia('(hover: none), (pointer: coarse)').matches)
      const worker = await waitForServiceWorker(page)
      // The pairing code must not survive in the URL: the script clears the
      // fragment with history.replaceState before any submission.
      assert.equal(await page.evaluate(() => location.hash), '', `${mode}: the pairing fragment is cleared`)
      await page.locator('#pair-form button[type="submit"]').click()
      await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
      const cookies = await context.cookies(origin)
      const session = cookies.find(cookie => SESSION_COOKIE_NAMES.includes(cookie.name))
      assert.ok(session, `${mode}: pairing set a session Cookie (${cookies.map(cookie => cookie.name).join(', ')})`)
      assert.equal(documentStatus, 200, `${mode}: the PC page reaches the gateway's DSH document`)
      await page.waitForFunction(() => window.__DSH_MOBILE_FRONTEND__ === 'dedicated', undefined, { timeout: 15_000 })
      // The rewritten DSH document is what a browser installs from: it must declare
      // the manifest exactly once and carry the theme colour.
      const head = await page.evaluate(() => ({
        manifests: [...document.querySelectorAll('link[rel="manifest"]')].map(link => link.getAttribute('href')),
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
        bootManifest: typeof globalThis.__DSH_BOOT__,
      }))
      assert.deepEqual(head.manifests, [MANIFEST_PATH], `${mode}: the DSH document declares the manifest once`)
      assert.equal(head.themeColor, '#2563EB', `${mode}: the DSH document carries the theme colour`)
      assert.equal(head.bootManifest, 'object', `${mode}: the boot manifest stays parseable`)

      const mount = await mountClient(page)
      assert.equal(mount.isLoopback, true, `${mode}: the dedicated frontend marks its gateway connection trusted`)
      const layerPaths = ['/mobile-access/desktop.css', '/mobile-access/desktop.js', '/mobile-access/custom.css', '/mobile-access/custom.js']
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !layerPaths.some(path => requests.includes(path))) {
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
      const seen = layerPaths.filter(path => requests.includes(path))
      observations.push({ mode, touchPrimary, seen, layout, session: session.name, cookieNames: cookies.map(cookie => cookie.name), documentStatus, worker })
      cases++
    } finally {
      await context.close()
    }
  }
  const desktopObservation = observations.find(entry => entry.mode === 'desktop')
  const touchObservation = observations.find(entry => entry.mode === 'touch')
  assert.equal(desktopObservation.touchPrimary, false, 'desktop context is not touch-primary')
  assert.equal(touchObservation.touchPrimary, true, 'touch context is touch-primary')
  assert.deepEqual(desktopObservation.seen.sort(), ['/mobile-access/desktop.css', '/mobile-access/desktop.js'])
  assert.deepEqual(touchObservation.seen.sort(), ['/mobile-access/custom.css', '/mobile-access/custom.js'])
  assert.ok(desktopObservation.layout.columns.split(' ').length >= 2, `desktop layout: ${desktopObservation.layout.columns}`)
  assert.ok(desktopObservation.layout.guideRight <= desktopObservation.layout.formLeft + 1,
    `desktop layout guidance is beside the form (${String(desktopObservation.layout.guideRight)} <= ${String(desktopObservation.layout.formLeft)})`)
  assert.equal(touchObservation.layout.columns.split(' ').length, 1, `touch layout: ${touchObservation.layout.columns}`)
  assert.ok(touchObservation.layout.guideBottom <= touchObservation.layout.formTop + 1,
    `touch layout stacks the guidance above the form (${String(touchObservation.layout.guideBottom)} <= ${String(touchObservation.layout.formTop)})`)

  // ---------------------------------- 3b. every code form a person can paste ---
  // The owner copies the app key or the whole entry link from the panel, so the page
  // must accept both, and a code-less link must be explained instead of posted.
  const submitCode = async (context, code) => {
    const page = await context.newPage()
    const posts = []
    page.on('request', request => {
      try {
        const pathname = new URL(request.url()).pathname
        if (pathname === `${AUTH}/auth/pair`) posts.push(pathname)
      } catch { /* data: or about: */ }
    })
    await page.goto(`${origin}${PC_ENTRY}`, { waitUntil: 'domcontentloaded' })
    await page.locator('#pair-form').waitFor({ state: 'visible', timeout: 15_000 })
    if (code !== undefined) await page.fill('#pair-token', code)
    await page.locator('#pair-form button[type="submit"]').click()
    return { page, posts }
  }

  const zhContext = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9' } })
  let freshCodeTtlMs = 0
  try {
    const opened = await openPairing(adminPort)
    const remaining = opened.expiresAt - Date.now()
    freshCodeTtlMs = remaining
    assert.ok(remaining > 4.5 * 60_000 && remaining <= 5 * 60_000 + 5_000, `a fresh code is valid for about five minutes (${String(Math.round(remaining / 1000))}s)`)
    const { page } = await submitCode(zhContext, opened.appKey)
    await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
    const afterAppKey = await zhContext.cookies(origin)
    const appKeySession = afterAppKey.find(cookie => SESSION_COOKIE_NAMES.includes(cookie.name))
    assert.ok(appKeySession, 'pasting the app key pairs the PC')
    // The same code cannot pair a second time: the page now says invalid/expired/used.
    const again = await submitCode(zhContext, opened.appKey)
    await again.page.waitForFunction(() => {
      const status = document.getElementById('pair-status')
      return status !== null && status.textContent.trim() !== ''
    }, undefined, { timeout: 15_000 })
    const consumedMessage = (await again.page.locator('#pair-status').textContent()).trim()
    assert.ok(consumedMessage.includes('配对码无效、已过期或已被使用'), `consumed-code message: ${consumedMessage}`)
    const afterReplay = await zhContext.cookies(origin)
    assert.equal(afterReplay.find(cookie => SESSION_COOKIE_NAMES.includes(cookie.name))?.value, appKeySession.value,
      'a consumed code does not issue a new session')
    cases++
  } finally {
    await zhContext.close()
  }

  const linkContext = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    const opened = await openPairing(adminPort)
    const link = `${origin}${PC_ENTRY}#key=${opened.appKey}`
    const { page } = await submitCode(linkContext, link)
    await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
    const cookies = await linkContext.cookies(origin)
    assert.ok(cookies.some(cookie => SESSION_COOKIE_NAMES.includes(cookie.name)), 'pasting the whole entry link pairs the PC')
    // A link without a code is explained, never posted.
    const bare = await submitCode(linkContext, `${origin}${PC_ENTRY}`)
    await bare.page.waitForFunction(() => {
      const status = document.getElementById('pair-status')
      return status !== null && status.textContent.trim() !== ''
    }, undefined, { timeout: 15_000 })
    const bareMessage = (await bare.page.locator('#pair-status').textContent()).trim()
    assert.ok(/invalid, expired or already used/i.test(bareMessage), `code-less link message: ${bareMessage}`)
    assert.deepEqual(bare.posts, [], 'a link without a code never posts to the pairing route')
    cases++
  } finally {
    await linkContext.close()
  }

  // The page must render the gateway's rate limit as "too many attempts". The
  // gateway's own 429 is covered at HTTP level in tests/pc-client.test.ts; here the
  // response is stubbed so the browser branch is deterministic.
  const limitedContext = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    const opened = await openPairing(adminPort)
    const page = await limitedContext.newPage()
    await page.route(`**${AUTH}/auth/pair`, route => route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: '{"error":"rate_limited"}',
    }))
    await page.goto(`${origin}${PC_ENTRY}`, { waitUntil: 'domcontentloaded' })
    await page.locator('#pair-form').waitFor({ state: 'visible', timeout: 15_000 })
    await page.fill('#pair-token', opened.appKey)
    await page.locator('#pair-form button[type="submit"]').click()
    await page.waitForFunction(() => {
      const status = document.getElementById('pair-status')
      return status !== null && status.textContent.trim() !== ''
    }, undefined, { timeout: 15_000 })
    const limitedMessage = (await page.locator('#pair-status').textContent()).trim()
    assert.ok(/too many attempts/i.test(limitedMessage), `429 message: ${limitedMessage}`)
    assert.equal(new URL(page.url()).pathname, PC_ENTRY, 'a rate-limited submission stays on the entry page')
    cases++
  } finally {
    await limitedContext.close()
  }
  // The PWA install path. Chromium refuses a service worker script fetched over a
  // certificate the browser has only been told to ignore, so the root scope is
  // measured on a trustworthy loopback origin, where the browser registers the very
  // same script and the very same `Service-Worker-Allowed: /` header decides the scope.
  const plainGateway = new MobileAccessGateway(parseGatewayConfig({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    allowedCidrs: ['127.0.0.0/8'],
    stateFile: resolve(directory, `${randomUUID()}.json`),
    customCssFile,
    customScriptFile,
    desktopCssFile,
    desktopScriptFile,
    tls: { mode: 'disabled' },
  }), new MemoryDeviceStore(), new MobileAccessService(new Context()))
  await plainGateway.start()
  const plainOrigin = plainGateway.address().origin
  const plainContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  let plainWorker = { scopes: [], reason: '' }
  try {
    const plainPage = await plainContext.newPage()
    await plainPage.goto(`${plainOrigin}${PC_ENTRY}`, { waitUntil: 'domcontentloaded' })
    await plainPage.locator('#pair-form').waitFor({ state: 'visible', timeout: 15_000 })
    plainWorker = await waitForServiceWorker(plainPage)
    assert.equal(plainWorker.supported, true, 'the loopback origin is a secure context')
    assert.ok(plainWorker.scopes.includes(`${plainOrigin}/`),
      `service worker scope: ${plainWorker.scopes.join(', ') || '(none)'} · ${plainWorker.reason}`)
    assert.ok(desktopObservation.worker.supported, 'the TLS origin is also a secure context')
    cases++
  } finally {
    await plainContext.close()
    await plainGateway.close()
  }

  // The replay of a consumed key must be refused and shown as a message.
  const replayContext = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    const replayPage = await replayContext.newPage()
    const replayRequests = []
    replayPage.on('response', response => {
      try {
        const url = new URL(response.url())
        if (url.pathname === `${AUTH}/auth/pair`) replayRequests.push(response.status())
      } catch { /* ignore */ }
    })
    const consumed = await openPairing(adminPort)
    const pairResponse = await httpsRequest(port, `${AUTH}/auth/pair`, {
      method: 'POST',
      headers: {
        origin,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(JSON.stringify({ token: consumed.token, label: 'PC smoke' }))),
      },
      body: JSON.stringify({ token: consumed.token, label: 'PC smoke' }),
    })
    assert.equal(pairResponse.status, 201, 'first use of a fresh key pairs')
    await replayPage.goto(`${origin}${PC_ENTRY}#key=${consumed.appKey}`, { waitUntil: 'domcontentloaded' })
    await replayPage.locator('#pair-form').waitFor({ state: 'visible', timeout: 15_000 })
    await replayPage.locator('#pair-form button[type="submit"], #pair-form button').first().click()
    await replayPage.waitForFunction(() => {
      const status = document.getElementById('pair-status')
      return status !== null && status.textContent.trim() !== ''
    }, undefined, { timeout: 15_000 })
    const message = (await replayPage.locator('#pair-status').textContent()).trim()
    const replayCookies = await replayContext.cookies(origin)
    assert.ok(replayRequests.some(status => status === 401 || status === 403 || status === 404), `replay status: ${replayRequests.join(',')}`)
    assert.ok(!replayCookies.some(cookie => SESSION_COOKIE_NAMES.includes(cookie.name)), 'a replayed key sets no session Cookie')
    assert.ok(/invalid, expired or already used/i.test(message), `the replay shows the rejected-code message: ${message}`)
    cases++
  } finally {
    await replayContext.close()
  }

  // ------------------------------------------------- 4. the install package --
  const info = await adminRequest(adminPort, `${ADMIN}/pc/info`)
  assert.equal(info.status, 200)
  const infoPayload = JSON.parse(info.body)
  assert.equal(infoPayload.entryPath, PC_ENTRY)
  assert.equal(infoPayload.packagePath, `${ADMIN}/pc/package`)
  assert.equal(infoPayload.certificate.available, false)
  assert.deepEqual(infoPayload.channels, [{ channel: 'lan', origin, entryUrl: `${origin}${PC_ENTRY}` }])
  const download = await adminRequest(adminPort, `${ADMIN}/pc/package?channel=lan`)
  assert.equal(download.status, 200, `package body: ${download.body.slice(0, 200)}`)
  assert.equal(download.headers['content-type'], 'application/zip')
  assert.equal(download.headers['content-disposition'], 'attachment; filename="dsh-mobile-pc.zip"')
  await writeFile(packageFile, download.rawBody)
  const keepPackage = process.env.DSH_PC_SMOKE_KEEP_PACKAGE
  if (keepPackage !== undefined && keepPackage !== '') {
    await mkdir(keepPackage, { recursive: true })
    const kept = join(keepPackage, 'dsh-mobile-pc.zip')
    await writeFile(kept, download.rawBody)
    console.log(`kept package: ${kept} (${String(download.rawBody.length)} bytes, fixture origin ${origin})`)
  }
  const zipEntries = readStoredZip(download.rawBody)
  const zipNames = zipEntries.map(entry => entry.name)
  assert.ok(zipNames.some(name => name.startsWith('README-')), `ZIP inventory: ${zipNames.join(', ')}`)
  assert.ok(zipNames.includes('2-open-dsh.cmd'))
  assert.ok(zipNames.includes('open-dsh.url'))
  cases++

  await mkdir(extracted, { recursive: true })
  const shell = ['pwsh', 'powershell'].find(candidate =>
    spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0)
  assert.ok(shell !== undefined, 'PowerShell is required for the Expand-Archive step')
  const expand = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${packageFile}' -DestinationPath '${extracted}' -Force`], { encoding: 'utf8' })
  assert.equal(expand.status, 0, `Expand-Archive failed: ${expand.stderr}`)
  const extractedFiles = await listFiles(extracted)
  assert.deepEqual([...extractedFiles].sort(), [...zipNames].sort(), 'Expand-Archive inventory matches the ZIP')
  for (const name of extractedFiles) {
    const body = await readFile(join(extracted, name))
    if (name.endsWith('.cmd')) {
      assert.ok(/^[\x09\x0d\x0a\x20-\x7e]*$/u.test(body.toString('latin1')), `${name} is not printable ASCII`)
      assert.ok(body.includes(Buffer.from('\r\n')), `${name} has no CRLF endings`)
      assert.ok(!body.toString('latin1').replaceAll('\r\n', '').includes('\n'), `${name} has a bare LF`)
    }
    const readme = zipNames.find(candidate => candidate.startsWith('README-'))
    if (name === readme) assert.ok(body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${name} has no UTF-8 BOM`)
  }
  cases++

  const pairing = await openPairing(adminPort)
  const paired = await httpsRequest(port, `${AUTH}/auth/pair`, {
    method: 'POST',
    headers: {
      origin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(JSON.stringify({ token: pairing.token, label: 'leak probe' }))),
    },
    body: JSON.stringify({ token: pairing.token, label: 'leak probe' }),
  })
  assert.equal(paired.status, 201)
  const deviceCookie = (paired.headers['set-cookie'] ?? []).map(line => line.split(';', 1)[0]).find(line => line?.startsWith('dsh_ma_device=')) ?? ''
  const deviceToken = deviceCookie.slice('dsh_ma_device='.length)
  assert.notEqual(deviceToken, '')
  const secrets = [
    Buffer.from(pairing.token), Buffer.from(pairing.appKey), Buffer.from(deviceToken),
    Buffer.from(directory),
  ]
  for (const name of extractedFiles) {
    const body = await readFile(join(extracted, name))
    for (const secret of secrets) {
      assert.ok(!body.includes(secret), `${name} leaks ${secret.toString('utf8').slice(0, 10)}…`)
    }
    assert.ok(!/[A-Za-z]:\\/u.test(body.toString('latin1')), `${name} contains a Windows absolute path`)
    assert.ok(!body.toString('latin1').includes(resolve(tmpdir())), `${name} contains an owner-local path`)
  }
  const remoteChannel = await adminRequest(adminPort, `${ADMIN}/pc/package?channel=remote`)
  assert.equal(remoteChannel.status, 409)
  assert.deepEqual(JSON.parse(remoteChannel.body), { error: 'channel_unavailable' })
  cases++

  // -------------------------------------------- 6. adversarial spot checks ---
  const revokeContext = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    const revokePage = await revokeContext.newPage()
    const opened = await openPairing(adminPort)
    await revokePage.goto(`${origin}${PC_ENTRY}#key=${opened.appKey}`, { waitUntil: 'domcontentloaded' })
    await revokePage.locator('#pair-form').waitFor({ state: 'visible', timeout: 15_000 })
    await revokePage.locator('#pair-form button[type="submit"]').click()
    await revokePage.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
    const devicesResponse = await adminRequest(adminPort, `${ADMIN}/lan/devices`)
    assert.equal(devicesResponse.status, 200)
    const devices = JSON.parse(devicesResponse.body).devices
    assert.ok(devices.length > 0, 'the paired PC is listed as a device')
    for (const device of devices) {
      const revoked = await adminRequest(adminPort, `${ADMIN}/lan/devices/revoke`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: device.id }),
      })
      assert.equal(revoked.status, 200, `revoke ${device.id}: ${revoked.body}`)
    }
    await revokePage.reload({ waitUntil: 'domcontentloaded' })
    await revokePage.waitForFunction(() => location.pathname !== '/', undefined, { timeout: 15_000 })
    assert.equal(new URL(revokePage.url()).pathname, `${AUTH}/login`, 'a revoked PC is sent to the reauthentication page')
    await revokePage.locator('#login-failed').waitFor({ state: 'visible', timeout: 15_000 })
    cases++
  } finally {
    await revokeContext.close()
  }

  const externalInfo = await httpsRequest(port, `${ADMIN}/pc/info`)
  assert.equal(externalInfo.status, 404, 'the external listener refuses the admin prefix')
  // No request data may reach the entry document: a query string never matches the
  // route and the body must not echo the probe either way.
  const probed = await httpsRequest(port, `${PC_ENTRY}?probe=%3Cscript%3Epc-smoke%3C%2Fscript%3E`, { headers: { accept: 'text/html' } })
  assert.notEqual(probed.status, 200, `a query string is not served as the PC page (${String(probed.status)})`)
  assert.ok(!probed.body.includes('pc-smoke'), 'the PC entry document never echoes request data')
  const foreignHost = await httpsRequest(port, PC_ENTRY, { headers: { accept: 'text/html', host: 'attacker.example' } })
  assert.notEqual(foreignHost.status, 200, `an unknown Host is not served the PC page (${String(foreignHost.status)})`)
  const rebound = await adminRequest(adminPort, `${ADMIN}/pc/info`, { headers: { host: 'attacker.example' } })
  assert.equal(rebound.status, 403, 'DNS-rebinding Host is refused')
  const crossSite = await adminRequest(adminPort, `${ADMIN}/pc/package`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403, 'a cross-site caller is refused')
  cases++

  console.log(`PC client smoke passed (${String(cases)} HTTPS Chromium scenarios).`)
  console.log(`layers: desktop=${desktopObservation.seen.join(',')} touch=${touchObservation.seen.join(',')}`)
  console.log(`service worker: loopback scope=${plainWorker.scopes.join(',')} · TLS origin=${desktopObservation.worker.scopes.join(',') || `refused by Chromium (${desktopObservation.worker.reason.slice(0, 90)}…)`}`)
  console.log(`pairing: session=${desktopObservation.session} cookies=${desktopObservation.cookieNames.join(',')} desktopColumns=${desktopObservation.layout.columns} touchColumns=${touchObservation.layout.columns}`)
  console.log(`pairing code: fresh window ${String(Math.round(freshCodeTtlMs / 1000))}s; app key, entry link and single-use replay all exercised in the browser`)
  console.log(`adversarial: probedQuery=${String(probed.status)} foreignHost=${String(foreignHost.status)} reboundHost=${String(rebound.status)} crossSite=${String(crossSite.status)} externalAdmin=${String(externalInfo.status)}`)
} finally {
  await browser?.close()
  for (const socket of proxySockets) socket.destroy()
  if (browserProxy !== undefined) browserProxy.closeAllConnections()
  await gateway?.close()
  const closeServer = server => new Promise(resolveClose => {
    if (server === undefined || !server.listening) { resolveClose(); return }
    server.closeAllConnections()
    server.close(() => resolveClose())
  })
  await closeServer(browserProxy)
  await closeServer(admin)
  await closeServer(upstream)
  const absolute = resolve(directory)
  if (dirname(absolute) === resolve(tmpdir()) && basename(absolute).startsWith('dsh-mobile-pc-client-smoke-')) {
    await rm(absolute, { recursive: true, force: true })
    if (existsSync(absolute)) throw new Error(`owned temporary directory was not removed: ${absolute}`)
  }
}
