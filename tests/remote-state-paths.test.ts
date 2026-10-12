import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureTlsIngressCertificate,
  purgeTlsIngressCertificates,
  tlsIngressPaths,
} from '../src/tls-ingress.js'
import { readTlsIngressTrustAnchor } from '../src/plugin.js'

const roots: string[] = []
const links: string[] = []
afterEach(async () => {
  for (const path of links.splice(0)) {
    const entry = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (entry?.isSymbolicLink()) await unlink(path)
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(): Promise<{ state: string; outside: string; sentinel: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-path-')); roots.push(root)
  const state = join(root, 'mobile-access'); const outside = join(root, 'outside')
  await mkdir(state); await mkdir(outside)
  const sentinel = join(outside, 'keep'); await writeFile(sentinel, 'outside must survive')
  return { state, outside, sentinel }
}
async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir'); links.push(path)
}

describe('private remote state ownership for the TLS ingress', () => {
  it('does not read, create or delete ingress material through an internal remote ancestor junction', async () => {
    const { state, outside, sentinel } = await fixture()
    await mkdir(join(outside, 'ingress'), { recursive: true })
    const certificate = join(outside, 'ingress', 'ca.pem'); await writeFile(certificate, 'external CA')
    await linkDirectory(outside, join(state, 'remote'))
    const stateFile = join(state, 'remote', 'devices.json')
    await expect(ensureTlsIngressCertificate({ publicOrigin: 'https://1.2.3.4' }, stateFile, Date.now(), undefined, state))
      .rejects.toThrow('tls_ingress_path_invalid')
    await expect(readTlsIngressTrustAnchor(stateFile, state)).rejects.toThrow('tls_ingress_ca_invalid')
    await expect(purgeTlsIngressCertificates(stateFile, state)).rejects.toThrow('tls_ingress_path_invalid')
    expect(await readFile(certificate, 'utf8')).toBe('external CA')
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
    expect(await readdir(outside)).toEqual(['ingress', 'keep'])
  })

  it('purge unlinks only a selected ingress junction and retains unrelated private files', async () => {
    const { state, outside, sentinel } = await fixture()
    const stateFile = join(state, 'remote', 'devices.json')
    const paths = tlsIngressPaths(stateFile)
    await mkdir(join(state, 'remote'), { recursive: true })
    await writeFile(paths.statusFile, 'owned identity'); await writeFile(stateFile, 'paired devices')
    await linkDirectory(outside, paths.directory)
    await expect(ensureTlsIngressCertificate({ publicOrigin: 'https://1.2.3.4' }, stateFile, Date.now(), undefined, state))
      .rejects.toThrow('tls_ingress_path_invalid')
    await purgeTlsIngressCertificates(stateFile, state)
    await expect(lstat(paths.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(paths.statusFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(stateFile, 'utf8')).toBe('paired devices')
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
  })
})