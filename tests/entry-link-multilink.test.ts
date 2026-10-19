/**
 * Independent verification of the multiple revocable entry links (task-26).
 *
 * This file is deliberately self-contained: it builds its own gateway, its own
 * loopback admin listener and its own upstream, and it derives the identifiers it
 * asserts on with `node:crypto` instead of calling the production helpers, so a
 * wrong implementation cannot make its own test pass. Nothing here is imported
 * from another test file.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as requestHttp, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MOBILE_CONTROL_MESSAGES } from '../src/client-messages.js'
import { ENTRY_LINK_ID_PATTERN, MAX_ENTRY_LINKS, createEntryLinkSecret } from '../src/entry-link.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { DEVICE_COOKIE, LOCAL_ADMIN_PREFIX, SESSION_COOKIE } from '../src/http-security.js'
import { JsonDeviceStore } from '../src/storage.js'

const AUTH = '/mobile-access'
const PAIR_PATH = `${AUTH}/auth/pair`
const RENEW_PATH = `${AUTH}/auth/renew`
const ADMIN = LOCAL_ADMIN_PREFIX
const LINK_PATH = `${ADMIN}/lan/link`
const LINKS_PATH = `${ADMIN}/lan/links`
const REVOKE_PATH = `${ADMIN}/lan/link/revoke`
const STATUS_PATH = `${ADMIN}/lan/status`
const DEVICES_PATH = `${ADMIN}/lan/devices`
const PC_INFO_PATH = `${ADMIN}/pc/info`

const directories: string[] = []
const servers: Server[] = []
const gateways: MobileAccessGateway[] = []

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  for (const directory of directories.splice(0)) {
    const withinTemp = relative(tmpdir(), directory)
    if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('unsafe test cleanup path')
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-verify-multilink-'))
  directories.push(directory)
  return directory
}

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

interface Response {
  readonly status: number
  readonly body: string
  readonly json: Record<string, unknown>
  readonly setCookie: readonly string[]
}

async function send(
  port: number,
  path: string,
  init: { method?: string; body?: string; cookie?: string; admin?: boolean; origin?: string; contentType?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  const contentType = init.contentType === undefined ? 'application/json' : init.contentType
  if (init.body !== undefined && contentType !== null) headers['content-type'] = contentType
  if (init.cookie !== undefined) headers.cookie = init.cookie
  if (init.origin !== undefined) {
    headers.origin = init.origin
    headers['sec-fetch-site'] = 'same-origin'
  }
  // The loopback admin route treats a POST as a browser mutation and wants the
  // same-origin pair the DSH desktop panel sends.
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
  let json: Record<string, unknown> = {}
  try { json = text === '' ? {} : JSON.parse(text) as Record<string, unknown> } catch { json = {} }
  return { status: response.status, body: text, json, setCookie: response.headers.getSetCookie() }
}

interface Harness {
  readonly root: string
  readonly stateFile: string
  readonly gateway: MobileAccessGateway
  readonly adminPort: number
  readonly externalPort: number
  readonly origin: string
  close(): Promise<void>
}

/** Build one gateway over `root`, exactly as the plugin wires it (JSON stores). */
async function start(root: string): Promise<Harness> {
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
    stateFile: join(root, 'devices.json'),
    tls: { mode: 'disabled' },
    maxPairingAttempts: 50,
  })
  const gateway = new MobileAccessGateway(parsed, new JsonDeviceStore(parsed.stateFile))
  gateways.push(gateway)
  await gateway.start()
  const origin = gateway.address().origin
  const pcClient = {
    channels: async () => [{ channel: 'lan' as const, origin }],
    certificate: async () => undefined,
  }
  const routes = [
    { prefix: `${ADMIN}/lan`, handler: gateway.localAdminRoute(`${ADMIN}/lan`, () => true).handler },
    { prefix: `${ADMIN}/pc`, handler: gateway.localAdminRoute(`${ADMIN}/pc`, () => true, pcClient).handler },
    { prefix: ADMIN, handler: gateway.localAdminRoute(ADMIN, () => true).handler },
  ]
  const admin = createServer((incoming, response) => {
    const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find(candidate => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`))
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not_found"}')
      return
    }
    Promise.resolve(route.handler(incoming, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{"error":"handler_failed"}')
    })
  })
  const adminPort = await listen(admin)
  const harness: Harness = {
    root,
    stateFile: parsed.stateFile,
    gateway,
    adminPort,
    externalPort: gateway.address().port,
    origin,
    close: async () => {
      await gateway.close()
      await new Promise<void>(resolve => { admin.close(() => { resolve() }) })
      await new Promise<void>(resolve => { upstream.close(() => { resolve() }) })
    },
  }
  return harness
}

/** Independent derivation of the identifier the migration promises for a v1 secret. */
function expectedMigratedId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

async function createLink(port: number, body: Record<string, unknown> = {}): Promise<Response> {
  return await send(port, LINK_PATH, { method: 'POST', body: JSON.stringify(body), admin: true })
}

async function listLinks(port: number): Promise<readonly Record<string, unknown>[]> {
  const listed = await send(port, LINKS_PATH, { admin: true })
  expect(listed.status, listed.body).toBe(200)
  return listed.json.links as readonly Record<string, unknown>[]
}

async function revoke(port: number, body: Record<string, unknown>): Promise<Response> {
  return await send(port, REVOKE_PATH, { method: 'POST', body: JSON.stringify(body), admin: true })
}

interface PairResult {
  readonly status: number
  readonly body: string
  readonly session?: string
  readonly device?: string
}

/** Pair through the public entry exactly as the PC client does. */
async function pair(harness: Harness, token: string, label = 'PC'): Promise<PairResult> {
  const response = await send(harness.externalPort, PAIR_PATH, {
    method: 'POST',
    body: JSON.stringify({ token, label }),
    origin: harness.origin,
  })
  const session = response.setCookie.find(entry => entry.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0]?.split('=')[1]
  const device = response.setCookie.find(entry => entry.startsWith(`${DEVICE_COOKIE}=`))?.split(';')[0]?.split('=')[1]
  return { status: response.status, body: response.body, ...(session === undefined ? {} : { session }), ...(device === undefined ? {} : { device }) }
}

async function devices(port: number): Promise<readonly Record<string, unknown>[]> {
  const listed = await send(port, DEVICES_PATH, { admin: true })
  expect(listed.status, listed.body).toBe(200)
  return listed.json.devices as readonly Record<string, unknown>[]
}

/**
 * Does the Session still open the DSH UI? A non-document API path is proxied
 * verbatim, so 200 means the session was accepted and 401 means it was refused
 * (a top-level document request would instead be redirected to the login page).
 */
async function sessionProbe(harness: Harness, session: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${String(harness.externalPort)}/api/verify-probe`, {
    headers: { cookie: `${SESSION_COOKIE}=${session}`, accept: 'application/json' },
    redirect: 'manual',
  })
  await response.text()
  return response.status
}

/** A raw request, so the `Host` header can be forged the way a rebound client would. */
async function rawRequest(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const outgoing = requestHttp({
      host: '127.0.0.1',
      port,
      path,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      agent: false,
    }, response => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode ?? 0) })
    })
    outgoing.once('error', reject)
    outgoing.end(init.body)
  })
}

