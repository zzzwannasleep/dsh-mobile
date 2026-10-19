import { crc32 as runtimeCrc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  buildPcPackage,
  buildStoredZip,
  crc32,
  PC_PACKAGE_TIMESTAMP,
  renderPcPackageReadme,
  type PcPackageInput,
  type ZipEntry,
} from '../src/pc-package.js'

const BASE: PcPackageInput = {
  origin: 'https://192.168.1.7:3443',
  entryPath: '/mobile-access/pc',
  locale: 'en',
}

const ENTRY_URL = 'https://192.168.1.7:3443/mobile-access/pc'
const CERTIFICATE_BODY = Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x02, 0x82, 0x01, 0x01, 0x00, 0xff])
const CERTIFICATE: PcPackageInput = {
  ...BASE,
  locale: 'zh',
  certificate: { name: 'dsh-mobile-ca.cer', body: CERTIFICATE_BODY },
}

interface ParsedEntry {
  readonly name: string
  readonly size: number
  readonly crc: number
  readonly flags: number
  readonly method: number
  readonly time: number
  readonly date: number
  readonly body: Buffer
}

/**
 * Independent reader for the archive under test: it starts at the end-of-
 * central-directory record, walks the central directory, then follows every
 * local header to the stored bytes.
 */
function parseZip(archive: Buffer): { readonly entries: readonly ParsedEntry[] } {
  const end = archive.byteLength - 22
  expect(archive.readUInt32LE(end)).toBe(0x06054B50)
  expect(archive.readUInt16LE(end + 4)).toBe(0)
  expect(archive.readUInt16LE(end + 6)).toBe(0)
  expect(archive.readUInt16LE(end + 8)).toBe(archive.readUInt16LE(end + 10))
  expect(archive.readUInt16LE(end + 20)).toBe(0)
  const totalEntries = archive.readUInt16LE(end + 10)
  const centralSize = archive.readUInt32LE(end + 12)
  const centralOffset = archive.readUInt32LE(end + 16)
  const entries: ParsedEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014B50)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const time = archive.readUInt16LE(cursor + 12)
    const date = archive.readUInt16LE(cursor + 14)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressed = archive.readUInt32LE(cursor + 20)
    const size = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034B50)
    expect(archive.readUInt16LE(localOffset + 6)).toBe(flags)
    expect(archive.readUInt16LE(localOffset + 8)).toBe(method)
    expect(archive.readUInt32LE(localOffset + 14)).toBe(crc)
    expect(archive.readUInt32LE(localOffset + 18)).toBe(compressed)
    expect(archive.readUInt32LE(localOffset + 22)).toBe(size)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    expect(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8')).toBe(name)

    const bodyStart = localOffset + 30 + localNameLength + localExtraLength
    entries.push({ name, size, crc, flags, method, time, date, body: archive.subarray(bodyStart, bodyStart + size) })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  expect(cursor).toBe(centralOffset + centralSize)
  expect(cursor + 22).toBe(archive.byteLength)
  return { entries }
}

function entryNames(archive: Buffer): readonly string[] {
  return parseZip(archive).entries.map(entry => entry.name)
}

function textFile(archive: Buffer, name: string): string {
  const entry = parseZip(archive).entries.find(candidate => candidate.name === name)
  expect(entry, `missing entry ${name}`).toBeDefined()
  return entry!.body.toString('utf8')
}

/** True when a text file mixes LF into a document that should be all CRLF. */
function hasLoneLineFeed(text: string): boolean {
  return text.replace(/\r\n/gu, '').includes('\n')
}

describe('CRC-32', () => {
  it('matches the standard reference vectors', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
    expect(crc32(Buffer.from('123456789'))).toBe(0xCBF43926)
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(0x414FA339)
  })

  it('agrees with the runtime CRC-32 implementation on mixed bytes', () => {
    const sample = Buffer.from(Array.from({ length: 512 }, (_unused, index) => (index * 37 + 11) % 256))
    expect(crc32(sample)).toBe(runtimeCrc32(sample))
    expect(crc32(Buffer.from([0x00, 0xff, 0x80, 0x7f]))).toBe(runtimeCrc32(Buffer.from([0x00, 0xff, 0x80, 0x7f])))
  })
})

