import { describe, expect, it } from 'vitest'
import {
  extractPairingToken,
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

/**
 * Drive the emitted pairing script in a minimal DOM, so a test can count the
 * POSTs and watch where the page sends the browser. Only the elements the script
 * really reads are provided; the install section and service worker stay absent.
 */
function runPairScript(options: {
  readonly hash: string
  readonly responseStatus?: number
}): {
  readonly posts: ReadonlyArray<{ readonly url: string; readonly body: string }>
  readonly replacements: readonly string[]
  readonly status: () => string
  readonly tokenValue: () => string
  readonly canSubmit: () => boolean
  readonly submit: () => Promise<void>
} {
  const posts: Array<{ url: string; body: string }> = []
  const replacements: string[] = []
  let submitHandler: ((event: { readonly preventDefault: () => void }) => Promise<void>) | undefined
  const token = { value: '' }
  const label = { value: '' }
  const status = { value: '' }
  const form = {
    addEventListener: (type: string, handler: (event: { readonly preventDefault: () => void }) => Promise<void>) => {
      if (type === 'submit') submitHandler = handler
    },
    querySelector: () => ({ disabled: false }),
  }
  const elements: Record<string, unknown> = {
    'pair-form': form,
    'pair-token': token,
    'device-label': label,
    'pair-status': status,
  }
  const location = {
    hash: options.hash,
    pathname: '/mobile-access/pc',
    search: '',
    replace: (target: string) => { replacements.push(target) },
  }
  const document = {
    documentElement: { dataset: {} as Record<string, string> },
    getElementById: (id: string) => elements[id] ?? null,
  }
  const fetch = (url: string, init: { readonly body: string }) => {
    posts.push({ url, body: init.body })
    const responseStatus = options.responseStatus ?? 201
    return Promise.resolve({ ok: responseStatus < 400, status: responseStatus })
  }
  const run = new Function('document', 'location', 'history', 'window', 'navigator', 'fetch', renderPairScript('en'))
  run(document, location, { replaceState: () => {} }, { addEventListener: () => {} }, {}, fetch)
  return {
    posts,
    replacements,
    status: () => status.value,
    tokenValue: () => token.value,
    canSubmit: () => submitHandler !== undefined,
    submit: async () => { await submitHandler?.({ preventDefault: () => {} }) },
  }
}

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
      zh: ['把这台电脑连接到 DSH', '先信任证书', '打开主人发来的链接', '安装为桌面应用', '配对码', '配对码（备用）'],
      en: ['Connect this PC to DSH', 'Trust the certificate first', 'Open the link the owner sent', 'Install as desktop app', 'Pairing code', 'Pairing code (fallback)'],
      it: ['Collega questo PC a DSH', 'Prima installa il certificato', 'Apri il link inviato dal proprietario', 'Installa come app desktop', 'Codice di abbinamento', 'Codice di abbinamento (alternativa)'],
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

  it('states the fallback code validity once, with no window for the durable link to beat', () => {
    const fallback = {
      zh: '配对码有效期默认 5 分钟，且只能使用一次。',
      en: 'A pairing code is valid for 5 minutes by default and can be used once.',
      it: 'Il codice di abbinamento vale 5 minuti per impostazione predefinita e si usa una sola volta.',
    } as const
    const window = { zh: '5 分钟', en: '5 minutes', it: '5 minuti' } as const

    for (const locale of LOCALES) {
      const page = renderPcEntryPage(locale, PC_OPTIONS)
      expect(page).toContain(fallback[locale])
      // The fallback field is the only place the page still names a validity window.
      expect(page.match(new RegExp(window[locale], 'g'))).toHaveLength(1)
    }
  })

  it('presents the durable link as the normal path and retires the two-minute framing', () => {
    const durable = {
      zh: ['不需要输入任何配对码', '这条链接一直有效，直到主人在 DSH 里撤销它'],
      en: ['with no pairing code to type', 'The link keeps working until the owner revokes it in DSH'],
      it: ['senza digitare alcun codice di abbinamento', 'Il link resta valido finché il proprietario non lo revoca in DSH'],
    } as const

    for (const locale of LOCALES) {
      const page = renderPcEntryPage(locale, PC_OPTIONS)
      for (const text of durable[locale]) expect(page).toContain(text)
      expect(page).not.toContain('两分钟')
      expect(page).not.toContain('two minutes')
      expect(page).not.toContain('due minuti')
      // Regenerating is retired everywhere: one link is now revoked, not replaced.
      expect(page).not.toContain('重新生成它')
      expect(page).not.toContain('regenerates it')
      expect(page).not.toContain('lo rigenera')
    }
  })

  it('keeps the fallback field described for assistive technology', () => {
    const page = renderPcEntryPage('en', PC_OPTIONS)

    expect(page).toContain('aria-describedby="pair-token-help"')
    expect(page).toContain('<p class="help" id="pair-token-help">')
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

describe('pairing field extraction', () => {
  it('accepts the raw token, an app key and a link that carries the code', () => {
    expect(extractPairingToken('abc123')).toBe('abc123')
    expect(extractPairingToken('  abc123  ')).toBe('abc123')
    expect(extractPairingToken('dsh1.5f2a.tok3n')).toBe('tok3n')
    expect(extractPairingToken('dsh2.remote-9.tok3n')).toBe('tok3n')
    expect(extractPairingToken('"abc123"')).toBe('abc123')
    expect(extractPairingToken('"dsh1.inst.abc.def"')).toBe('abc.def')
    expect(extractPairingToken('“dsh1.inst.tok”')).toBe('tok')
    expect(extractPairingToken('https://192.168.1.7:3443/mobile-access/pc#key=dsh1.inst.tok')).toBe('tok')
    expect(extractPairingToken('https://host/mobile-access/pair#token=raw')).toBe('raw')
    expect(extractPairingToken('https://host/mobile-access/pc?token=raw')).toBe('raw')
    expect(extractPairingToken('https://host/mobile-access/pc?instance=i&token=raw')).toBe('raw')
  })

  it('reports no code for empty input or a link without one', () => {
    expect(extractPairingToken('')).toBe('')
    expect(extractPairingToken('   ')).toBe('')
    expect(extractPairingToken('""')).toBe('')
    expect(extractPairingToken('#')).toBe('')
    expect(extractPairingToken('#token=')).toBe('')
    expect(extractPairingToken('https://host/mobile-access/pc')).toBe('')
    expect(extractPairingToken('https://host/mobile-access/pc?foo=bar')).toBe('')
  })

  it('passes an unrelated single value through so the gateway decides', () => {
    expect(extractPairingToken('not-a-code')).toBe('not-a-code')
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

  it('gives every pairing failure its own message in the page language', () => {
    const expected = {
      zh: [
        '配对码无效、已过期或已被使用。请在 DSH 里重新生成（默认 5 分钟有效，只能使用一次）。',
        '网关拒绝了这次请求的来源（不是配对码的问题）：请确认这台电脑和主机在同一局域网，或改用远程入口/正确的链接地址。',
        '尝试次数过多，请稍等一会儿再试。',
        '电脑上的配对窗口已关闭。窗口默认只开放 5 分钟',
      ],
      en: ['invalid, expired or already used', 'refused where this request came from', 'Too many attempts', 'pairing window on the computer is closed'],
      it: ['non è valido, è scaduto o è già stato usato', 'rifiutato l’origine di questa richiesta', 'Troppi tentativi', 'finestra di abbinamento sul computer è chiusa'],
    } as const
    for (const locale of LOCALES) {
      const localized = renderPairScript(locale)
      expect(localized).toContain('if (response.status === 401)')
      expect(localized).toContain('if (response.status === 403)')
      expect(localized).toContain('if (response.status === 429)')
      expect(localized).toContain('if (response.status === 404)')
      for (const text of expected[locale]) expect(localized).toContain(text)
    }
    // A refused source must never be reported as an expired code.
    expect(renderPairScript('zh')).not.toContain('if (response.status === 403 || response.status === 404)')
  })

  it('normalizes the field value before posting and refuses to post an empty code', () => {
    expect(script).toContain('const code = extractPairingToken(token.value)')
    expect(script).toMatch(/if \(code === ''\) \{\n\s+status\.value = "This pairing code is invalid/)
    expect(script).toContain('body: JSON.stringify({ token: code, label: label.value || undefined })')
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

  it('embeds working copies of the exported fragment parser and extractor', () => {
    const parser = /const parsePairFragment = ([\s\S]*?)\n\n {2}const extractPairingToken =/.exec(script)
    const extractor = /const extractPairingToken = ([\s\S]*?)\n\n {2}const form =/.exec(script)
    expect(parser).not.toBeNull()
    expect(extractor).not.toBeNull()
    const runtimeParser = new Function(`return (${parser?.[1] ?? ''})`)() as (hash: string) => {
      readonly token?: string
      readonly instance?: string
    }
    const runtimeExtractor = new Function('parsePairFragment', `return (${extractor?.[1] ?? ''})`)(runtimeParser) as (input: string) => string

    const fragments = ['#token=abc', '#key=dsh1.inst.tok', '#instance=i&token=t', '', '#foo=bar', '#key=dsh2.i.t']
    for (const hash of fragments) expect(runtimeParser(hash)).toEqual(parsePairFragment(hash))
    const pastes = ['abc123', 'dsh1.inst.tok', '"dsh1.inst.tok"', 'https://host/mobile-access/pc#key=dsh1.inst.tok', 'https://host/mobile-access/pc?token=raw', 'https://host/mobile-access/pc', '']
    for (const value of pastes) expect(runtimeExtractor(value)).toBe(extractPairingToken(value))
  })
})

describe('a link that carries a token', () => {
  const ENTRY_LINK = '#key=dsh1.instance1.tok3n'

  it('posts the extracted token exactly once and then replaces the location with /', async () => {
    const page = runPairScript({ hash: ENTRY_LINK })

    // The token moves from the fragment into the field before any submission.
    expect(page.tokenValue()).toBe('tok3n')
    expect(page.replacements).toEqual([])
    expect(page.canSubmit()).toBe(true)
    await page.submit()
    expect(page.posts).toHaveLength(1)
    expect(page.posts[0]?.url).toBe('/mobile-access/auth/pair')
    expect(page.posts[0]?.body).toBe('{"token":"tok3n"}')
    expect(page.replacements).toEqual(['/'])
  })

  it('keeps the fallback form without a POST when the page carries no token', async () => {
    const page = runPairScript({ hash: '' })

    expect(page.replacements).toEqual([])
    expect(page.canSubmit()).toBe(true)
    await page.submit()
    expect(page.posts).toHaveLength(0)
    expect(page.status()).toContain('invalid, expired or already used')
  })

  it('reports a rejected POST instead of redirecting', async () => {
    const page = runPairScript({ hash: ENTRY_LINK, responseStatus: 401 })

    await page.submit()
    expect(page.posts).toHaveLength(1)
    expect(page.status()).toContain('invalid, expired or already used')
    expect(page.replacements).toEqual([])
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
