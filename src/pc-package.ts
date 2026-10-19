/**
 * PC install package for a friend on Windows.
 *
 * The archive is written by hand (STORE records, CRC-32, fixed timestamps) so
 * the plugin needs no compression dependency and identical input produces
 * byte-identical output. It never carries a pairing token, a device secret or
 * an absolute local path: the pairing code is short-lived (5 minutes by
 * default, `pairingTtlMs`) and single use, so the README tells the friend to
 * open the page first and then ask the owner for a fresh code or the whole
 * entry link.
 */

/** Entry stored without compression inside the package ZIP. */
export interface ZipEntry {
  /** Relative, forward-slash separated name; UTF-8 is declared with flag bit 11. */
  readonly name: string
  readonly body: Buffer
}

/** Supported package language, matching the plugin's other user-facing copy. */
export type PcPackageLocale = 'zh' | 'en' | 'it'

/** Pairing certificate offered by the gateway, stored as-is in the package. */
export interface PcPackageCertificate {
  /** ASCII file name inside the archive, for example `dsh-mobile-ca.cer`. */
  readonly name: string
  /** Raw certificate bytes. */
  readonly body: Buffer
}

/** Everything needed to render one friend-facing package. */
export interface PcPackageInput {
  /** Bare `https://host:port` origin of the PC entry page. */
  readonly origin: string
  /** Absolute path of the PC entry page, for example `/mobile-access/pc`. */
  readonly entryPath: string
  readonly locale: PcPackageLocale
  /** Product label used in the README title; defaults to `DSH Mobile`. */
  readonly productName?: string
  /** Included only when the gateway has a pairing certificate to share. */
  readonly certificate?: PcPackageCertificate
}

/**
 * Fixed MS-DOS timestamp written into every ZIP record so a repeat build is
 * byte-identical: 2024-01-01 12:00:00, never the current clock.
 */
