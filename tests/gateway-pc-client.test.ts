import { randomUUID } from 'node:crypto'
import { request as requestHttp, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway, parseMobileBootPlan, rewriteMobileIndex } from '../src/gateway.js'
import { MemoryDeviceStore } from '../src/storage.js'

interface HttpResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Start the dedicated gateway with an intentionally dead upstream: every route
 * covered here is answered by the gateway itself, before any proxying.
 */
async function startGateway(): Promise<MobileAccessGateway> {
  const resolved = parseGatewayConfig({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: 'http://127.0.0.1:9',
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(tmpdir(), `dsh-mobile-pc-${randomUUID()}.json`),
    tls: { mode: 'disabled' },
  })
  const instance = new MobileAccessGateway(resolved, new MemoryDeviceStore())
  await instance.start()
  cleanups.push(() => instance.close())
  return instance
}

async function get(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = requestHttp({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('error', reject)
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

function index(entries: unknown[]): string {
  return `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body></body></html>`
}

const BOOT_ENTRIES = [
  { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
  { id: '@deepseek-ai/dsh-client-ui-theme', url: '/theme.js', rev: 'theme' },
  {
    id: '@deepseek-ai/dsh-client-ui-layout',
    url: '/layout.js',
    rev: 'layout',
    inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
  },
  { id: '@deepseek-ai/dsh-client-ui-conversation', url: '/conversation.js', rev: 'conversation' },
]

describe('PC entry page routes', () => {
  it('serves the desktop entry page to an unauthenticated browser', async () => {
    const instance = await startGateway()
    const result = await get(instance.address().port, '/mobile-access/pc')
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(String(result.headers.vary)).toContain('Accept-Language')
    expect(result.body.byteLength).toBeGreaterThan(200)
    expect(result.body.toString('utf8')).toContain('</html>')
  })

  it('localizes the entry page from Accept-Language', async () => {
    const instance = await startGateway()
    const port = instance.address().port
    const zh = await get(port, '/mobile-access/pc', { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })
    const en = await get(port, '/mobile-access/pc', { headers: { 'accept-language': 'en-US,en;q=0.9' } })
    expect(zh.status).toBe(200)
    expect(en.status).toBe(200)
    expect(zh.body.equals(en.body)).toBe(false)
  })

  it('keeps pair.js behind the pairing window while pc.js stays available', async () => {
    const instance = await startGateway()
    const port = instance.address().port
    // No pairing window is open, so the phone page's script is not served.
    expect((await get(port, '/mobile-access/pair.js')).status).toBe(404)
    const script = await get(port, '/mobile-access/pc.js')
    expect(script.status).toBe(200)
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(script.body.byteLength).toBeGreaterThan(100)
  })

  it('does not answer non-GET requests to the entry documents', async () => {
    const instance = await startGateway()
    const result = await get(instance.address().port, '/mobile-access/pc', { method: 'POST' })
    // The exact code comes from the trust gate (403) or the unknown-route guard
    // (404); either way the document is never served for a mutation.
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(result.status).toBeLessThan(500)
  })
})

describe('installable web app routes', () => {
  it('serves the manifest rooted at the origin', async () => {
    const instance = await startGateway()
    const result = await get(instance.address().port, '/mobile-access/manifest.webmanifest')
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('application/manifest+json; charset=utf-8')
    expect(result.headers['cache-control']).toBe('no-cache')
    const manifest = JSON.parse(result.body.toString('utf8')) as {
      start_url: string
      scope: string
      icons: Array<{ src: string }>
    }
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    for (const icon of manifest.icons) expect(icon.src.startsWith('/mobile-access/pwa/')).toBe(true)
  })

  it('serves the service worker from the root scope and forbids caching it', async () => {
    const instance = await startGateway()
    const result = await get(instance.address().port, '/mobile-access/pc-sw.js')
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(result.headers['service-worker-allowed']).toBe('/')
    expect(result.headers['cache-control']).toBe('no-cache')
  })

  it('serves install icons as PNG bytes and 404s unknown icons', async () => {
    const instance = await startGateway()
    const port = instance.address().port
    const manifest = await get(port, '/mobile-access/manifest.webmanifest')
    const parsed = JSON.parse(manifest.body.toString('utf8')) as { icons: Array<{ src: string }> }
    expect(parsed.icons.length).toBeGreaterThanOrEqual(3)
    for (const icon of parsed.icons) {
      const result = await get(port, icon.src)
      expect(result.status).toBe(200)
      expect(result.headers['content-type']).toBe('image/png')
      expect(result.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
    }
    expect((await get(port, '/mobile-access/pwa/icon-64.png')).status).toBe(404)
  })
})

describe('installable served document', () => {
  it('injects the manifest link and theme color exactly once', () => {
    const output = rewriteMobileIndex(index(BOOT_ENTRIES))
    expect(output.split('rel="manifest"').length - 1).toBe(1)
    expect(output).toContain('<link rel="manifest" href="/mobile-access/manifest.webmanifest">')
    expect(output.split('name="theme-color"').length - 1).toBe(1)
    const head = output.indexOf('</head>')
    expect(output.indexOf('rel="manifest"')).toBeLessThan(head)
  })

  it('leaves a document that already declares the manifest alone', () => {
    const upstream = index(BOOT_ENTRIES).replace(
      '</head>',
      '<link rel="manifest" href="/mobile-access/manifest.webmanifest"></head>',
    )
    const output = rewriteMobileIndex(upstream)
    expect(output.split('rel="manifest"').length - 1).toBe(1)
  })

  it('keeps the rewritten boot manifest parseable', () => {
    const output = rewriteMobileIndex(index(BOOT_ENTRIES))
    const plan = parseMobileBootPlan(output, [])
    expect(plan.entries.length).toBe(BOOT_ENTRIES.length)
    expect(output).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
  })
})
