/** Browser-facing pairing and reauthentication pages with language negotiation. */
export type AuthPageLocale = 'zh' | 'en' | 'it'

interface AuthPageCopy {
  readonly lang: string
  readonly pairTitle: string
  readonly pairHeading: string
  readonly pairingCode: string
  readonly deviceName: string
  readonly pair: string
  readonly pairing: string
  readonly pairFailed: string
  readonly pairingWindowClosed: string
  readonly pairingCodeInvalid: string
  readonly pairingSourceRefused: string
  readonly pairingRateLimited: string
  readonly unavailable: string
  readonly reconnectTitle: string
  readonly reconnectHeading: string
  readonly restoring: string
  readonly noLongerPaired: string
  readonly openPairing: string
}

const COPY: Record<AuthPageLocale, AuthPageCopy> = {
  en: {
    lang: 'en', pairTitle: 'Pair DSH mobile access', pairHeading: 'Pair this device',
    pairingCode: 'Pairing code', deviceName: 'Device name', pair: 'Pair', pairing: 'Pairing…',
    pairFailed: 'Pairing failed',
    pairingWindowClosed: 'The pairing window on the computer is closed. It stays open for 5 minutes by default — ask the owner to open pairing again and send a fresh code.',
    pairingCodeInvalid: 'This pairing code is invalid, expired or already used. Generate a new one in DSH (valid for 5 minutes by default and single use).',
    pairingSourceRefused: 'The gateway refused where this request came from — this is not about the pairing code. Check that this PC and the host are on the same local network, or use the remote entry or the correct link address.',
    pairingRateLimited: 'Too many attempts. Wait a moment and try again.',
    unavailable: 'The computer is unavailable.',
    reconnectTitle: 'Reconnect DSH mobile access', reconnectHeading: 'Reconnect this device',
    restoring: 'Restoring the secure Session…', noLongerPaired: 'This device is no longer paired. Open pairing on the computer, then pair it again.',
    openPairing: 'Open pairing',
  },
  zh: {
    lang: 'zh-CN', pairTitle: '配对 DSH 移动访问', pairHeading: '配对此设备',
    pairingCode: '配对码', deviceName: '设备名称', pair: '配对', pairing: '正在配对…',
    pairFailed: '配对失败',
    pairingWindowClosed: '电脑上的配对窗口已关闭。窗口默认只开放 5 分钟，请让电脑的主人重新打开配对，并发来一个新的配对码。',
    pairingCodeInvalid: '配对码无效、已过期或已被使用。请在 DSH 里重新生成（默认 5 分钟有效，只能使用一次）。',
    pairingSourceRefused: '网关拒绝了这次请求的来源（不是配对码的问题）：请确认这台电脑和主机在同一局域网，或改用远程入口/正确的链接地址。',
    pairingRateLimited: '尝试次数过多，请稍等一会儿再试。',
    unavailable: '电脑当前不可用。',
    reconnectTitle: '重新连接 DSH 移动访问', reconnectHeading: '重新连接此设备',
    restoring: '正在恢复安全会话…', noLongerPaired: '此设备已不在配对列表中。请在电脑端打开配对，然后重新配对。',
    openPairing: '打开配对页面',
  },
  it: {
    lang: 'it-IT', pairTitle: 'Abbina accesso mobile DSH', pairHeading: 'Abbina questo dispositivo',
    pairingCode: 'Codice di abbinamento', deviceName: 'Nome dispositivo', pair: 'Abbina', pairing: 'Abbinamento…',
    pairFailed: 'Abbinamento non riuscito',
    pairingWindowClosed: 'La finestra di abbinamento sul computer è chiusa. Resta aperta 5 minuti per impostazione predefinita: chiedi al proprietario di riaprire l’abbinamento e inviarti un nuovo codice.',
    pairingCodeInvalid: 'Il codice di abbinamento non è valido, è scaduto o è già stato usato. Generane uno nuovo in DSH (valido 5 minuti per impostazione predefinita, monouso).',
    pairingSourceRefused: 'Il gateway ha rifiutato l’origine di questa richiesta — non dipende dal codice di abbinamento. Verifica che questo PC e l’host siano sulla stessa rete locale, oppure usa l’ingresso remoto o l’indirizzo di link corretto.',
    pairingRateLimited: 'Troppi tentativi. Attendi un momento e riprova.',
    unavailable: 'Il computer non è disponibile.',
    reconnectTitle: 'Riconnetti accesso mobile DSH', reconnectHeading: 'Riconnetti questo dispositivo',
    restoring: 'Ripristino della sessione sicura…', noLongerPaired: 'Questo dispositivo non è più abbinato. Apri l’abbinamento sul computer e ripeti la procedura.',
    openPairing: 'Apri abbinamento',
  },
}