/** Renew with the persistent device credential: the only probe that survives a restart. */
async function renew(harness: Harness, device: string): Promise<Response> {
  return await send(harness.externalPort, RENEW_PATH, {
    method: 'POST',
    body: '{}',
    cookie: `${DEVICE_COOKIE}=${device}`,
    origin: harness.origin,
  })
}

function appKeyOf(view: Record<string, unknown>): string {
  return view.appKey as string
}

describe('multiple entry links: migration from the single-link release', () => {
  it('keeps a version 1 link working with a stable derived id across two restarts', async () => {
    const root = await temporaryDirectory()
    const secret = createEntryLinkSecret()
    await writeFile(join(root, 'entry-link.json'), `${JSON.stringify({ version: 1, secret })}\n`, 'utf8')
    const independentId = expectedMigratedId(secret)

    const first = await start(root)
    const links = await listLinks(first.adminPort)
    expect(links).toHaveLength(1)
    expect(links[0]?.id).toBe(independentId)
    expect(links[0]?.label).toBe('Access link')
    expect(links[0]?.secret, 'the raw secret is never part of the view').toBeUndefined()
    expect(appKeyOf(links[0] as Record<string, unknown>))
      .toBe(`dsh1.${first.gateway.config.instanceId}.${secret}`)
    expect((await send(first.adminPort, STATUS_PATH, { admin: true })).json.entryLink)
      .toStrictEqual({ active: true, count: 1 })
    await first.close()

    // Reading the old file must not rewrite it: with no pair in between, the second
    // start derives the very same identifier from the same untouched version 1 file.
    const second = await start(root)
    expect((await listLinks(second.adminPort)).map(link => link.id)).toStrictEqual([independentId])
    const untouched = JSON.parse(await readFile(join(root, 'entry-link.json'), 'utf8')) as Record<string, unknown>
    expect(untouched).toStrictEqual({ version: 1, secret })

    // The link pairs, and the device it created is attributed to the migrated id.
    const paired = await pair(second, appKeyOf((await listLinks(second.adminPort))[0] as Record<string, unknown>))
    expect(paired.status, paired.body).toBe(201)
    const afterPair = await devices(second.adminPort)
    expect(afterPair).toHaveLength(1)
    expect(afterPair[0]?.entryLinkId).toBe(independentId)
    await second.close()

    const third = await start(root)
    expect((await listLinks(third.adminPort)).map(link => link.id)).toStrictEqual([independentId])
    // The touch rewrote the file as version 2; the identity must not move with it.
    const rewritten = JSON.parse(await readFile(join(root, 'entry-link.json'), 'utf8')) as Record<string, unknown>
    expect(rewritten.version).toBe(2)
    expect((rewritten.links as readonly Record<string, unknown>[])[0]?.id).toBe(independentId)
    expect((rewritten.links as readonly Record<string, unknown>[])[0]?.lastUsedAt).toBeTypeOf('number')
    expect(await devices(third.adminPort)).toHaveLength(1)
    // Revoking the migrated link reports the device that entered through it.
    const revoked = await revoke(third.adminPort, { linkId: independentId })
    expect(revoked.status, revoked.body).toBe(200)
    expect(revoked.json).toStrictEqual({ revoked: true, devicesRevoked: 1 })
    expect(await devices(third.adminPort)).toHaveLength(0)
    expect(await listLinks(third.adminPort)).toHaveLength(0)
    expect((await send(third.adminPort, STATUS_PATH, { admin: true })).json.entryLink)
      .toStrictEqual({ active: false, count: 0 })
    await third.close()
  })

  it('refuses a device whose link file disappeared, and accepts it again once restored', async () => {
    const root = await temporaryDirectory()
    const secret = createEntryLinkSecret()
    const linkFile = join(root, 'entry-link.json')
    await writeFile(linkFile, `${JSON.stringify({ version: 1, secret })}\n`, 'utf8')

    const before = await start(root)
    const links = await listLinks(before.adminPort)
    const paired = await pair(before, appKeyOf(links[0] as Record<string, unknown>))
    expect(paired.status, paired.body).toBe(201)
    expect(paired.device, 'the persistent device credential is issued').toBeTruthy()
    const device = paired.device as string
    const renewal = await renew(before, device)
    expect(renewal.status, renewal.body).toBe(200)
    await before.close()

    // The link file is gone, but the device store still holds a device bound to it.
    await rm(linkFile, { force: true })
    const orphaned = await start(root)
    expect(await listLinks(orphaned.adminPort)).toHaveLength(0)
    const refused = await renew(orphaned, device)
    expect(refused.status, refused.body).toBe(401)
    // Fail closed also on the session path: a fresh session is unreachable, and the
    // stored device cannot mint one.
    expect(await pair(orphaned, appKeyOf(links[0] as Record<string, unknown>))).toMatchObject({ status: 401 })
    await orphaned.close()

    // Restoring the same secret revives the link and the device it owns.
    await writeFile(linkFile, `${JSON.stringify({ version: 1, secret })}\n`, 'utf8')
    const restored = await start(root)
    expect((await listLinks(restored.adminPort)).map(link => link.id)).toStrictEqual([expectedMigratedId(secret)])
    expect((await renew(restored, device)).status).toBe(200)
    expect(await devices(restored.adminPort)).toHaveLength(1)
    await restored.close()
  })
})