export const PC_PACKAGE_TIMESTAMP: { readonly time: number; readonly date: number; readonly iso: string } = {
  /** DOS time field: hour 12, minute 0, second 0. */
  time: 0x6000,
  /** DOS date field: year 2024, month 1, day 1. */
  date: 0x5821,
  /** The same instant in ISO form, for tests and reports. */
  iso: '2024-01-01T12:00:00',
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034B50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014B50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054B50
const ZIP_VERSION = 20
/** General-purpose flag bit 11: the entry name is UTF-8, not CP437. */
const ZIP_FLAG_UTF8 = 0x0800
const ZIP_METHOD_STORE = 0
const MAX_ZIP_ENTRIES = 0xFFFF
const MAX_ZIP_NAME_BYTES = 0xFFFF
const MAX_ZIP_SIZE = 0xFFFFFFFF

const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const PRINTABLE_ASCII = /^[\t\n\r\x20-\x7e]*$/u
const DEFAULT_PRODUCT_NAME = 'DSH Mobile'
const CERTIFICATE_SCRIPT_NAME = '1-trust-certificate.cmd'
const LAUNCHER_NAME = '2-open-dsh.cmd'
const SHORTCUT_NAME = 'open-dsh.url'
/** Conservative batch-safe certificate file name; it is embedded in a `.cmd`. */
const CERTIFICATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
/**
 * Characters that may appear in the entry URL. Everything a `cmd.exe` line
 * treats specially (`"`, `%`, `&`, `|`, `<`, `>`, `^`) and every non-ASCII byte
 * is rejected so the launcher cannot be broken by its own configuration.
 */
const SAFE_URL_PATTERN = /^[A-Za-z0-9:/?#[\]@!$'()*+,;=._~-]+$/u

const CRC32_TABLE = buildCrc32Table()

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xEDB88320 ^ (value >>> 1)) >>> 0 : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

/**
 * CRC-32 of one buffer (IEEE 802.3, reflected polynomial 0xEDB88320).
 * `crc32(Buffer.from('123456789'))` is `0xCBF43926`.
 */
export function crc32(body: Buffer): number {
  let value = 0xFFFFFFFF
  for (const byte of body) value = ((value >>> 8) ^ (CRC32_TABLE[(value ^ byte) & 0xFF] ?? 0)) >>> 0
  return (value ^ 0xFFFFFFFF) >>> 0
}

/** Reject entry names that could escape the extraction directory or break a reader. */
function safeEntryName(name: string): string {
  if (name === '') throw new Error('zip_entry_name_empty')
  if (name.startsWith('/') || /^[A-Za-z]:/u.test(name)) throw new Error('zip_entry_name_absolute')
  if (name.includes('\\')) throw new Error('zip_entry_name_backslash')
  if (name.includes('..')) throw new Error('zip_entry_name_traversal')
  if (CONTROL_CHARACTERS.test(name)) throw new Error('zip_entry_name_control')
  return name
}

/**
 * Build one deterministic ZIP archive: STORE entries, CRC-32, UTF-8 names and
 * the fixed {@link PC_PACKAGE_TIMESTAMP}. Unsafe entry names throw instead of
 * being silently rewritten.
 */
export function buildStoredZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('zip_entry_count_limit')
  const localRecords: Buffer[] = []
  const centralRecords: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(safeEntryName(entry.name), 'utf8')
    const body = entry.body
    const size = body.byteLength
    if (nameBytes.byteLength > MAX_ZIP_NAME_BYTES || size > MAX_ZIP_SIZE) throw new Error('zip_entry_size_limit')
    const checksum = crc32(body)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0)
    local.writeUInt16LE(ZIP_VERSION, 4)
    local.writeUInt16LE(ZIP_FLAG_UTF8, 6)
    local.writeUInt16LE(ZIP_METHOD_STORE, 8)
    local.writeUInt16LE(PC_PACKAGE_TIMESTAMP.time, 10)
    local.writeUInt16LE(PC_PACKAGE_TIMESTAMP.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBytes.byteLength, 26)
    local.writeUInt16LE(0, 28)
    localRecords.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0)
    central.writeUInt16LE(ZIP_VERSION, 4)
    central.writeUInt16LE(ZIP_VERSION, 6)
    central.writeUInt16LE(ZIP_FLAG_UTF8, 8)
    central.writeUInt16LE(ZIP_METHOD_STORE, 10)
    central.writeUInt16LE(PC_PACKAGE_TIMESTAMP.time, 12)
    central.writeUInt16LE(PC_PACKAGE_TIMESTAMP.date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBytes.byteLength, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralRecords.push(central, nameBytes)

    offset += local.byteLength + nameBytes.byteLength + size
  }

  const centralDirectory = Buffer.concat(centralRecords)
  if (offset > MAX_ZIP_SIZE || centralDirectory.byteLength > MAX_ZIP_SIZE) throw new Error('zip_archive_size_limit')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localRecords, centralDirectory, end])
}

/** Normalize and validate the bare origin plus entry path into one safe URL. */
function resolveEntryUrl(origin: string, entryPath: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error('pc_package_origin_invalid')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('pc_package_origin_invalid')
  if (parsed.username !== '' || parsed.password !== '') throw new Error('pc_package_origin_invalid')
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') throw new Error('pc_package_origin_invalid')
  if (entryPath === '' || !entryPath.startsWith('/')) throw new Error('pc_package_entry_path_invalid')
  if (entryPath.includes('..') || entryPath.includes('\\')) throw new Error('pc_package_entry_path_invalid')
  if (/[\u0000-\u0020\u007f]/u.test(entryPath)) throw new Error('pc_package_entry_path_invalid')
  const url = `${parsed.origin}${entryPath}`
  if (!SAFE_URL_PATTERN.test(url)) throw new Error('pc_package_url_unsafe')
  return url
}

function resolveProductName(productName: string | undefined): string {
  if (productName === undefined) return DEFAULT_PRODUCT_NAME
  if (productName === '' || productName.length > 64 || CONTROL_CHARACTERS.test(productName)) {
    throw new Error('pc_package_product_name_invalid')
  }
  return productName
}

/** Normalize CRLF so every generated text file is Windows-friendly. */
function crlf(text: string): string {
  return text.replace(/\r?\n/gu, '\r\n')
}