interface PcEntryCopy {
  readonly title: string
  readonly brand: string
  readonly heading: string
  readonly lead: string
  readonly stepsTitle: string
  readonly trustTitle: string
  readonly trustBody: string
  readonly trustLink: string
  readonly trustWarning: string
  readonly trustWindows: string
  readonly codeTitle: string
  readonly codeBody: string
  readonly installTitle: string
  readonly installBody: string
  readonly formTitle: string
  readonly formHelp: string
  readonly devicePlaceholder: string
  readonly installButton: string
  readonly installHint: string
  readonly securityNote: string
  readonly noScript: string
}

const PC_COPY: Record<AuthPageLocale, PcEntryCopy> = {
  en: {
    title: 'Connect this PC to DSH',
    brand: 'DSH Mobile',
    heading: 'Connect this PC to DSH',
    lead: 'This page pairs this browser with the DSH running on the owner’s computer. Afterwards DSH opens here like an ordinary web app.',
    stepsTitle: 'Three short steps',
    trustTitle: 'Trust the certificate first',
    trustBody: 'Download and install the certificate before anything else. Until it is installed the browser shows a “not secure” warning for this address — that warning is expected, and it disappears once the certificate is trusted.',
    trustLink: 'Download the certificate',
    trustWarning: 'Open the downloaded file and confirm the security prompt, then reopen this page.',
    trustWindows: 'Open the downloaded file, confirm the Windows security prompt, then close and reopen this tab.',
    codeTitle: 'Enter the pairing code',
    codeBody: 'Ask the owner for the pairing code and paste it on the right. A code is valid for 5 minutes by default and can be used once, so ask for a fresh one whenever it expires.',
    installTitle: 'Install it as a desktop app (optional)',
    installBody: 'In Edge or Chrome open the ⋯ menu and choose Apps → Install this site as an app. When the browser offers the install, a button appears below the form.',
    formTitle: 'Pair this PC',
    formHelp: 'Paste the pairing code, the pairing key or the whole link the owner sent.',
    devicePlaceholder: 'This PC',
    installButton: 'Install as desktop app',
    installHint: 'Installing adds a Start-menu entry and an app window; nothing else on the computer changes.',
    securityNote: 'The code is sent once to the owner’s computer and is removed from the page address.',
    noScript: 'Pairing needs JavaScript. Enable it and reload this page.',
  },
  zh: {
    title: '把这台电脑连接到 DSH',
    brand: 'DSH Mobile',
    heading: '把这台电脑连接到 DSH',
    lead: '这个页面把当前浏览器与电脑上的 DSH 配对。配对完成后，DSH 会像普通网页应用一样在这里打开。',
    stepsTitle: '三步即可完成',
    trustTitle: '先信任证书',
    trustBody: '请先下载并安装证书。安装之前浏览器会提示此地址“不安全”，这是正常现象；证书被信任后提示就会消失。',
    trustLink: '下载证书',
    trustWarning: '打开下载的文件并确认安全提示，然后重新打开本页面。',
    trustWindows: '打开下载的文件，确认 Windows 的安全提示，然后关闭并重新打开本标签页。',
    codeTitle: '输入配对码',
    codeBody: '向电脑的主人索取配对码，粘贴在右侧。配对码默认 5 分钟内有效，且只能使用一次；过期后请再要一个新的。',
    installTitle: '可选：安装为桌面应用',
    installBody: '在 Edge 或 Chrome 中打开 ⋯ 菜单，选择“应用 → 将此站点作为应用安装”。浏览器支持安装时，表单下方会出现按钮。',
    formTitle: '配对此电脑',
    formHelp: '粘贴主人发来的配对码、配对密钥或整条链接都可以。',
    devicePlaceholder: '这台电脑',
    installButton: '安装为桌面应用',
    installHint: '安装后会多一个开始菜单入口和独立窗口，电脑上的其他内容不变。',
    securityNote: '配对码只发送一次到主人的电脑，并会从页面地址中移除。',
    noScript: '配对需要 JavaScript，请开启后刷新本页面。',
  },
  it: {
    title: 'Collega questo PC a DSH',
    brand: 'DSH Mobile',
    heading: 'Collega questo PC a DSH',
    lead: 'Questa pagina abbina il browser al DSH in esecuzione sul computer del proprietario. Dopo l’abbinamento DSH si apre qui come una normale app web.',
    stepsTitle: 'Tre passaggi brevi',
    trustTitle: 'Prima installa il certificato',
    trustBody: 'Scarica e installa il certificato prima di tutto. Finché non è installato il browser segnala che questo indirizzo non è sicuro: è previsto e l’avviso scompare dopo aver installato il certificato.',
    trustLink: 'Scarica il certificato',
    trustWarning: 'Apri il file scaricato e conferma l’avviso di sicurezza, poi riapri questa pagina.',
    trustWindows: 'Apri il file scaricato, conferma l’avviso di sicurezza di Windows, poi chiudi e riapri questa scheda.',
    codeTitle: 'Inserisci il codice di abbinamento',
    codeBody: 'Chiedi il codice di abbinamento al proprietario e incollalo a destra. Il codice vale 5 minuti per impostazione predefinita e si usa una sola volta: se scade, chiedine uno nuovo.',
    installTitle: 'Installa come app desktop (facoltativo)',
    installBody: 'In Edge o Chrome apri il menu ⋯ e scegli App → Installa questo sito come app. Quando il browser lo propone, sotto il modulo compare un pulsante.',
    formTitle: 'Abbina questo PC',
    formHelp: 'Incolla il codice, la chiave di abbinamento o il link completo inviato dal proprietario.',
    devicePlaceholder: 'Questo PC',
    installButton: 'Installa come app desktop',
    installHint: 'L’installazione aggiunge una voce nel menu Start e una finestra dedicata; il resto del computer non cambia.',
    securityNote: 'Il codice viene inviato una sola volta al computer del proprietario e viene rimosso dall’indirizzo della pagina.',
    noScript: 'Per l’abbinamento serve JavaScript: attivalo e ricarica la pagina.',
  },
}

