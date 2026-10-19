import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessController } from '../src/access.js'
import { parseGatewayConfig } from '../src/config.js'
import { JsonEntryLinkStore, createEntryLinkSecret, parseEntryLinkSnapshot } from '../src/entry-link.js'
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

interface Fixture {
  readonly directory: string
  readonly gateway: MobileAccessGateway
  readonly adminPort: number
  readonly externalPort: number
}

async function fixture(directory?: string, options: { publicTls?: boolean, nestedState?: boolean } = {}): Promise<Fixture> {
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
    new MemoryDeviceStore(),
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

describe('JsonEntryLinkStore', () => {
  it('round-trips a generated secret and clears it', async () => {
    const directory = await temporaryDirectory()
    const store = new JsonEntryLinkStore(directory)
    expect(await store.load()).toBeUndefined()

    const secret = createEntryLinkSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await store.save(secret)
    expect(await store.load()).toBe(secret)

    const persisted = JSON.parse(await readFile(store.file, 'utf8')) as Record<string, unknown>
    expect(persisted).toStrictEqual({ version: 1, secret })

    await store.clear()
    expect(await store.load()).toBeUndefined()
    await expect(store.clear()).resolves.toBeUndefined()
  })

  it('refuses a malformed, foreign or replaced file instead of disabling the link silently', async () => {
    const directory = await temporaryDirectory()
    const store = new JsonEntryLinkStore(directory)
    await writeFile(store.file, 'not json at all\n', 'utf8')
    await expect(store.load()).rejects.toThrow()

    await writeFile(store.file, `${JSON.stringify({ version: 2, secret: createEntryLinkSecret() })}\n`, 'utf8')
    await expect(store.load()).rejects.toThrow(/unsupported version/u)

    await writeFile(store.file, `${JSON.stringify({ version: 1, secret: 'too-short' })}\n`, 'utf8')
    await expect(store.load()).rejects.toThrow(/invalid secret/u)

    await writeFile(store.file, `${JSON.stringify({ version: 1, secret: createEntryLinkSecret(), extra: 1 })}\n`, 'utf8')
    await expect(store.load()).resolves.toMatch(/^[\w-]{43}$/u)

    await rm(store.file, { force: true })
    await mkdir(store.file)
    await expect(store.load()).rejects.toThrow(/entry_link_file_invalid/u)
  })

  it('validates the persisted shape directly', () => {
    const secret = createEntryLinkSecret()
    expect(parseEntryLinkSnapshot({ version: 1, secret })).toStrictEqual({ version: 1, secret })
    expect(() => parseEntryLinkSnapshot(null)).toThrow()
    expect(() => parseEntryLinkSnapshot([])).toThrow()
    expect(() => parseEntryLinkSnapshot({ version: 1 })).toThrow()
    expect(() => parseEntryLinkSnapshot({ version: 1, secret: `${secret}=` })).toThrow()
  })
})

describe('durable entry link authorization', () => {
  it('pairs repeatedly through the durable secret without any window', async () => {
    const secret = createEntryLinkSecret()
    const access = await controller(secret)
    expect(access.entryLinkStatus()).toStrictEqual({ active: true })

    const first = await access.pair('friend-a', secret, 'Friend PC')
    const second = await access.pair('friend-b', `dsh1.3f2a1b.${secret}`, 'Second PC')
    expect(first.deviceId).not.toBe(second.deviceId)
    expect(access.listDevices()).toHaveLength(2)
    // Still reusable after both pairings: the link is a bearer credential, not a window.
    await expect(access.pair('friend-c', secret, 'Third PC')).resolves.toMatchObject({ deviceToken: expect.any(String) })
    expect(access.pairingStatus().open).toBe(false)
  })

  it('never exposes the secret through device listings', async () => {
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
    await expect(access.pair('phone', window.token, 'Phone')).resolves.toMatchObject({ deviceToken: expect.any(String) })
    await expect(access.pair('phone-2', window.token, 'Replay')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('friend', secret, 'Friend PC')).resolves.toMatchObject({ deviceToken: expect.any(String) })
  })

  it('rejects a rotated or revoked secret and keeps the cap in place', async () => {
    const secret = createEntryLinkSecret()
    const access = await controller(secret)
    const rotated = createEntryLinkSecret()
    access.setEntrySecret(rotated)
    await expect(access.pair('friend-a', secret, 'Old link')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('friend-b', rotated, 'New link')).resolves.toMatchObject({ deviceToken: expect.any(String) })

    access.setEntrySecret(undefined)
    expect(access.entryLinkStatus()).toStrictEqual({ active: false })
    await expect(access.pair('friend-c', rotated, 'Revoked link')).rejects.toMatchObject({ status: 401 })

    const capped = await controller(createEntryLinkSecret())
    const capSecret = createEntryLinkSecret()
    capped.setEntrySecret(capSecret)
    for (let index = 0; index < 4; index += 1) {
      await expect(capped.pair(`device-${String(index)}`, capSecret, `PC ${String(index)}`)).resolves.toMatchObject({ deviceToken: expect.any(String) })
    }
    await expect(capped.pair('device-overflow', capSecret, 'One too many')).rejects.toMatchObject({ status: 409 })
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
  it('creates the link once, returns it unchanged, and regenerates on request', async () => {
    const { adminPort, externalPort } = await fixture()
    const created = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })
    expect(created.status).toBe(201)
    expect(created.body.created).toBe(true)
    const appKey = created.body.appKey as string
    expect(appKey).toMatch(/^dsh[12]\.[\w-]+\.[\w-]{43}$/u)
    const entryUrl = created.body.entryUrl as string
    expect(entryUrl).toBe(`http://127.0.0.1:${String(externalPort)}/mobile-access/pc#key=${appKey}`)

    const again = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect(again.body.appKey).toBe(appKey)

    const regenerated = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{"regenerate":true}', admin: true })
    expect(regenerated.status).toBe(201)
    expect(regenerated.body.appKey).not.toBe(appKey)

    const status = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/status`, { admin: true })
    expect(status.body.entryLink).toStrictEqual({ active: true })

    const bad = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{"regenerate":"yes"}', admin: true })
    expect(bad.status).toBe(400)
  })

  it('lets a friend pair through the link repeatedly, then revokes it', async () => {
    const { adminPort, externalPort } = await fixture()
    const created = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })
    const appKey = created.body.appKey as string
    const entryUrl = created.body.entryUrl as string
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

    const revoked = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link/revoke`, { method: 'POST', body: '{}', admin: true })
    expect(revoked.status).toBe(200)
    const afterRevoke = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Too late' }), origin,
    })
    expect(afterRevoke.status).toBe(401)
    const status = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/status`, { admin: true })
    expect(status.body.entryLink).toStrictEqual({ active: false })
  })

  it('keeps the local and the public entry link independent', async () => {
    // src/plugin.ts stores the remote devices under <stateDirectory>/remote, so each
    // channel owns its own link file: a local link must never open the public entry.
    const root = await temporaryDirectory()
    const lan = await fixture(root)
    const remote = await fixture(root, { nestedState: true })
    const lanKey = (await json(lan.adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })).body.appKey as string
    const remoteKey = (await json(remote.adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })).body.appKey as string
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

  it('keeps the same link valid after a gateway restart', async () => {
    const directory = await temporaryDirectory()
    const first = await fixture(directory)
    const created = await json(first.adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })
    const appKey = created.body.appKey as string
    await first.gateway.close()
    gateways.splice(gateways.indexOf(first.gateway), 1)

    const restarted = await fixture(directory)
    const status = await json(restarted.adminPort, `${LOCAL_ADMIN_PREFIX}/lan/status`, { admin: true })
    expect(status.body.entryLink).toStrictEqual({ active: true })
    const paired = await json(restarted.externalPort, '/mobile-access/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ token: appKey, label: 'After restart' }),
      origin: `http://127.0.0.1:${String(restarted.externalPort)}`,
    })
    expect(paired.status).toBeLessThan(300)
  })

  it('refreshes an already-bound computer instead of registering another device', async () => {
    // publicTls mirrors the Cloudflare/SakuraFrp remote gateway: the listener is plain
    // but the public origin is HTTPS, so the __Host- device binding is issued.
    const { adminPort, externalPort } = await fixture(undefined, { publicTls: true })
    const created = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })
    const appKey = created.body.appKey as string
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
    const before = (await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/status`, { admin: true })).body.deviceCount

    const second = await json(externalPort, '/mobile-access/auth/pair', {
      method: 'POST', body: JSON.stringify({ token: appKey, label: 'Friend PC' }), origin, cookie: everyPath,
    })
    expect(second.status).toBe(200)
    expect(second.body.reused).toBe(true)
    expect(second.body.deviceId).toBe(first.body.deviceId)
    const after = (await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/status`, { admin: true })).body.deviceCount
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
  })

  it('cannot reuse a local-network device, which carries no binding the browser sends', async () => {
    // A plain-HTTP entry issues no __Host- binding and keeps the device token on the
    // narrow renewal path, so a repeat open has nothing the browser would send and
    // pairs again. This is the documented limitation, not an accident of the fixture.
    const { adminPort, externalPort } = await fixture()
    const created = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })
    const appKey = created.body.appKey as string
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

  it('never serves the link secret on the external listener', async () => {
    const { adminPort, externalPort } = await fixture()
    const created = await json(adminPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })
    const secret = (created.body.appKey as string).split('.')[2] as string
    expect(secret).toMatch(/^[\w-]{43}$/u)

    // The external listener proxies unknown paths upstream; whatever it answers,
    // the link secret and the admin route must not be reachable from outside.
    const external = await json(externalPort, `${LOCAL_ADMIN_PREFIX}/lan/link`, { method: 'POST', body: '{}', admin: true })
    expect(JSON.stringify(external.body)).not.toContain(secret)
    expect(external.body.entryUrl).toBeUndefined()
    const externalStatus = await json(externalPort, `${LOCAL_ADMIN_PREFIX}/lan/status`, { admin: true })
    expect(JSON.stringify(externalStatus.body)).not.toContain(secret)
    expect(externalStatus.body.entryLink).toBeUndefined()
  })
})
