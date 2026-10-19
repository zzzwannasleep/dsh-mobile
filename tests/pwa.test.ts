import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PWA_ICONS,
  PWA_MANIFEST_PATH,
  PWA_SERVICE_WORKER_PATH,
  PWA_THEME_COLOR,
  pwaIconPath,
  renderPwaServiceWorker,
  renderWebAppManifest,
} from '../src/pwa.js'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

interface ManifestIcon {
  readonly src: string
  readonly sizes: string
  readonly type: string
  readonly purpose: string
}

interface Manifest {
  readonly name: string
  readonly short_name: string
  readonly start_url: string
  readonly scope: string
  readonly display: string
  readonly background_color: string
  readonly theme_color: string
  readonly icons: readonly ManifestIcon[]
}

describe('PC client PWA assets', () => {
  it('serves the manifest and the service worker from the frozen gateway paths', () => {
    expect(PWA_MANIFEST_PATH).toBe('/mobile-access/manifest.webmanifest')
    expect(PWA_SERVICE_WORKER_PATH).toBe('/mobile-access/pc-sw.js')
    expect(PWA_THEME_COLOR).toMatch(/^#[0-9A-F]{6}$/u)
  })

  it('renders a deterministic, origin-relative manifest', () => {
    const source = renderWebAppManifest()
    const manifest = JSON.parse(source) as Manifest

    expect(manifest.name).toBe('DSH Mobile')
    expect(manifest.short_name).toBe('DSH')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.background_color).toMatch(/^#[0-9A-F]{6}$/u)
    expect(manifest.theme_color).toBe(PWA_THEME_COLOR)
    expect(manifest.icons.map(icon => [icon.sizes, icon.purpose])).toEqual([
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['512x512', 'maskable'],
    ])
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png')
      expect(icon.src.startsWith('/mobile-access/pwa/')).toBe(true)
      expect(icon.src).not.toMatch(/^[a-z]+:/u)
    }
    // No external origin may appear anywhere in the document the CSP covers.
    expect(source).not.toMatch(/https?:\/\//u)
    expect(renderWebAppManifest()).toBe(source)
    expect((JSON.parse(renderWebAppManifest({ startUrl: '/mobile-access/pc' })) as Manifest).start_url)
      .toBe('/mobile-access/pc')
  })

  it('never answers a request from the pass-through service worker', () => {
    const source = renderPwaServiceWorker()

    expect(source).toContain("self.addEventListener('install'")
    expect(source).toContain('self.skipWaiting()')
    expect(source).toContain("self.addEventListener('activate'")
    expect(source).toContain('self.clients.claim()')

    // The fetch listener is the whole reason the worker exists; it must stay a
    // listener only, because DSH's own caches own every response.
    const fetchListener = source.slice(source.indexOf("self.addEventListener('fetch'"))
    expect(fetchListener).toContain('addEventListener')
    expect(fetchListener).not.toMatch(/respondWith\s*\(/u)
    expect(source).not.toMatch(/respondWith\s*\(/u)

    const directory = mkdtempSync(join(tmpdir(), 'dsh-mobile-pwa-'))
    try {
      const file = join(directory, 'pc-sw.js')
      writeFileSync(file, source)
      expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow()
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('ships real PNG icons at the advertised dimensions', () => {
    for (const icon of PWA_ICONS) {
      const path = pwaIconPath(icon)
      expect(existsSync(path)).toBe(true)
      const bytes = readFileSync(path)
      expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE)
      expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
      expect(bytes.readUInt32BE(16)).toBe(icon.size)
      expect(bytes.readUInt32BE(20)).toBe(icon.size)
      expect(bytes.byteLength).toBeLessThanOrEqual(200 * 1024)
      expect(icon.url).toBe(`/mobile-access/pwa/${icon.file}`)
    }
    const maskable = PWA_ICONS.find(icon => icon.purpose === 'maskable')
    const plain = PWA_ICONS.find(icon => icon.size === 512 && icon.purpose === 'any')
    expect(maskable).toBeDefined()
    expect(plain).toBeDefined()
    expect(readFileSync(pwaIconPath(maskable!)).equals(readFileSync(pwaIconPath(plain!)))).toBe(false)
  })

  it('resolves icons from the module location instead of the caller working directory', () => {
    const repositoryRoot = new URL('..', import.meta.url)
    for (const icon of PWA_ICONS) {
      const expected = fileURLToPath(new URL(`assets/pwa/${icon.file}`, repositoryRoot))
      expect(pwaIconPath(icon)).toBe(expected)
      expect(existsSync(expected)).toBe(true)
      // The built bundle (`lib/index.mjs`) sits at the same depth as `src/pwa.ts`,
      // so the same module-relative specifier resolves the identical committed
      // file from either layout.
      expect(fileURLToPath(new URL(`../assets/pwa/${icon.file}`, new URL('lib/index.mjs', repositoryRoot)))).toBe(expected)
    }
    expect(() => pwaIconPath({ url: '/x', file: '../icon-192.png', size: 192, purpose: 'any' })).toThrow()
  })
})
