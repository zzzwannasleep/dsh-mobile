import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessController, normalizePairingToken } from '../src/access.js'
import { JsonDeviceStore } from '../src/storage.js'

const directories: string[] = []
const controllers: AccessController[] = []
let clock = 1_000_000

async function controller(): Promise<AccessController> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-pairing-'))
  directories.push(directory)
  const access = new AccessController(new JsonDeviceStore(join(directory, 'devices.json')), {
    pairingTtlMs: 300_000,
    deviceTtlMs: 3_600_000,
    sessionTtlMs: 30_000,
    maxDevices: 4,
    maxSessions: 8,
    rateLimitWindowMs: 60_000,
    maxPairingAttempts: 8,
    maxRateLimitKeys: 8,
    now: () => clock,
  })
  controllers.push(access)
  await access.initialize()
  return access
}

afterEach(async () => {
  clock = 1_000_000
  for (const access of controllers.splice(0)) await access.close()
  for (const directory of directories.splice(0)) {
    const withinTemp = relative(tmpdir(), directory)
    if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('unsafe test cleanup path')
    await rm(directory, { recursive: true, force: true })
  }
})

describe('normalizePairingToken', () => {
  it('keeps a raw code untouched and accepts the app key that carries it', () => {
    expect(normalizePairingToken('abc-DEF_123')).toBe('abc-DEF_123')
    expect(normalizePairingToken('dsh1.3f2a1b.abc-DEF_123')).toBe('abc-DEF_123')
    expect(normalizePairingToken('dsh2.3f2a1b.abc-DEF_123')).toBe('abc-DEF_123')
  })

  it('extracts the code from a pasted entry link, fragment first', () => {
    const link = 'https://192.168.1.10:3443/mobile-access/pc#key=dsh1.3f2a1b.abc-DEF_123'
    expect(normalizePairingToken(link)).toBe('abc-DEF_123')
    expect(normalizePairingToken('https://example.test/mobile-access/pc?token=abc-DEF_123')).toBe('abc-DEF_123')
    expect(normalizePairingToken('https://example.test/x?token=wrong#token=abc-DEF_123')).toBe('abc-DEF_123')
    expect(normalizePairingToken('https://example.test/x#key=abc-DEF_123&other=1')).toBe('abc-DEF_123')
  })

  it('decodes a percent-encoded link value and tolerates chat-app wrappers', () => {
    expect(normalizePairingToken('https://example.test/pc#key=dsh1.i.a%2Bb%2Fc')).toBe('a+b/c')
    expect(normalizePairingToken('  "abc-DEF_123"  ')).toBe('abc-DEF_123')
    expect(normalizePairingToken('<abc-DEF_123>')).toBe('abc-DEF_123')
    expect(normalizePairingToken('abc-DEF_123\n')).toBe('abc-DEF_123')
  })

  it('never rewrites an unrelated value into something else', () => {
    expect(normalizePairingToken('')).toBe('')
    expect(normalizePairingToken('   ')).toBe('')
    expect(normalizePairingToken('not a code')).toBe('not a code')
    expect(normalizePairingToken('dsh1.only-two-parts')).toBe('dsh1.only-two-parts')
    expect(normalizePairingToken('https://example.test/pc')).toBe('https://example.test/pc')
  })
})

describe('pairing with a pasted app key or entry link', () => {
  it('pairs with the app key and consumes the one-time window', async () => {
    const access = await controller()
    const window = await access.openPairing()
    const appKey = `dsh1.3f2a1b.${window.token}`

    const paired = await access.pair('pc-source', appKey, 'Friend PC')
    expect(paired.deviceToken).toMatch(/^[\w-]{43}$/u)
    expect(paired.sessionToken).toMatch(/^[\w-]{43}$/u)

    await expect(access.pair('pc-source', window.token, 'Replay')).rejects.toMatchObject({ status: 401 })
  })

  it('pairs with the whole entry link and with the raw code', async () => {
    const access = await controller()
    const viaLink = await access.openPairing()
    const link = `https://192.168.1.10:3443/mobile-access/pc#key=dsh1.3f2a1b.${viaLink.token}`
    await expect(access.pair('pc-source', link, 'Friend PC')).resolves.toMatchObject({ deviceToken: expect.any(String) })

    const viaCode = await access.openPairing()
    await expect(access.pair('pc-source', viaCode.token, 'Phone')).resolves.toMatchObject({ deviceToken: expect.any(String) })
  })

  it('still rejects a wrong code, an expired window and a stale window after reissue', async () => {
    const access = await controller()
    const stale = await access.openPairing()
    const fresh = await access.openPairing()
    await expect(access.pair('pc-source', `dsh1.i.${stale.token}`, 'Stale')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('pc-source', 'totally-wrong', 'Wrong')).rejects.toMatchObject({ status: 401 })

    clock += 300_001
    await expect(access.pair('pc-source', fresh.token, 'Late')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('pc-source', `dsh1.i.${fresh.token}`, 'Late')).rejects.toMatchObject({ status: 401 })
  })

  it('keeps the rate limiter and the length cap in front of normalization', async () => {
    const access = await controller()
    await access.openPairing()
    await expect(access.pair('long', 'x'.repeat(600), 'Long')).rejects.toMatchObject({ status: 401 })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(access.pair('flood', 'nope', 'Flood')).rejects.toMatchObject({ status: 401 })
    }
    await expect(access.pair('flood', 'nope', 'Flood')).rejects.toMatchObject({ status: 429 })
  })

  it('honours the configured window as the ceiling for a requested TTL', async () => {
    const access = await controller()
    await expect(access.openPairing(300_000)).resolves.toMatchObject({ expiresAt: clock + 300_000 })
    await expect(access.openPairing(300_001)).rejects.toMatchObject({ status: 400 })
    await expect(access.openPairing(9_999)).rejects.toMatchObject({ status: 400 })
  })
})

describe('durable entry link normalization', () => {
  it('accepts the app key and the whole entry link built from the durable secret', async () => {
    const secret = randomBytes(32).toString('base64url')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-pairing-'))
    directories.push(directory)
    const access = new AccessController(new JsonDeviceStore(join(directory, 'devices.json')), {
      pairingTtlMs: 300_000,
      deviceTtlMs: 3_600_000,
      sessionTtlMs: 30_000,
      maxDevices: 4,
      maxSessions: 8,
      rateLimitWindowMs: 60_000,
      maxPairingAttempts: 8,
      maxRateLimitKeys: 8,
      entrySecret: secret,
      now: () => clock,
    })
    controllers.push(access)
    await access.initialize()

    const appKey = `dsh1.3f2a1b.${secret}`
    const link = `https://192.168.1.10:3443/mobile-access/pc#key=${appKey}`
    await expect(access.pair('friend-a', appKey, 'App key')).resolves.toMatchObject({ deviceToken: expect.any(String) })
    await expect(access.pair('friend-b', link, 'Entry link')).resolves.toMatchObject({ deviceToken: expect.any(String) })
    await expect(access.pair('friend-c', `  "${secret}"  `, 'Wrapped')).resolves.toMatchObject({ deviceToken: expect.any(String) })
    await expect(access.pair('friend-d', `${secret}x`, 'Almost')).rejects.toMatchObject({ status: 401 })
  })
})