describe('stored ZIP container', () => {
  it('writes STORE records with UTF-8 names and the fixed DOS timestamp', () => {
    const archive = buildStoredZip([{ name: '说明/readme.txt', body: Buffer.from('hello') }])
    const parsed = parseZip(archive)

    expect(parsed.entries).toHaveLength(1)
    const entry = parsed.entries[0]!
    expect(entry.name).toBe('说明/readme.txt')
    expect(entry.method).toBe(0)
    expect(entry.flags).toBe(0x0800)
    expect(entry.time).toBe(PC_PACKAGE_TIMESTAMP.time)
    expect(entry.date).toBe(PC_PACKAGE_TIMESTAMP.date)
    expect(entry.size).toBe(5)
    expect(entry.crc).toBe(crc32(entry.body))
    expect(entry.crc).toBe(runtimeCrc32(entry.body))
    expect(entry.body.toString('utf8')).toBe('hello')
  })

  it('decodes the fixed timestamp back to 2024-01-01 12:00:00', () => {
    const { date, time } = PC_PACKAGE_TIMESTAMP
    expect([
      1980 + ((date >> 9) & 0x7f),
      (date >> 5) & 0x0f,
      date & 0x1f,
      (time >> 11) & 0x1f,
      (time >> 5) & 0x3f,
      (time & 0x1f) * 2,
    ]).toEqual([2024, 1, 1, 12, 0, 0])
    expect(PC_PACKAGE_TIMESTAMP.iso).toBe('2024-01-01T12:00:00')
  })

  it('produces byte-identical output for identical input', () => {
    const entries: readonly ZipEntry[] = [
      { name: 'a.txt', body: Buffer.from('alpha') },
      { name: 'nested/b.txt', body: Buffer.alloc(0) },
      { name: 'nested/c.bin', body: Buffer.from([0, 1, 2, 255]) },
    ]
    const first = buildStoredZip(entries)
    const second = buildStoredZip([
      { name: 'a.txt', body: Buffer.from('alpha') },
      { name: 'nested/b.txt', body: Buffer.alloc(0) },
      { name: 'nested/c.bin', body: Buffer.from([0, 1, 2, 255]) },
    ])

    expect(first.equals(second)).toBe(true)
    expect(first.toString('hex')).toBe(second.toString('hex'))
  })

  it('round-trips names, sizes, CRCs and content through the central directory', () => {
    const archive = buildStoredZip([
      { name: 'README-en.txt', body: Buffer.from('line one\r\nline two\r\n') },
      { name: 'empty.txt', body: Buffer.alloc(0) },
      { name: 'assets/icon.bin', body: Buffer.from(Array.from({ length: 300 }, (_unused, index) => index % 251)) },
    ])
    const parsed = parseZip(archive)

    expect(parsed.entries.map(entry => entry.name)).toEqual(['README-en.txt', 'empty.txt', 'assets/icon.bin'])
    for (const entry of parsed.entries) {
      expect(entry.method).toBe(0)
      expect(entry.flags & 0x0800).toBe(0x0800)
      expect(entry.size).toBe(entry.body.byteLength)
      expect(entry.crc).toBe(crc32(entry.body))
      expect(entry.crc).toBe(runtimeCrc32(entry.body))
    }
    expect(parsed.entries[0]!.body.toString('utf8')).toBe('line one\r\nline two\r\n')
    expect(parsed.entries[1]!.body.byteLength).toBe(0)
    expect(parsed.entries[2]!.body[299]).toBe(299 % 251)
  })

  it('accepts nested relative names', () => {
    expect(entryNames(buildStoredZip([{ name: 'nested/dir/file.txt', body: Buffer.alloc(0) }]))).toEqual(['nested/dir/file.txt'])
  })

  it('rejects unsafe entry names', () => {
    const rejected = [
      '',
      '/absolute.txt',
      'C:/absolute.txt',
      'C:relative-drive.txt',
      'nested\\file.txt',
      '..',
      '../escape.txt',
      'nested/../../escape.txt',
      'nested/..',
      'a..b.txt',
      'control\u0000name.txt',
      'control\u001fname.txt',
      'delete\u007fname.txt',
      'line\nbreak.txt',
    ]
    for (const name of rejected) {
      expect(() => buildStoredZip([{ name, body: Buffer.alloc(0) }]), JSON.stringify(name)).toThrow(Error)
    }
  })
})

