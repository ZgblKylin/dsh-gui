/**
 * End-to-end self-check of the remote-connection module against a real SSH host.
 *
 * Usage: node src/remote/selfcheck.mjs [ssh-alias]      (default alias: WSL)
 *
 * The alias must be reachable with `ssh -o BatchMode=yes` and must carry a dsh
 * install at the defaults documented in `./config.ts` (`~/dsh-gui-home`), plus a
 * `~/dsh-gui-home/dsh-gui` checkout whose `npm run harness` starts a backend. The
 * script drives the real HTTP routes registered by `./index.ts`, so it covers
 * route posture (405, cross-site 403), both launch forms (the built-in command,
 * and a configured `workdir` + `startCommand`), the connection log (progressive
 * growth, token-free lines), failure text (a taken local port, an unresolvable
 * host, an unenterable working directory), and the `~/.ssh/config` import. It
 * then asserts that neither a tunnel process nor a remote backend survives
 * `down`.
 *
 * This is a manual verification script, not part of the built plugin: it is not
 * referenced by `src/index.ts` and stays out of the published `files` list.
 */

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerRemoteConnections, createRemoteConnections } from './index.ts'
import { readConfiguredSshTabs } from './config.ts'
import { appendServeFlags } from './commands.ts'
import { openTunnel, runSsh } from './ssh.ts'

const alias = process.argv[2] ?? 'WSL'
const npmWorkdir = '~/dsh-gui-home/dsh-gui'
const failures = []
const evidence = []

/** Record one observed fact. */
function note(line) {
  evidence.push(line)
  console.log(line)
}

/** Assert one condition, recording the failure instead of throwing. */
function check(label, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Pause between polls. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A web server double matching @deepseek-ai/dsh-host-webserver's dispatch. */
function fakeWebServer(host) {
  const routes = []
  return {
    host,
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at !== -1) routes.splice(at, 1)
      }
    },
    match(pathname) {
      const exact = routes.find(route => route.kind === 'exact' && route.path === pathname)
      if (exact !== undefined) return exact
      let best
      for (const route of routes) {
        if (route.kind !== 'prefix') continue
        if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue
        if (best === undefined || route.path.length > best.path.length) best = route
      }
      return best
    },
    count() {
      return routes.length
    },
  }
}

const loggerContext = {
  logger: {
    info: () => {},
    warn: message => note(`warn ${String(message)}`),
    error: message => note(`error ${String(message)}`),
  },
}

/** Register the routes against a fresh double and serve them over real HTTP. */
async function openRoutes(options) {
  const webServer = fakeWebServer('127.0.0.1')
  const dispose = registerRemoteConnections(loggerContext, webServer, options)
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = webServer.match(pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void Promise.resolve(route.handler(req, res)).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      dispose()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** Remote processes matching one pattern, as `pid command` lines. */
function remoteProcesses(pattern) {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, `pgrep -fa ${pattern}`], { encoding: 'utf8' })
  return (result.stdout ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
}

/** One remote shell command, stdout only. */
function remote(command) {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, command], { encoding: 'utf8' })
  return (result.stdout ?? '').trim()
}

