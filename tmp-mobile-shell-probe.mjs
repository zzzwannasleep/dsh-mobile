/** One-off probe: does the dedicated mobile shell render on DSH 0.2.0-rc.2 with 0.7.1, and which client modules load? */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle } from './scripts/packed-profile.mjs'
import { createMobileProfile, launchDsh, removeTemporaryRoot, openPairing, pairMobilePage, dismissOnboarding, CLIENT_TIMEOUT_MS } from './scripts/mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('.', import.meta.url))
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-shell-probe-'))
const prefix = 'dsh-mobile-shell-probe-'
let dsh
let browser
let failure

try {
  const tarball = await packBundle(repository, root)
  const home = await createMobileProfile(root, { tarball, dshBin })
  dsh = launchDsh(root, home, dshBin)
  const baseUrl = await dsh.ready()
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ locale: 'en-US' })
  await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await dismissOnboarding(desktop)
  const pairUrl = await openPairing(desktop, baseUrl, dsh.logs)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  const phone = await context.newPage()
  const errors = []
  phone.on('pageerror', error => errors.push(error.message))
  await pairMobilePage(phone, pairUrl, dsh.logs)
  await dismissOnboarding(phone)
  await phone.waitForTimeout(1500)
  const state = await phone.evaluate(() => {
    const shell = document.querySelector('.dshm-shell')
    const entries = window.__DSH_BOOT__?.entries?.map(entry => entry.id) ?? []
    const bodyChild = document.body.firstElementChild
    return {
      frontend: window.__DSH_MOBILE_FRONTEND__ ?? '(absent)',
      hasShell: shell !== null,
      shellClass: shell?.className ?? '',
      bodyFirstChild: bodyChild ? `${bodyChild.tagName}.${String(bodyChild.className).slice(0, 80)}` : '(none)',
      dshmNodes: [...document.querySelectorAll('[class*="dshm-"]')].length,
      entries,
      title: document.title,
      viewportMeta: document.querySelector('meta[name="viewport"]')?.content ?? '(absent)',
    }
  })
  console.log(JSON.stringify(state, null, 2))
  await phone.screenshot({ path: join(root, 'phone.png'), fullPage: false })
  console.log('errors:', JSON.stringify(errors))
  assert.equal(state.frontend, 'dedicated', 'gateway injected the dedicated frontend marker')
  await context.close()
  await desktop.close()
} catch (error) {
  failure = error
  throw error
} finally {
  await browser?.close()
  const stopped = await dsh?.close()
  await removeTemporaryRoot(root, prefix)
  if (failure === undefined && stopped?.forced) throw new Error('shell probe fixture needed forced termination')
}