describe('PC package inventory', () => {
  it('builds the launcher package without a certificate', () => {
    const archive = buildPcPackage(BASE)
    const parsed = parseZip(archive)

    expect(parsed.entries.map(entry => entry.name)).toEqual(['README-en.txt', '2-open-dsh.cmd', 'open-dsh.url'])
    for (const entry of parsed.entries) {
      expect(entry.method).toBe(0)
      expect(entry.flags & 0x0800).toBe(0x0800)
      expect(entry.time).toBe(PC_PACKAGE_TIMESTAMP.time)
      expect(entry.date).toBe(PC_PACKAGE_TIMESTAMP.date)
      expect(entry.crc).toBe(crc32(entry.body))
      expect(entry.size).toBe(entry.body.byteLength)
    }
  })

  it('adds the certificate script and the certificate only when one is supplied', () => {
    const archive = buildPcPackage(CERTIFICATE)
    const parsed = parseZip(archive)

    expect(parsed.entries.map(entry => entry.name)).toEqual([
      'README-zh.txt',
      '1-trust-certificate.cmd',
      'dsh-mobile-ca.cer',
      '2-open-dsh.cmd',
      'open-dsh.url',
    ])
    expect(parsed.entries.find(entry => entry.name === 'dsh-mobile-ca.cer')!.body.equals(CERTIFICATE_BODY)).toBe(true)
    expect(entryNames(buildPcPackage(BASE))).not.toContain('1-trust-certificate.cmd')
  })

  it('produces byte-identical packages for identical input', () => {
    expect(buildPcPackage(BASE).equals(buildPcPackage(BASE))).toBe(true)
    expect(buildPcPackage(CERTIFICATE).equals(buildPcPackage(CERTIFICATE))).toBe(true)
    expect(buildPcPackage(BASE).toString('hex')).toBe(buildPcPackage({ ...BASE }).toString('hex'))
  })

  it('normalizes the origin and keeps the entry path intact', () => {
    const archive = buildPcPackage({ ...BASE, origin: 'https://Example.COM:3443' })
    expect(textFile(archive, 'open-dsh.url')).toBe('[InternetShortcut]\r\nURL=https://example.com:3443/mobile-access/pc\r\n')
  })
})

describe('batch files and shortcut', () => {
  it('keeps every .cmd printable-ASCII with CRLF, @echo off and a closing pause', () => {
    const archive = buildPcPackage(CERTIFICATE)
    const commands = parseZip(archive).entries.filter(entry => entry.name.endsWith('.cmd'))
    expect(commands.map(entry => entry.name)).toEqual(['1-trust-certificate.cmd', '2-open-dsh.cmd'])

    for (const command of commands) {
      const text = command.body.toString('ascii')
      expect(text.startsWith('@echo off\r\n'), command.name).toBe(true)
      expect(text.trimEnd().endsWith('endlocal'), command.name).toBe(true)
      expect(text, command.name).toContain('\r\npause\r\n')
      expect(hasLoneLineFeed(text), command.name).toBe(false)
      expect(/^[\t\n\r\x20-\x7e]*$/u.test(text), command.name).toBe(true)
      expect(command.body.toString('latin1')).toBe(text)
    }
  })

  it('prefers an Edge or Chrome app window and falls back to the default browser', () => {
    const launcher = textFile(buildPcPackage(BASE), '2-open-dsh.cmd')

    expect(launcher).toContain(`set "DSH_URL=${ENTRY_URL}"`)
    expect(launcher).toContain('--app="%DSH_URL%"')
    expect(launcher).toContain('start "" "%DSH_BROWSER%" --app="%DSH_URL%"')
    expect(launcher).toContain('start "" "%DSH_URL%"')
    expect(launcher).toContain('%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe')
    expect(launcher).toContain('%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe')
    expect(launcher.indexOf('msedge.exe')).toBeLessThan(launcher.indexOf('chrome.exe'))
    expect(launcher).toContain('if defined DSH_BROWSER')
  })

  it('runs certutil against the certificate next to the script', () => {
    const script = textFile(buildPcPackage(CERTIFICATE), '1-trust-certificate.cmd')

    expect(script).toContain('certutil -user -addstore Root "%~dp0dsh-mobile-ca.cer"')
    expect(script).toContain('if errorlevel 1 goto failed')
    expect(script).toContain(':failed')
  })

  it('ships an Internet shortcut pointing at the entry page', () => {
    expect(textFile(buildPcPackage(BASE), 'open-dsh.url')).toBe(`[InternetShortcut]\r\nURL=${ENTRY_URL}\r\n`)
  })
})

