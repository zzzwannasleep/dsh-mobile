/**
 * Hosts a pinned GitHub release download may redirect to.
 *
 * `github.com/<owner>/<repo>/releases/download/<tag>/<asset>` does not serve the bytes itself: it
 * answers 302 with a signed URL on a release-asset host. A fetch configured with
 * `redirect: 'error'` fails that hop as `TypeError: fetch failed` (cause: `unexpected redirect`)
 * before a single byte is transferred, which is exactly how the cloudflared component could never
 * install. Following one validated hop keeps the origin restriction while allowing the shape
 * every GitHub release download uses.
 */
import { EnvHttpProxyAgent, type Dispatcher } from 'undici'

const RELEASE_ASSET_HOSTS: readonly string[] = Object.freeze([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])

let proxyAgent: EnvHttpProxyAgent | undefined
/**
 * Component downloads (GitHub releases) often need the machine's configured HTTP
 * proxy: Node's global fetch ignores proxy environment variables unless a
 * dispatcher is supplied. The agent reads HTTPS_PROXY/HTTP_PROXY/ALL_PROXY and
 * NO_PROXY exactly like curl does, and is created lazily at most once.
 */
function proxyDispatcher(): Dispatcher | undefined {
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  if (!names.some(name => (process.env[name] ?? '') !== '')) return undefined
  proxyAgent ??= new EnvHttpProxyAgent()
  return proxyAgent
}

/** Fetch with the environment's proxy dispatcher attached when one is configured. */
export function componentFetch(url: string, init: Omit<RequestInit, 'dispatcher'> & { dispatcher?: Dispatcher } = {}): Promise<Response> {
  const dispatcher = init.dispatcher ?? proxyDispatcher()
  return fetch(url, (dispatcher === undefined ? init : { ...init, dispatcher }) as RequestInit)
}

/** Input for {@link downloadPinnedArtifact}. */
export interface PinnedDownloadRequest {
  /** Absolute URL of the pinned artifact. */
  readonly url: string
  /** Exact byte length the artifact must have. */
  readonly expectedBytes: number
  /** Stable error-code prefix owned by the calling component, such as `cloudflared`. */
  readonly errorPrefix: string
  readonly signal: AbortSignal
  /** Hosts a single redirect hop may target; defaults to the GitHub release asset hosts. */
  readonly redirectHosts?: readonly string[]
}

/** Follow one redirect hop after checking its scheme and host. A second hop is refused. */
async function followValidatedRedirect(response: Response, request: PinnedDownloadRequest): Promise<Response> {
  const location = response.headers.get('location')
  if (location === null) throw new Error(`${request.errorPrefix}_download_redirect_missing`)
  let target: URL
  try {
    target = new URL(location, request.url)
  } catch {
    throw new Error(`${request.errorPrefix}_download_redirect_invalid`)
  }
  const hosts = request.redirectHosts ?? RELEASE_ASSET_HOSTS
  if (target.protocol !== 'https:' || !hosts.includes(target.hostname)) {
    throw new Error(`${request.errorPrefix}_download_redirect_rejected`)
  }
  return componentFetch(target.href, { redirect: 'error', signal: request.signal })
}

/** Attempts per install. A 55 MB transfer through a TUN proxy can reset mid-stream: the first
 * real run in the development environment failed after 1.5 MB and succeeded on the next attempt,
 * which is exactly the confusing "nothing happened" the user saw. */
const DOWNLOAD_ATTEMPTS = 2
const RETRY_DELAY_MS = 750

/** Whether a failure is a transport problem worth a second attempt rather than a verdict. */
function isRetryable(error: unknown): boolean {
  // undici reports network faults as TypeError('fetch failed'), and a 5xx is worth one more try.
  if (error instanceof TypeError) return true
  if (error instanceof Error && /_download_http_5\d\d$/u.test(error.message)) return true
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

async function attemptDownload(request: PinnedDownloadRequest): Promise<Uint8Array> {
  const first = await componentFetch(request.url, { redirect: 'manual', signal: request.signal })
  const redirected = first.status >= 300 && first.status < 400
  const response = redirected ? await followValidatedRedirect(first, request) : first
  if (!response.ok) throw new Error(`${request.errorPrefix}_download_http_${String(response.status)}`)
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) !== request.expectedBytes)) {
    throw new Error(`${request.errorPrefix}_download_size_mismatch`)
  }
  if (response.body === null) throw new Error(`${request.errorPrefix}_download_size_mismatch`)
  const bytes = new Uint8Array(request.expectedBytes)
  const reader = response.body.getReader()
  let received = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (chunk.value.byteLength > bytes.byteLength - received) {
      await reader.cancel()
      throw new Error(`${request.errorPrefix}_download_size_mismatch`)
    }
    bytes.set(chunk.value, received)
    received += chunk.value.byteLength
  }
  if (received !== request.expectedBytes) throw new Error(`${request.errorPrefix}_download_size_mismatch`)
  return bytes
}

/**
 * Download a pinned artifact, following at most one validated redirect, and check its exact length.
 * A transport failure is retried once; a length or redirect verdict is not. The caller still
 * verifies the SHA-256 before publishing anything.
 * @param request - the pinned URL, its exact byte length and the caller's error prefix.
 * @returns the artifact bytes.
 */
export async function downloadPinnedArtifact(request: PinnedDownloadRequest): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await attemptDownload(request)
    } catch (error) {
      lastError = error
      if (attempt === DOWNLOAD_ATTEMPTS || !isRetryable(error)) throw error
      await delay(RETRY_DELAY_MS)
    }
  }
  throw lastError
}
