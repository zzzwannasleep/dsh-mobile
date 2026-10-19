/**
 * Progressive web app assets for the PC client: the web app manifest a browser
 * installs, the deliberate pass-through service worker, and the committed icons
 * the gateway serves from `PWA_ICON_PREFIX`.
 *
 * Every path here is origin-relative, because the gateway serves one origin per
 * pairing channel and no external asset may be referenced under its CSP.
 */
import { fileURLToPath } from 'node:url'
import { AUTH_PREFIX } from './http-security.js'

/** Gateway path of the web app manifest the PC entry page links. */
export const PWA_MANIFEST_PATH = `${AUTH_PREFIX}/manifest.webmanifest`

/** Gateway path of the pass-through service worker the PC entry page registers. */
export const PWA_SERVICE_WORKER_PATH = `${AUTH_PREFIX}/pc-sw.js`

/** Browser theme colour, injected as `<meta name="theme-color">`. */
export const PWA_THEME_COLOR = '#2563EB'

/** Colour a standalone window paints before the app renders. */
const PWA_BACKGROUND_COLOR = '#F7F8FA'

/** Gateway path prefix every shipped icon is served from. */
const PWA_ICON_PREFIX = `${AUTH_PREFIX}/pwa/`

/** One committed icon: its served URL, its file under `assets/pwa/`, and its role. */
export interface PwaIcon {
  readonly url: string
  readonly file: string
  readonly size: number
  readonly purpose: 'any' | 'maskable'
}

/**
 * The icons the manifest references, in manifest order.
 *
 * The maskable entry keeps its artwork inside the middle 80% circle, so a
 * launcher mask that crops to that safe area never clips the subject.
 */
export const PWA_ICONS: readonly PwaIcon[] = [
  { url: `${PWA_ICON_PREFIX}icon-192.png`, file: 'icon-192.png', size: 192, purpose: 'any' },
  { url: `${PWA_ICON_PREFIX}icon-512.png`, file: 'icon-512.png', size: 512, purpose: 'any' },
  { url: `${PWA_ICON_PREFIX}icon-maskable-512.png`, file: 'icon-maskable-512.png', size: 512, purpose: 'maskable' },
]

/**
 * Absolute path of one shipped icon file, resolved from this module.
 *
 * This module sits one directory below the package root in both layouts — the
 * source tree (`src/pwa.ts`) and the built bundle (`lib/index.mjs`) — so the same
 * relative specifier finds the committed PNG either way and never depends on the
 * caller's working directory.
 */
export function pwaIconPath(icon: PwaIcon): string {
  if (!/^[a-z0-9-]+\.png$/u.test(icon.file)) throw new Error(`invalid_pwa_icon:${icon.file}`)
  return fileURLToPath(new URL(`../assets/pwa/${icon.file}`, import.meta.url))
}

/** Deterministic web app manifest JSON for one origin-relative app. */
export function renderWebAppManifest(options: { readonly startUrl?: string } = {}): string {
  const manifest = {
    name: 'DSH Mobile',
    short_name: 'DSH',
    start_url: options.startUrl ?? '/',
    scope: '/',
    display: 'standalone',
    background_color: PWA_BACKGROUND_COLOR,
    theme_color: PWA_THEME_COLOR,
    icons: PWA_ICONS.map(icon => ({
      src: icon.url,
      sizes: `${icon.size}x${icon.size}`,
      type: 'image/png',
      purpose: icon.purpose,
    })),
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Pass-through service worker source.
 *
 * A fetch listener is what makes the page installable, but this worker
 * deliberately never answers a request itself: it never calls `respondWith`, so
 * the browser keeps its own network handling and DSH's own caches stay
 * authoritative.
 */
export function renderPwaServiceWorker(): string {
  return `// DSH Mobile pass-through service worker. It exists so the PC entry page can be
// installed as a desktop app. The fetch listener below deliberately never calls
// respondWith: the browser keeps its own network handling and DSH's own caches
// stay authoritative. Nothing here caches, rewrites or replays a response.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', () => {
  // Intentionally empty: the browser handles this request on its own.
})
`
}