/** Names of the remote launch logs present right now. */
function remoteLogs() {
  return remote('ls -1 /tmp/dsh-desktop-tabs-*.log 2>/dev/null')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

/** Local ssh clients still forwarding one local port. */
function localTunnelProcesses(localPort) {
  const shell = process.platform === 'win32' ? 'pwsh' : 'ps'
  const script = process.platform === 'win32'
    ? 'Get-CimInstance Win32_Process -Filter "Name=\'ssh.exe\'" | Select-Object -ExpandProperty CommandLine'
    : 'ps -eo args'
  const result = spawnSync(shell, ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  if (result.error !== undefined) return [`<could not inspect local processes: ${result.error.message}>`]
  return (result.stdout ?? '').split('\n').filter(line => line.includes(`127.0.0.1:${localPort}:`))
}

/** Whether a loopback port can be bound, i.e. nothing holds it. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(() => resolve(true)))
  })
}

/** One HTTP call against a route server. */
async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', ...options })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, headers: response.headers, body }
}

/** One status row of a tab from `GET /connections`. */
async function statusRow(base, id) {
  const state = await call(base, '/desktop-tabs/api/connections')
  return state.body?.connections?.find(entry => entry.id === id)
}

/**
 * Run one `POST .../up` while polling the status route, so the connection log can
 * be observed growing before the response arrives.
 */
async function watchUp(base, id, request) {
  let settled = false
  const payload = request()
  void payload.then(() => { settled = true }, () => { settled = true })
  const lengths = []
  const samples = []
  while (!settled) {
    const row = await statusRow(base, id)
    lengths.push(row?.log?.length ?? 0)
    samples.push(row?.log ?? [])
    await sleep(180)
  }
  return { payload, lengths, samples, row: await statusRow(base, id) }
}

/** Log-line assertions shared by both launch forms. */
function checkLog(label, row, token) {
  const lines = row?.log ?? []
  note(`${label}：连接日志共 ${lines.length} 行`)
  for (const line of lines) note(`      ${line}`)
  check(`${label}日志已记录关键步骤`, ['SSH 连通性', '启动远端 dsh', '隧道已建立', '健康检查通过'].every(marker => lines.some(line => line.includes(marker))), lines.join(' | ').slice(0, 400))
  check(`${label}日志不含 token 明文`, token === undefined || lines.every(line => !line.includes(token)))
  check(`${label}日志的 token 值均已脱敏`, lines.every(line => !/token=(?!\*\*\*)\S/.test(line)))
  check(`${label}日志为单行且无 ANSI`, lines.every(line => !line.includes('\n') && !line.includes('\u001b')))
}

const remoteHome = remote('printf %s "$HOME"')
note(`remote home: ${remoteHome}`)
// A connection opened by another session may already be live on the host; every
// residue check below is diffed against what was there before this run.
const foreignLogs = remoteLogs()
const foreignRemote = remoteProcesses(`'dsh/lib/bin[.]js web'`)
if (foreignRemote.length > 0) note(`pre-existing remote dsh web processes (left untouched): ${JSON.stringify(foreignRemote)}`)

const workspace = mkdtempSync(join(tmpdir(), 'dsh-desktop-tabs-selfcheck-'))
mkdirSync(join(workspace, 'gui'), { recursive: true })
writeFileSync(join(workspace, 'gui', 'desktop-tabs.json'), JSON.stringify({
  tabs: [
    { id: 'wsl', title: 'WSL', ssh: { host: alias } },
    { id: 'wsl-npm', title: 'WSL npm', ssh: { host: alias }, workdir: npmWorkdir, startCommand: 'npm run harness' },
  ],
}, null, 2))
note(`fixture ${join(workspace, 'gui', 'desktop-tabs.json')}`)

// ---------------------------------------------------------------- offline checks
const configured = readConfiguredSshTabs(workspace)
check('config reader finds both ssh descriptors', configured.length === 2, JSON.stringify(configured))
check('config reader reads the flat launch fields', configured[1]?.workdir === npmWorkdir && configured[1]?.startCommand === 'npm run harness', JSON.stringify(configured[1]))

const flagCases = [
  ['node bin.js web --no-open', 0, 'node bin.js web --no-open --host 127.0.0.1 --port 0'],
  ['npm run harness', 0, 'npm run harness -- --host 127.0.0.1 --port 0'],
  ['pnpm run dev', 2412, 'pnpm run dev -- --host 127.0.0.1 --port 2412'],
  ['node x.js web --host 0.0.0.0 --port 1234', 0, 'node x.js web --host 0.0.0.0 --port 1234'],
  ['node x.js web --hostname foo', 0, 'node x.js web --hostname foo --host 127.0.0.1 --port 0'],
]
for (const [command, port, expected] of flagCases) {
  const actual = appendServeFlags(command, port)
  check(`appendServeFlags(${command})`, actual === expected, actual)
}

const refusedServer = fakeWebServer('0.0.0.0')
let refusal = ''
registerRemoteConnections({ logger: { info: () => {}, warn: () => {}, error: message => { refusal = String(message) } } }, refusedServer, { dshHome: workspace })
check('registration is refused off loopback', refusedServer.count() === 0 && refusal.includes('loopback'), `routes ${refusedServer.count()}, message "${refusal.slice(0, 120)}"`)

const offline = createRemoteConnections({ dshHome: workspace, tabs: async () => [{ id: 'missing', title: 'Missing' }] })
check('status lists a configured tab as idle without a log', offline.status().every(row => row.state === 'idle' && Array.isArray(row.log) && row.log.length === 0), JSON.stringify(offline.status()))
let offlineError = ''
try {
  await offline.up('missing')
} catch (error) {
  offlineError = error instanceof Error ? error.message : String(error)
}
offline.dispose()
check('a tab without an ssh descriptor fails readably', offlineError.includes('no "ssh" descriptor'), offlineError.slice(0, 160))

// The same id appears in both lists: the tab row carries no ssh descriptor, so
// only the per-field merge with the `connections` row can resolve it — and its bad
// working directory proves the readable launch failure.
const bad = createRemoteConnections({
  dshHome: workspace,
  tabs: async () => ({
    tabs: [{ id: 'wsl-badworkdir', title: 'tab row without ssh' }],
    connections: [{ id: 'wsl-badworkdir', title: 'bad', ssh: { host: alias }, workdir: '/nonexistent-dsh-tabs-dir' }],
  }),
})
let badError = ''
try {
  await bad.up('wsl-badworkdir')
} catch (error) {
  badError = error instanceof Error ? error.message : String(error)
}
const badRow = bad.status().find(row => row.id === 'wsl-badworkdir')
bad.dispose()
check('a connections-only row is resolved by id', badRow !== undefined && badRow.state === 'error' && badError.includes('远端工作目录不可进入'), badError.slice(0, 200))
check('the failed launch is in the connection log', (badRow?.log ?? []).some(line => line.includes('连接失败')), JSON.stringify(badRow?.log))

// A local port that something else already holds must fail the forward instead of
// quietly landing on that other service.
const occupied = createTcpServer()
await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
const occupiedPort = occupied.address().port
let tunnelError = ''
try {
  const unlucky = await openTunnel({ host: alias, localPort: occupiedPort, remotePort: 1 })
  unlucky.child.kill()
} catch (error) {
  tunnelError = error instanceof Error ? error.message : String(error)
}
await new Promise(resolve => occupied.close(resolve))
check('a taken local port fails the forward', tunnelError.includes('exited during startup'), tunnelError.slice(0, 200))
check('a taken local port keeps the ssh error line', tunnelError.includes('Permission denied'), tunnelError.slice(0, 200))

// A lookup failure is the path Windows ssh answers with a localized message: the
// ssh-generated line must survive, and the localized part must not arrive as
// octal escapes or replacement characters.
let resolveError = ''
try {
  const run = runSsh('dsh-nonexistent-host-6f2a', 'echo ok', { timeoutMs: 15_000 })
  await run.done
} catch (error) {
  resolveError = error instanceof Error ? error.message : String(error)
}
check('a failed lookup keeps the ssh error line', resolveError.includes('Could not resolve hostname'), resolveError.slice(0, 200))
check('a failed lookup keeps no replacement characters', !resolveError.includes('\uFFFD'), resolveError.slice(0, 200))
if (process.platform === 'win32') {
  check('a failed lookup is not left as octal escapes', !/\\[0-3][0-7]{2}/.test(resolveError), resolveError.slice(0, 200))
}

// ------------------------------------------- case a: built-in launch (config file)
const serverA = await openRoutes({ dshHome: workspace })
const preexistingRemote = remoteProcesses(`'dsh/lib/bin[.]js web'`)
note(`remote dsh web processes before the default launch: ${preexistingRemote.length}`)
try {
  const wrongMethod = await call(serverA.base, '/desktop-tabs/api/connections/wsl')
  check('GET /connections/wsl answers 405', wrongMethod.status === 405, `status ${wrongMethod.status}`)
  const crossSite = await call(serverA.base, '/desktop-tabs/api/connections', { headers: { 'sec-fetch-site': 'cross-site' } })
  check('cross-site /connections answers 403', crossSite.status === 403, `status ${crossSite.status}`)
  const hosts = await call(serverA.base, '/desktop-tabs/api/ssh-hosts')
  check('GET /ssh-hosts lists the alias', hosts.status === 200 && hosts.body?.hosts?.some(host => host.alias === alias), `status ${hosts.status}`)
  check('GET /ssh-hosts sets no-store', hosts.headers.get('cache-control') === 'no-store')
  const unknown = await call(serverA.base, '/desktop-tabs/api/connections/wsl/nope', { method: 'POST' })
  check('POST /connections/wsl/nope answers 404', unknown.status === 404, `status ${unknown.status}`)

  const started = Date.now()
  const attempt = await watchUp(serverA.base, 'wsl', () => call(serverA.base, '/desktop-tabs/api/connections/wsl/up', { method: 'POST' }))
  const up = await attempt.payload
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  check('POST /connections/wsl/up answers 200', up.status === 200, `status ${up.status} body ${JSON.stringify(up.body).slice(0, 300)}`)
  check('up returns a token URL', typeof up.body?.url === 'string' && up.body.url.includes('token='), up.body?.url)
  if (typeof up.body?.url !== 'string') throw new Error('no url to verify')

  const url = new URL(up.body.url)
  const token = url.searchParams.get('token')
  const localPortA = Number(url.port)
  note(`default launch took ${elapsed}s; url port ${localPortA}`)
  note(`connection log samples: ${JSON.stringify(attempt.lengths)}`)

  const increases = attempt.lengths.filter((value, index) => index !== 0 && value > attempt.lengths[index - 1])
  check('the connection log grows while up runs', attempt.lengths.length >= 3 && attempt.lengths[attempt.lengths.length - 1] >= 5 && increases.length >= 2, `samples ${JSON.stringify(attempt.lengths)}`)
  const milestones = {
    ssh: attempt.samples.some(log => log.some(line => line.includes('SSH 连通性'))),
    tunnel: attempt.samples.some(log => log.some(line => line.includes('隧道已建立'))),
    health: attempt.samples.some(log => log.some(line => line.includes('健康检查通过'))),
  }
  note(`steps observed in mid-flight samples: ${JSON.stringify(milestones)}`)
  check(
    'earlier steps are visible while later ones are still running',
    milestones.ssh && attempt.samples.some(log => !log.some(line => line.includes('SSH 连通性'))),
    `${attempt.samples.length} samples`,
  )
  checkLog('默认', attempt.row, token)

  const bareProbe = await fetch(`${url.origin}/`, { redirect: 'manual' })
  note(`bare / through tunnel: ${bareProbe.status}`)
  check('tunnel answers 401 without a token', bareProbe.status === 401, `status ${bareProbe.status}`)
  const tokened = await fetch(url, { redirect: 'manual' })
  const cookie = tokened.headers.get('set-cookie')
  note(`tokened / through tunnel: ${tokened.status}${cookie === null ? '' : ` ${cookie.split(';')[0]}`}`)
  check('tunnel answers 303 with the token', tokened.status === 303, `status ${tokened.status}`)

  const afterUp = remoteProcesses(`'dsh/lib/bin[.]js web'`)
  const startedRemote = afterUp.filter(line => !preexistingRemote.includes(line))
  note(`remote dsh web processes started by the default launch: ${startedRemote.length}`)
  check('the default launch started a remote dsh web process', startedRemote.length >= 1, JSON.stringify(startedRemote).slice(0, 300))
  check('the tunnel is a live local ssh client', localTunnelProcesses(localPortA).length >= 1)

  const down = await call(serverA.base, '/desktop-tabs/api/connections/wsl/down', { method: 'POST' })
  check('POST /connections/wsl/down answers 200', down.status === 200, `status ${down.status}`)
  const afterDownRow = await statusRow(serverA.base, 'wsl')
  check('down clears the connection log', afterDownRow?.state === 'idle' && afterDownRow.log.length === 0, JSON.stringify(afterDownRow))
  check('local port is free after down', await portIsFree(localPortA))
  check('no local ssh client forwards that port', localTunnelProcesses(localPortA).length === 0, JSON.stringify(localTunnelProcesses(localPortA)).slice(0, 300))
  const survivors = remoteProcesses(`'dsh/lib/bin[.]js web'`).filter(line => startedRemote.includes(line))
  check('no remote dsh web process started by the default launch survives down', survivors.length === 0, JSON.stringify(survivors).slice(0, 300))
} catch (error) {
  check('the default launch path completed without an unexpected error', false, error instanceof Error ? error.message : String(error))
} finally {
  await call(serverA.base, '/desktop-tabs/api/connections/wsl/down', { method: 'POST' }).catch(() => {})
  await serverA.close()
}

// ------------------- case b: configured workdir + startCommand (connections row)
const serverB = await openRoutes({
  dshHome: workspace,
  tabs: async () => ({
    tabs: [],
    connections: [{ id: 'wsl-npm', title: 'WSL npm', ssh: { host: alias }, workdir: npmWorkdir, startCommand: 'npm run harness' }],
  }),
})
try {
  const attempt = await watchUp(serverB.base, 'wsl-npm', () => call(serverB.base, '/desktop-tabs/api/connections/wsl-npm/up', { method: 'POST' }))
  const up = await attempt.payload
  check('POST /connections/wsl-npm/up answers 200', up.status === 200, `status ${up.status} body ${JSON.stringify(up.body).slice(0, 300)}`)
  if (typeof up.body?.url !== 'string') throw new Error('no url to verify for the configured launch')
  const url = new URL(up.body.url)
  const token = url.searchParams.get('token')
  const localPortB = Number(url.port)
  note(`configured launch url port ${localPortB} (${url.origin})`)
  note(`connection log samples: ${JSON.stringify(attempt.lengths)}`)

  checkLog('配置', attempt.row, token)
  const logText = (attempt.row?.log ?? []).join('\n')
  check(
    'the log shows the configured workdir and the flag-appended command',
    logText.includes(npmWorkdir) && logText.includes('npm run harness -- --host 127.0.0.1 --port 0'),
    logText.slice(0, 400),
  )

  const peer = remote('p=$(pgrep -f \'harness[.]mjs\' | head -n1); if [ -n "$p" ]; then printf \'PID=%s\\n\' $p; printf \'CWD=%s\\n\' $(readlink /proc/$p/cwd); printf \'CMD=%s\\n\' "$(ps -o args= -p $p)"; fi')
  note('远端进程证据：')
  for (const line of peer.split('\n')) if (line !== '') note(`      ${line}`)
  check('the configured launch runs from the configured workdir', peer.includes(`CWD=${remoteHome}/dsh-gui-home/dsh-gui`), peer)
  check('the configured launch runs the configured command', peer.includes('harness.mjs'), peer)

  const remoteLog = remote('tail -n 5 $(ls -t /tmp/dsh-desktop-tabs-*.log | head -n1) | sed -E "s/token=[^ ]+/token=***/g"')
  note('远端启动日志（token 已脱敏）：')
  for (const line of remoteLog.split('\n')) if (line !== '') note(`      ${line}`)
  check('the remote log shows the harness command and the launch URL', remoteLog.includes('harness.mjs') && remoteLog.includes('dsh web: http://'), remoteLog.slice(0, 300))

  const bareProbe = await fetch(`${url.origin}/`, { redirect: 'manual' })
  check('the configured launch answers 401 without a token', bareProbe.status === 401, `status ${bareProbe.status}`)
  const tokened = await fetch(url, { redirect: 'manual' })
  check('the configured launch answers 303 with the token', tokened.status === 303, `status ${tokened.status}`)

  const down = await call(serverB.base, '/desktop-tabs/api/connections/wsl-npm/down', { method: 'POST' })
  check('POST /connections/wsl-npm/down answers 200', down.status === 200, `status ${down.status}`)
  check('local port is free after the configured launch', await portIsFree(localPortB))
  check('no local ssh client forwards that port', localTunnelProcesses(localPortB).length === 0, JSON.stringify(localTunnelProcesses(localPortB)).slice(0, 300))

  const leftHarness = remoteProcesses(`'harness[.]mjs'`)
  const leftBackend = remoteProcesses(`'bin[.]js web --port 3080'`)
  const leftLogs = remoteLogs().filter(name => !foreignLogs.includes(name))
  const port3080 = remote("ss -ltn 2>/dev/null | grep -c ':3080' || true")
  note(`远端残留：harness.mjs=${leftHarness.length} bin.js(3080)=${leftBackend.length} 新增日志=${leftLogs.length} 3080 监听=${port3080}`)
  check('no harness process survives the configured launch down', leftHarness.length === 0, JSON.stringify(leftHarness).slice(0, 300))
  check('no backend process survives the configured launch down', leftBackend.length === 0, JSON.stringify(leftBackend).slice(0, 300))
  check('no remote launch log survives down', leftLogs.length === 0, JSON.stringify(leftLogs))
  check('remote port 3080 is released', port3080 === '0', port3080)
} catch (error) {
  check('the configured launch path completed without an unexpected error', false, error instanceof Error ? error.message : String(error))
} finally {
  await call(serverB.base, '/desktop-tabs/api/connections/wsl-npm/down', { method: 'POST' }).catch(() => {})
  await serverB.close()
  rmSync(workspace, { recursive: true, force: true })
}

console.log('')
console.log(failures.length === 0 ? `PASS (${evidence.length} observations)` : `FAIL (${failures.length}): ${failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