/** Encode one batch/shortcut file, refusing anything that is not plain ASCII. */
function asciiBuffer(text: string): Buffer {
  const normalized = crlf(text)
  if (!PRINTABLE_ASCII.test(normalized)) throw new Error('pc_package_text_not_ascii')
  return Buffer.from(normalized, 'ascii')
}

function renderCertificateScript(certificateName: string): string {
  return `@echo off
setlocal
echo.
echo DSH Mobile: trust the local certificate for the current Windows user
echo.
certutil -user -addstore Root "%~dp0${certificateName}"
if errorlevel 1 goto failed
echo.
echo The certificate was added. Continue with the next step in the README.
goto done

:failed
echo.
echo The certificate could not be added.
echo Right-click this file, choose "Run as administrator", and try again.

:done
echo.
pause
endlocal
`
}

function renderLauncherScript(url: string): string {
  return `@echo off
setlocal
rem DSH Mobile launcher: opens the PC page in an Edge or Chrome app window when available.
set "DSH_URL=${url}"

set "DSH_BROWSER="
for %%B in (
  "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"
  "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"
  "%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe"
  "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"
  "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"
  "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"
) do if not defined DSH_BROWSER if exist %%B set "DSH_BROWSER=%%~B"

if defined DSH_BROWSER (
  start "" "%DSH_BROWSER%" --app="%DSH_URL%"
) else (
  start "" "%DSH_URL%"
)

echo.
echo If nothing opened, double-click ${SHORTCUT_NAME} instead.
pause
endlocal
`
}

function renderShortcut(url: string): string {
  return `[InternetShortcut]
URL=${url}
`
}

interface ReadmeStep {
  readonly title: string
  readonly body: readonly string[]
}

interface ReadmeCopy {
  readonly titleSuffix: string
  readonly intro: readonly string[]
  readonly unzip: ReadmeStep
  readonly certificate: ReadmeStep
  readonly launch: ReadmeStep
  readonly pair: ReadmeStep
  readonly install: ReadmeStep
  readonly urlLabel: string
  readonly notesTitle: string
  readonly notes: readonly string[]
  readonly certificateNote: string
  readonly noCertificateNote: string
}

