import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessController } from '../src/access.js'
import { parseGatewayConfig } from '../src/config.js'
import {
  ENTRY_LINK_LABEL_DEFAULT,
  JsonEntryLinkStore,
  MAX_ENTRY_LINKS,
  createEntryLinkId,
  createEntryLinkSecret,
  deriveEntryLinkId,
  normalizeEntryLinkLabel,
  parseEntryLinkState,
  type EntryLinkRecord,
} from '../src/entry-link.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { LOCAL_ADMIN_PREFIX } from '../src/http-security.js'
import { JsonDeviceStore, MemoryDeviceStore } from '../src/storage.js'

const directories: string[] = []
const servers: Server[] = []
const gateways: MobileAccessGateway[] = []
let clock = 1_000_000

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-entry-link-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  clock = 1_000_000
  for (const gateway of gateways.splice(0)) await gateway.close()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  for (const directory of directories.splice(0)) {
    const withinTemp = relative(tmpdir(), directory)
    if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('unsafe test cleanup path')
    await rm(directory, { recursive: true, force: true })
  }
})

function listen(server: Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      resolve(address.port)
    })
  })
}

async function controller(entrySecret?: string): Promise<AccessController> {
  const directory = await temporaryDirectory()
  const access = new AccessController(new JsonDeviceStore(join(directory, 'devices.json')), {
    pairingTtlMs: 300_000,
    deviceTtlMs: 3_600_000,
    sessionTtlMs: 30_000,
    maxDevices: 4,
    maxSessions: 8,
    rateLimitWindowMs: 60_000,
    maxPairingAttempts: 50,
    maxRateLimitKeys: 8,
    ...(entrySecret === undefined ? {} : { entrySecret }),
    now: () => clock,
  })
  await access.initialize()
  return access
}

function record(secret: string, label = ENTRY_LINK_LABEL_DEFAULT, id = createEntryLinkId()): EntryLinkRecord {
  return Object.freeze({ id, label, secret, createdAt: 1_500_000 })
}

interface Fixture {
  readonly directory: string
  readonly gateway: MobileAccessGateway
  readonly adminPort: number
  readonly externalPort: number
}

async function fixture(directory?: string, options: { publicTls?: boolean, nestedState?: boolean, persistentDevices?: boolean } = {}): Promise<Fixture> {
  const root = directory ?? await temporaryDirectory()
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}\n')
  })
  const upstreamPort = await listen(upstream)
  const parsed = parseGatewayConfig({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    // src/plugin.ts keeps the remote device store in <stateDirectory>/remote, so the
    // local and the public entry never share one link file.
    stateFile: options.nestedState === true ? join(root, 'remote', 'devices.json') : join(root, 'devices.json'),
    tls: { mode: 'disabled' },
    maxPairingAttempts: 50,
  })
  // The remote gateway terminates TLS in front (Cloudflare, SakuraFrp, a proxy), so it
  // keeps a plain listener while treating the public origin as HTTPS. parseGatewayConfig
  // derives publicTls from the listener mode, so the public half is set here.
  const gateway = new MobileAccessGateway(
    options.publicTls === true ? { ...parsed, publicTls: true } : parsed,
    // The restart scenarios need the devices to survive with the link file, exactly as
    // the plugin's own JsonDeviceStore does.
    options.persistentDevices === true ? new JsonDeviceStore(parsed.stateFile) : new MemoryDeviceStore(),
  )
  gateways.push(gateway)
  await gateway.start()
  const admin = createServer((incoming, response) => {
    const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname
    if (!(pathname === `${LOCAL_ADMIN_PREFIX}/lan` || pathname.startsWith(`${LOCAL_ADMIN_PREFIX}/lan/`))) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not_found"}')
      return
    }
    Promise.resolve(gateway.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/lan`, () => true).handler(incoming, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"error":"handler_failed"}')
      })
  })
  const adminPort = await listen(admin)
  return { directory: root, gateway, adminPort, externalPort: gateway.address().port }
}

interface JsonResponse {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly setCookie: readonly string[]
}

async function json(port: number, path: string, init: { method?: string, body?: string, origin?: string, admin?: boolean, cookie?: string } = {}): Promise<JsonResponse> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.origin !== undefined) headers.origin = init.origin
  if (init.cookie !== undefined) headers.cookie = init.cookie
  // The loopback admin route treats a POST as a browser mutation: it wants either a
  // desktop-admin marker or a same-origin Origin/Sec-Fetch-Site pair, exactly as
  // the DSH desktop panel sends it.
  if (init.admin === true) {
    headers.origin = `http://127.0.0.1:${String(port)}`
    headers['sec-fetch-site'] = 'same-origin'
  }
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text === '' ? {} : JSON.parse(text) as Record<string, unknown>,
    setCookie: response.headers.getSetCookie(),
  }
}

