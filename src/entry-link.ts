import { createHash, randomBytes } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { assertManagedParents, removeManagedTree, writeManagedPrivateFile } from './managed-files.js'
import { restrictPrivateFile } from './private-file.js'

/** Upper bound for the private file; sixteen records stay far below this. */
const MAX_ENTRY_LINK_BYTES = 16 * 1024

/** Same shape as an opaque pairing token: base64url of 32 random bytes. */
const ENTRY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u

/** How many links one channel may hold before the panel refuses to add another. */
export const MAX_ENTRY_LINKS = 16

/** Stable public identifier of one link; the secret itself is never the identifier. */
export const ENTRY_LINK_ID_PATTERN = /^[a-f\d]{16}$/u

/** Name a link carries when the owner does not type one. */
export const ENTRY_LINK_LABEL_DEFAULT = 'Access link'

/** One durable entry link: a bearer secret plus the metadata the owner manages it by. */
export interface EntryLinkRecord {
  readonly id: string
  readonly label: string
  readonly secret: string
  readonly createdAt: number
  readonly lastUsedAt?: number
}

/** Durable entry-link state. Unlike the device store this holds the raw secrets. */
export interface EntryLinkState {
  readonly version: 2
  readonly links: readonly EntryLinkRecord[]
}

/** Where a version 1 payload (one anonymous secret) is folded into the list model. */
export interface EntryLinkMigration {
  readonly id: string
  readonly createdAt: number
}

/** Mint a fresh durable entry secret, in the same shape as a pairing token. */
export function createEntryLinkSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** Mint the public identifier of a new link. */
export function createEntryLinkId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * Derive the identifier of a link that predates the list model.
 *
 * A version 1 file held one secret and no identifier, and the identifier is what
 * ties a paired device back to its link. Hashing the secret keeps that identifier
 * stable across restarts without rewriting the file, so a device paired before the
 * upgrade still belongs to the link it entered through.
 */
export function deriveEntryLinkId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

/** Validate an owner-supplied link name; an empty one falls back to the default. */
export function normalizeEntryLinkLabel(value: string | undefined): string {
  const label = (value ?? '').normalize('NFC').trim()
  if (label === '') return ENTRY_LINK_LABEL_DEFAULT
  if (label.length > 64 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error('entry link label must be 1 to 64 printable characters')
  }
  return label
}

function assertTimestamp(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`entry link state ${name} must be a non-negative integer`)
  }
}

function freezeState(links: readonly EntryLinkRecord[]): EntryLinkState {
  return Object.freeze({ version: 2 as const, links: Object.freeze([...links]) })
}

function parseEntryLinkRecord(value: unknown): EntryLinkRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('entry link state contains an invalid link')
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !ENTRY_LINK_ID_PATTERN.test(record.id)) {
    throw new Error('entry link state contains an invalid id')
  }
  if (typeof record.secret !== 'string' || !ENTRY_SECRET_PATTERN.test(record.secret)) {
    throw new Error('entry link state contains an invalid secret')
  }
  if (record.label !== undefined && typeof record.label !== 'string') {
    throw new Error('entry link state contains an invalid label')
  }
  let label: string
  try {
    label = record.label === undefined ? ENTRY_LINK_LABEL_DEFAULT : normalizeEntryLinkLabel(record.label)
  } catch {
    throw new Error('entry link state contains an invalid label')
  }
  assertTimestamp(record.createdAt, 'createdAt')
  if (record.lastUsedAt !== undefined) assertTimestamp(record.lastUsedAt, 'lastUsedAt')
  return Object.freeze({
    id: record.id,
    label,
    secret: record.secret,
    createdAt: record.createdAt,
    ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
  })
}

/**
 * Validate persisted link state before it can authorize anything.
 *
 * A version 1 payload (`{ version: 1, secret }`, the single-link release) is folded
 * into one record using the migration metadata the caller derives from the file, so
 * an installed link survives the upgrade with a stable identifier.
 */