const README_COPY: Record<PcPackageLocale, ReadmeCopy> = {
  zh: {
    titleSuffix: ' 电脑端使用说明',
    intro: [
      '这个压缩包里是电脑端访问 DSH 所需的文件。请先解压，然后按下面的步骤操作，不需要安装任何软件。',
      '配对码由主人生成，会另外发给你。',
    ],
    unzip: {
      title: '解压',
      body: [
        '右键这个压缩包，选择“全部解压缩”，解压到一个文件夹（例如桌面）。',
        '请先解压再打开文件，不要在压缩包里直接双击。',
      ],
    },
    certificate: {
      title: '信任证书',
      body: [
        '双击 {certificateScript}。如果 Windows 询问是否允许更改，请选择“是”。',
        '看到“证书已添加”后，按任意键关闭窗口。',
        '证书文件 {certificate} 只用于加密你和主人电脑之间的连接，不会改动电脑上的其他设置。',
        '如果 Windows 提示“Windows 已保护你的电脑”，请点击“更多信息”，再点“仍要运行”。',
      ],
    },
    launch: {
      title: '打开 DSH',
      body: [
        '双击 {launcher}。',
        '如果 Windows 提示“Windows 已保护你的电脑”，请点击“更多信息”，再点“仍要运行”。',
        '如果 {launcher} 无法运行，可以改为双击 {shortcut}，它不会弹出上面的提示。',
        '浏览器会打开下面这个地址：',
      ],
    },
    pair: {
      title: '输入配对码',
      body: [
        '页面会要求输入配对码。请先打开页面，再向主人索取：配对码默认 5 分钟内有效，而且只能使用一次（主人可以在插件设置里把它改成 10 秒到 15 分钟）。',
        '配对码被第一台设备成功使用后即失效，所以第二台电脑，或同一台电脑上的第二个浏览器，需要请主人重新生成。',
        '输入框接受三种写法：原始配对码、应用密钥（dsh1.<实例>.<配对码>，自签远程入口是 dsh2.<实例>.<配对码>）或整条 PC 入口链接（形如 https://…/mobile-access/pc#key=…）。直接打开主人发来的链接最省事，不必手动输入。',
        '主人在 DSH Mobile 的“PC 端”里点“生成配对码”，把配对码或链接发给你。',
        '如果页面提示“配对码无效、已过期或已被使用”，请再向主人要一个新的；如果提示请求来源被拒绝，说明这台电脑和主人的电脑不在同一网络，或链接地址不对。',
        '配对成功后这台电脑会被记住，以后打开不需要再次输入。',
      ],
    },
    install: {
      title: '安装为桌面应用（可选）',
      body: [
        '在浏览器右上角的菜单里选择“应用” → “将此站点作为应用安装”（Edge），或“更多工具” → “创建快捷方式”（Chrome）。',
        '安装后可以从桌面或开始菜单直接打开，像普通软件一样。',
      ],
    },
    urlLabel: '地址：',
    notesTitle: '说明',
    notes: [
      '这个压缩包里没有配对码、密码或密钥，配对码始终由主人另外提供。',
      '如果页面打不开，或浏览器提示连接不安全，请把屏幕上的提示告诉主人。',
    ],
    certificateNote: '证书只安装到当前 Windows 用户，仅用于这条加密连接。',
    noCertificateNote: '本安装包不包含证书文件。',
  },
  en: {
    titleSuffix: ' on your PC',
    intro: [
      'This archive contains the files for using DSH on a Windows PC. Unzip it first, then follow the steps below; you do not need to install any software.',
      'The pairing code is created by the owner and sent to you separately.',
    ],
    unzip: {
      title: 'Unzip',
      body: [
        'Right-click the archive, choose "Extract All", and extract it to a folder such as your Desktop.',
        'Extract the files first, then open them; do not double-click anything inside the archive.',
      ],
    },
    certificate: {
      title: 'Trust the certificate',
      body: [
        'Double-click {certificateScript}. If Windows asks whether to allow changes, choose Yes.',
        'When you see that the certificate was added, press any key to close the window.',
        'The certificate file {certificate} only protects the connection between your PC and the owner\'s computer; it does not change other settings.',
        'If Windows shows "Windows protected your PC", click More info, then Run anyway.',
      ],
    },
    launch: {
      title: 'Open DSH',
      body: [
        'Double-click {launcher}.',
        'If Windows shows "Windows protected your PC", click More info, then Run anyway.',
        'If {launcher} does not run, double-click {shortcut} instead; it shows no such warning.',
        'Your browser opens this address:',
      ],
    },
    pair: {
      title: 'Enter the pairing code',
      body: [
        'The page asks for a pairing code. Open the page first, then ask the owner: a code is valid for 5 minutes by default and can be used only once (the owner can change the time from 10 seconds to 15 minutes).',
        'The first device to pair consumes the code, so a second PC, or a second browser on the same PC, needs a freshly generated code.',
        'The field accepts three forms: the raw code, the app key (dsh1.<instance>.<code>, or dsh2.<instance>.<code> for a self-signed remote entry) or the whole PC entry link (shaped like https://…/mobile-access/pc#key=…). Opening the link the owner sent you is the easiest path; there is nothing to type.',
        'In DSH Mobile the owner opens the "PC" tab, clicks "Generate pairing code", and sends you the code or the link.',
        'If the page says the code is invalid, expired or already used, ask the owner for a new one; if it says the request source was refused, this PC and the owner\'s computer are not on the same network, or the link address is wrong.',
        'After pairing, this PC is remembered and you do not need a new code next time.',
      ],
    },
    install: {
      title: 'Install as a desktop app (optional)',
      body: [
        'In the browser menu choose Apps → Install this site as an app (Edge), or More tools → Create shortcut (Chrome).',
        'After installing, open it from the desktop or the Start menu like any other app.',
      ],
    },
    urlLabel: 'Address:',
    notesTitle: 'Notes',
    notes: [
      'This archive contains no pairing code, password, or key; the owner always supplies the pairing code separately.',
      'If the page does not open, or the browser warns about the connection, show the owner what the page says.',
    ],
    certificateNote: 'The certificate is installed for the current Windows user only and only for this connection.',
    noCertificateNote: 'This package does not include a certificate file.',
  },
  it: {
    titleSuffix: ' sul tuo PC',
    intro: [
      'Questo archivio contiene i file per usare DSH su un PC Windows. Estrailo prima, poi segui i passaggi qui sotto; non devi installare nulla.',
      'Il codice di abbinamento viene creato dal proprietario e ti arriva separatamente.',
    ],
    unzip: {
      title: 'Estrai l\'archivio',
      body: [
        'Fai clic con il pulsante destro sull\'archivio, scegli "Estrai tutto" e indica una cartella, per esempio il Desktop.',
        'Estrai prima i file, poi aprili; non fare doppio clic sui file dentro l\'archivio.',
      ],
    },
    certificate: {
      title: 'Considera attendibile il certificato',
      body: [
        'Fai doppio clic su {certificateScript}. Se Windows chiede di consentire le modifiche, scegli Sì.',
        'Quando vedi che il certificato è stato aggiunto, premi un tasto per chiudere la finestra.',
        'Il file del certificato {certificate} protegge solo la connessione tra il tuo PC e il computer del proprietario; non modifica altre impostazioni.',
        'Se Windows mostra "Windows ha protetto il PC", fai clic su Ulteriori informazioni, poi su Esegui comunque.',
      ],
    },
    launch: {
      title: 'Apri DSH',
      body: [
        'Fai doppio clic su {launcher}.',
        'Se Windows mostra "Windows ha protetto il PC", fai clic su Ulteriori informazioni, poi su Esegui comunque.',
        'Se {launcher} non parte, fai doppio clic su {shortcut}: non mostra quell\'avviso.',
        'Il browser apre questo indirizzo:',
      ],
    },
    pair: {
      title: 'Inserisci il codice di abbinamento',
      body: [
        'La pagina chiede il codice di abbinamento. Apri prima la pagina e poi chiedilo al proprietario: il codice vale 5 minuti per impostazione predefinita e si usa una sola volta (il proprietario può cambiare la durata da 10 secondi a 15 minuti).',
        'Il codice viene consumato dalla prima apparecchiatura che si abbina, quindi un secondo PC, o un secondo browser sullo stesso PC, ha bisogno di un codice nuovo.',
        'Il campo accetta tre forme: il codice grezzo, la chiave di abbinamento (dsh1.<istanza>.<codice>, oppure dsh2.<istanza>.<codice> per un ingresso remoto autofirmato) o l\'intero link di ingresso al PC (del tipo https://…/mobile-access/pc#key=…). Aprire il link che ti ha inviato il proprietario è la via più semplice: non devi digitare nulla.',
        'In DSH Mobile il proprietario apre la scheda "PC", fa clic su "Genera codice di abbinamento" e ti invia il codice o il link.',
        'Se la pagina dice che il codice non è valido, è scaduto o è già stato usato, chiedine uno nuovo al proprietario; se dice che l\'origine della richiesta è stata rifiutata, questo PC e il computer del proprietario non sono sulla stessa rete, oppure l\'indirizzo del link è sbagliato.',
        'Dopo l\'abbinamento questo PC viene ricordato e non serve un nuovo codice.',
      ],
    },
    install: {
      title: 'Installa come app desktop (facoltativo)',
      body: [
        'Nel menu del browser scegli App → Installa questo sito come app (Edge), oppure Altri strumenti → Crea collegamento (Chrome).',
        'Dopo l\'installazione puoi aprirla dal desktop o dal menu Start come qualsiasi altra app.',
      ],
    },
    urlLabel: 'Indirizzo:',
    notesTitle: 'Note',
    notes: [
      'Questo archivio non contiene codici di abbinamento, password o chiavi: il codice arriva sempre dal proprietario.',
      'Se la pagina non si apre o il browser segnala la connessione, mostra al proprietario il messaggio che compare.',
    ],
    certificateNote: 'Il certificato viene installato solo per l\'utente Windows corrente e solo per questa connessione.',
    noCertificateNote: 'Questo pacchetto non include un file di certificato.',
  },
}