describe('multiple entry links: two links stay independent', () => {
  it('revokes one link and leaves the other pairing, removing only its own devices', async () => {
    const harness = await start(await temporaryDirectory())
    const first = await createLink(harness.adminPort, { label: 'Owner' })
    const second = await createLink(harness.adminPort, { label: 'Friend' })
    expect(first.status, first.body).toBe(201)
    expect(second.status, second.body).toBe(201)
    expect(first.json).toMatchObject({ created: true })
    const firstView = first.json.link as Record<string, unknown>
    const secondView = second.json.link as Record<string, unknown>
    expect(firstView.id).not.toBe(secondView.id)
    expect(ENTRY_LINK_ID_PATTERN.test(firstView.id as string)).toBe(true)
    expect((firstView.entryUrl as string)).toBe(`${harness.origin}${AUTH}/pc#key=${appKeyOf(firstView)}`)
    expect(first.json.appKey).toBe(appKeyOf(firstView))

    const viaFirst = await pair(harness, appKeyOf(firstView), 'Owner PC')
    const viaSecond = await pair(harness, appKeyOf(secondView), 'Friend PC')
    expect(viaFirst.status, viaFirst.body).toBe(201)
    expect(viaSecond.status, viaSecond.body).toBe(201)
    expect(await sessionProbe(harness, viaFirst.session as string)).toBe(200)
    expect(await sessionProbe(harness, viaSecond.session as string)).toBe(200)
    const both = await devices(harness.adminPort)
    expect(both).toHaveLength(2)
    expect(both.map(device => device.entryLinkId).sort()).toStrictEqual([firstView.id, secondView.id].sort())
    const views = await listLinks(harness.adminPort)
    expect(views.map(view => view.deviceCount)).toStrictEqual([1, 1])

    const revoked = await revoke(harness.adminPort, { linkId: firstView.id })
    expect(revoked.status, revoked.body).toBe(200)
    expect(revoked.json).toStrictEqual({ revoked: true, devicesRevoked: 1 })

    // Only the revoked link's device is gone; the other link still works end to end.
    const remaining = await devices(harness.adminPort)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.entryLinkId).toBe(secondView.id)
    expect(await sessionProbe(harness, viaFirst.session as string)).toBe(401)
    expect(await sessionProbe(harness, viaSecond.session as string)).toBe(200)
    expect((await pair(harness, appKeyOf(firstView))).status, 'the revoked link stops pairing').toBe(401)
    const third = await pair(harness, appKeyOf(secondView), 'Friend second PC')
    expect(third.status, third.body).toBe(201)
    expect(await devices(harness.adminPort)).toHaveLength(2)
    expect((await listLinks(harness.adminPort)).map(view => view.id)).toStrictEqual([secondView.id])
    expect((await send(harness.adminPort, STATUS_PATH, { admin: true })).json.entryLink)
      .toStrictEqual({ active: true, count: 1 })

    // Revoking everything clears the channel, and reports what it removed.
    const all = await revoke(harness.adminPort, { all: true })
    expect(all.status, all.body).toBe(200)
    expect(all.json).toStrictEqual({ revoked: true, devicesRevoked: 2, revokedLinks: 1 })
    expect(await devices(harness.adminPort)).toHaveLength(0)
    expect(await listLinks(harness.adminPort)).toHaveLength(0)
    expect((await send(harness.adminPort, STATUS_PATH, { admin: true })).json.entryLink)
      .toStrictEqual({ active: false, count: 0 })
    // The files agree with the in-memory answer.
    const persisted = JSON.parse(await readFile(join(harness.root, 'entry-link.json'), 'utf8').catch(() => '{"version":2,"links":[]}')) as Record<string, unknown>
    expect(persisted.links ?? []).toStrictEqual([])
    const stored = JSON.parse(await readFile(harness.stateFile, 'utf8')) as { devices?: readonly unknown[] }
    expect(stored.devices ?? []).toStrictEqual([])
  })

  it('fails closed for a device whose link was removed from the live set, then works again', async () => {
    const harness = await start(await temporaryDirectory())
    const created = await createLink(harness.adminPort)
    const view = created.json.link as Record<string, unknown>
    const paired = await pair(harness, appKeyOf(view))
    expect(paired.status, paired.body).toBe(201)
    expect(await renew(harness, paired.device as string)).toMatchObject({ status: 200 })

    // Remove the link from the controller without touching the files: the device
    // store still names it, so the device must be refused rather than trusted.
    harness.gateway.access.setEntryLinks([])
    expect((await renew(harness, paired.device as string)).status).toBe(401)
    expect(await sessionProbe(harness, paired.session as string)).toBe(401)

    // Re-installing the same link brings the device back; nothing was destroyed.
    // The Session refused above was ended by that refusal, so the device mints a
    // fresh one, and the old Session stays dead rather than being resurrected.
    harness.gateway.access.setEntryLinks([{ id: view.id as string, secret: (view.appKey as string).split('.').slice(2).join('.') }])
    const renewed = await renew(harness, paired.device as string)
    expect(renewed.status, renewed.body).toBe(200)
    const freshSession = renewed.setCookie
      .find(entry => entry.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0]?.split('=')[1] as string
    expect(freshSession).toBeTruthy()
    expect(await sessionProbe(harness, freshSession)).toBe(200)
    expect(await sessionProbe(harness, paired.session as string)).toBe(401)
    expect(await devices(harness.adminPort)).toHaveLength(1)
  })

  it('never lets a one-time code device be cut off by a link revocation', async () => {
    const harness = await start(await temporaryDirectory())
    const opened = await send(harness.adminPort, `${ADMIN}/lan/pairing/open`, { method: 'POST', body: '{}', admin: true })
    expect(opened.status, opened.body).toBe(201)
    const code = opened.json.token as string
    const byCode = await pair(harness, code, 'Phone')
    expect(byCode.status, byCode.body).toBe(201)
    const byCodeDevice = (await devices(harness.adminPort))[0]
    expect(byCodeDevice?.entryLinkId).toBeUndefined()

    const created = await createLink(harness.adminPort)
    const view = created.json.link as Record<string, unknown>
    expect((await pair(harness, appKeyOf(view), 'PC')).status).toBe(201)
    const all = await revoke(harness.adminPort, { all: true })
    expect(all.json).toStrictEqual({ revoked: true, devicesRevoked: 1, revokedLinks: 1 })
    const left = await devices(harness.adminPort)
    expect(left).toHaveLength(1)
    expect(left[0]?.entryLinkId).toBeUndefined()
    expect(await renew(harness, byCode.device as string)).toMatchObject({ status: 200 })
  })
})

