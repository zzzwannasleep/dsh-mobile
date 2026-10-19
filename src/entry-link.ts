import { randomBytes } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { assertManagedParents, removeManagedTree, writeManagedPrivateFile } from './managed-files.js'
import { restrictPrivateFile } from './private-file.js'

/** Upper bound for the private file; the payload is one 43-character secret. */
const MAX_ENTRY_LINK_BYTES = 4096

/** Same shape as an opaque pairing token: base64url of 32 random bytes. */
const ENTRY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u

/** Durable entry-link state. Unlike the device store this holds the raw secret. */
export interface EntryLinkSnapshot {
  readonly version: 1
  readonly secret: string
}

/** Mint a fresh durable entry secret, in the same shape as a pairing token. */
export function createEntryLinkSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** Validate one persisted entry link before it can authorize anything. */
export function parseEntryLinkSnapshot(value: unknown): EntryLinkSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('entry link state must be an object')
  const snapshot = value as Record<string, unknown>
  if (snapshot.version !== 1) throw new Error('entry link state has an unsupported version')
  if (typeof snapshot.secret !== 'string' || !ENTRY_SECRET_PATTERN.test(snapshot.secret)) {
    throw new Error('entry link state has an invalid secret')
  }
  return Object.freeze({ version: 1, secret: snapshot.secret })
}

/**
 * Owner-only storage for the one durable PC entry secret of a gateway.
 *
 * The secret is a bearer credential for the public entry page, so the file is
 * created and re-checked through the same managed-private-file helpers the
 * provider tokens use: symlinks and unknown fields are refused, the mode stays
 * owner-only, and a malformed file throws instead of silently disabling the link.
 */
export class JsonEntryLinkStore {
  readonly stateRoot: string
  readonly file: string

  constructor(stateDirectory: string, private readonly ownedRoot = stateDirectory) {
    if (!isAbsolute(stateDirectory)) throw new Error('entry link state directory must be absolute')
    this.stateRoot = resolve(stateDirectory)
    this.file = join(this.stateRoot, 'entry-link.json')
  }

  /** Read the stored secret, or undefined when the owner has not created one. */
  async load(): Promise<string | undefined> {
    await assertManagedParents(this.ownedRoot, this.file, 'entry_link')
    let entry
    try {
      entry = await lstat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_ENTRY_LINK_BYTES) {
      throw new Error('entry_link_file_invalid')
    }
    await restrictPrivateFile(this.file)
    const parsed = parseEntryLinkSnapshot(JSON.parse(await readFile(this.file, 'utf8')) as unknown)
    return parsed.secret
  }

  /** Persist a secret, replacing any previous one. */
  async save(secret: string): Promise<void> {
    const snapshot = parseEntryLinkSnapshot({ version: 1, secret })
    await writeManagedPrivateFile(this.ownedRoot, this.file, `${JSON.stringify(snapshot)}\n`, 'entry_link')
  }

  /** Remove the stored secret; an absent file is not an error. */
  async clear(): Promise<void> {
    await removeManagedTree(this.ownedRoot, this.file, 'entry_link')
  }
}