const LINK_PATH = `${LOCAL_ADMIN_PREFIX}/lan/link`
const LINKS_PATH = `${LOCAL_ADMIN_PREFIX}/lan/links`
const REVOKE_PATH = `${LOCAL_ADMIN_PREFIX}/lan/link/revoke`
const STATUS_PATH = `${LOCAL_ADMIN_PREFIX}/lan/status`

/** Create one link through the admin route and return its view. */
async function createLink(port: number, label?: string): Promise<Record<string, unknown>> {
  const created = await json(port, LINK_PATH, {
    method: 'POST',
    body: JSON.stringify(label === undefined ? {} : { label }),
    admin: true,
  })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  return created.body
}

async function listLinks(port: number): Promise<readonly Record<string, unknown>[]> {
  const listed = await json(port, LINKS_PATH, { admin: true })
  expect(listed.status).toBe(200)
  return listed.body.links as readonly Record<string, unknown>[]
}

describe('JsonEntryLinkStore', () => {
  it('round-trips several links and clears them', async () => {
    const directory = await temporaryDirectory()
    const store = new JsonEntryLinkStore(directory)
    expect(await store.load()).toStrictEqual({ version: 2, links: [] })

    const first = record(createEntryLinkSecret(), '我的电脑')
    const second = record(createEntryLinkSecret(), '朋友的电脑')
    await store.save({ version: 2, links: [first, second] })
    expect(await store.load()).toStrictEqual({ version: 2, links: [first, second] })

    const persisted = JSON.parse(await readFile(store.file, 'utf8')) as Record<string, unknown>
    expect(persisted).toStrictEqual({ version: 2, links: [first, second] })

    await store.clear()
    expect(await store.load()).toStrictEqual({ version: 2, links: [] })
    await expect(store.clear()).resolves.toBeUndefined()
  })

  it('upgrades the single-link file of the previous release with a stable id', async () => {
    const directory = await temporaryDirectory()
    const store = new JsonEntryLinkStore(directory)
    const secret = createEntryLinkSecret()
    await writeFile(store.file, `${JSON.stringify({ version: 1, secret, extra: 1 })}\n`, 'utf8')

    const migrated = await store.load()
    expect(migrated.links).toHaveLength(1)
    // The identifier is what ties a paired device back to its link, so it must be
    // derived from the secret rather than drawn fresh on every read.
    expect(migrated.links[0]).toStrictEqual({
      id: deriveEntryLinkId(secret),
      label: ENTRY_LINK_LABEL_DEFAULT,
      secret,
      createdAt: expect.any(Number) as unknown as number,
    })
    expect(migrated.links[0]?.createdAt).toBeGreaterThan(0)
    expect((await store.load()).links[0]?.id).toBe(deriveEntryLinkId(secret))
  })

  it('refuses a malformed, foreign or replaced file instead of disabling the links silently', async () => {
    const directory = await temporaryDirectory()
    const store = new JsonEntryLinkStore(directory)
    await writeFile(store.file, 'not json at all\n', 'utf8')
    await expect(store.load()).rejects.toThrow()

    await writeFile(store.file, `${JSON.stringify({ version: 3, links: [] })}\n`, 'utf8')
    await expect(store.load()).rejects.toThrow(/unsupported version/u)

    await writeFile(store.file, `${JSON.stringify({ version: 2, secret: createEntryLinkSecret() })}\n`, 'utf8')
    await expect(store.load()).rejects.toThrow(/unsupported version/u)

    await writeFile(store.file, `${JSON.stringify({ version: 1, secret: 'too-short' })}\n`, 'utf8')
    await expect(store.load()).rejects.toThrow(/invalid secret/u)

    const many = Array.from({ length: MAX_ENTRY_LINKS + 1 }, () => record(createEntryLinkSecret()))
    await writeFile(store.file, `${JSON.stringify({ version: 2, links: many })}\n`, 'utf8')
    await expect(store.load()).rejects.toThrow(/unsupported version or link count/u)

    const secret = createEntryLinkSecret()
    await writeFile(store.file, `${JSON.stringify({ version: 2, links: [record(secret), record(secret)] })}\n`, 'utf8')
    await expect(store.load()).rejects.toThrow(/duplicate link identities/u)

    await rm(store.file, { force: true })
    await mkdir(store.file)
    await expect(store.load()).rejects.toThrow(/entry_link_file_invalid/u)
  })

  it('validates the persisted shape directly', () => {
    const secret = createEntryLinkSecret()
    const migrated = { id: deriveEntryLinkId(secret), createdAt: 1 }
    expect(parseEntryLinkState({ version: 1, secret }, migrated)).toStrictEqual({
      version: 2,
      links: [{ id: migrated.id, label: ENTRY_LINK_LABEL_DEFAULT, secret, createdAt: 1 }],
    })
    // Without the metadata the version 1 secret has no stable identity.
    expect(() => parseEntryLinkState({ version: 1, secret })).toThrow(/migration metadata/u)
    expect(() => parseEntryLinkState(null)).toThrow()
    expect(() => parseEntryLinkState([])).toThrow()
    expect(() => parseEntryLinkState({ version: 1 })).toThrow()
    expect(() => parseEntryLinkState({ version: 1, secret: `${secret}=` }, migrated)).toThrow()
    expect(() => parseEntryLinkState({ version: 2, links: [] })).not.toThrow()
    expect(() => parseEntryLinkState({ version: 2, links: 'nope' })).toThrow()
    expect(() => parseEntryLinkState({ version: 2, links: [{ ...record(secret), id: 'nope' }] })).toThrow(/invalid id/u)
    expect(() => parseEntryLinkState({ version: 2, links: [{ ...record(secret), label: 'x'.repeat(65) }] })).toThrow(/invalid label/u)
    expect(() => parseEntryLinkState({ version: 2, links: [{ ...record(secret), createdAt: -1 }] })).toThrow(/createdAt/u)
    expect(() => parseEntryLinkState({ version: 2, links: [{ ...record(secret), lastUsedAt: 1.5 }] })).toThrow(/lastUsedAt/u)
  })

  it('normalizes the label the owner types', () => {
    expect(normalizeEntryLinkLabel(undefined)).toBe(ENTRY_LINK_LABEL_DEFAULT)
    expect(normalizeEntryLinkLabel('  ')).toBe(ENTRY_LINK_LABEL_DEFAULT)
    expect(normalizeEntryLinkLabel('  我的电脑  ')).toBe('我的电脑')
    expect(() => normalizeEntryLinkLabel('x'.repeat(65))).toThrow()
    expect(() => normalizeEntryLinkLabel('bad\u0000name')).toThrow()
  })
})