describe('README', () => {
  it('writes a UTF-8 BOM followed by the rendered text', () => {
    const archive = buildPcPackage(BASE)
    const body = parseZip(archive).entries.find(entry => entry.name === 'README-en.txt')!.body

    expect(body.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))).toBe(true)
    const text = body.subarray(3).toString('utf8')
    expect(text).toBe(renderPcPackageReadme(BASE))
    expect(renderPcPackageReadme(BASE).charCodeAt(0)).not.toBe(0xFEFF)
  })

  it('documents unzip, launch, the short-lived pairing code and the desktop install', () => {
    const readme = renderPcPackageReadme(BASE)

    expect(readme.startsWith('DSH Mobile on your PC')).toBe(true)
    expect(readme.endsWith('\r\n')).toBe(true)
    expect(hasLoneLineFeed(readme)).toBe(false)
    expect(readme).toContain(ENTRY_URL)
    expect(readme).toContain('2-open-dsh.cmd')
    expect(readme).toContain('open-dsh.url')
    expect(readme).toContain('valid for 5 minutes by default')
    expect(readme).toContain('Install as a desktop app')
    expect(readme).not.toContain('1-trust-certificate.cmd')
    expect(readme).toContain('does not include a certificate file')
  })

  it('pins the 5-minute, single-use and three-forms wording in every locale', () => {
    const expectations = {
      zh: [
        '默认 5 分钟内有效',
        '只能使用一次',
        '10 秒到 15 分钟',
        '原始配对码',
        'dsh1.<实例>.<配对码>',
        'dsh2.<实例>.<配对码>',
        'PC 入口链接',
        '无效、已过期或已被使用',
        '不在同一网络',
      ],
      en: [
        'valid for 5 minutes by default',
        'used only once',
        '10 seconds to 15 minutes',
        'raw code',
        'dsh1.<instance>.<code>',
        'dsh2.<instance>.<code>',
        'PC entry link',
        'invalid, expired or already used',
        'not on the same network',
      ],
      it: [
        '5 minuti per impostazione predefinita',
        'una sola volta',
        'da 10 secondi a 15 minuti',
        'codice grezzo',
        'dsh1.<istanza>.<codice>',
        'dsh2.<istanza>.<codice>',
        'link di ingresso al PC',
        'non è valido, è scaduto o è già stato usato',
        'non sono sulla stessa rete',
      ],
    } as const

    for (const locale of ['zh', 'en', 'it'] as const) {
      const readme = renderPcPackageReadme({ ...BASE, locale })
      for (const text of expectations[locale]) expect(readme, `${locale}: ${text}`).toContain(text)
      expect(readme, locale).not.toContain('两分钟')
      expect(readme, locale).not.toContain('two minutes')
      expect(readme, locale).not.toContain('due minuti')
    }
  })

  it('adds the certificate step when a certificate is supplied', () => {
    const readme = renderPcPackageReadme(CERTIFICATE)

    expect(readme).toContain('1-trust-certificate.cmd')
    expect(readme).toContain('dsh-mobile-ca.cer')
    expect(readme).not.toContain('does not include a certificate file')
    expect(readme).toContain(ENTRY_URL)
  })

  it('uses the requested locale for the file name and the body', () => {
    const titles = { zh: '电脑端使用说明', en: 'on your PC', it: 'sul tuo PC' } as const
    for (const locale of ['zh', 'en', 'it'] as const) {
      const input: PcPackageInput = { ...BASE, locale }
      expect(entryNames(buildPcPackage(input))).toContain(`README-${locale}.txt`)
      expect(renderPcPackageReadme(input)).toContain(titles[locale])
    }
    expect(renderPcPackageReadme({ ...BASE, locale: 'zh' })).toContain('配对码')
    expect(renderPcPackageReadme({ ...BASE, locale: 'it' })).toContain('codice di abbinamento')
  })

  it('honours a custom product name', () => {
    expect(renderPcPackageReadme({ ...BASE, productName: 'Acme Harness' }).startsWith('Acme Harness on your PC')).toBe(true)
  })
})