describe('multiple entry links: route contract', () => {
  it('caps one channel at sixteen links and frees a slot when one is revoked', async () => {
    const harness = await start(await temporaryDirectory())
    expect(MAX_ENTRY_LINKS).toBe(16)
    const ids: string[] = []
    for (let index = 0; index < MAX_ENTRY_LINKS; index += 1) {
      const created = await createLink(harness.adminPort, { label: `link ${String(index)}` })
      expect(created.status, created.body).toBe(201)
      ids.push((created.json.link as Record<string, unknown>).id as string)
    }
    const over = await createLink(harness.adminPort)
    expect(over.status, over.body).toBe(409)
    expect(over.json).toStrictEqual({ error: 'entry_link_limit' })
    expect(await listLinks(harness.adminPort)).toHaveLength(MAX_ENTRY_LINKS)
    const persisted = JSON.parse(await readFile(join(harness.root, 'entry-link.json'), 'utf8')) as { links: readonly unknown[] }
    expect(persisted.links).toHaveLength(MAX_ENTRY_LINKS)

    // The last link still pairs, so the cap did not break the installed ones.
    const last = await listLinks(harness.adminPort)
    const appKey = appKeyOf(last[MAX_ENTRY_LINKS - 1] as Record<string, unknown>)
    expect((await pair(harness, appKey)).status).toBe(201)

    expect((await revoke(harness.adminPort, { linkId: ids[0] as string })).status).toBe(200)
    const replacement = await createLink(harness.adminPort)
    expect(replacement.status, replacement.body).toBe(201)
    expect((replacement.json.link as Record<string, unknown>).id).not.toBe(ids[0])
    expect(await listLinks(harness.adminPort)).toHaveLength(MAX_ENTRY_LINKS)
  })

  it('validates the link label and the revoke body as contracted', async () => {
    const harness = await start(await temporaryDirectory())
    for (const label of [42, true, null, ['x'], { name: 'x' }]) {
      const rejected = await createLink(harness.adminPort, { label })
      expect(rejected.status, `label ${JSON.stringify(label)}: ${rejected.body}`).toBe(400)
    }
    expect((await createLink(harness.adminPort, { label: 'a'.repeat(65) })).status).toBe(400)
    expect((await createLink(harness.adminPort, { label: `bad\u0001name` })).status).toBe(400)
    expect((await createLink(harness.adminPort, { label: `bad\u007fname` })).status).toBe(400)

    const named = await createLink(harness.adminPort, { label: 'a'.repeat(64) })
    expect(named.status, named.body).toBe(201)
    expect((named.json.link as Record<string, unknown>).label).toBe('a'.repeat(64))
    const trimmed = await createLink(harness.adminPort, { label: '  Owner  ' })
    expect((trimmed.json.link as Record<string, unknown>).label).toBe('Owner')
    const blank = await createLink(harness.adminPort, { label: '   ' })
    expect((blank.json.link as Record<string, unknown>).label).toBe('Access link')
    const absent = await createLink(harness.adminPort)
    expect((absent.json.link as Record<string, unknown>).label).toBe('Access link')
    expect((await listLinks(harness.adminPort)).map(view => view.label))
      .toStrictEqual(['a'.repeat(64), 'Owner', 'Access link', 'Access link'])

    // Revoke: an unknown but well-formed id is a miss, a malformed body is a bad request.
    expect((await revoke(harness.adminPort, { linkId: '0123456789abcdef' })).status).toBe(404)
    expect((await revoke(harness.adminPort, { linkId: '0123456789abcdef' })).json).toStrictEqual({ error: 'not_found' })
    for (const body of [{}, { linkId: 12 }, { linkId: 'zzzz' }, { linkId: 'A'.repeat(16) }, { all: false }]) {
      expect((await revoke(harness.adminPort, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await send(harness.adminPort, REVOKE_PATH, { method: 'POST', body: '[]', admin: true })).status).toBe(400)
    expect((await send(harness.adminPort, REVOKE_PATH, { method: 'POST', body: 'not json', admin: true })).status).toBe(400)
    // A missing Content-Type is refused by the shared JSON reader before the route
    // sees it; that is pre-existing behaviour of every admin mutation.
    expect((await send(harness.adminPort, REVOKE_PATH, { method: 'POST', body: '{}', admin: true, contentType: null })).status).toBe(415)
    expect((await send(harness.adminPort, REVOKE_PATH, { method: 'POST', body: '', admin: true })).status).toBe(400)
  })

  it('appends on every call and ignores the retired regenerate flag', async () => {
    const harness = await start(await temporaryDirectory())
    const first = await createLink(harness.adminPort, { label: 'First' })
    const second = await send(harness.adminPort, LINK_PATH, { method: 'POST', body: JSON.stringify({ regenerate: true }), admin: true })
    expect(second.status, second.body).toBe(201)
    expect(second.json).toMatchObject({ created: true })
    const views = await listLinks(harness.adminPort)
    expect(views).toHaveLength(2)
    const firstId = (first.json.link as Record<string, unknown>).id
    const secondId = (second.json.link as Record<string, unknown>).id
    expect(firstId).not.toBe(secondId)
    expect(views.map(view => view.id)).toStrictEqual([firstId, secondId])
    // The first link is still usable: nothing was rotated away.
    expect((await pair(harness, appKeyOf(views[0] as Record<string, unknown>))).status).toBe(201)
    expect((await pair(harness, appKeyOf(views[1] as Record<string, unknown>))).status).toBe(201)
    // A non-boolean regenerate is ignored rather than rejected, because the route no
    // longer reads the field at all.
    const ignored = await send(harness.adminPort, LINK_PATH, { method: 'POST', body: JSON.stringify({ regenerate: 'yes' }), admin: true })
    expect(ignored.status, ignored.body).toBe(201)
    expect(await listLinks(harness.adminPort)).toHaveLength(3)
  })

  it('refuses a link name it cannot store without writing a partial file', async () => {
    const harness = await start(await temporaryDirectory())
    const created = await createLink(harness.adminPort, { label: 'Keep' })
    expect(created.status).toBe(201)
    const before = await readFile(join(harness.root, 'entry-link.json'), 'utf8')
    expect((await createLink(harness.adminPort, { label: 'x'.repeat(65) })).status).toBe(400)
    expect(await readFile(join(harness.root, 'entry-link.json'), 'utf8')).toBe(before)
    expect(await listLinks(harness.adminPort)).toHaveLength(1)
  })
})

describe('multiple entry links: adversarial state files', () => {
  it('leaves a device from an older release untouched while a link revocation removes its own', async () => {
    const root = await temporaryDirectory()
    // A device written by the release that stored no link id, next to a live link.
    const legacy = {
      version: 1,
      devices: [{
        id: 'a'.repeat(32),
        label: 'Phone from before the upgrade',
        tokenDigest: 'b'.repeat(64),
        createdAt: Date.now() - 60_000,
        expiresAt: Date.now() + 3_600_000,
        lastSeenAt: Date.now() - 60_000,
      }],
    }
    await writeFile(join(root, 'devices.json'), `${JSON.stringify(legacy)}\n`, 'utf8')
    const harness = await start(root)
    expect(await devices(harness.adminPort)).toHaveLength(1)

    const created = await createLink(harness.adminPort, { label: 'New link' })
    const view = created.json.link as Record<string, unknown>
    expect((await pair(harness, appKeyOf(view))).status).toBe(201)
    expect(await devices(harness.adminPort)).toHaveLength(2)

    // Revoking the link must cut off only the device it created.
    const revoked = await revoke(harness.adminPort, { linkId: view.id })
    expect(revoked.status, revoked.body).toBe(200)
    expect(revoked.json).toStrictEqual({ revoked: true, devicesRevoked: 1 })
    const left = await devices(harness.adminPort)
    expect(left).toHaveLength(1)
    expect(left[0]?.id).toBe('a'.repeat(32))
    expect(left[0]?.entryLinkId).toBeUndefined()
  })

  it('fails closed on a hand-edited link file and lets the owner start over', async () => {
    const cases: readonly { readonly name: string, readonly payload: unknown }[] = [
      {
        name: 'seventeen links',
        payload: {
          version: 2,
          links: Array.from({ length: 17 }, () => ({ id: '0123456789abcdef', label: 'x', secret: createEntryLinkSecret(), createdAt: 1 })),
        },
      },
      {
        name: 'duplicate ids',
        payload: {
          version: 2,
          links: [
            { id: '0123456789abcdef', label: 'a', secret: createEntryLinkSecret(), createdAt: 1 },
            { id: '0123456789abcdef', label: 'b', secret: createEntryLinkSecret(), createdAt: 2 },
          ],
        },
      },
      {
        name: 'duplicate secrets',
        payload: (() => {
          const secret = createEntryLinkSecret()
          return {
            version: 2,
            links: [
              { id: '0123456789abcdef', label: 'a', secret, createdAt: 1 },
              { id: 'fedcba9876543210', label: 'b', secret, createdAt: 2 },
            ],
          }
        })(),
      },
      {
        name: 'an unknown id shape',
        payload: { version: 2, links: [{ id: 'NOT-HEX', label: 'a', secret: createEntryLinkSecret(), createdAt: 1 }] },
      },
      {
        name: 'a secret of the wrong length',
        payload: { version: 2, links: [{ id: '0123456789abcdef', label: 'a', secret: 'too-short', createdAt: 1 }] },
      },
      {
        name: 'an unsupported version',
        payload: { version: 3, links: [] },
      },
    ]

    for (const scenario of cases) {
      const root = await temporaryDirectory()
      await writeFile(join(root, 'entry-link.json'), `${JSON.stringify(scenario.payload)}\n`, 'utf8')
      const warnings: string[] = []
      const capture = (warning: Error & { code?: string }): void => { warnings.push(warning.code ?? warning.message) }
      process.on('warning', capture)
      let harness: Harness | undefined
      try {
        harness = await start(root)
        await new Promise(resolve => { setImmediate(resolve) })
        // Nothing is trusted, and the gateway keeps serving.
        expect(await listLinks(harness.adminPort), scenario.name).toHaveLength(0)
        expect((await send(harness.adminPort, STATUS_PATH, { admin: true })).json.entryLink)
          .toStrictEqual({ active: false, count: 0 })
        expect(warnings, scenario.name).toContain('DSH_MOBILE_ENTRY_LINK_INVALID')
        // The owner can start over without repairing the file by hand.
        const created = await createLink(harness.adminPort, { label: 'Recovered' })
        expect(created.status, created.body).toBe(201)
        const persisted = JSON.parse(await readFile(join(root, 'entry-link.json'), 'utf8')) as { version: number, links: readonly unknown[] }
        expect(persisted.version).toBe(2)
        expect(persisted.links).toHaveLength(1)
        expect((await pair(harness, appKeyOf(created.json.link as Record<string, unknown>))).status).toBe(201)
      } finally {
        process.off('warning', capture)
        if (harness !== undefined) await harness.close()
      }
    }
  })

  it('names a link with its normalized form and reports the per-link device count', async () => {
    const harness = await start(await temporaryDirectory())
    // "e" + combining acute accent normalizes to the precomposed character.
    const created = await createLink(harness.adminPort, { label: 'Cafe\u0301' })
    expect(created.status, created.body).toBe(201)
    expect((created.json.link as Record<string, unknown>).label).toBe('Caf\u00e9')

    const view = created.json.link as Record<string, unknown>
    const first = await pair(harness, appKeyOf(view), 'One')
    const second = await pair(harness, appKeyOf(view), 'Two')
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect((await listLinks(harness.adminPort))[0]?.deviceCount).toBe(2)
    expect((await listLinks(harness.adminPort))[0]?.lastUsedAt).toBeTypeOf('number')

    // Revoking one device directly lowers the link's own count, and the link stays.
    const paired = await devices(harness.adminPort)
    const target = paired[0]?.id as string
    expect((await send(harness.adminPort, `${ADMIN}/lan/devices/revoke`, {
      method: 'POST', body: JSON.stringify({ deviceId: target }), admin: true,
    })).status).toBe(200)
    expect((await listLinks(harness.adminPort))[0]?.deviceCount).toBe(1)
    expect((await listLinks(harness.adminPort))[0]?.id).toBe(view.id)
    expect((await pair(harness, appKeyOf(view), 'Three')).status).toBe(201)
  })

  it('reports every revoked link when the whole channel is cleared', async () => {
    const harness = await start(await temporaryDirectory())
    const ids: string[] = []
    for (let index = 0; index < MAX_ENTRY_LINKS; index += 1) {
      const created = await createLink(harness.adminPort)
      const view = created.json.link as Record<string, unknown>
      ids.push(view.id as string)
      if (index % 4 === 0) expect((await pair(harness, appKeyOf(view))).status).toBe(201)
    }
    expect(await devices(harness.adminPort)).toHaveLength(4)
    const all = await revoke(harness.adminPort, { all: true })
    expect(all.status, all.body).toBe(200)
    expect(all.json).toStrictEqual({ revoked: true, devicesRevoked: 4, revokedLinks: MAX_ENTRY_LINKS })
    expect(await devices(harness.adminPort)).toHaveLength(0)
    // A second clear is idempotent.
    expect((await revoke(harness.adminPort, { all: true })).json)
      .toStrictEqual({ revoked: true, devicesRevoked: 0, revokedLinks: 0 })
  })
})

describe('multiple entry links: frozen panel copy', () => {
  it('matches the contract table in every locale', () => {
    // Copied verbatim from the frozen contract (section 4b); a drift here would reach
    // the owner's panel and the guides that quote these strings.
    const frozen: Readonly<Record<string, Readonly<Record<'it' | 'en' | 'zh', string>>>> = {
      pcGenerateLink: {
        zh: '生成新链接',
        en: 'Create new link',
        it: 'Crea nuovo link',
      },
      pcEntryLinkLabel: {
        zh: '访问链接（直接打开，无需配对码）',
        en: 'Access links (open one directly — no pairing code)',
        it: 'Link di accesso (aprine uno direttamente — nessun codice)',
      },
      pcLinkRevoke: { zh: '撤销', en: 'Revoke', it: 'Revoca' },
      pcLinkRevokeConfirm: { zh: '确认撤销', en: 'Confirm revoke', it: 'Conferma revoca' },
      pcLinkLabelPlaceholder: {
        zh: '给这条链接起个名字（可留空）',
        en: 'Name this link (optional)',
        it: 'Dai un nome a questo link (facoltativo)',
      },
      pcLinkDefaultLabel: { zh: '访问链接', en: 'Access link', it: 'Link di accesso' },
      pcLinkListEmpty: {
        zh: '还没有访问链接。生成一条发给需要远程访问的人。',
        en: 'No access links yet. Create one and send it to whoever needs remote access.',
        it: 'Nessun link di accesso. Creane uno e invialo a chi ha bisogno dell’accesso remoto.',
      },
      pcLinkCreatedMeta: { zh: '创建于 {time}', en: 'Created {time}', it: 'Creato {time}' },
      pcLinkUsedMeta: { zh: '上次使用 {time}', en: 'Last used {time}', it: 'Ultimo uso {time}' },
      pcLinkUnusedMeta: { zh: '尚未使用', en: 'Not used yet', it: 'Mai usato' },
      pcLinkDeviceCount: { zh: '{count} 台设备', en: '{count} device(s)', it: '{count} dispositivi' },
      pcLinkRevoked: { zh: '链接已撤销。', en: 'Link revoked.', it: 'Link revocato.' },
      pcLinkRevokedDevices: {
        zh: '链接已撤销，{count} 台用它进入的设备也已移除。',
        en: 'Link revoked; the {count} device(s) that entered through it were removed too.',
        it: 'Link revocato; anche i {count} dispositivi entrati con esso sono stati rimossi.',
      },
      pcLinksFailed: {
        zh: '读取访问链接失败：{error}',
        en: 'Reading the access links failed: {error}',
        it: 'Lettura dei link di accesso non riuscita: {error}',
      },
      pcLinkLimit: {
        zh: '访问链接已达上限（{max} 条），请先撤销不再使用的链接。',
        en: 'The link limit is reached ({max}); revoke a link you no longer use first.',
        it: 'Limite di link raggiunto ({max}); revoca prima un link che non usi più.',
      },
      pcLinkCreating: { zh: '正在生成新链接…', en: 'Creating a new link…', it: 'Creazione di un nuovo link…' },
      pcLinkReady: {
        zh: '访问链接已复制，可以随时发给需要远程访问的人。',
        en: 'Access link copied — send it to whoever needs remote access.',
        it: 'Link di accesso copiato: invialo a chi ha bisogno dell’accesso remoto.',
      },
      pcLinkDurable: {
        zh: '每条链接长期有效、可重复打开，可以给每个人单独发一条；撤销某条链接后，用它进入的设备会一起移除。',
        en: 'Each link stays valid and can be reopened, so send a different one to each person; revoking a link also removes the devices that entered through it.',
        it: 'Ogni link resta valido e può essere riaperto: inviane uno diverso a ogni persona. Revocando un link vengono rimossi anche i dispositivi entrati con esso.',
      },
    }
    const messages = MOBILE_CONTROL_MESSAGES as unknown as Record<'it' | 'en' | 'zh', Record<string, string>>
    for (const [key, expected] of Object.entries(frozen)) {
      for (const locale of ['it', 'en', 'zh'] as const) {
        expect(messages[locale][key], `${locale}.${key}`).toBe(expected[locale])
      }
    }
    // The retired keys are gone from every locale.
    for (const locale of ['it', 'en', 'zh'] as const) {
      for (const retired of ['pcCopyLink', 'pcRegenerateLink', 'pcLinkRegenerated']) {
        expect(messages[locale][retired], `${locale}.${retired}`).toBeUndefined()
      }
    }
  })
})

describe('multiple entry links: trust boundary and concurrency', () => {
  it('keeps the link routes and every secret off the external listener', async () => {
    const harness = await start(await temporaryDirectory())
    const created = await createLink(harness.adminPort, { label: 'Secret holder' })
    const view = created.json.link as Record<string, unknown>
    const secret = (view.appKey as string).split('.')[2] as string
    expect(secret).toHaveLength(43)

    const probes: readonly { readonly method: string; readonly path: string }[] = [
      { method: 'GET', path: LINKS_PATH },
      { method: 'POST', path: LINK_PATH },
      { method: 'POST', path: REVOKE_PATH },
      { method: 'GET', path: STATUS_PATH },
      { method: 'GET', path: DEVICES_PATH },
      { method: 'GET', path: PC_INFO_PATH },
    ]
    for (const probe of probes) {
      const external = await send(harness.externalPort, probe.path, {
        method: probe.method,
        origin: harness.origin,
        ...(probe.method === 'POST' ? { body: '{}' } : {}),
      })
      expect(external.status, `${probe.method} ${probe.path} externally: ${external.body}`).toBe(404)
      expect(external.body).not.toContain(secret)
      expect(external.body).not.toContain(view.id as string)
    }

    // The loopback admin route is the only surface that sees a secret, and the shared
    // pc/info payload stays free of it.
    const info = await send(harness.adminPort, PC_INFO_PATH, { admin: true })
    expect(info.status, info.body).toBe(200)
    expect(info.body).not.toContain(secret)
    expect(info.body).not.toContain('#key=')
    expect((info.json.channels as readonly Record<string, unknown>[])[0]?.entryUrl).toBe(`${harness.origin}${AUTH}/pc`)
    expect((await send(harness.adminPort, STATUS_PATH, { admin: true })).body).not.toContain(secret)
    expect((await send(harness.adminPort, DEVICES_PATH, { admin: true })).body).not.toContain(secret)
    const listed = await send(harness.adminPort, LINKS_PATH, { admin: true })
    expect(listed.body).toContain(secret)
    // A foreign authority, a cross-site fetch and an unexpected query are all refused.
    expect(await rawRequest(harness.adminPort, LINKS_PATH, {
      headers: { host: 'public.example.test' },
    })).toBe(403)
    expect(await rawRequest(harness.adminPort, LINK_PATH, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${String(harness.adminPort)}`,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
        'content-length': '2',
      },
      body: '{}',
    })).toBe(403)
    // A loopback request with no Origin at all is refused for a mutation.
    expect(await rawRequest(harness.adminPort, LINK_PATH, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${String(harness.adminPort)}`,
        'content-type': 'application/json',
        'content-length': '2',
      },
      body: '{}',
    })).toBe(403)
    expect((await send(harness.adminPort, `${LINKS_PATH}?x=1`, { admin: true })).status).toBe(400)
  })

  it('loses no link when creates and last-used touches interleave', async () => {
    const harness = await start(await temporaryDirectory())
    const first = await createLink(harness.adminPort, { label: 'Base' })
    const base = first.json.link as Record<string, unknown>
    expect((await pair(harness, appKeyOf(base))).status).toBe(201)

    // Six concurrent mutations: three appends and three last-used touches, all of
    // which rewrite the whole file. A lost update would drop a link.
    const [second, third, fourth, viaBase, viaSecond, viaThird] = await Promise.all([
      createLink(harness.adminPort, { label: 'Second' }),
      createLink(harness.adminPort, { label: 'Third' }),
      createLink(harness.adminPort, { label: 'Fourth' }),
      pair(harness, appKeyOf(base), 'Again'),
      createLink(harness.adminPort, { label: 'Fifth' }).then(async created => await pair(harness, appKeyOf(created.json.link as Record<string, unknown>))),
      createLink(harness.adminPort, { label: 'Sixth' }).then(async created => await pair(harness, appKeyOf(created.json.link as Record<string, unknown>))),
    ])
    for (const response of [second, third, fourth]) expect(response.status, response.body).toBe(201)
    expect(viaBase.status).toBe(201)
    expect(viaSecond.status).toBe(201)
    expect(viaThird.status).toBe(201)

    const views = await listLinks(harness.adminPort)
    const ids = views.map(view => view.id)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
    const persisted = JSON.parse(await readFile(join(harness.root, 'entry-link.json'), 'utf8')) as { links: readonly Record<string, unknown>[] }
    expect(persisted.links.map(link => link.id)).toStrictEqual(ids)
    expect(views.filter(view => view.lastUsedAt !== undefined).length).toBeGreaterThanOrEqual(1)
    // Every created link still pairs: none was silently replaced.
    for (const view of views) expect((await pair(harness, appKeyOf(view))).status).toBe(201)

    // Twenty simultaneous appends cannot exceed the cap nor lose a record.
    const burst = await Promise.all(Array.from({ length: 20 }, async () => await createLink(harness.adminPort)))
    const created = burst.filter(response => response.status === 201)
    const limited = burst.filter(response => response.status === 409)
    expect(created.length + limited.length).toBe(20)
    const afterBurst = await listLinks(harness.adminPort)
    expect(afterBurst).toHaveLength(MAX_ENTRY_LINKS)
    const burstFile = JSON.parse(await readFile(join(harness.root, 'entry-link.json'), 'utf8')) as { links: readonly Record<string, unknown>[] }
    expect(burstFile.links.map(link => link.id)).toStrictEqual(afterBurst.map(view => view.id))
    expect(new Set(afterBurst.map(view => view.id)).size).toBe(MAX_ENTRY_LINKS)
  })

  it('keeps the file and the list in step through a mixed burst of creates and revokes', async () => {
    const harness = await start(await temporaryDirectory())
    const seeded = await createLink(harness.adminPort, { label: 'Seed' })
    const seed = seeded.json.link as Record<string, unknown>
    expect((await pair(harness, appKeyOf(seed))).status).toBe(201)

    // Creates, a last-used touch and whole-channel clears all interleave. Whatever the
    // order, the persisted list and the served list must agree, with no duplicates.
    await Promise.all([
      createLink(harness.adminPort, { label: 'A' }),
      createLink(harness.adminPort, { label: 'B' }),
      pair(harness, appKeyOf(seed), 'Touched'),
      revoke(harness.adminPort, { all: true }),
      createLink(harness.adminPort, { label: 'C' }),
      createLink(harness.adminPort, { label: 'D' }),
      revoke(harness.adminPort, { all: true }),
      createLink(harness.adminPort, { label: 'E' }),
    ])

    const views = await listLinks(harness.adminPort)
    const ids = views.map(view => view.id)
    expect(new Set(ids).size).toBe(ids.length)
    const persisted = JSON.parse(await readFile(join(harness.root, 'entry-link.json'), 'utf8').catch(() => '{"links":[]}')) as { links: readonly Record<string, unknown>[] }
    expect(persisted.links.map(link => link.id)).toStrictEqual(ids)
    // Every surviving link is usable and its secret is the one the file holds.
    for (const view of views) expect((await pair(harness, appKeyOf(view))).status).toBe(201)
    expect((await send(harness.adminPort, STATUS_PATH, { admin: true })).json.entryLink)
      .toStrictEqual({ active: ids.length > 0, count: ids.length })
  })

  it('never resurrects a link revoked while a pair was in flight', async () => {
    const harness = await start(await temporaryDirectory())
    const created = await createLink(harness.adminPort, { label: 'Doomed' })
    const view = created.json.link as Record<string, unknown>

    // Pair and revoke at the same moment: the pair may win or lose, but the link must
    // end up gone from memory and from the file, and no device may outlive it.
    const [paired] = await Promise.all([
      pair(harness, appKeyOf(view), 'Racer'),
      revoke(harness.adminPort, { linkId: view.id }),
    ])
    // Observed order: the pair wins and answers 201, then the revoke sweeps away the
    // device it just created, which the empty device list below proves. The tolerance
    // keeps the test honest if a faster machine schedules the revoke first.
    expect([201, 401]).toContain(paired.status)

    // Give a queued last-used touch every chance to land late.
    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(await listLinks(harness.adminPort)).toHaveLength(0)
    const persisted = JSON.parse(await readFile(join(harness.root, 'entry-link.json'), 'utf8').catch(() => '{"version":2,"links":[]}')) as { links: readonly Record<string, unknown>[] }
    expect(persisted.links).toStrictEqual([])
    expect((await send(harness.adminPort, STATUS_PATH, { admin: true })).json.entryLink)
      .toStrictEqual({ active: false, count: 0 })
    // The only way a device could survive is by not being attributed to the link.
    expect(await devices(harness.adminPort)).toStrictEqual([])
    expect((await pair(harness, appKeyOf(view))).status).toBe(401)
  })

  it('keeps the local and the public entry links independent', async () => {
    const root = await temporaryDirectory()
    const local = await start(root)
    const created = await createLink(local.adminPort, { label: 'Local' })
    const view = created.json.link as Record<string, unknown>
    const secret = (view.appKey as string).split('.')[2] as string
    // The remote channel keeps its own state directory, so it never sees this link.
    const remote = await start(join(root, 'remote'))
    expect(await listLinks(remote.adminPort)).toHaveLength(0)
    const remoteCreated = await createLink(remote.adminPort, { label: 'Remote' })
    expect(remoteCreated.status, remoteCreated.body).toBe(201)
    const remoteView = remoteCreated.json.link as Record<string, unknown>
    expect(remoteView.id).not.toBe(view.id)
    expect((remoteView.appKey as string).split('.')[2]).not.toBe(secret)
    // Each secret is refused by the other channel's gateway.
    expect((await pair(remote, appKeyOf(view))).status).toBe(401)
    expect((await pair(local, appKeyOf(remoteView))).status).toBe(401)
    expect((await pair(local, appKeyOf(view))).status).toBe(201)
    expect((await pair(remote, appKeyOf(remoteView))).status).toBe(201)
  })
})