describe('durable entry link authorization', () => {
  it('pairs repeatedly through the durable secret without any window', async () => {
    const secret = createEntryLinkSecret()
    const access = await controller(secret)
    expect(access.entryLinkStatus()).toStrictEqual({ active: true, count: 1 })

    const first = await access.pair('friend-a', secret, 'Friend PC')
    const second = await access.pair('friend-b', `dsh1.3f2a1b.${secret}`, 'Second PC')
    expect(first.deviceId).not.toBe(second.deviceId)
    expect(access.listDevices()).toHaveLength(2)
    // Still reusable after both pairings: the link is a bearer credential, not a window.
    await expect(access.pair('friend-c', secret, 'Third PC')).resolves.toMatchObject({ deviceToken: expect.any(String) })
    expect(access.pairingStatus().open).toBe(false)
    // Every device records the link it came through, so revoking the link finds them.
    expect(new Set(access.listDevices().map(device => device.entryLinkId)).size).toBe(1)
    expect(access.listDevices().map(device => device.entryLinkId)).toStrictEqual([
      deriveEntryLinkId(secret), deriveEntryLinkId(secret), deriveEntryLinkId(secret),
    ])
    expect(access.matchEntryLink(`dsh2.a.${secret}`)).toBe(deriveEntryLinkId(secret))
    expect(access.matchEntryLink(createEntryLinkSecret())).toBeUndefined()
  })

  it('never exposes a secret through device listings', async () => {
    const secret = createEntryLinkSecret()
    const access = await controller(secret)
    await access.pair('friend-a', secret, 'Friend PC')
    const serialized = JSON.stringify(access.listDevices())
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(secret.slice(0, 16))
  })

  it('leaves the one-time pairing window exactly as it was', async () => {
    const secret = createEntryLinkSecret()
    const access = await controller(secret)
    const window = await access.openPairing()
    const phone = await access.pair('phone', window.token, 'Phone')
    // A code is not an invitation: the device it creates belongs to no link.
    expect(phone.entryLinkId).toBeUndefined()
    expect(access.listDevices()[0]?.entryLinkId).toBeUndefined()
    await expect(access.pair('phone-2', window.token, 'Replay')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('friend', secret, 'Friend PC')).resolves.toMatchObject({ deviceToken: expect.any(String) })
  })

  it('revokes one link without touching the others', async () => {
    const access = await controller()
    const mine = record(createEntryLinkSecret(), '我的电脑')
    const friend = record(createEntryLinkSecret(), '朋友的电脑')
    access.setEntryLinks([mine, friend])
    expect(access.entryLinkStatus()).toStrictEqual({ active: true, count: 2 })

    const own = await access.pair('me', mine.secret, 'My PC')
    const theirs = await access.pair('friend', friend.secret, 'Friend PC')
    expect(own.entryLinkId).toBe(mine.id)
    expect(theirs.entryLinkId).toBe(friend.id)

    await expect(access.revokeEntryLink(mine.id)).resolves.toBe(1)
    expect(access.entryLinkStatus()).toStrictEqual({ active: true, count: 1 })
    expect(access.listDevices().map(device => device.id)).toStrictEqual([theirs.deviceId])
    // The revoked invitation cannot be used again, and its device lost its Session.
    await expect(access.pair('stranger', mine.secret, 'Late')).rejects.toMatchObject({ status: 401 })
    await expect(access.renewDevice(own.deviceId)).rejects.toMatchObject({ status: 401 })
    expect(() => access.authorizeSession(own.sessionToken)).toThrow(/authentication_failed|device_revoked/u)
    // The other link keeps working exactly as before.
    await expect(access.renewDevice(theirs.deviceId)).resolves.toMatchObject({ deviceId: theirs.deviceId })
    await expect(access.pair('friend-2', friend.secret, 'Second friend PC')).resolves.toMatchObject({ deviceToken: expect.any(String) })
    await expect(access.revokeEntryLink(mine.id)).resolves.toBe(0)
  })

  it('refuses a device whose link is no longer installed', async () => {
    const access = await controller()
    const link = record(createEntryLinkSecret())
    access.setEntryLinks([link])
    const paired = await access.pair('friend', link.secret, 'Friend PC')
    expect(paired.entryLinkId).toBe(link.id)

    // A lost or replaced link file must fail closed rather than leave the invitation
    // alive for the whole device lifetime.
    access.setEntryLinks([])
    await expect(access.renewDevice(paired.deviceId)).rejects.toMatchObject({ status: 401, code: 'device_revoked' })
    await expect(access.renew(paired.deviceToken)).rejects.toMatchObject({ status: 401, code: 'device_revoked' })
    await expect(access.probe(paired.deviceToken)).rejects.toMatchObject({ status: 401, code: 'device_revoked' })
    expect(() => access.authorizeDevice(paired.deviceToken)).toThrow()
    expect(() => access.authorizeSession(paired.sessionToken)).toThrow()

    // Re-installing the same link makes the device usable again, because nothing about
    // the device itself changed.
    access.setEntryLinks([link])
    await expect(access.renewDevice(paired.deviceId)).resolves.toMatchObject({ deviceId: paired.deviceId })
  })

  it('rejects a rotated or revoked secret and keeps the cap in place', async () => {
    const secret = createEntryLinkSecret()
    const access = await controller(secret)
    const rotated = createEntryLinkSecret()
    access.setEntrySecret(rotated)
    await expect(access.pair('friend-a', secret, 'Old link')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('friend-b', rotated, 'New link')).resolves.toMatchObject({ deviceToken: expect.any(String) })

    access.setEntrySecret(undefined)
    expect(access.entryLinkStatus()).toStrictEqual({ active: false, count: 0 })
    await expect(access.pair('friend-c', rotated, 'Revoked link')).rejects.toMatchObject({ status: 401 })

    const capped = await controller(createEntryLinkSecret())
    const capSecret = createEntryLinkSecret()
    capped.setEntrySecret(capSecret)
    for (let index = 0; index < 4; index += 1) {
      await expect(capped.pair(`device-${String(index)}`, capSecret, `PC ${String(index)}`)).resolves.toMatchObject({ deviceToken: expect.any(String) })
    }
    await expect(capped.pair('device-overflow', capSecret, 'One too many')).rejects.toMatchObject({ status: 409 })
  })

  it('refuses credentials it cannot use instead of installing them', async () => {
    const access = await controller()
    const secret = createEntryLinkSecret()
    expect(() => { access.setEntryLinks([{ id: 'nope', secret }]) }).toThrow(/invalid_request/u)
    expect(() => { access.setEntryLinks([{ id: createEntryLinkId(), secret: '' }]) }).toThrow(/invalid_request/u)
    expect(() => { access.setEntryLinks([{ id: createEntryLinkId(), secret: 'x'.repeat(513) }]) }).toThrow(/invalid_request/u)
    const id = createEntryLinkId()
    expect(() => { access.setEntryLinks([{ id, secret }, { id, secret: createEntryLinkSecret() }]) }).toThrow(/invalid_request/u)
    expect(access.entryLinkStatus()).toStrictEqual({ active: false, count: 0 })
  })

  it('keeps the rate limiter in front of the durable secret', async () => {
    const access = await controller(createEntryLinkSecret())
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await expect(access.pair('flood', 'wrong', 'Flood')).rejects.toMatchObject({ status: 401 })
    }
    await expect(access.pair('flood', 'wrong', 'Flood')).rejects.toMatchObject({ status: 429 })
  })
})