describe('package never leaks a secret', () => {
  it('embeds no pairing token, app key or absolute local path', () => {
    const archive = buildPcPackage(CERTIFICATE)
    const files = parseZip(archive).entries.filter(entry => entry.name !== 'dsh-mobile-ca.cer')
    const joined = files.map(entry => entry.body.toString('utf8')).join('\n')

    expect(joined).toContain(ENTRY_URL)
    // The README may describe the accepted forms, but it must never carry a real
    // credential: the only `#` is the documented `#key=…` placeholder, and no
    // `dsh1.`/`dsh2.` is followed by an instance and a code.
    expect(joined.replaceAll('#key=…', '')).not.toContain('#')
    expect(joined).not.toMatch(/dsh[12]\.[A-Za-z0-9_-]+\./u)
    expect(joined).toContain('dsh1.<')
    expect(joined).toContain('dsh2.<')
    expect(joined).not.toContain('token')
    expect(joined).not.toContain('Token')
    expect(joined).not.toContain('appKey')
    expect(joined).not.toMatch(/[A-Za-z]:\\/u)
    expect(joined).not.toContain('/Users/')
    expect(joined).not.toContain('/home/')
    expect(joined).not.toContain('C:\\')
  })
})

describe('input validation', () => {
  it('rejects an origin that is not a bare http(s) origin', () => {
    const rejected = [
      '192.168.1.7:3443',
      'ftp://192.168.1.7:3443',
      'https://user:secret@192.168.1.7:3443',
      'https://192.168.1.7:3443/mobile-access/pc',
      'https://192.168.1.7:3443/?channel=lan',
      'https://192.168.1.7:3443/#key=abc',
      '',
    ]
    for (const origin of rejected) {
      expect(() => buildPcPackage({ ...BASE, origin }), origin).toThrow('pc_package_origin_invalid')
    }
  })

  it('rejects an entry path that is not a plain absolute path', () => {
    const rejected = ['', 'mobile-access/pc', '/mobile-access/../pc', '/mobile-access\\pc', '/mobile access/pc', '/pc\u0000', '/pc\n']
    for (const entryPath of rejected) {
      expect(() => buildPcPackage({ ...BASE, entryPath }), JSON.stringify(entryPath)).toThrow('pc_package_entry_path_invalid')
    }
  })

  it('rejects a product name that would break the README', () => {
    expect(() => renderPcPackageReadme({ ...BASE, productName: '' })).toThrow('pc_package_product_name_invalid')
    expect(() => renderPcPackageReadme({ ...BASE, productName: 'a'.repeat(65) })).toThrow('pc_package_product_name_invalid')
    expect(() => renderPcPackageReadme({ ...BASE, productName: 'bad\nname' })).toThrow('pc_package_product_name_invalid')
  })

  it('rejects a certificate name that is unsafe for the archive or the script', () => {
    const rejected = ['', '../ca.cer', 'nested/ca.cer', 'ca cer.cer', 'ca\\cer.cer', 'a'.repeat(70), '-ca.cer']
    for (const name of rejected) {
      expect(() => buildPcPackage({ ...BASE, certificate: { name, body: CERTIFICATE_BODY } }), name).toThrow('pc_package_certificate_name_invalid')
    }
    for (const name of ['README-en.txt', '1-trust-certificate.cmd', '2-open-dsh.cmd', 'open-dsh.url']) {
      expect(() => buildPcPackage({ ...BASE, certificate: { name, body: CERTIFICATE_BODY } }), name).toThrow('pc_package_certificate_name_conflict')
    }
  })

  it('keeps every rejected input out of a built archive', () => {
    expect(() => buildStoredZip([{ name: 'ok.txt', body: Buffer.alloc(0) }, { name: '../bad.txt', body: Buffer.alloc(0) }])).toThrow()
  })
})