/**
 * Absolute routes and feature flags the PC entry page renders with.
 * `scriptPath` is the PC page's own script route; the phone page always loads
 * `/mobile-access/pair.js`, which exists only while the pairing window is open.
 */
export interface PairPageOptions {
  readonly certificateRequired: boolean
  readonly certificateUrl: string
  readonly manifestPath: string
  readonly serviceWorkerPath: string
  readonly scriptPath: string
  readonly entryPath: string
}

/** Pairing fields recovered from a `location.hash` fragment; never rendered into HTML. */
export interface PairFragment {
  readonly token?: string
  readonly instance?: string
}

/**
 * Extract the pairing token and instance id from a `location.hash` fragment.
 * Accepted forms: `#token=<token>`, `#key=dsh1.<instance>.<token>`,
 * `#key=dsh2.<instance>.<token>` and `#instance=<instance>&token=<token>`.
 * The body stays self-contained so `renderPairScript` can embed it verbatim.
 * @param hash - the raw fragment, with or without the leading `#`.
 * @returns the parsed fields; both are absent when the fragment carries neither form.
 */
export function parsePairFragment(hash: string): PairFragment {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const instance = params.get('instance')?.trim() ?? ''
  const token = params.get('token')?.trim() ?? ''
  if (token !== '') return instance === '' ? { token } : { token, instance }
  const appKey = /^(dsh\d+)\.([^.]+)\.(.+)$/.exec(params.get('key')?.trim() ?? '')
  const keyInstance = appKey?.[2]
  const keyToken = appKey?.[3]
  if (keyInstance !== undefined && keyInstance !== '' && keyToken !== undefined && keyToken !== '') {
    return { token: keyToken, instance: keyInstance }
  }
  return instance === '' ? {} : { instance }
}

/**
 * Extract the raw pairing token from whatever a person pasted into the code field:
 * the token itself, an app key (`dsh1.<instance>.<token>` / `dsh2.…`) or a link that
 * carries `key`/`token` in its fragment or query. Surrounding whitespace and quotes are
 * removed. An input that looks like a link but carries no code yields `''`, so the page
 * can explain the code instead of posting a value that cannot match.
 * The body stays self-contained apart from `parsePairFragment`, which `renderPairScript`
 * embeds right next to it.
 * @param input - the raw code-field value.
 * @returns the token to submit, or `''` when the input carries no usable code.
 */