interface PreparedPackage {
  readonly url: string
  readonly productName: string
  readonly certificate: PcPackageCertificate | undefined
  readonly readme: string
}

function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) => values[key] ?? match)
}

function renderReadmeText(options: {
  readonly locale: PcPackageLocale
  readonly url: string
  readonly productName: string
  readonly certificate: PcPackageCertificate | undefined
}): string {
  const copy = README_COPY[options.locale]
  const values: Record<string, string> = {
    certificate: options.certificate?.name ?? '',
    certificateScript: CERTIFICATE_SCRIPT_NAME,
    launcher: LAUNCHER_NAME,
    shortcut: SHORTCUT_NAME,
  }
  const fill = (text: string): string => fillPlaceholders(text, values)
  const steps: ReadmeStep[] = [
    copy.unzip,
    ...(options.certificate === undefined ? [] : [copy.certificate]),
    { title: copy.launch.title, body: [...copy.launch.body, `${copy.urlLabel} ${options.url}`] },
    copy.pair,
    copy.install,
  ]
  const title = `${options.productName}${copy.titleSuffix}`
  const lines: string[] = [title, '='.repeat(Math.max(24, Math.min(72, title.length))), '', ...copy.intro.map(fill), '']
  steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${fill(step.title)}`)
    for (const line of step.body) lines.push(`   ${fill(line)}`)
    lines.push('')
  })
  lines.push(fill(copy.notesTitle), '-'.repeat(24))
  for (const note of copy.notes) lines.push(`- ${fill(note)}`)
  lines.push(`- ${fill(options.certificate === undefined ? copy.noCertificateNote : copy.certificateNote)}`)
  lines.push('')
  return lines.join('\r\n')
}

function preparePcPackage(input: PcPackageInput): PreparedPackage {
  const url = resolveEntryUrl(input.origin, input.entryPath)
  const productName = resolveProductName(input.productName)
  let certificate: PcPackageCertificate | undefined
  if (input.certificate !== undefined) {
    const name = input.certificate.name
    if (!CERTIFICATE_NAME_PATTERN.test(name)) throw new Error('pc_package_certificate_name_invalid')
    const reserved = new Set([`README-${input.locale}.txt`, CERTIFICATE_SCRIPT_NAME, LAUNCHER_NAME, SHORTCUT_NAME])
    if (reserved.has(name)) throw new Error('pc_package_certificate_name_conflict')
    certificate = { name, body: input.certificate.body }
  }
  return { url, productName, certificate, readme: renderReadmeText({ locale: input.locale, url, productName, certificate }) }
}

/**
 * Render the friend-facing README text for one package, without a byte-order
 * mark; {@link buildPcPackage} writes it as `README-<locale>.txt` with a BOM.
 */
export function renderPcPackageReadme(input: PcPackageInput): string {
  return preparePcPackage(input).readme
}

/**
 * Build the deterministic ZIP a Windows friend unzips and double-clicks:
 * the localized README, an optional certificate script plus certificate, the
 * app-window launcher and an `open-dsh.url` fallback.
 */
export function buildPcPackage(input: PcPackageInput): Buffer {
  const prepared = preparePcPackage(input)
  const certificate = prepared.certificate
  const entries: ZipEntry[] = [
    {
      name: `README-${input.locale}.txt`,
      body: Buffer.concat([UTF8_BOM, Buffer.from(prepared.readme, 'utf8')]),
    },
    ...(certificate === undefined ? [] : [
      { name: CERTIFICATE_SCRIPT_NAME, body: asciiBuffer(renderCertificateScript(certificate.name)) },
      { name: certificate.name, body: certificate.body },
    ]),
    { name: LAUNCHER_NAME, body: asciiBuffer(renderLauncherScript(prepared.url)) },
    { name: SHORTCUT_NAME, body: asciiBuffer(renderShortcut(prepared.url)) },
  ]
  return buildStoredZip(entries)
}
