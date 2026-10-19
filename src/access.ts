import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ENTRY_LINK_ID_PATTERN, deriveEntryLinkId } from './entry-link.js'
import type { DeviceSnapshot, DeviceStore, StoredDevice } from './storage.js'

/** Stable error categories converted to deliberately terse HTTP responses. */
export class AccessError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'AccessError'
  }
}

/** Resource and lifetime controls for device authentication. */
export interface AccessControllerOptions {
  readonly pairingTtlMs: number
  readonly deviceTtlMs: number
  readonly sessionTtlMs: number
  readonly maxDevices: number
  readonly maxSessions: number
  readonly rateLimitWindowMs: number
  readonly maxPairingAttempts: number
  readonly maxRateLimitKeys: number
  /**
   * Optional durable entry secret accepted by {@link AccessController.pair} in
   * place of a short pairing window. It is reusable, so a copied entry link keeps
   * working until the owner revokes it; only its digest is retained here. Its
   * identifier is derived from the secret, exactly like a migrated stored link.
   */
  readonly entrySecret?: string
  readonly now?: () => number
}

/** One durable entry link as the gateway knows it: an identifier and a bearer secret. */
export interface EntryLinkCredential {
  readonly id: string
  readonly secret: string
}

/** Values issued once after pairing; only digests survive the response. */
export interface PairingResult {
  readonly deviceId: string
  readonly deviceToken: string
  readonly deviceExpiresAt: number
  readonly sessionToken: string
  readonly csrfToken: string
  readonly sessionExpiresAt: number
  /** The durable entry link this device came through, when it used one. */
  readonly entryLinkId?: string
}

/** Values issued after renewal with the persistent HttpOnly device Cookie. */
export interface RenewalResult {
  readonly deviceId: string
  readonly sessionToken: string
  readonly csrfToken: string
  readonly sessionExpiresAt: number
}

/** Authenticated Session identity retained only inside the gateway. */
export interface SessionAuthorization {
  readonly sessionKey: string
  readonly deviceId: string
  readonly expiresAt: number
}

/** Result of a persistent-device reachability check without opening a Session. */
export interface DeviceProbeResult {
  readonly deviceId: string
  readonly deviceExpiresAt: number
}

/** Why a short-lived Session ended; only device revocation is sent to clients. */
export type SessionEndReason = 'logout' | 'expired' | 'evicted' | 'revoked'

/** Safe device metadata returned by the loopback administration API. */
export interface DeviceSummary {
  readonly id: string
  readonly label: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastSeenAt: number
  /** The entry link this device came through; absent for a one-time code. */
  readonly entryLinkId?: string
  readonly revokedAt?: number
}

interface PairingWindow {
  readonly digest: Buffer
  readonly expiresAt: number
}

interface SessionRecord {
  readonly key: string
  readonly deviceId: string
  readonly csrfDigest: Buffer
  readonly createdAt: number
  readonly expiresAt: number
}

interface LimitBucket {
  count: number
  resetAt: number
}