export function extractPairingToken(input: string): string {
  const trimmed = input.trim()
  const wrapped = /^["'`“”‘’]+([\s\S]*?)["'`“”‘’]+$/.exec(trimmed)
  const candidate = (wrapped === null ? trimmed : wrapped[1] ?? '').trim()
  if (candidate === '') return ''
  const hash = candidate.indexOf('#')
  const query = candidate.indexOf('?')
  if (hash !== -1 || query !== -1) {
    const embedded = parsePairFragment(candidate.slice(hash === -1 ? query : hash))
    return embedded.token === undefined ? '' : embedded.token
  }
  const appKey = parsePairFragment(`#key=${candidate}`)
  if (appKey.token !== undefined) return appKey.token
  return candidate.includes('/') || candidate.includes(':') ? '' : candidate
}

/** Choose Chinese, Italian, or English from an HTTP Accept-Language header. */
export function resolveAuthPageLocale(header: string | undefined): AuthPageLocale {
  const values = header?.split(',').map((value, index) => {
    const [language, ...parameters] = value.split(';')
    const quality = parameters.find(parameter => parameter.trim().toLowerCase().startsWith('q='))
    const parsedQuality = quality === undefined ? 1 : Number(quality.trim().slice(2))
    return {
      language: language?.trim().toLowerCase() ?? '',
      quality: Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : 0,
      index,
    }
  }).filter(value => value.quality > 0).sort((left, right) => right.quality - left.quality || left.index - right.index).map(value => value.language) ?? []
  for (const value of values) {
    if (value.startsWith('zh')) return 'zh'
    if (value.startsWith('it')) return 'it'
    if (value.startsWith('en')) return 'en'
  }
  return 'en'
}

/** Escape a static configuration value for use inside a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Today's phone-sized pairing page; the no-options output contract is frozen. */
function renderPhonePairPage(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `<!doctype html>
<html lang="${copy.lang}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>input,textarea{font-size:16px}</style>
<title>${copy.pairTitle}</title>
<main>
  <h1>${copy.pairHeading}</h1>
  <form id="pair-form">
    <label>${copy.pairingCode} <input id="pair-token" autocomplete="one-time-code" required></label>
    <label>${copy.deviceName} <input id="device-label" maxlength="64" autocomplete="off"></label>
    <button type="submit">${copy.pair}</button>
    <output id="pair-status" aria-live="polite"></output>
  </form>
</main>
<script src="/mobile-access/pair.js" defer></script>
</html>
`
}

/**
 * Render the browser pairing form without reflecting request data into HTML.
 * Without options this keeps today's phone page unchanged; with options it adds the
 * certificate hint, the manifest link and the optional desktop-install button.
 * @param locale - negotiated page language.
 * @param options - absolute routes and feature flags for the enhanced page.
 * @returns a self-contained HTML document.
 */
export function renderPairPage(locale: AuthPageLocale, options?: PairPageOptions): string {
  const copy = COPY[locale]
  if (options === undefined) return renderPhonePairPage(locale)
  const pc = PC_COPY[locale]
  const certificate = options.certificateRequired
    ? `  <p>${pc.trustBody}</p>
  <p><a href="${escapeAttribute(options.certificateUrl)}" download>${pc.trustLink}</a></p>
  <p>${pc.trustWarning}</p>
`
    : ''
  return `<!doctype html>
<html lang="${copy.lang}" data-service-worker-path="${escapeAttribute(options.serviceWorkerPath)}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="manifest" href="${escapeAttribute(options.manifestPath)}">
<style>input,textarea{font-size:16px}</style>
<title>${copy.pairTitle}</title>
<main>
  <h1>${copy.pairHeading}</h1>
${certificate}  <form id="pair-form">
    <label>${copy.pairingCode} <input id="pair-token" autocomplete="one-time-code" required></label>
    <label>${copy.deviceName} <input id="device-label" maxlength="64" autocomplete="off"></label>
    <button type="submit">${copy.pair}</button>
    <output id="pair-status" aria-live="polite"></output>
  </form>
  <section id="install-section" hidden>
    <button type="button" id="install-app">${pc.installButton}</button>
    <p>${pc.installHint}</p>
  </section>
</main>
<script src="/mobile-access/pair.js" defer></script>
</html>
`
}

/**
 * Render the desktop-first PC entry page: guidance beside the pairing form.
 * @param locale - negotiated page language.
 * @param options - absolute routes and feature flags; every value is static configuration.
 * @returns a self-contained HTML document with inline CSS and no external asset.
 */
export function renderPcEntryPage(locale: AuthPageLocale, options: PairPageOptions): string {
  const copy = COPY[locale]
  const pc = PC_COPY[locale]
  const trustStep = options.certificateRequired
    ? `      <li>
        <h3>${pc.trustTitle}</h3>
        <p>${pc.trustBody}</p>
        <p><a href="${escapeAttribute(options.certificateUrl)}" download>${pc.trustLink}</a></p>
        <p class="help">${pc.trustWindows}</p>
      </li>
`
    : ''
  return `<!doctype html>
<html lang="${copy.lang}" data-service-worker-path="${escapeAttribute(options.serviceWorkerPath)}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<link rel="canonical" href="${escapeAttribute(options.entryPath)}">
<link rel="manifest" href="${escapeAttribute(options.manifestPath)}">
<title>${pc.title}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f7f8fa;color:#1f2937;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.page{max-width:1080px;margin:0 auto;padding:28px 18px 56px}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 22px;color:#2563eb;font-weight:600}
.brand-mark{width:10px;height:10px;border-radius:3px;background:#2563eb}
h1{margin:0 0 10px;font-size:clamp(26px,4vw,34px);line-height:1.2;letter-spacing:-.01em}
h2{margin:0 0 14px;font-size:19px;line-height:1.3}
h3{margin:0 0 4px;font-size:16px;line-height:1.35}
.lead{margin:0 0 26px;max-width:64ch;color:#4b5563}
.grid{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:start}
@media (min-width:720px){.grid{grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:22px}.page{padding:44px 28px 72px}}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px 22px 24px}
.steps{margin:0;padding-left:22px}
.steps li{margin:0 0 16px}
.steps li:last-child{margin-bottom:0}
.steps p{margin:0 0 6px;color:#4b5563}
.steps a{color:#2563eb}
.help{margin:0 0 14px;font-size:14px;color:#6b7280}
.steps .help{margin-bottom:0}
.note{margin:14px 0 0;font-size:13px;color:#6b7280}
.field{margin:0 0 14px}
label{display:block;margin:0 0 6px;font-size:14px;font-weight:600}
input{width:100%;min-height:44px;padding:10px 12px;font:inherit;color:inherit;background:#fff;border:1px solid #d1d5db;border-radius:10px}
button{min-height:44px;padding:0 18px;font:inherit;font-weight:600;color:#fff;background:#2563eb;border:1px solid #2563eb;border-radius:10px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
output{display:block;margin-top:12px;font-size:14px;color:#4b5563}
#install-section{margin-top:18px;padding-top:16px;border-top:1px solid #e5e7eb}
#install-app{background:#fff;color:#2563eb}
.noscript{margin:0 0 18px;padding:12px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;color:#9a3412}
</style>
<body>
<main class="page">
  <p class="brand"><span class="brand-mark" aria-hidden="true"></span>${pc.brand}</p>
  <h1>${pc.heading}</h1>
  <p class="lead">${pc.lead}</p>
  <noscript><p class="noscript">${pc.noScript}</p></noscript>
  <div class="grid">
    <section class="card" aria-labelledby="guide-title">
      <h2 id="guide-title">${pc.stepsTitle}</h2>
      <ol class="steps">
${trustStep}      <li>
        <h3>${pc.codeTitle}</h3>
        <p>${pc.codeBody}</p>
      </li>
      <li>
        <h3>${pc.installTitle}</h3>
        <p>${pc.installBody}</p>
      </li>
      </ol>
    </section>
    <section class="card" aria-labelledby="pair-title">
      <h2 id="pair-title">${pc.formTitle}</h2>
      <p class="help">${pc.formHelp}</p>
      <form id="pair-form">
        <div class="field">
          <label for="pair-token">${copy.pairingCode}</label>
          <input id="pair-token" autocomplete="one-time-code" required>
        </div>
        <div class="field">
          <label for="device-label">${copy.deviceName}</label>
          <input id="device-label" maxlength="64" autocomplete="off" placeholder="${pc.devicePlaceholder}">
        </div>
        <button type="submit">${copy.pair}</button>
        <output id="pair-status" aria-live="polite"></output>
      </form>
      <p class="note">${pc.securityNote}</p>
      <section id="install-section" hidden>
        <button type="button" id="install-app">${pc.installButton}</button>
        <p class="help">${pc.installHint}</p>
      </section>
    </section>
  </div>
</main>
<script src="${escapeAttribute(options.scriptPath)}" defer></script>
</body>
</html>
`
}

/**
 * Render the pairing form script shared by the phone page and the PC entry page.
 * The fragment parser is embedded from `parsePairFragment` so both stay one implementation.
 * @param locale - negotiated page language for every status message.
 * @returns a CSP-safe script that reads the token from the fragment only.
 */
export function renderPairScript(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `(() => {
  const parsePairFragment = ${parsePairFragment.toString()}

  const extractPairingToken = ${extractPairingToken.toString()}

  const form = document.getElementById('pair-form')
  const token = document.getElementById('pair-token')
  const label = document.getElementById('device-label')
  const status = document.getElementById('pair-status')
  const installSection = document.getElementById('install-section')
  const installButton = document.getElementById('install-app')
  const fragment = parsePairFragment(location.hash)
  history.replaceState(null, '', location.pathname + location.search)
  if (token && fragment.token) token.value = fragment.token
  let installPrompt = null
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt = event
    if (installSection) installSection.hidden = false
  })
  if (installButton) installButton.addEventListener('click', async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    await installPrompt.userChoice
    installPrompt = null
    if (installSection) installSection.hidden = true
  })
  const workerPath = document.documentElement.dataset.serviceWorkerPath
  if (workerPath && navigator.serviceWorker !== undefined && window.dshMobileNative === undefined) {
    navigator.serviceWorker.register(workerPath, { scope: '/' }).catch(() => {})
  }
  if (!form || !token || !label || !status) return
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const code = extractPairingToken(token.value)
    if (code === '') {
      status.value = ${JSON.stringify(copy.pairingCodeInvalid)}
      return
    }
    status.value = ${JSON.stringify(copy.pairing)}
    const submit = form.querySelector('button[type="submit"]')
    if (submit) submit.disabled = true
    try {
      const response = await fetch('/mobile-access/auth/pair', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: code, label: label.value || undefined }),
      })
      if (response.status === 429) {
        status.value = ${JSON.stringify(copy.pairingRateLimited)}
        if (submit) submit.disabled = false
        return
      }
      if (response.status === 401) {
        status.value = ${JSON.stringify(copy.pairingCodeInvalid)}
        if (submit) submit.disabled = false
        return
      }
      if (response.status === 403) {
        status.value = ${JSON.stringify(copy.pairingSourceRefused)}
        if (submit) submit.disabled = false
        return
      }
      if (response.status === 404) {
        status.value = ${JSON.stringify(copy.pairingWindowClosed)}
        if (submit) submit.disabled = false
        return
      }
      if (!response.ok) {
        status.value = ${JSON.stringify(copy.pairFailed)}
        if (submit) submit.disabled = false
        return
      }
      location.replace('/')
    } catch {
      status.value = ${JSON.stringify(copy.unavailable)}
      if (submit) submit.disabled = false
    }
  })
})()
`
}

/** Render the browser reauthentication page. */
export function renderLoginPage(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `<!doctype html>
<html lang="${copy.lang}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${copy.reconnectTitle}</title>
<main>
  <h1>${copy.reconnectHeading}</h1>
  <p id="login-progress" aria-live="polite">${copy.restoring}</p>
  <section id="login-failed" hidden>
    <p>${copy.noLongerPaired}</p>
    <a href="/mobile-access/pair">${copy.openPairing}</a>
  </section>
</main>
<script src="/mobile-access/login.js" defer></script>
</html>
`
}

/** Render the reauthentication script with locale-owned failure text. */
export function renderLoginScript(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `(() => {
  const candidate = new URL(location.href).searchParams.get('return')
  let returnPath = '/'
  if (candidate && candidate.startsWith('/')) {
    try {
      const resolved = new URL(candidate, location.origin)
      const pathname = decodeURIComponent(resolved.pathname)
      if (resolved.origin === location.origin && pathname !== '/mobile-access'
        && !pathname.startsWith('/mobile-access/') && !pathname.includes('\\\\')) {
        returnPath = resolved.pathname + resolved.search + resolved.hash
      }
    } catch {
      // Malformed untrusted return targets keep the safe root default.
    }
  }
  fetch('/mobile-access/auth/renew', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then((response) => {
    if (response.ok) {
      location.replace(returnPath)
      return
    }
    document.getElementById('login-progress').hidden = true
    document.getElementById('login-failed').hidden = false
  }).catch(() => {
    document.getElementById('login-progress').textContent = ${JSON.stringify(copy.unavailable)}
  })
})()
`
}
