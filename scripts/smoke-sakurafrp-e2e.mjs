/**
 * Live SakuraFrp channel end-to-end check against the real natfrp.com API.
 *
 * Boots the packed plugin in an isolated DSH profile, selects the SakuraFrp
 * provider with the operator's access token, installs the pinned frpc if
 * needed, points the configured tunnel at the local gateway and waits for a
 * ready state. Credentials come from SAKURAFRP_TOKEN / SAKURAFRP_TUNNEL_ID and
 * never enter the log output.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { packBundle } from './packed-profile.mjs'
import { createMobileProfile, sanitized } from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const token = process.env.SAKURAFRP_TOKEN ?? ''
const tunnelId = Number(process.env.SAKURAFRP_TUNNEL_ID ?? '0')
if (token === '' || !Number.isSafeInteger(tunnelId) || tunnelId < 1) {
  console.error('set SAKURAFRP_TOKEN and SAKURAFRP_TUNNEL_ID')
  process.exit(1)
}
const startedAt = Date.now()
const root = await mkdtemp(join(tmpdir(), 'dsh-sakurafrp-e2e-'))
let dsh
let home
const failures = []
const notes = []
try {
  const tarball = await packBundle(repository, root)
  home = await createMobileProfile(root, { tarball, dshBin })
  // Same launch contract as mobile-boot-fixture.launchDsh, plus the machine's
  // proxy variables so the pinned frpc download can leave the network.
  const environment = {}
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const child = spawn(process.execPath, [dshBin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: root,
    env: {
      ...environment,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(root, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
      NODE_OPTIONS: '', NODE_PATH: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  const childExit = new Promise(resolve => { child.once('close', (code, signal) => resolve({ code, signal })) })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-24_000) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-24_000) })
  const readyUrl = await new Promise((resolveReady, rejectReady) => {
    const deadline = Date.now() + 120_000
    const poll = setInterval(() => {
      const url = /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)?.[1]
      if (url !== undefined) { clearInterval(poll); resolveReady(url) }
      if (Date.now() > deadline) { clearInterval(poll); rejectReady(new Error(`DSH did not start\n${sanitized(stdout)}`)) }
    }, 100)
  })
  const closeChild = async () => {
    child.kill('SIGTERM')
    const result = await Promise.race([
      childExit,
      new Promise(resolve => setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } resolve({ code: null, signal: 'SIGKILL' }) }, 12_000)),
    ])
    return result
  }
  dsh = { ready: async () => readyUrl, close: closeChild, logs: () => sanitized(stdout) }
  const baseUrl = await dsh.ready()
  notes.push(`dsh ready at ${baseUrl}`)


  // The local admin route requires the desktop trust marker; inside the test
  // browser the same-origin page carries it, so drive the panel via Chromium.
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  const call = (path, init) => page.evaluate(async ({ path: target, init: options }) => {
    const response = await fetch(target, options)
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { status: response.status, body }
  }, { path, init })
  const headers = () => ({ 'content-type': 'application/json' })

  // 1. pick the SakuraFrp provider
  let result = await call('/api/mobile-access/remote/provider', { method: 'POST', headers: headers(), body: JSON.stringify({ provider: 'sakurafrp' }) })
  notes.push(`provider select: ${result.status}`)
  if (result.status !== 200) throw new Error(`provider select failed: ${JSON.stringify(result)}`)

  // 2. save the access token
  result = await call('/api/mobile-access/remote/sakurafrp/token', { method: 'POST', headers: headers(), body: JSON.stringify({ token }) })
  notes.push(`token save: ${result.status}`)
  if (result.status !== 200) throw new Error(`token save failed: ${JSON.stringify(result)}`)
  const payload = JSON.stringify(result.body)
  if (payload.includes(token)) throw new Error('token echoed back in the response')

  // 3. verify the tunnel list against the real API
  result = await call('/api/mobile-access/remote/sakurafrp/tunnels', {})
  notes.push(`tunnels: ${result.status} count=${result.body?.tunnels?.length ?? '?'}`)
  if (result.status !== 200) throw new Error(`tunnels failed: ${JSON.stringify(result.body)}`)
  const found = result.body.tunnels?.find(tunnel => tunnel.id === tunnelId)
  if (found === undefined) throw new Error(`tunnel ${tunnelId} is not in the account list: ${JSON.stringify(result.body.tunnels)}`)
  notes.push(`tunnel type=${found.type} remote=${found.remote} online=${found.online}`)

  // 4. select the tunnel
  result = await call('/api/mobile-access/remote/sakurafrp/configure', { method: 'POST', headers: headers(), body: JSON.stringify({ tunnelId }) })
  notes.push(`tunnel configure: ${result.status}`)
  if (result.status !== 200) throw new Error(`tunnel configure failed: ${JSON.stringify(result)}`)

  // 5. install the pinned frpc component (real download + verification)
  result = await call('/api/mobile-access/remote/sakurafrp/component/install', { method: 'POST', headers: headers(), body: JSON.stringify({ confirm: true }) })
  notes.push(`frpc install: ${result.status} ${JSON.stringify(result.body?.providers?.sakurafrp?.component ?? {})}`)
  if (result.status !== 200) throw new Error(`frpc install failed: ${JSON.stringify(result.body)}`)

  // 6. start the remote channel and wait for readiness or a stable error
  result = await call('/api/mobile-access/remote/control', { method: 'POST', headers: headers(), body: JSON.stringify({ running: true }) })
  notes.push(`remote start: ${result.status} state=${result.body?.state} errorCode=${result.body?.errorCode ?? '-'}`)
  let final = result.body
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const snapshot = await call('/api/mobile-access/remote/control', {})
    final = snapshot.body
    if (final?.state === 'ready' || final?.state === 'error' || final?.state === 'unavailable') break
    await new Promise(resolve => setTimeout(resolve, 3_000))
  }
  notes.push(`final state=${final?.state} origin=${final?.origin ?? '-'} errorCode=${final?.errorCode ?? '-'}`)
  if (final?.state !== 'ready') {
    throw new Error(`SakuraFrp channel did not become ready: state=${final?.state} code=${final?.errorCode}`)
  }

  // 7. The tunnel has visitor authentication (auth_pass) enabled on the
  // SakuraFrp side; authorize this machine's public IP so the probe passes.
  const authApi = await fetch(`https://api.natfrp.com/v4/tunnel/auth?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: String(tunnelId) }).toString(),
  })
  notes.push(`tunnel/auth: ${authApi.status} ${(await authApi.text()).slice(0, 100)}`)
  const origin = new URL(final.origin)
  const caPem = await readFile(join(home, 'mobile-access', 'remote', 'ingress', 'ca.pem'), 'utf8')
  notes.push(`pairing CA read: ${caPem.length > 0} bytes=${caPem.length}`)
  // Node-behavior experiment: send plaintext HTTP at the public tunnel port.
  // A reply means the node terminates TLS / speaks HTTP itself; silence means
  // raw TCP passthrough that expects the client to start TLS.
  const rawProbe = spawn(process.execPath, ['-e', `
    const net = require('node:net');
    const s = net.connect(${JSON.stringify(Number(found.remote))}, ${JSON.stringify(origin.hostname)}, () => {
      s.write('GET /mobile-access/health HTTP/1.1\\r\\nHost: ' + ${JSON.stringify(origin.host)} + '\\r\\nConnection: close\\r\\n\\r\\n');
    });
    let data = '';
    s.setTimeout(6000, () => { console.log('silent-timeout'); s.destroy(); process.exit(0); });
    s.on('data', c => { data += c.toString('latin1'); });
    s.on('close', () => { console.log('raw=' + data.slice(0, 300).replace(/[\\r\\n]+/g, ' | ')); process.exit(0); });
    s.on('error', e => { console.log('raw-error=' + e.message); process.exit(0); });
  `], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
  let rawOut = ''
  rawProbe.stdout?.on('data', chunk => { rawOut += chunk })
  await new Promise(resolve => rawProbe.once('close', resolve))
  notes.push(`raw node probe: ${rawOut.trim()}`)
  const probe = spawn(process.execPath, ['-e', `
    const https = require('node:https');
    const req = https.get(${JSON.stringify(origin.href)} + '/mobile-access/health', { ca: process.env.SAKURAFRP_CA_PEM, servername: ${JSON.stringify(origin.hostname)} }, res => {
      let body = '';
      res.on('data', c => { body += c });
      res.on('end', () => { console.log('status=' + res.statusCode + ' body=' + body.slice(0, 200)); res.destroy(); process.exit(0); });
    });
    req.on('error', e => { console.log('error=' + e.message); process.exit(1); });
    req.setTimeout(15000, () => { console.log('error=timeout'); req.destroy(); process.exit(1); });
  `], { env: { ...process.env, SAKURAFRP_CA_PEM: caPem }, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  let probeOut = ''
  probe.stdout?.on('data', chunk => { probeOut += chunk })
  probe.stderr?.on('data', chunk => { probeOut += chunk })
  await new Promise(resolve => probe.once('close', resolve))
  notes.push(`public probe: ${probeOut.trim()}`)
  // Control experiment: hit the loopback plain-HTTP listener directly with the
  // public Host, isolating gateway logic from the SakuraFrp node path.
  const localPort = found.localPort ?? 0
  const localProbe = spawn(process.execPath, ['-e', `
    const https = require('node:https');
    const req = https.request({ host: '127.0.0.1', port: ${JSON.stringify(localPort)}, path: '/mobile-access/health', method: 'GET', ca: process.env.SAKURAFRP_CA_PEM, servername: ${JSON.stringify(origin.hostname)}, headers: { host: ${JSON.stringify(origin.host)} } }, res => {
      let body = '';
      res.on('data', c => { body += c });
      res.on('end', () => { console.log('status=' + res.statusCode + ' body=' + body.slice(0, 200)); res.destroy(); process.exit(0); });
    });
    req.on('error', e => { console.log('error=' + e.message); process.exit(1); });
    req.setTimeout(8000, () => { console.log('error=timeout'); req.destroy(); process.exit(1); });
    req.end();
  `], { env: { ...process.env, SAKURAFRP_CA_PEM: caPem }, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  let localOut = ''
  localProbe.stdout?.on('data', chunk => { localOut += chunk })
  localProbe.stderr?.on('data', chunk => { localOut += chunk })
  await new Promise(resolve => localProbe.once('close', resolve))
  notes.push(`local probe (${localPort}): ${localOut.trim()}`)
  if (!probeOut.includes('status=2') && !probeOut.includes('status=3')) {
    // Dump the plugin's private log tail (it never leaves this machine) so the
    // gateway-side view of the failed request is visible.
    const logFile = join(home, 'mobile-access', 'logs', 'dsh-mobile.log')
    const log = await readFile(logFile, 'utf8').catch(() => '<no log>')
    notes.push(`gateway log tail: ${log.slice(-3000).replace(/\r?\n/gu, ' | ')}`)
    throw new Error(`public entry probe failed: ${probeOut.trim()} | local: ${localOut.trim()}`)
  }

  await browser.close()
  console.log(`SakuraFrp E2E READY: tunnel ${tunnelId} serving ${final.origin} (${Date.now() - startedAt} ms)`)
} catch (error) {
  failures.push(error instanceof Error ? error : new Error(String(error)))
} finally {
  if (dsh !== undefined) {
    try {
      const result = await dsh.close()
      if (result.forced) failures.push(new Error('DSH did not stop quiescently'))
    } catch (error) { failures.push(error) }
  }
  try { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* temp cleanup best effort */ }
  console.log(notes.map(note => sanitized(note)).join('\n'))
}
if (failures.length > 0) {
  console.error(`SakuraFrp E2E FAILED: ${failures.map(error => sanitized(error.message)).join(' | ')}`)
  process.exit(1)
}