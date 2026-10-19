import { describe, expect, it } from 'vitest'
import {
  parsePairFragment,
  renderLoginPage,
  renderLoginScript,
  renderPairPage,
  renderPairScript,
  renderPcEntryPage,
  resolveAuthPageLocale,
} from '../src/auth-pages.js'

const PC_OPTIONS = {
  certificateRequired: true,
  certificateUrl: '/mobile-access/ca.cer',
  manifestPath: '/mobile-access/manifest.webmanifest',
  serviceWorkerPath: '/mobile-access/pc-sw.js',
  scriptPath: '/mobile-access/pc.js',
  entryPath: '/mobile-access/pc',
} as const

const LOCALES = ['zh', 'en', 'it'] as const

describe('browser authentication page localization', () => {
  it('negotiates the supported languages and falls back to English', () => {
    expect(resolveAuthPageLocale('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh')
    expect(resolveAuthPageLocale('it-IT,en-US;q=0.8')).toBe('it')
    expect(resolveAuthPageLocale('en-US;q=0.5,zh-CN;q=0.9')).toBe('zh')
    expect(resolveAuthPageLocale('zh-CN;q=0,en-US;q=0.8')).toBe('en')
    expect(resolveAuthPageLocale('fr-FR,de;q=0.8')).toBe('en')
    expect(resolveAuthPageLocale(undefined)).toBe('en')
  })

  it('renders the pairing form and script in the negotiated language', () => {
    const page = renderPairPage('zh')
    const script = renderPairScript('it')

    expect(page).toContain('<html lang="zh-CN">')
    expect(page).toContain('配对码')
    expect(page).toContain('配对')
    expect(script).toContain('Abbinamento…')
    expect(script).toContain('Abbinamento non riuscito')
    expect(script).toContain("/mobile-access/auth/pair")
  })

  it('keeps pairing inputs above the Safari 16px focus-zoom threshold', () => {
    // Pre-auth pages load before the mobile client, so no stylesheet floor
    // exists yet; Safari zooms any focused editable under 16px and never
    // zooms back.
    const page = renderPairPage('en')
    expect(page).toContain('<style>input,textarea{font-size:16px}</style>')
  })

  it('renders localized reauthentication failure guidance', () => {
    const page = renderLoginPage('it')
    const script = renderLoginScript('zh')

    expect(page).toContain('<html lang="it-IT">')
    expect(page).toContain('Riconnetti questo dispositivo')
    expect(script).toContain('电脑当前不可用。')
    expect(script).toContain("/mobile-access/auth/renew")
  })
})

describe('phone pairing page without options', () => {
  it('keeps the frozen minimal document', () => {
    const page = renderPairPage('en')

    expect(page.startsWith('<!doctype html>\n<html lang="en">\n')).toBe(true)
    expect(page).toContain('<script src="/mobile-access/pair.js" defer></script>')
    expect(page).not.toContain('manifest')
    expect(page).not.toContain('install-section')
    expect(page).not.toContain('data-service-worker-path')
    expect(page).not.toContain('ca.cer')
  })

  it('adds certificate, manifest and install guidance when options are given', () => {
    const page = renderPairPage('zh', PC_OPTIONS)

    expect(page).toContain('data-service-worker-path="/mobile-access/pc-sw.js"')
    expect(page).toContain('<link rel="manifest" href="/mobile-access/manifest.webmanifest">')
    expect(page).toContain('<a href="/mobile-access/ca.cer" download>下载证书</a>')
    expect(page).toContain('确认安全提示')
    expect(page).not.toContain('Windows')
    expect(page).toContain('id="install-section" hidden')
    expect(page).toContain('id="install-app"')
    expect(page).toContain('<script src="/mobile-access/pair.js" defer></script>')
  })

  it('omits the certificate block when no certificate is required', () => {
    const page = renderPairPage('en', { ...PC_OPTIONS, certificateRequired: false })

    expect(page).not.toContain('ca.cer')
    expect(page).not.toContain('Download the certificate')
    expect(page).toContain('id="pair-form"')
  })
})

describe('desktop PC entry page', () => {
  it('renders a calm two-column layout that collapses on narrow screens', () => {
    for (const locale of LOCALES) {
      const page = renderPcEntryPage(locale, PC_OPTIONS)

      expect(page).toContain('@media (min-width:720px)')
      expect(page).toContain('grid-template-columns:minmax(0,1fr)')
      expect(page).toContain('grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr)')
      expect(page).toContain('font:16px/1.55 system-ui')
      expect(page).toContain('background:#2563eb')
      expect(page).toContain('min-height:44px')
    }
  })

  it('localizes the guidance and the form for every supported language', () => {
    const expectations = {
      zh: ['把这台电脑连接到 DSH', '先信任证书', '输入配对码', '安装为桌面应用', '配对码', '配对此电脑'],
      en: ['Connect this PC to DSH', 'Trust the certificate first', 'Enter the pairing code', 'Install as desktop app', 'Pairing code', 'Pair this PC'],
      it: ['Collega questo PC a DSH', 'Prima installa il certificato', 'Inserisci il codice di abbinamento', 'Installa come app desktop', 'Codice di abbinamento', 'Abbina questo PC'],
    } as const

    for (const locale of LOCALES) {
      const page = renderPcEntryPage(locale, PC_OPTIONS)
      for (const text of expectations[locale]) expect(page).toContain(text)
    }
    expect(renderPcEntryPage('zh', PC_OPTIONS)).toContain('<html lang="zh-CN"')
    expect(renderPcEntryPage('en', PC_OPTIONS)).toContain('<html lang="en"')
    expect(renderPcEntryPage('it', PC_OPTIONS)).toContain('<html lang="it-IT"')
  })

  it('wires the shared pairing form, the manifest and the service worker', () => {
    const page = renderPcEntryPage('en', PC_OPTIONS)

    expect(page).toContain('<link rel="manifest" href="/mobile-access/manifest.webmanifest">')
    expect(page).toContain('data-service-worker-path="/mobile-access/pc-sw.js"')
    expect(page).toContain('<link rel="canonical" href="/mobile-access/pc">')
    expect(page).toContain('<script src="/mobile-access/pc.js" defer></script>')
    expect(page).toContain('id="pair-form"')
    expect(page).toContain('id="pair-token"')
    expect(page).toContain('id="device-label"')
    expect(page).toContain('id="pair-status"')
    expect(page).toContain('id="install-section" hidden')
    expect(page).toContain('id="install-app"')
    expect(page).toContain('<noscript>')
  })

  it('explains the certificate warning before the certificate is trusted', () => {
    const required = renderPcEntryPage('en', PC_OPTIONS)
    const optional = renderPcEntryPage('en', { ...PC_OPTIONS, certificateRequired: false })

    expect(required).toContain('<a href="/mobile-access/ca.cer" download>Download the certificate</a>')
    expect(required).toContain('“not secure” warning')
    expect(required).toContain('that warning is expected')
    expect(required).toContain('confirm the Windows security prompt')
    expect(required.match(/<li>/g)).toHaveLength(3)
    expect(optional).not.toContain('ca.cer')
    expect(optional).not.toContain('Download the certificate')
    expect(optional.match(/<li>/g)).toHaveLength(2)
  })

  it('escapes configuration values placed in attributes', () => {
    const page = renderPcEntryPage('en', { ...PC_OPTIONS, certificateUrl: '/ca.cer?a=1&b="2"' })

    expect(page).toContain('href="/ca.cer?a=1&amp;b=&quot;2&quot;"')
    expect(page).not.toContain('b="2"')
  })

  it('loads the script the caller names, while the phone page keeps pair.js', () => {
    const pc = renderPcEntryPage('en', { ...PC_OPTIONS, scriptPath: '/mobile-access/pc.js?rev=7' })
    expect(pc).toContain('<script src="/mobile-access/pc.js?rev=7" defer></script>')

    // pair.js only exists while a pairing window is open, so the phone page must
    // never follow the PC page's always-available script route.
    expect(renderPairPage('en')).toContain('<script src="/mobile-access/pair.js" defer></script>')
    expect(renderPairPage('en', PC_OPTIONS)).toContain('<script src="/mobile-access/pair.js" defer></script>')
    expect(renderPairPage('en', PC_OPTIONS)).not.toContain('/mobile-access/pc.js')
  })

  it('stays CSP-safe: no inline handler, no external asset, no inline script', () => {
    for (const locale of LOCALES) {
      const page = renderPcEntryPage(locale, PC_OPTIONS)

      expect(page).not.toMatch(/\son[a-z]+\s*=/i)
      expect(page).not.toMatch(/(?:href|src)\s*=\s*"?javascript:/i)
      expect(page).not.toMatch(/(?:src|href)="https?:/i)
      expect(page).not.toMatch(/(?:src|href)="\/\//)
      expect(page.match(/<script/g)).toHaveLength(1)
      expect(page).toContain('<script src="/mobile-access/pc.js" defer></script>')
      expect(page).toContain('<style>')
    }
  })
})

describe('pairing fragment parsing', () => {
  it('accepts the documented fragment forms', () => {
    expect(parsePairFragment('#token=abc123')).toEqual({ token: 'abc123' })
    expect(parsePairFragment('token=abc123')).toEqual({ token: 'abc123' })
    expect(parsePairFragment('#key=dsh1.5f2a.tok3n')).toEqual({ token: 'tok3n', instance: '5f2a' })
    expect(parsePairFragment('#key=dsh2.remote-9.tok3n')).toEqual({ token: 'tok3n', instance: 'remote-9' })
    expect(parsePairFragment('#instance=inst1&token=tok1')).toEqual({ token: 'tok1', instance: 'inst1' })
  })

  it('keeps dots inside the app-key token and trims surrounding whitespace', () => {
    expect(parsePairFragment('#key=dsh1.inst.abc.def')).toEqual({ token: 'abc.def', instance: 'inst' })
    expect(parsePairFragment('#token=%20abc%20')).toEqual({ token: 'abc' })
    expect(parsePairFragment('#token=abc+def')).toEqual({ token: 'abc def' })
  })

  it('prefers an explicit token over an app key', () => {
    expect(parsePairFragment('#token=direct&key=dsh1.inst.other')).toEqual({ token: 'direct' })
  })

  it('returns nothing for empty, unknown or malformed fragments', () => {
    expect(parsePairFragment('')).toEqual({})
    expect(parsePairFragment('#')).toEqual({})
    expect(parsePairFragment('#foo=bar')).toEqual({})
    expect(parsePairFragment('#key=not-an-app-key')).toEqual({})
    expect(parsePairFragment('#key=dsh1.onlytwo')).toEqual({})
    expect(parsePairFragment('#token=')).toEqual({})
    expect(parsePairFragment('#instance=inst1')).toEqual({ instance: 'inst1' })
  })
})

describe('shared pairing script', () => {
  const script = renderPairScript('en')

  it('reads the token from the fragment, clears it and posts the JSON body', () => {
    expect(script).toContain('parsePairFragment(location.hash)')
    expect(script).toContain('history.replaceState(null, \'\', location.pathname + location.search)')
    expect(script).toContain("/mobile-access/auth/pair")
    expect(script).toContain("credentials: 'same-origin'")
    expect(script).toContain("'content-type': 'application/json'")
    expect(script).toContain('location.replace(\'/\')')
  })

  it('handles a closed pairing window and a network failure in the page language', () => {
    for (const locale of LOCALES) {
      const localized = renderPairScript(locale)
      expect(localized).toContain('response.status === 401 || response.status === 403 || response.status === 404')
      expect(localized).toContain(locale === 'zh' ? '这个配对码已失效' : locale === 'it' ? 'non è più valido' : 'is no longer valid')
    }
  })

  it('registers the service worker only on a plain browser origin', () => {
    expect(script).toContain('document.documentElement.dataset.serviceWorkerPath')
    expect(script).toContain('navigator.serviceWorker !== undefined')
    expect(script).toContain('window.dshMobileNative === undefined')
    // The script lives under /mobile-access/, so the manifest's '/'-scoped app
    // needs the explicit root scope the gateway's Service-Worker-Allowed allows.
    expect(script).toContain("navigator.serviceWorker.register(workerPath, { scope: '/' })")
    expect(script).toMatch(/register\(workerPath, \{ scope: '\/' \}\)\.catch\(\(\) => \{\}\)/)
  })

  it('reveals and uses the desktop-install prompt', () => {
    expect(script).toContain("window.addEventListener('beforeinstallprompt'")
    expect(script).toContain('installSection.hidden = false')
    expect(script).toContain('installPrompt.prompt()')
  })

  it('embeds a working copy of the exported fragment parser', () => {
    const embedded = /const parsePairFragment = ([\s\S]*?)\n\n {2}const form =/.exec(script)
    expect(embedded).not.toBeNull()
    const runtimeParser = new Function(`return (${embedded?.[1] ?? ''})`)() as (hash: string) => {
      readonly token?: string
      readonly instance?: string
    }
    const cases = ['#token=abc', '#key=dsh1.inst.tok', '#instance=i&token=t', '', '#foo=bar', '#key=dsh2.i.t']
    for (const hash of cases) expect(runtimeParser(hash)).toEqual(parsePairFragment(hash))
  })
})

describe('pairing tokens stay out of rendered documents', () => {
  const token = 'tok3n-8f14e45fceea167a5a36dedd4bea2543'

  it('parses the token from the fragment but never renders it', () => {
    const fragment = parsePairFragment(`#key=dsh1.instance1.${token}`)
    expect(fragment).toEqual({ token, instance: 'instance1' })

    for (const locale of LOCALES) {
      const documents = [
        renderPairPage(locale),
        renderPairPage(locale, PC_OPTIONS),
        renderPcEntryPage(locale, PC_OPTIONS),
        renderPairScript(locale),
      ]
      for (const document of documents) {
        expect(document).not.toContain(token)
        expect(document).not.toMatch(/id="pair-token"[^>]*value=/)
      }
    }
  })
})
