import { X509Certificate } from 'node:crypto'
import { lstat, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readCertificateRenewal, type CertRenewalStatus } from './cert-renewal.js'
import { ensureManagedCa, issueServerCertificate, readManagedCa } from './managed-setup.js'
import { isIP } from './ip.js'
import { restrictPrivateFile } from './private-file.js'
import { assertManagedParents, ensureManagedDirectory, writeManagedPrivateFile } from './managed-files.js'

/**
 * The public HTTPS origin whose host the ingress leaf must cover.
 *
 * A raw-TCP tunnel forwards the node's traffic untouched, so the gateway itself
 * terminates TLS; the certificate has to name the public entry host (an IPv4
 * literal today) or the phone cannot anchor the connection.
 */
export interface TlsIngressSettings {
  readonly publicOrigin: string
}

/** Private files owned by the gateway's self-signed TLS ingress. */
export interface TlsIngressPaths {
  readonly directory: string
  readonly caCertFile: string
  readonly caKeyFile: string
  readonly certFile: string
  readonly keyFile: string
  readonly statusFile: string
}

/** Signed ingress material plus the fingerprint the app must pin. */
export interface TlsIngressCertificate {
  readonly paths: TlsIngressPaths
  readonly ca: X509Certificate
  readonly leaf: X509Certificate
  readonly caFingerprint: string
  readonly status: CertRenewalStatus
}

/** Private ingress directory, always a sibling of the remote device file. */
export function tlsIngressPaths(stateFile: string): TlsIngressPaths {
  const directory = join(dirname(stateFile), 'ingress')
  return Object.freeze({
    directory,
    caCertFile: join(directory, 'ca.pem'),
    caKeyFile: join(directory, 'ca-key.pem'),
    certFile: join(directory, 'server.pem'),
    keyFile: join(directory, 'server-key.pem'),
    // Keep the identity marker outside the certificate directory so deleting
    // that directory cannot silently create a replacement CA on next start.
    statusFile: join(dirname(stateFile), 'ingress-identity.json'),
  })
}

async function regularFileExists(file: string): Promise<boolean> {
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('tls_ingress_file_invalid')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readIngressIdentity(file: string): Promise<string | undefined> {
  if (!(await regularFileExists(file))) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid identity')
    const record = parsed as Record<string, unknown>
    if (record.version !== 1 || typeof record.caFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/u.test(record.caFingerprint)) throw new Error('invalid identity')
    return record.caFingerprint
  } catch (error) {
    throw new Error('tls_ingress_ca_invalid', { cause: error })
  }
}

async function writeIngressIdentity(file: string, fingerprint: string, ownedRoot: string): Promise<void> {
  await writeManagedPrivateFile(ownedRoot, file, `${JSON.stringify({ version: 1, caFingerprint: fingerprint })}\n`, 'tls_ingress')
}

function coversPublicHost(certificate: X509Certificate, address: string): boolean {
  const alternatives = certificate.subjectAltName ?? ''
  // A domain entry needs a DNS SAN; an IPv4 entry needs an IP SAN. Mixing the
  // two would issue a certificate the phone cannot anchor.
  const expected = isIP(address) === 0 ? `DNS:${address}` : `IP Address:${address}`
  return alternatives.split(',').some(entry => entry.trim() === expected)
}

/**
 * Materialize the CA and leaf the gateway terminates TLS with.
 *
 * The CA remains stable for paired phones; an expired CA must be re-paired, not
 * replaced silently. The leaf is re-signed when expiring or no longer valid for
 * the public entry host, and the running gateway reloads it after a renewal check.
 */