export function parseEntryLinkState(value: unknown, migrated?: EntryLinkMigration): EntryLinkState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('entry link state must be an object')
  }
  const snapshot = value as Record<string, unknown>
  if (snapshot.version === 1) {
    if (typeof snapshot.secret !== 'string' || !ENTRY_SECRET_PATTERN.test(snapshot.secret)) {
      throw new Error('entry link state has an invalid secret')
    }
    if (migrated === undefined) throw new Error('entry link state is missing its migration metadata')
    if (!ENTRY_LINK_ID_PATTERN.test(migrated.id)) throw new Error('entry link migration id is invalid')
    assertTimestamp(migrated.createdAt, 'createdAt')
    return freezeState([{
      id: migrated.id,
      label: ENTRY_LINK_LABEL_DEFAULT,
      secret: snapshot.secret,
      createdAt: migrated.createdAt,
    }])
  }
  if (snapshot.version !== 2 || !Array.isArray(snapshot.links) || snapshot.links.length > MAX_ENTRY_LINKS) {
    throw new Error('entry link state has an unsupported version or link count')
  }
  const links = snapshot.links.map(parseEntryLinkRecord)
  if (new Set(links.map(link => link.id)).size !== links.length
    || new Set(links.map(link => link.secret)).size !== links.length) {
    throw new Error('entry link state contains duplicate link identities')
  }
  return freezeState(links)
}

/** Read the legacy secret of a version 1 payload, for deriving its identifier. */
function legacySecret(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const snapshot = value as Record<string, unknown>
  return snapshot.version === 1 && typeof snapshot.secret === 'string' && ENTRY_SECRET_PATTERN.test(snapshot.secret)
    ? snapshot.secret
    : undefined
}

/**
 * Owner-only storage for the durable PC entry links of a gateway.
 *
 * Every secret is a bearer credential for the public entry page, so the file is
 * created and re-checked through the same managed-private-file helpers the provider
 * tokens use: symlinks and a foreign file are refused, the mode stays owner-only, and
 * a malformed file throws instead of silently disabling every link.
 */
export class JsonEntryLinkStore {
  readonly stateRoot: string
  readonly file: string

  constructor(stateDirectory: string, private readonly ownedRoot = stateDirectory) {
    if (!isAbsolute(stateDirectory)) throw new Error('entry link state directory must be absolute')
    this.stateRoot = resolve(stateDirectory)
    this.file = join(this.stateRoot, 'entry-link.json')
  }

  /** Read every stored link, or an empty list when the owner has not created one. */
  async load(): Promise<EntryLinkState> {
    await assertManagedParents(this.ownedRoot, this.file, 'entry_link')
    let entry
    try {
      entry = await lstat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return freezeState([])
      throw error
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_ENTRY_LINK_BYTES) {
      throw new Error('entry_link_file_invalid')
    }
    await restrictPrivateFile(this.file)
    const payload = JSON.parse(await readFile(this.file, 'utf8')) as unknown
    const secret = legacySecret(payload)
    return parseEntryLinkState(payload, {
      // A version 1 file records no creation time of its own; the file's own
      // modification time is the closest honest answer and is only used for display.
      id: secret === undefined ? '0000000000000000' : deriveEntryLinkId(secret),
      createdAt: Math.max(0, Math.floor(entry.mtimeMs)),
    })
  }

  /** Persist the whole list, replacing the previous state. */
  async save(state: EntryLinkState): Promise<void> {
    const validated = parseEntryLinkState(state)
    await writeManagedPrivateFile(this.ownedRoot, this.file, `${JSON.stringify(validated)}\n`, 'entry_link')
  }

  /** Remove every stored link; an absent file is not an error. */
  async clear(): Promise<void> {
    await removeManagedTree(this.ownedRoot, this.file, 'entry_link')
  }
}