describe('entry link admin route', () => {
  it('appends one link per call and lists them with their own URLs', async () => {
    const { adminPort, externalPort } = await fixture()
    const first = await createLink(adminPort, '我的电脑')
    expect(first.created).toBe(true)
    const appKey = first.appKey as string
    expect(appKey).toMatch(/^dsh[12]\.[\w-]+\.[\w-]{43}$/u)
    expect(first.entryUrl).toBe(`http://127.0.0.1:${String(externalPort)}/mobile-access/pc#key=${appKey}`)
    expect(first.link).toMatchObject({ label: '我的电脑', deviceCount: 0, appKey, entryUrl: first.entryUrl })

    // A second call is a second invitation, not a rotation.
    const second = await createLink(adminPort)
    expect(second.appKey).not.toBe(appKey)
    expect((second.link as Record<string, unknown>).label).toBe(ENTRY_LINK_LABEL_DEFAULT)
    const links = await listLinks(adminPort)
    expect(links).toHaveLength(2)
    expect(links.map(link => link.id)).toStrictEqual([
      (first.link as Record<string, unknown>).id,
      (second.link as Record<string, unknown>).id,
    ])
    expect(links.map(link => link.appKey)).toStrictEqual([appKey, second.appKey])
    expect(links[0]?.createdAt).toEqual(expect.any(Number))
    expect(links[0]?.lastUsedAt).toBeUndefined()

    const status = await json(adminPort, STATUS_PATH, { admin: true })
    expect(status.body.entryLink).toStrictEqual({ active: true, count: 2 })

    // A device that pairs through one link is counted on that link only, and the link
    // records when it was last used.
    const paired = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin: `http://127.0.0.1:${String(externalPort)}`,
    })
    expect(paired.status).toBeLessThan(300)
    const counted = await listLinks(adminPort)
    expect(counted.map(link => link.deviceCount)).toStrictEqual([1, 0])
    expect(counted[0]?.lastUsedAt).toEqual(expect.any(Number))
  })

  it('revokes exactly the link it is told to, and everything with all', async () => {
    const { adminPort, externalPort } = await fixture()
    const origin = `http://127.0.0.1:${String(externalPort)}`
    const mine = await createLink(adminPort, '我的电脑')
    const friend = await createLink(adminPort, '朋友的电脑')
    const myId = (mine.link as Record<string, unknown>).id as string
    const friendId = (friend.link as Record<string, unknown>).id as string

    const myDevice = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: mine.appKey, label: 'My PC' }), origin,
    })
    const friendDevice = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: friend.appKey, label: 'Friend PC' }), origin,
    })
    expect(myDevice.status).toBeLessThan(300)
    expect(friendDevice.status).toBeLessThan(300)

    const revoked = await json(adminPort, REVOKE_PATH, { method: 'POST', body: JSON.stringify({ linkId: friendId }), admin: true })
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
    expect(revoked.body).toStrictEqual({ revoked: true, devicesRevoked: 1 })

    // Only the friend's invitation and the friend's device are gone.
    expect((await listLinks(adminPort)).map(link => link.id)).toStrictEqual([myId])
    const devices = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/devices`, { admin: true })
    expect((devices.body.devices as readonly Record<string, unknown>[]).map(device => device.label)).toStrictEqual(['My PC'])
    await expect(json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: friend.appKey, label: 'Too late' }), origin,
    })).resolves.toMatchObject({ status: 401 })
    await expect(json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: mine.appKey, label: 'Still fine' }), origin,
    })).resolves.toMatchObject({ status: expect.any(Number) })

    // A stale browser that still holds the friend's device cannot get back in either.
    const stale = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ token: friend.appKey, label: 'Friend PC' }),
      origin,
      cookie: (friendDevice.setCookie.filter(entry => !entry.toLowerCase().includes('path=/mobile-access/auth/renew')).map(entry => entry.split(';')[0] as string).join('; ')),
    })
    expect(stale.status).toBe(401)

    await expect(json(adminPort, REVOKE_PATH, { method: 'POST', body: JSON.stringify({ linkId: '0'.repeat(16) }), admin: true }))
      .resolves.toMatchObject({ status: 404 })
    await expect(json(adminPort, REVOKE_PATH, { method: 'POST', body: '{}', admin: true }))
      .resolves.toMatchObject({ status: 400 })
    await expect(json(adminPort, REVOKE_PATH, { method: 'POST', body: JSON.stringify({ linkId: 'nope' }), admin: true }))
      .resolves.toMatchObject({ status: 400 })

    const all = await json(adminPort, REVOKE_PATH, { method: 'POST', body: JSON.stringify({ all: true }), admin: true })
    expect(all.status).toBe(200)
    // Only the owner's link is left, and it carries two devices by now.
    expect(all.body).toStrictEqual({ revoked: true, devicesRevoked: 2, revokedLinks: 1 })
    expect(await listLinks(adminPort)).toStrictEqual([])
    const status = await json(adminPort, STATUS_PATH, { admin: true })
    expect(status.body.entryLink).toStrictEqual({ active: false, count: 0 })
  })

  it('refuses a link name it cannot store', async () => {
    const { adminPort } = await fixture()
    await expect(json(adminPort, LINK_PATH, { method: 'POST', body: JSON.stringify({ label: 7 }), admin: true }))
      .resolves.toMatchObject({ status: 400 })
    await expect(json(adminPort, LINK_PATH, { method: 'POST', body: JSON.stringify({ label: 'x'.repeat(65) }), admin: true }))
      .resolves.toMatchObject({ status: 400 })
    await expect(json(adminPort, LINK_PATH, { method: 'POST', body: JSON.stringify({ label: 'bad\u0000name' }), admin: true }))
      .resolves.toMatchObject({ status: 400 })
    expect(await listLinks(adminPort)).toStrictEqual([])
    // A blank name is not a failure: the link gets the default one.
    const blank = await createLink(adminPort, '   ')
    expect((blank.link as Record<string, unknown>).label).toBe(ENTRY_LINK_LABEL_DEFAULT)
  })

  it('stops at the link limit and accepts a new link after a revocation', async () => {
    const { adminPort } = await fixture()
    for (let index = 0; index < MAX_ENTRY_LINKS; index += 1) await createLink(adminPort, `链接 ${String(index)}`)
    const overflow = await json(adminPort, LINK_PATH, { method: 'POST', body: '{}', admin: true })
    expect(overflow.status).toBe(409)
    expect(overflow.body.error).toBe('entry_link_limit')
    expect(await listLinks(adminPort)).toHaveLength(MAX_ENTRY_LINKS)

    const links = await listLinks(adminPort)
    await json(adminPort, REVOKE_PATH, { method: 'POST', body: JSON.stringify({ linkId: links[0]?.id }), admin: true })
    await expect(createLink(adminPort, '替换')).resolves.toMatchObject({ created: true })
  })

  it('lets a friend pair through the link repeatedly, then revokes it', async () => {
    const { adminPort, externalPort } = await fixture()
    const created = await createLink(adminPort, '朋友')
    const appKey = created.appKey as string
    const entryUrl = created.entryUrl as string
    const linkId = (created.link as Record<string, unknown>).id as string
    const origin = `http://127.0.0.1:${String(externalPort)}`

    const first = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin,
    })
    expect(first.status).toBeLessThan(300)
    expect(first.setCookie.length).toBeGreaterThan(0)

    // The whole entry link works too, and the link is not consumed by the first friend.
    const second = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: entryUrl, label: 'Second PC' }), origin,
    })
    expect(second.status).toBeLessThan(300)

    const revoked = await json(adminPort, REVOKE_PATH, { method: 'POST', body: JSON.stringify({ linkId }), admin: true })
    expect(revoked.status).toBe(200)
    expect(revoked.body.devicesRevoked).toBe(2)
    const afterRevoke = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Too late' }), origin,
    })
    expect(afterRevoke.status).toBe(401)
    const status = await json(adminPort, STATUS_PATH, { admin: true })
    expect(status.body.entryLink).toStrictEqual({ active: false, count: 0 })
    expect(status.body.deviceCount).toBe(0)
  })

  it('keeps the local and the public entry link independent', async () => {
    // src/plugin.ts stores the remote devices under <stateDirectory>/remote, so each
    // channel owns its own link file: a local link must never open the public entry.
    const root = await temporaryDirectory()
    const lan = await fixture(root)
    const remote = await fixture(root, { nestedState: true })
    const lanKey = (await createLink(lan.adminPort)).appKey as string
    const remoteKey = (await createLink(remote.adminPort)).appKey as string
    expect(lanKey).not.toBe(remoteKey)

    const cross = await json(remote.externalPort, '/mobile-access/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ token: lanKey, label: 'Cross channel' }),
      origin: `http://127.0.0.1:${String(remote.externalPort)}`,
    })
    expect(cross.status).toBe(401)
    const own = await json(remote.externalPort, '/mobile-access/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ token: remoteKey, label: 'Own channel' }),
      origin: `http://127.0.0.1:${String(remote.externalPort)}`,
    })
    expect(own.status).toBeLessThan(300)
  })

  it('keeps the same links valid after a gateway restart', async () => {
    const directory = await temporaryDirectory()
    const first = await fixture(directory, { persistentDevices: true })
    const mine = await createLink(first.adminPort, '我的电脑')
    const friend = await createLink(first.adminPort, '朋友的电脑')
    const myId = (mine.link as Record<string, unknown>).id
    const paired = await json(first.externalPort, '/mobile-access/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ token: friend.appKey, label: 'After restart' }),
      origin: `http://127.0.0.1:${String(first.externalPort)}`,
    })
    expect(paired.status).toBeLessThan(300)
    await first.gateway.close()
    gateways.splice(gateways.indexOf(first.gateway), 1)

    const restarted = await fixture(directory, { persistentDevices: true })
    const status = await json(restarted.adminPort, STATUS_PATH, { admin: true })
    expect(status.body.entryLink).toStrictEqual({ active: true, count: 2 })
    const links = await listLinks(restarted.adminPort)
    expect(links.map(link => link.id)).toStrictEqual([myId, (friend.link as Record<string, unknown>).id])
    expect(links.map(link => link.deviceCount)).toStrictEqual([0, 1])
    expect(links.map(link => link.label)).toStrictEqual(['我的电脑', '朋友的电脑'])
    const again = await json(restarted.externalPort, '/mobile-access/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ token: friend.appKey, label: 'After restart' }),
      origin: `http://127.0.0.1:${String(restarted.externalPort)}`,
    })
    expect(again.status).toBeLessThan(300)
    // The device that paired before the restart is still bound to its link.
    const revoked = await json(restarted.adminPort, REVOKE_PATH, {
      method: 'POST', body: JSON.stringify({ linkId: (friend.link as Record<string, unknown>).id }), admin: true,
    })
    expect(revoked.body.devicesRevoked).toBe(2)
  })

  it('upgrades a previous release\'s link file and keeps the devices it paired', async () => {
    const directory = await temporaryDirectory()
    const secret = createEntryLinkSecret()
    await writeFile(join(directory, 'entry-link.json'), `${JSON.stringify({ version: 1, secret })}\n`, 'utf8')
    const legacy = await fixture(directory, { persistentDevices: true })
    const status = await json(legacy.adminPort, STATUS_PATH, { admin: true })
    expect(status.body.entryLink).toStrictEqual({ active: true, count: 1 })
    const links = await listLinks(legacy.adminPort)
    expect(links[0]?.id).toBe(deriveEntryLinkId(secret))
    expect(links[0]?.label).toBe(ENTRY_LINK_LABEL_DEFAULT)

    const paired = await json(legacy.externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: secret, label: 'Friend PC' }), origin: `http://127.0.0.1:${String(legacy.externalPort)}`,
    })
    expect(paired.status).toBeLessThan(300)
    expect((await listLinks(legacy.adminPort))[0]?.deviceCount).toBe(1)

    // The upgraded file keeps the link, and the device still belongs to it.
    await legacy.gateway.close()
    gateways.splice(gateways.indexOf(legacy.gateway), 1)
    const restarted = await fixture(directory, { persistentDevices: true })
    const links2 = await listLinks(restarted.adminPort)
    expect(links2[0]?.id).toBe(deriveEntryLinkId(secret))
    expect(links2[0]?.deviceCount).toBe(1)
    const revoked = await json(restarted.adminPort, REVOKE_PATH, {
      method: 'POST', body: JSON.stringify({ linkId: deriveEntryLinkId(secret) }), admin: true,
    })
    expect(revoked.body).toStrictEqual({ revoked: true, devicesRevoked: 1 })
  })

  it('refreshes an already-bound computer instead of registering another device', async () => {
    // publicTls mirrors the Cloudflare/SakuraFrp remote gateway: the listener is plain
    // but the public origin is HTTPS, so the __Host- device binding is issued.
    const { adminPort, externalPort } = await fixture(undefined, { publicTls: true })
    const created = await createLink(adminPort)
    const appKey = created.appKey as string
    const linkId = (created.link as Record<string, unknown>).id as string
    const origin = `https://127.0.0.1:${String(externalPort)}`

    const first = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin,
    })
    expect(first.status).toBe(201)
    // A browser sends each Cookie only where its Path matches. The device token is
    // pinned to the narrow renewal path, so /auth/pair receives the __Host- device id
    // alone - the shape this test sends, not every Set-Cookie the response carried.
    const isRenewPath = (entry: string): boolean => entry.toLowerCase().includes('path=/mobile-access/auth/renew')
    const firstValue = (entry: string): string => entry.split(';')[0] as string
    const everyPath = first.setCookie.filter(entry => !isRenewPath(entry)).map(firstValue).join('; ')
    const renewPath = first.setCookie.filter(isRenewPath).map(firstValue).join('; ')
    expect(everyPath).toContain('__Host-dsh_ma_device_id=')
    expect(everyPath).not.toContain('dsh_ma_device=')
    expect(renewPath).toContain('dsh_ma_device=')
    const before = (await json(adminPort, STATUS_PATH, { admin: true })).body.deviceCount

    const second = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin, cookie: everyPath,
    })
    expect(second.status).toBe(200)
    expect(second.body.reused).toBe(true)
    expect(second.body.deviceId).toBe(first.body.deviceId)
    const after = (await json(adminPort, STATUS_PATH, { admin: true })).body.deviceCount
    expect(after).toBe(before)

    // A caller that does send the token (the renewal path's own client) reuses too.
    const viaToken = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin, cookie: `${everyPath}; ${renewPath}`,
    })
    expect(viaToken.status).toBe(200)
    expect(viaToken.body.reused).toBe(true)

    // A one-time code never takes the reuse path, and a stale binding still pairs.
    const stale = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin, cookie: '__Host-dsh_ma_device_id=not-a-device',
    })
    expect(stale.status).toBe(201)
    expect(stale.body.reused).toBeUndefined()

    // Once the link is revoked the bound browser cannot reuse its way back in.
    await json(adminPort, REVOKE_PATH, { method: 'POST', body: JSON.stringify({ linkId }), admin: true })
    const afterRevoke = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin, cookie: everyPath,
    })
    expect(afterRevoke.status).toBe(401)
  })

  it('cannot reuse a local-network device, which carries no binding the browser sends', async () => {
    // A plain-HTTP entry issues no __Host- binding and keeps the device token on the
    // narrow renewal path, so a repeat open has nothing the browser would send and
    // pairs again. This is the documented limitation, not an accident of the fixture.
    const { adminPort, externalPort } = await fixture()
    const created = await createLink(adminPort)
    const appKey = created.appKey as string
    const origin = `http://127.0.0.1:${String(externalPort)}`

    const first = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin,
    })
    expect(first.status).toBe(201)
    const everyPath = first.setCookie
      .filter(entry => !entry.toLowerCase().includes('path=/mobile-access/auth/renew'))
      .map(entry => entry.split(';')[0] as string).join('; ')
    expect(everyPath).not.toContain('__Host-dsh_ma_device_id')
    expect(everyPath).not.toContain('dsh_ma_device=')

    const second = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin, cookie: everyPath,
    })
    expect(second.status).toBe(201)
    expect(second.body.reused).toBeUndefined()
  })

  it('never serves a link secret on the external listener', async () => {
    const { adminPort, externalPort } = await fixture()
    const created = await createLink(adminPort)
    const secret = (created.appKey as string).split('.')[2] as string
    expect(secret).toMatch(/^[\w-]{43}$/u)

    // The external listener proxies unknown paths upstream; whatever it answers,
    // the link secret and the admin routes must not be reachable from outside.
    const external = await json(externalPort, LINK_PATH, { method: 'POST', body: '{}', admin: true })
    expect(JSON.stringify(external.body)).not.toContain(secret)
    expect(external.body.entryUrl).toBeUndefined()
    const externalLinks = await json(externalPort, LINKS_PATH, { admin: true })
    expect(JSON.stringify(externalLinks.body)).not.toContain(secret)
    expect(externalLinks.body.links).toBeUndefined()
    const externalStatus = await json(externalPort, STATUS_PATH, { admin: true })
    expect(JSON.stringify(externalStatus.body)).not.toContain(secret)
    expect(externalStatus.body.entryLink).toBeUndefined()
  })
})