export async function ensureTlsIngressCertificate(
  settings: TlsIngressSettings,
  stateFile: string,
  now: number = Date.now(),
  expectedCaFingerprint?: string,
  ownedRoot: string = dirname(stateFile),
): Promise<TlsIngressCertificate> {
  const paths = tlsIngressPaths(stateFile)
  await assertManagedParents(ownedRoot, paths.statusFile, 'tls_ingress')
  await assertManagedParents(ownedRoot, paths.caCertFile, 'tls_ingress')
  try {
    const directory = await lstat(paths.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('tls_ingress_directory_invalid')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const previousFingerprint = await readIngressIdentity(paths.statusFile)
  const [caCertExists, caKeyExists, leafCertExists, leafKeyExists] = await Promise.all([
    regularFileExists(paths.caCertFile), regularFileExists(paths.caKeyFile),
    regularFileExists(paths.certFile), regularFileExists(paths.keyFile),
  ])
  if (caCertExists !== caKeyExists || (!caCertExists && (previousFingerprint !== undefined || leafCertExists || leafKeyExists))) {
    throw new Error('tls_ingress_ca_invalid')
  }
  if (caCertExists && (await readCertificateRenewal(paths.caCertFile, now)).state === 'expired') {
    throw new Error('tls_ingress_ca_expired')
  }
  if (previousFingerprint === undefined) {
    await ensureManagedDirectory(ownedRoot, dirname(paths.statusFile), 'tls_ingress')
    try {
      await writeFile(paths.statusFile, '{"version":1,"pending":true}\n', { flag: 'wx', mode: 0o600 })
      await restrictPrivateFile(paths.statusFile)
    } catch (error) {
      throw new Error('tls_ingress_ca_invalid', { cause: error })
    }
  }
  const caFiles = {
    mode: 'managed',
    caCertFile: paths.caCertFile,
    caKeyFile: paths.caKeyFile,
    certFile: paths.certFile,
    keyFile: paths.keyFile,
  } as const
  let ca: X509Certificate
  try {
    await assertManagedParents(ownedRoot, paths.caCertFile, 'tls_ingress')
    ca = expectedCaFingerprint === undefined ? await ensureManagedCa(caFiles) : await readManagedCa(caFiles)
  } catch (error) {
    throw new Error('tls_ingress_ca_invalid', { cause: error })
  }
  const caFingerprint = ca.fingerprint256.replaceAll(':', '').toLowerCase()
  if (previousFingerprint !== undefined && caFingerprint !== previousFingerprint) {
    throw new Error('tls_ingress_ca_changed')
  }
  if (expectedCaFingerprint !== undefined && caFingerprint !== expectedCaFingerprint) {
    throw new Error('tls_ingress_ca_changed')
  }
  if (previousFingerprint === undefined) await writeIngressIdentity(paths.statusFile, caFingerprint, ownedRoot)
  const publicHost = new URL(settings.publicOrigin).hostname
  let leaf: X509Certificate | undefined
  try {
    leaf = new X509Certificate(await readFile(paths.certFile))
  } catch {
    leaf = undefined
  }
  const reusable = leaf !== undefined
    && Date.parse(leaf.validTo) > now + 24 * 60 * 60_000
    && coversPublicHost(leaf, publicHost)
    && leaf.verify(ca.publicKey)
  if (!reusable) {
    await assertManagedParents(ownedRoot, paths.certFile, 'tls_ingress')
    await issueServerCertificate(
      { caCertFile: paths.caCertFile, caKeyFile: paths.caKeyFile },
      { commonName: 'DSH Mobile TLS ingress', ...(isIP(publicHost) === 0 ? { dnsNames: [publicHost] } : { ipAddresses: [publicHost] }) },
      { certFile: paths.certFile, keyFile: paths.keyFile },
    )
    leaf = new X509Certificate(await readFile(paths.certFile))
  }
  const signed = leaf ?? (() => { throw new Error('tls_ingress_cert_unknown') })()
  return Object.freeze({
    paths,
    ca,
    leaf: signed,
    caFingerprint,
    status: await readCertificateRenewal(paths.certFile, now),
  })
}

/** Remove only the five files owned by the local self-signed TLS ingress. */
export async function purgeTlsIngressCertificates(stateFile: string, ownedRoot: string = dirname(stateFile)): Promise<void> {
  const paths = tlsIngressPaths(stateFile)
  await assertManagedParents(ownedRoot, paths.statusFile, 'tls_ingress')
  await assertManagedParents(ownedRoot, paths.directory, 'tls_ingress')
  try {
    const marker = await lstat(paths.statusFile)
    if (!marker.isFile() && !marker.isSymbolicLink()) throw new Error('tls_ingress_file_invalid')
    await unlink(paths.statusFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let directory
  try { directory = await lstat(paths.directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (directory.isSymbolicLink()) {
    await unlink(paths.directory)
    return
  }
  if (!directory.isDirectory()) throw new Error('tls_ingress_directory_invalid')
  for (const file of [paths.caCertFile, paths.caKeyFile, paths.certFile, paths.keyFile]) {
    await assertManagedParents(ownedRoot, file, 'tls_ingress')
    let entry
    try { entry = await lstat(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('tls_ingress_file_invalid')
    await unlink(file)
  }
  try {
    await assertManagedParents(ownedRoot, paths.directory, 'tls_ingress')
    await rmdir(paths.directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}