/** Fixed-window limiter whose attacker-controlled key table is itself bounded. */
export class BoundedRateLimiter {
  private readonly buckets = new Map<string, LimitBucket>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maximumKeys: number,
  ) {}

  /** Consume one attempt; unknown keys fail closed when the bounded table is full. */
  take(key: string, now: number): boolean {
    for (const [candidate, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(candidate)
    }
    const current = this.buckets.get(key)
    if (current === undefined) {
      if (this.buckets.size >= this.maximumKeys) return false
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (current.count >= this.limit) return false
    current.count += 1
    return true
  }

  /** Current table size, exposed for bounded-state assertions. */
  get size(): number {
    return this.buckets.size
  }
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function digestHex(value: string): string {
  return digest(value).toString('hex')
}

function matchesDigest(value: string, expected: Buffer): boolean {
  return timingSafeEqual(digest(value), expected)
}

function readPairingParameter(source: string): string | undefined {
  if (source === '') return undefined
  for (const part of source.split('&')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator)
    if (name !== 'key' && name !== 'token') continue
    const raw = part.slice(separator + 1)
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return undefined
}

/**
 * Accept one pairing secret in every form a person can realistically paste: the
 * raw code, an app key (`dsh1.<instance>.<code>`) or an entry link that carries
 * `key`/`token` in its fragment or query. Values that match none of those are
 * returned trimmed, so an unrelated string still fails the digest comparison
 * instead of being silently rewritten. Never throws.
 */
export function normalizePairingToken(value: string): string {
  let candidate = value.trim()
  if (candidate === '') return ''
  const wrapped = /^["'`<([{]+([\s\S]*?)["'`>)\]}]+$/u.exec(candidate)
  if (wrapped !== null) candidate = wrapped[1]!.trim()
  const hash = candidate.indexOf('#')
  const query = candidate.indexOf('?')
  if (hash !== -1 || query !== -1) {
    const fragment = hash === -1 ? '' : candidate.slice(hash + 1)
    const search = query === -1 ? '' : candidate.slice(query + 1, hash === -1 ? undefined : hash)
    const carried = readPairingParameter(fragment) ?? readPairingParameter(search)
    if (carried !== undefined && carried !== '') candidate = carried
  }
  const appKey = /^dsh\d+\.[^.]+\.([\s\S]+)$/u.exec(candidate)
  if (appKey !== null) candidate = appKey[1]!
  return candidate.trim()
}

function normalizeLabel(value: string | undefined): string {
  const label = (value ?? 'Mobile device').normalize('NFC').trim()
  if (label.length < 1 || label.length > 64 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new AccessError(400, 'invalid_request')
  }
  return label
}

function publicDevice(device: StoredDevice): DeviceSummary {
  return Object.freeze({
    id: device.id,
    label: device.label,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    lastSeenAt: device.lastSeenAt,
    ...(device.entryLinkId === undefined ? {} : { entryLinkId: device.entryLinkId }),
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
  })
}

/** Pairing, persistent-device, short-Session, revocation, and CSRF state machine. */
export class AccessController {
  private readonly now: () => number
  private readonly pairLimiter: BoundedRateLimiter
  private devices: StoredDevice[] = []
  private pairingWindow: PairingWindow | undefined
  /** Digest of every installed durable entry link, keyed by its public identifier. */
  private readonly entryLinks = new Map<string, Buffer>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionEndedListeners = new Set<(authorization: SessionAuthorization, reason: SessionEndReason) => void>()
  private mutation: Promise<void> = Promise.resolve()
  private initialized = false
  private closing = false
  private closeTask: Promise<void> | undefined

  constructor(private readonly store: DeviceStore, private readonly options: AccessControllerOptions) {
    this.now = options.now ?? Date.now
    if (options.entrySecret !== undefined) {
      this.setEntryLinks([{ id: deriveEntryLinkId(options.entrySecret), secret: options.entrySecret }])
    }
    this.pairLimiter = new BoundedRateLimiter(
      options.maxPairingAttempts,
      options.rateLimitWindowMs,
      options.maxRateLimitKeys,
    )
  }

  /** Load and validate digest-only durable state before accepting traffic. */
  async initialize(): Promise<void> {
    if (this.initialized || this.closing) throw new Error('access controller cannot be initialized again')
    const snapshot = await this.store.load()
    // Older releases retained revoked identities. Remove those tombstones on upgrade.
    const devices = snapshot.devices.filter(device => device.revokedAt === undefined)
    if (devices.length > this.options.maxDevices) throw new Error('device state exceeds configured maxDevices')
    if (devices.length !== snapshot.devices.length) await this.store.save(this.snapshot(devices))
    this.devices = devices
    this.initialized = true
  }

  private requireInitialized(): void {
    if (!this.initialized || this.closing) throw new Error('access controller is not available')
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutation
    let release!: () => void
    this.mutation = new Promise<void>(resolve => { release = resolve })
    await prior
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private snapshot(devices: readonly StoredDevice[]): DeviceSnapshot {
    return Object.freeze({ version: 1, devices: Object.freeze([...devices]) })
  }

  private emitSessionEnded(session: SessionRecord, reason: SessionEndReason): void {
    const authorization = Object.freeze({
      sessionKey: session.key,
      deviceId: session.deviceId,
      expiresAt: session.expiresAt,
    })
    for (const listener of this.sessionEndedListeners) listener(authorization, reason)
  }

  private removeSession(key: string, reason: SessionEndReason): void {
    const session = this.sessions.get(key)
    if (session === undefined) return
    this.sessions.delete(key)
    this.emitSessionEnded(session, reason)
  }

  private pruneSessions(now: number): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.removeSession(key, 'expired')
    }
  }

  private createSession(deviceId: string, now: number, deviceExpiresAt: number): RenewalResult {
    this.pruneSessions(now)
    if (this.sessions.size >= this.options.maxSessions) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.createdAt - right.createdAt)[0]
      if (oldest !== undefined) this.removeSession(oldest.key, 'evicted')
    }
    const sessionToken = opaqueToken()
    const csrfToken = opaqueToken()
    const key = digestHex(sessionToken)
    const record: SessionRecord = Object.freeze({
      key,
      deviceId,
      csrfDigest: digest(csrfToken),
      createdAt: now,
      expiresAt: Math.min(now + this.options.sessionTtlMs, deviceExpiresAt),
    })
    this.sessions.set(key, record)
    return Object.freeze({ deviceId, sessionToken, csrfToken, sessionExpiresAt: record.expiresAt })
  }

  /** Open one short pairing window and return its one-time secret to a loopback caller only. */
  async openPairing(requestedTtlMs?: number): Promise<{ token: string; expiresAt: number }> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const ttl = requestedTtlMs ?? this.options.pairingTtlMs
      if (!Number.isSafeInteger(ttl) || ttl < 10_000 || ttl > this.options.pairingTtlMs) {
        throw new AccessError(400, 'invalid_request')
      }
      const token = opaqueToken()
      const expiresAt = this.now() + ttl
      this.pairingWindow = Object.freeze({ digest: digest(token), expiresAt })
      return Object.freeze({ token, expiresAt })
    })
  }

  /**
   * Install the durable entry links without touching the device store.
   *
   * The gateway loads the persisted list and calls this after construction, so a
   * link the owner sent last month still pairs after a DSH restart. Replacing the
   * whole set is deliberate: the caller owns the persisted list, and a link that is
   * no longer in it stops authorizing anything immediately.
   */
  setEntryLinks(links: readonly EntryLinkCredential[]): void {
    const next = new Map<string, Buffer>()
    for (const link of links) {
      if (!ENTRY_LINK_ID_PATTERN.test(link.id) || typeof link.secret !== 'string'
        || link.secret === '' || link.secret.length > 512 || next.has(link.id)) {
        throw new AccessError(400, 'invalid_request')
      }
      next.set(link.id, digest(link.secret))
    }
    this.entryLinks.clear()
    for (const [id, digestValue] of next) this.entryLinks.set(id, digestValue)
  }

  /** Install or clear a single durable entry secret, for a caller that holds one. */
  setEntrySecret(secret: string | undefined): void {
    this.setEntryLinks(secret === undefined || secret === ''
      ? []
      : [{ id: deriveEntryLinkId(secret), secret }])
  }

  /** How many durable entry links are installed; the secrets never leave the gateway. */
  entryLinkStatus(): { readonly active: boolean; readonly count: number } {
    return Object.freeze({ active: this.entryLinks.size > 0, count: this.entryLinks.size })
  }

  /**
   * Which durable entry link a presented token is, if any. Never consumes it.
   *
   * The pair route uses this both to tell a reusable link from a one-time code - a
   * reusable link may refresh an already-bound device, a code may not - and to record
   * which link a new device came through.
   */
  matchEntryLink(token: string): string | undefined {
    if (this.entryLinks.size === 0 || token.length > 512) return undefined
    return this.matchEntryLinkSecret(normalizePairingToken(token))
  }

  /** Whether a presented token is one of the durable entry secrets. */
  matchesEntrySecret(token: string): boolean {
    return this.matchEntryLink(token) !== undefined
  }

  private matchEntryLinkSecret(secret: string): string | undefined {
    if (secret.length > 512) return undefined
    for (const [id, digestValue] of this.entryLinks) {
      if (matchesDigest(secret, digestValue)) return id
    }
    return undefined
  }

  /**
   * Remove one link and every device that entered through it.
   *
   * Revoking an invitation must cut off the people who accepted it, so the devices
   * bound to this link are deleted and their Sessions end with reason `revoked`,
   * exactly like a direct device revocation. Devices that paired with a one-time
   * code, and devices from releases that stored no link, are untouched.
   */
  async revokeEntryLink(linkId: string): Promise<number> {
    this.requireInitialized()
    return this.exclusive(async () => {
      this.entryLinks.delete(linkId)
      const now = this.now()
      const removed = this.devices.filter(device => device.entryLinkId === linkId)
      if (removed.length === 0) return 0
      const next = this.devices.filter(device => device.entryLinkId !== linkId)
      await this.store.save(this.snapshot(next))
      this.devices = next
      const removedIds = new Set(removed.map(device => device.id))
      for (const [key, session] of this.sessions) {
        if (removedIds.has(session.deviceId)) this.removeSession(key, 'revoked')
      }
      return removed.filter(device => device.expiresAt > now).length
    })
  }

  /** Consume the pairing window exactly once and persist only the device-token digest. */
  async pair(sourceKey: string, token: string, label?: string): Promise<PairingResult> {
    this.requireInitialized()
    const now = this.now()
    if (!this.pairLimiter.take(sourceKey, now)) throw new AccessError(429, 'rate_limited')
    if (token.length > 512) throw new AccessError(401, 'authentication_failed')
    const secret = normalizePairingToken(token)
    if (secret.length > 512) throw new AccessError(401, 'authentication_failed')
    return this.exclusive(async () => {
      const window = this.pairingWindow
      const windowMatches = window !== undefined && window.expiresAt > now && matchesDigest(secret, window.digest)
      // A durable entry link is a reusable bearer secret, so pairing through it never
      // consumes anything: a copied link keeps working until the owner revokes it. The
      // short window keeps its one-time semantics.
      const entryLinkId = this.matchEntryLinkSecret(secret)
      if (!windowMatches && entryLinkId === undefined) {
        if (window !== undefined && window.expiresAt <= now) this.pairingWindow = undefined
        throw new AccessError(401, 'authentication_failed')
      }
      if (windowMatches) this.pairingWindow = undefined
      const active = this.devices.filter(device => device.revokedAt === undefined && device.expiresAt > now)
      if (active.length >= this.options.maxDevices) throw new AccessError(409, 'device_limit')

      const deviceToken = opaqueToken()
      const device: StoredDevice = Object.freeze({
        id: randomBytes(16).toString('hex'),
        label: normalizeLabel(label),
        tokenDigest: digestHex(deviceToken),
        createdAt: now,
        expiresAt: now + this.options.deviceTtlMs,
        lastSeenAt: now,
        ...(entryLinkId === undefined ? {} : { entryLinkId }),
      })
      const retained = this.devices.filter(candidate => candidate.revokedAt === undefined && candidate.expiresAt > now)
      const next = [...retained, device]
      await this.store.save(this.snapshot(next))
      this.devices = next
      const session = this.createSession(device.id, now, device.expiresAt)
      return Object.freeze({
        ...session,
        deviceToken,
        deviceExpiresAt: device.expiresAt,
        ...(entryLinkId === undefined ? {} : { entryLinkId }),
      })
    })
  }

  /** Exchange a valid persistent device credential for a new short Session. */
  async renew(deviceToken: string): Promise<RenewalResult> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const now = this.now()
      const device = this.requireDevice(deviceToken, now)
      const index = this.devices.indexOf(device)
      const updated: StoredDevice = Object.freeze({ ...device, lastSeenAt: now })
      const next = [...this.devices]
      next[index] = updated
      await this.store.save(this.snapshot(next))
      this.devices = next
      return this.createSession(device.id, now, device.expiresAt)
    })
  }

  /**
   * Exchange the device a browser already owns for a new Session, addressed by its
   * id. A durable entry link is opened repeatedly from the same computer and the
   * browser only sends its `__Host-` device id to the pair route - the device token
   * Cookie is scoped to the narrow renewal path - so reuse keys off the id that
   * actually arrives instead of registering a duplicate device every time.
   */
  async renewDevice(deviceId: string): Promise<RenewalResult> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const now = this.now()
      const device = this.requireDeviceId(deviceId, now)
      const index = this.devices.indexOf(device)
      const updated: StoredDevice = Object.freeze({ ...device, lastSeenAt: now })
      const next = [...this.devices]
      next[index] = updated
      await this.store.save(this.snapshot(next))
      this.devices = next
      return this.createSession(device.id, now, device.expiresAt)
    })
  }

  /** Validate a persistent device credential without consuming a Session slot. */
  async probe(deviceToken: string): Promise<DeviceProbeResult> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const now = this.now()
      const device = this.requireDevice(deviceToken, now)
      const index = this.devices.indexOf(device)
      const updated: StoredDevice = Object.freeze({ ...device, lastSeenAt: now })
      const next = [...this.devices]
      next[index] = updated
      await this.store.save(this.snapshot(next))
      this.devices = next
      return Object.freeze({ deviceId: device.id, deviceExpiresAt: device.expiresAt })
    })
  }

  /** Validate a device credential without writing state or opening a Session. */
  authorizeDevice(deviceToken: string): DeviceProbeResult {
    this.requireInitialized()
    const device = this.requireDevice(deviceToken, this.now())
    return Object.freeze({ deviceId: device.id, deviceExpiresAt: device.expiresAt })
  }

  /**
   * Refuse a device whose entry link is gone.
   *
   * A revoked link removes its devices outright, so this only fires when the state
   * files disagree: the link file was lost, replaced or edited, or the two files were
   * written by different releases. Failing closed keeps an invitation the owner
   * believes is withdrawn from staying alive for the device lifetime.
   */
  private assertEntryLinkActive(device: StoredDevice): void {
    if (device.entryLinkId !== undefined && !this.entryLinks.has(device.entryLinkId)) {
      throw new AccessError(401, 'device_revoked')
    }
  }

  private requireDevice(deviceToken: string, now: number): StoredDevice {
    if (deviceToken.length > 512) throw new AccessError(401, 'authentication_failed')
    const tokenDigest = digest(deviceToken)
    const device = this.devices.find(candidate => timingSafeEqual(Buffer.from(candidate.tokenDigest, 'hex'), tokenDigest))
    if (device === undefined) throw new AccessError(401, 'authentication_failed')
    if (device.revokedAt !== undefined) throw new AccessError(401, 'device_revoked')
    if (device.expiresAt <= now) throw new AccessError(401, 'device_expired')
    this.assertEntryLinkActive(device)
    return device
  }

  private requireDeviceId(deviceId: string, now: number): StoredDevice {
    if (deviceId.length > 512) throw new AccessError(401, 'authentication_failed')
    const device = this.devices.find(candidate => candidate.id === deviceId)
    if (device === undefined) throw new AccessError(401, 'authentication_failed')
    if (device.revokedAt !== undefined) throw new AccessError(401, 'device_revoked')
    if (device.expiresAt <= now) throw new AccessError(401, 'device_expired')
    this.assertEntryLinkActive(device)
    return device
  }

  /** Resolve a short Session Cookie without revealing whether device or Session failed. */
  authorizeSession(sessionToken: string): SessionAuthorization {
    this.requireInitialized()
    if (sessionToken.length > 512) throw new AccessError(401, 'authentication_failed')
    const now = this.now()
    this.pruneSessions(now)
    const key = digestHex(sessionToken)
    const session = this.sessions.get(key)
    const device = session === undefined ? undefined : this.devices.find(candidate => candidate.id === session.deviceId)
    if (session === undefined || device === undefined || device.revokedAt !== undefined || device.expiresAt <= now
      || (device.entryLinkId !== undefined && !this.entryLinks.has(device.entryLinkId))) {
      if (session !== undefined) this.removeSession(session.key, 'expired')
      throw new AccessError(401, 'authentication_failed')
    }
    return Object.freeze({ sessionKey: key, deviceId: session.deviceId, expiresAt: session.expiresAt })
  }

  /** Require the Session-bound anti-CSRF value for an authenticated mutation. */
  assertCsrf(authorization: SessionAuthorization, csrfToken: string | undefined): void {
    const session = this.sessions.get(authorization.sessionKey)
    if (session === undefined || csrfToken === undefined || csrfToken.length > 512
      || !matchesDigest(csrfToken, session.csrfDigest)) {
      throw new AccessError(403, 'forbidden')
    }
  }

  /** End one short Session and notify the gateway to abort its attached work. */
  logout(authorization: SessionAuthorization): void {
    this.removeSession(authorization.sessionKey, 'logout')
  }

  /** Durably delete the device, then end every Session owned by that device. */
  async revokeDevice(deviceId: string): Promise<boolean> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const next = this.devices.filter(device => device.id !== deviceId)
      if (next.length === this.devices.length) return false
      await this.store.save(this.snapshot(next))
      this.devices = next
      for (const [key, session] of this.sessions) {
        if (session.deviceId === deviceId) this.removeSession(key, 'revoked')
      }
      return true
    })
  }

  /** Remove every persistent credential and terminate every active Session. */
  async resetDevices(): Promise<void> {
    this.requireInitialized()
    await this.exclusive(async () => {
      await this.store.save(this.snapshot([]))
      this.devices = []
      for (const key of [...this.sessions.keys()]) this.removeSession(key, 'revoked')
      this.pairingWindow = undefined
    })
  }

  /** Safe metadata for the loopback administration surface. */
  listDevices(): readonly DeviceSummary[] {
    this.requireInitialized()
    return Object.freeze(this.devices.map(publicDevice))
  }

  /** Pairing status without exposing the one-time secret. */
  pairingStatus(): { open: boolean; expiresAt?: number } {
    this.requireInitialized()
    const window = this.pairingWindow
    if (window === undefined || window.expiresAt <= this.now()) {
      this.pairingWindow = undefined
      return Object.freeze({ open: false })
    }
    return Object.freeze({ open: true, expiresAt: window.expiresAt })
  }

  /** Subscribe gateway resources to Session logout, expiry, eviction, and device revocation. */
  onSessionEnded(listener: (authorization: SessionAuthorization, reason: SessionEndReason) => void): () => void {
    this.sessionEndedListeners.add(listener)
    return () => { this.sessionEndedListeners.delete(listener) }
  }

  /** Stop new operations, drain durable mutations, then clear volatile credentials. */
  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closing = true
    this.closeTask = this.finishClose()
    return this.closeTask
  }

  private async finishClose(): Promise<void> {
    await this.mutation
    this.pairingWindow = undefined
    for (const key of [...this.sessions.keys()]) this.removeSession(key, 'expired')
    this.sessionEndedListeners.clear()
    this.initialized = false
  }

  /** Bounded volatile-state metrics for tests and local status. */
  metrics(): { sessions: number; rateLimitKeys: number } {
    return Object.freeze({ sessions: this.sessions.size, rateLimitKeys: this.pairLimiter.size })
  }
}
