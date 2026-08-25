/**
 * dsh-remote host half: owns the durable machinery behind the connection tab
 * bar. It registers the `/remote-api/*` HTTP JSON routes on the harness web
 * server and behind them:
 *
 *  - `local.start` — spawn an additional self-hosted `dsh web` backend on a
 *    free port (checked by `probe` first; started only when the port is dead),
 *  - `ssh.connect` — secure remote mode: the remote backend is started with a
 *    configurable command (default `npx '@deepseek-ai/dsh' web`) and kept
 *    running inside a `dsh-gui` tmux session. No code is deployed to the
 *    remote — the startup command owns how dsh is run there. The frontend is
 *    reached over an SSH local port forward (`ssh -N -L`): the pipeline
 *    establishes the session, checks the remote toolchain, starts/restarts the
 *    tmux session, discovers the session's serving port, forwards it to a free
 *    local loopback port, and only then reports the local URL as loadable,
 *  - `creds.*` / `keyfile.write` — the credential store (Windows DPAPI,
 *    Linux gpg; keys and filenames carry `ZgblKylin+dsh-gui+<连接名>`), plus the
 *    uploaded SSH private-key files.
 *
 * Connection records (name/address/port/ssh fields) are kept by the browser
 * half in localStorage — dsh-gui manages the connection config; the remote
 * owns its own DSH_HOME (default `~/.dsh`, or whatever the configured startup
 * command sets) and plugin configuration.
 *
 * Security posture: `/remote-api` is an unauthenticated local RPC, so this
 * half refuses to serve when the web server is bound to anything but the
 * loopback address (see `apply`).
 *
 * This half is a real Node ESM bundle: node: builtins are used directly.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
}

export const name = 'dsh-remote'

/** Required services for route registration. */
export const inject = ['webServer']

/** App passphrase for the Linux gpg credential store (混淆级, not a strong secret — see docs). */
const GPG_PIN = 'dsh-remote-app-pin'

/** JSON request body / uploaded key size caps (bytes), guarding memory + disk. */
const MAX_JSON_BODY = 1 * 1024 * 1024
const MAX_KEY_B64 = 8 * 1024 * 1024

/** Default remote command that starts the DSH backend; override via env. */
export const defaultStartCommand = (): string =>
  process.env.DSH_REMOTE_START_COMMAND || `npx '@deepseek-ai/dsh' web`

interface Discovery {
  home: string
  platform: string
  node: string
  repoRoot: string
  harnessDir: string
  bin: string
}

interface LocalHandle {
  pid: number
  proc: ReturnType<typeof spawn>
}

/** Locate the self-hosted harness checkout by walking up from cwd / DSH_HOME. */
function discover(): Discovery {
  const home = process.env.DSH_HOME || ''
  const cwd = process.cwd()
  let root = ''
  let p = cwd
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(p, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'))) { root = p; break }
    const q = dirname(p)
    if (q === p) break
    p = q
  }
  if (root === '' && home !== '') {
    let q = home
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(q, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'))) { root = q; break }
      const n = dirname(q)
      if (n === q) break
      q = n
    }
  }
  return {
    home,
    platform: process.platform,
    node: process.execPath,
    repoRoot: root,
    harnessDir: root === '' ? '' : join(root, 'deepseek-harness'),
    bin: root === '' ? '' : join(root, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
  }
}

/** Minimal same-origin fence for /remote-api, mirroring the connection plugin's posture. */
function trusted(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const origin = req.headers['origin']
  if (origin === undefined) return true
  const host = req.headers['host']
  if (host === undefined) return false
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

/** Read the request body (bounded) and JSON.parse it (empty body -> {}). */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_JSON_BODY) {
        reject(new Error(`request body exceeds ${MAX_JSON_BODY} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { resolve(text === '' ? {} : JSON.parse(text)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/**
 * Finite-timeout HTTP GET. Distinct from reachability: `reachable` only means
 * the TCP/HTTP connection succeeded; `loadable` additionally requires a 2xx
 * status, which is what "前端可加载" must mean (a 404 startup window or an
 * arbitrary 403/404 service must NOT count as ready).
 */
function probe(url: string): Promise<{ reachable: boolean; loadable: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = httpGet(url, { timeout: 4000 }, (res) => {
      const status = res.statusCode ?? 0
      resolve({ reachable: status > 0, loadable: status >= 200 && status < 300, status })
      res.resume()
    })
    req.on('error', (error: Error) => resolve({ reachable: false, loadable: false, error: error.message }))
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, loadable: false, error: 'timeout' }) })
  })
}

/** Run a short-lived child and collect output. */
function runSync(argv: string[], input?: string, timeoutMs = 120000): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(argv[0], argv.slice(1), { input, encoding: 'utf8', timeout: timeoutMs })
  return {
    exitCode: result.error !== undefined || result.status === null ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Resolve a usable executable for an ssh-family tool name, preferring a real
 * non-zero binary over empty PATH shims (this machine ships a 0-byte
 * `C:\Windows\ssh.exe` that would otherwise shadow OpenSSH).
 * @returns an absolute executable path, or the bare name when nothing usable resolves.
 */
function resolveTool(tool: string): string {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    // Known OpenSSH installs first (they sit lower in PATH and may be
    // shadowed by an empty shim like C:\Windows\ssh.exe).
    candidates.push(`C:\\Windows\\System32\\OpenSSH\\${tool}.exe`)
    candidates.push(`C:\\Program Files\\OpenSSH\\${tool}.exe`)
    candidates.push(`C:\\Program Files (x86)\\OpenSSH\\${tool}.exe`)
    const r = runSync(['where.exe', tool], undefined, 10000)
    for (const line of r.stdout.split(/\r?\n/)) {
      const p = line.trim()
      if (p !== '') candidates.push(p)
    }
  } else {
    const r = runSync(['which', tool], undefined, 10000)
    for (const line of r.stdout.split(/\n/)) {
      const p = line.trim()
      if (p !== '') candidates.push(p)
    }
  }
  for (const p of candidates) {
    try {
      if (p === '') continue
      const stats = existsSync(p) ? statSync(p) : undefined
      if (stats !== undefined && stats.size > 0) return p
    } catch { /* continue probing candidates */ }
  }
  return tool
}

/** Resolve whether ssh/plink/sshpass exist on this host, to real paths. */
function sshAvailability(): { ssh: string | null; plink: string | null; sshpass: string | null } {
  const ssh = resolveTool('ssh')
  const plink = resolveTool('plink')
  const sshpass = resolveTool('sshpass')
  return {
    ssh: ssh === 'ssh' ? null : ssh,
    plink: plink === 'plink' ? null : plink,
    sshpass: sshpass === 'sshpass' ? null : sshpass,
  }
}

/**
 * Build the real client argv for a remote `bash -s` run.
 *
 * `auth.host` is the SSH target (an ssh-config alias like `ASUS` or a literal
 * hostname), deliberately distinct from the DSH backend `address`. When
 * neither a password nor a key file is given, the bare host is passed through
 * so the local `~/.ssh/config` (Host alias, User, IdentityFile, port) is
 * reused unchanged. Port flag (ssh `-p` / plink `-P`) is only emitted when an
 * explicit non-default port was supplied — consistent across the three tools.
 */
function buildSshArgv(auth: Record<string, unknown>, avail: { ssh: string | null; plink: string | null; sshpass: string | null }): string[] | null {
  const user = String(auth.user ?? '')
  const userHost = (user !== '' ? `${user}@` : '') + String(auth.host)
  const explicitPort = auth.port !== undefined && auth.port !== null && Number(auth.port) !== 22
  const port = String(auth.port ?? 22)
  if (auth.password && !auth.keyFile) {
    if (avail.sshpass !== null && avail.ssh !== null) {
      const argv = [avail.sshpass, '-p', String(auth.password), avail.ssh, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15']
      if (explicitPort) argv.push('-p', port)
      argv.push(userHost, 'bash -s')
      return argv
    }
    if (avail.plink !== null) {
      const argv = [avail.plink, '-batch', '-pw', String(auth.password)]
      if (explicitPort) argv.push('-P', port)
      argv.push(userHost, 'bash -s')
      return argv
    }
    return null
  }
  if (avail.ssh === null) return null
  const argv = [avail.ssh]
  if (auth.keyFile) argv.push('-i', String(auth.keyFile))
  argv.push('-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')
  if (explicitPort) argv.push('-p', port)
  argv.push(userHost, 'bash -s')
  return argv
}

/** One remote command fed to `bash -s` over ssh. */
async function sshRun(ctx: Context, auth: Record<string, unknown>, script: string, timeoutMs = 120000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const avail = sshAvailability()
  if (avail.ssh === null && avail.plink === null) return { exitCode: 1, stdout: '', stderr: 'ssh not available' }
  const argv = buildSshArgv(auth, avail)
  if (argv === null) return { exitCode: 1, stdout: '', stderr: 'password auth requires plink or sshpass' }
  return runSync(argv, script, timeoutMs)
}

/** Shared log line -> plugin console. */
function log(ctx: Context, message: string): void {
  ctx.logger?.info(`[dsh-remote] ${message}`)
}

/** Live progress of the in-flight remote connect; polled by the shell via `ssh.status`. */
const remoteProgress: {
  running: boolean
  startedAt: number
  steps: Array<{ step: string; ok?: boolean; detail?: string }>
} = {
  running: false,
  startedAt: 0,
  steps: [],
}

/** Append a live-progress line; consecutive lines with the same step text are
 *  collapsed so volatile counters (e.g. the port-wait countdown) do not flood
 *  the shell's progress list. */
function progress(step: string, ok?: boolean, detail?: string): void {
  const last = remoteProgress.steps[remoteProgress.steps.length - 1]
  if (last !== undefined && last.step === step) {
    last.ok = ok
    last.detail = detail
    return
  }
  remoteProgress.steps.push({ step, ok, detail })
  if (remoteProgress.steps.length > 400) remoteProgress.steps.splice(0, remoteProgress.steps.length - 400)
}

/** Record one connection-log line into the returned log AND the live store. */
function pushLog(log: Array<{ step: string; ok: boolean; detail?: string }>, step: string, ok: boolean, detail?: string): void {
  log.push({ step, ok, detail })
  progress(step, ok, detail)
}

/** Replace a connection-log line (both log and live store). */
function replaceLog(log: Array<{ step: string; ok: boolean; detail?: string }>, index: number, step: string, ok: boolean, detail?: string): void {
  log[index] = { step, ok, detail }
  progress(step, ok, detail)
}

/** Remote diagnostics log tail (redirect of the tmux pane) + a wait counter. */
const REMOTE_LOG = '$HOME/.dsh-gui-remote.log'

/** A live SSH local port forward (remote service reached via 127.0.0.1). */
interface Tunnel {
  key: string
  localPort: number
  remotePort: number
  proc: ReturnType<typeof spawn>
}

/** All live tunnels, keyed `${host}:${remotePort}`; killed on teardown. */
const tunnels = new Map<string, Tunnel>()

/** Find a free loopback port for the local side of the forward. */
function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Open an SSH local port forward: local 127.0.0.1:<localPort> -> remote
 * 127.0.0.1:<remotePort>. The remote backend binds loopback only, so the
 * traffic rides over the encrypted session instead of being exposed on the
 * LAN. The tunnel process is detached and kept alive; close it with
 * closeTunnel / teardown. Reuses a live tunnel for the same host:port.
 */
async function openTunnel(ctx: Context, auth: Record<string, unknown>, avail: { ssh: string | null; plink: string | null; sshpass: string | null }, remotePort: number): Promise<{ ok: boolean; localPort?: number; error?: string }> {
  const key = `${auth.host}:${remotePort}`
  const existing = tunnels.get(key)
  if (existing !== undefined && existing.proc.exitCode === null) {
    void log(ctx, `reuse tunnel ${key} (local ${existing.localPort})`)
    return { ok: true, localPort: existing.localPort }
  }
  if (existing !== undefined) tunnels.delete(key)

  const localPort = await freeLocalPort()
  const forward = `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`
  const user = String(auth.user ?? '')
  const userHost = `${user !== '' ? `${user}@` : ''}${auth.host}`
  const explicitPort = auth.port !== undefined && auth.port !== null && Number(auth.port) !== 22
  const port = String(auth.port ?? 22)

  let argv: string[] | null = null
  if (auth.password && !auth.keyFile) {
    if (avail.sshpass !== null && avail.ssh !== null) {
      argv = [avail.sshpass, '-p', String(auth.password), avail.ssh, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-N', '-L', forward]
      if (explicitPort) argv.push('-p', port)
      argv.push(userHost)
    } else if (avail.plink !== null) {
      const args = [avail.plink, '-batch', '-pw', String(auth.password), '-L', forward]
      if (explicitPort) args.push('-P', port)
      args.push(userHost)
      argv = args
    }
  } else if (avail.ssh !== null) {
    argv = [avail.ssh]
    if (auth.keyFile) argv.push('-i', String(auth.keyFile))
    argv.push('-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-N', '-L', forward)
    if (explicitPort) argv.push('-p', port)
    argv.push(userHost)
  }
  if (argv === null) {
    return { ok: false, error: 'password auth requires plink or sshpass' }
  }

  const proc = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: process.platform !== 'win32' })
  tunnels.set(key, { key, localPort, remotePort, proc })
  proc.once('exit', () => { if (tunnels.get(key)?.proc === proc) tunnels.delete(key) })
  void log(ctx, `tunnel open ${key} -> 127.0.0.1:${localPort}`)
  return { ok: true, localPort }
}

/** Close a live tunnel by host:remotePort. */
function closeTunnel(key: string): boolean {
  const tunnel = tunnels.get(key)
  if (tunnel !== undefined) {
    try { tunnel.proc.kill() } catch { /* already gone */ }
    tunnels.delete(key)
    return true
  }
  return false
}

/** Remote TCP-open probe on 127.0.0.1:<port> through ssh. */
async function sshPortOpen(ctx: Context, auth: Record<string, unknown>, port: number): Promise<boolean> {
  const res = await sshRun(ctx, auth, `(echo > /dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1 && echo OPEN || echo CLOSED`, 20000)
  return res.exitCode === 0 && res.stdout.includes('OPEN')
}

/** Remote toolchain presence check; reports each missing tool. */
async function checkRemoteToolchain(ctx: Context, auth: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  const res = await sshRun(ctx, auth, [
    // node/npm (npx ships with npm) run the dsh CLI; tmux hosts the session so
    // the backend survives the ssh command returning. git/pnpm are no longer
    // required since no code is deployed to the remote.
    'for c in node npm tmux; do',
    '  if command -v "$c" >/dev/null 2>&1; then echo "OK $c"; else echo "MISSING $c"; fi',
    'done',
  ].join('\n'), 30000)
  const lines = res.stdout.trim().split('\n').map(s => s.trim()).filter(Boolean)
  const missing = lines.filter(l => l.startsWith('MISSING')).map(l => l.replace(/^MISSING\s+/, ''))
  if (res.exitCode !== 0 && missing.length === 0) return { ok: false, detail: res.stderr.trim() }
  if (missing.length > 0) return { ok: false, detail: `远端缺少工具: ${missing.join(', ')}` }
  return { ok: true, detail: lines.join('\n') }
}

/** Discover the port the live `dsh-gui` tmux session is serving on. */
async function discoverSessionPort(ctx: Context, auth: Record<string, unknown>, fallback: number): Promise<number> {
  const res = await sshRun(ctx, auth, 'tmux list-panes -t dsh-gui -F \'#{pane_start_command}\' 2>/dev/null | head -1', 20000)
  const m = /--port(?:\s+|=)(\d+)/.exec(res.stdout)
  const port = m ? Number(m[1]) : fallback
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}

/** ACTIVE when the tmux session exists and its pane is not dead. */
async function sessionState(ctx: Context, auth: Record<string, unknown>): Promise<'MISSING' | 'STALE' | 'ALIVE'> {
  const res = await sshRun(ctx, auth, [
    'if tmux has-session -t dsh-gui 2>/dev/null; then',
    '  if tmux list-panes -t dsh-gui -F \'#{pane_dead}\' 2>/dev/null | grep -q 1; then echo STALE; else echo ALIVE; fi',
    'else echo MISSING; fi',
  ].join('\n'), 20000)
  const out = res.stdout.trim()
  if (res.exitCode !== 0) return 'MISSING'
  if (out.includes('ALIVE')) return 'ALIVE'
  if (out.includes('STALE')) return 'STALE'
  return 'MISSING'
}

export function apply(ctx: Context): void {
  // /remote-api can start processes, run remote bash with stored credentials,
  // and write files: never serve it over a non-loopback bind.
  if (ctx.webServer.host !== '127.0.0.1') {
    ctx.logger?.error('[dsh-remote] refusing to start: /remote-api is unauthenticated and must stay on the loopback bind (webServer.host is not 127.0.0.1)')
    return
  }
  const locals = new Map<number, LocalHandle>()
  const startedAt = Date.now()

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: '/remote-api',
    handler: (req: IncomingMessage, res: ServerResponse) => { void dispatch(ctx, req, res, locals) },
  })

  // Kill locally started backends and every SSH tunnel on teardown.
  ctx.effect(() => () => {
    disposeRoute()
    for (const handle of locals.values()) {
      try { stopLocal(handle) } catch { /* already gone */ }
    }
    locals.clear()
    for (const tunnel of tunnels.values()) {
      try { tunnel.proc.kill() } catch { /* already gone */ }
    }
    tunnels.clear()
  }, 'dsh-remote teardown')

  void log(ctx, `host up (${new Date(startedAt).toISOString()})`)
}

/** One JSON POST under /remote-api/<op>. */
async function dispatch(ctx: Context, req: IncomingMessage, res: ServerResponse, locals: Map<number, LocalHandle>): Promise<void> {
  if (!trusted(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'untrusted origin' }))
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const op = pathname.replace(/^\/remote-api\/?/, '')
  let args: Record<string, unknown> = {}
  try {
    args = await readJson(req)
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'invalid request' }))
    return
  }
  const respond = (payload: unknown): void => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }
  try {
    respond(await handleOp(ctx, op, args, locals))
  } catch (error) {
    respond({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** The credential file for one connection: .../gui/credentials/ZgblKylin+dsh-gui+<name>.bin */
function credFile(name: string): string {
  const env = discover()
  const base = env.home !== '' ? env.home : join(env.repoRoot, '.dsh')
  const safe = String(name).replace(/[^\w\-.]/g, '_')
  return join(base, 'gui', 'credentials', `ZgblKylin+dsh-gui+${safe}.bin`)
}

const WIN_ENCRYPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$raw=[Convert]::FromBase64String($env:RAW)',
  "$enc=[Security.Cryptography.ProtectedData]::Protect($raw,$null,'CurrentUser')",
  '[IO.File]::WriteAllBytes($env:OUT,$enc)',
].join('\n')
// Decryption emits base64 (not the console stream), so non-ASCII bytes round-trip
// through the parent without any OEM/UTF-8 console-encoding corruption.
const WIN_DECRYPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$b=[Convert]::FromBase64String($env:B64)',
  "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
  '[Console]::Write([Convert]::ToBase64String($p))',
].join('\n')

function powerShellEncoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Encrypt a payload to the file (win32: DPAPI; else gpg symmetric). */
function credSave(file: string, payload: unknown): { ok: boolean; error?: string } {
  const data = JSON.stringify(payload)
  mkdirSync(dirname(file), { recursive: true })
  if (process.platform === 'win32') {
    const encoded = powerShellEncoded(WIN_ENCRYPT)
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      env: { ...process.env, RAW: Buffer.from(data, 'utf8').toString('base64'), OUT: file },
    })
    return { ok: r.status === 0, error: r.status !== 0 ? r.stderr || undefined : undefined }
  }
  const r = runSync(['gpg', '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', GPG_PIN, '--cipher-algo', 'AES256', '--output', file, '--symmetric'], data, 20000)
  return { ok: r.exitCode === 0, error: r.exitCode !== 0 ? r.stderr : undefined }
}

/** Decrypt a payload file (win32: DPAPI; else gpg). Output travels as base64. */
function credRead(file: string): { exists: boolean; payload: unknown } {
  if (!existsSync(file)) return { exists: false, payload: null }
  if (process.platform === 'win32') {
    const encoded = powerShellEncoded(WIN_DECRYPT)
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      env: { ...process.env, B64: readFileSync(file).toString('base64') },
    })
    const b64 = (r.stdout ?? '').trim()
    if (b64 === '') return { exists: false, payload: null }
    let text = ''
    try { text = Buffer.from(b64, 'base64').toString('utf8') } catch { /* fall through */ }
    if (text === '') return { exists: false, payload: null }
    let payload: unknown = null
    try { payload = JSON.parse(text) } catch { payload = text }
    return { exists: true, payload }
  }
  const r = runSync(['gpg', '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', GPG_PIN, '--decrypt', file], undefined, 20000)
  const text = r.stdout.trim()
  if (text === '') return { exists: false, payload: null }
  let payload: unknown = null
  try { payload = JSON.parse(text) } catch { payload = text }
  return { exists: true, payload }
}

/** Stop one locally started backend (tree-scoped). */
function stopLocal(handle: LocalHandle): void {
  if (handle.proc.pid !== undefined) {
    if (process.platform === 'win32') {
      runSync(['taskkill', '/PID', String(handle.proc.pid), '/T', '/F'], undefined, 10000)
    } else {
      try { handle.proc.kill() } catch { /* already gone */ }
    }
  }
}

async function handleOp(ctx: Context, op: string, args: Record<string, unknown>, locals: Map<number, LocalHandle>): Promise<unknown> {
  const env = discover()
  switch (op) {
    case 'env':
      return { ...env, ssh: sshAvailability() }
    case 'probe':
      return probe(String(args.url ?? ''))
    case 'local.start': {
      const port = Number(args.port)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: 'invalid port' }
      if (locals.has(port)) return { ok: true, already: true, port }
      if (env.bin === '' || env.node === '') return { ok: false, error: 'no harness bin found' }
      const logFile = join(env.home !== '' ? env.home : join(env.repoRoot, '.dsh'), 'gui', `remote-${port}.log`)
      mkdirSync(dirname(logFile), { recursive: true })
      const out = openSync(logFile, 'a')
      const child = spawn(env.node, [env.bin, 'web', '--port', String(port)], {
        cwd: env.harnessDir !== '' ? env.harnessDir : env.repoRoot,
        env: { ...process.env, DSH_HOME: env.home !== '' ? env.home : join(env.repoRoot, '.dsh') },
        stdio: ['ignore', out, out],
        detached: process.platform !== 'win32',
      })
      locals.set(port, { pid: child.pid ?? -1, proc: child })
      void log(ctx, `local.start ${port} pid=${child.pid ?? -1}`)
      return { ok: true, port, pid: child.pid ?? -1 }
    }
    case 'local.stop': {
      const port = Number(args.port)
      const handle = locals.get(port)
      if (handle) {
        stopLocal(handle)
        locals.delete(port)
        return { ok: true, stopped: true }
      }
      return { ok: true, stopped: false }
    }
    case 'local.list':
      return { ports: Array.from(locals.keys()) }
    case 'creds.has': {
      const file = credFile(String(args.name ?? ''))
      return { exists: existsSync(file) }
    }
    case 'creds.read': {
      const file = credFile(String(args.name ?? ''))
      return credRead(file)
    }
    case 'creds.save': {
      const file = credFile(String(args.name ?? ''))
      return credSave(file, args.payload)
    }
    case 'creds.remove': {
      const file = credFile(String(args.name ?? ''))
      if (existsSync(file)) unlinkSync(file)
      return { ok: true }
    }
    case 'keyfile.write': {
      const base = env.home !== '' ? env.home : join(env.repoRoot, '.dsh')
      const name = String(args.name ?? 'key').replace(/[^\w\-.]/g, '_')
      const b64 = String(args.b64 ?? '')
      if (b64.length > MAX_KEY_B64) return { ok: false, error: `key too large (max ${MAX_KEY_B64} bytes base64)` }
      const dir = join(base, 'gui', 'keys')
      const file = join(dir, `${name}.pem`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, Buffer.from(b64, 'base64'), { mode: 0o600 })
      return { ok: true, path: file }
    }
    case 'auth.available':
      return sshAvailability()
    case 'tunnel.close': {
      const conn = (args.conn ?? {}) as Record<string, unknown>
      if (!conn.sshHost && !conn.address) return { ok: false, error: 'no host' }
      const remotePort = Number(conn.port)
      const host = String(conn.sshHost ?? conn.address)
      const key = `${host}:${remotePort}`
      return { ok: closeTunnel(key), key }
    }
    case 'ssh.connect': {
      remoteProgress.running = true
      remoteProgress.startedAt = Date.now()
      remoteProgress.steps = []
      try {
        const conn = (args.conn ?? {}) as Record<string, unknown>
        const logLines: Array<{ step: string; ok: boolean; detail?: string }> = []
        if (!conn.address || !conn.port) {
          return { ok: false, log: [{ step: 'connect', ok: false, detail: 'address and port required' }] }
        }
        // SSH target is its own field (an ssh-config alias like `ASUS` or an
        // explicit host), distinct from the DSH frontend address. When left
        // empty it falls back to the DSH address.
        const sshHost = String(conn.sshHost ?? conn.address)
        const auth = {
          user: conn.sshUser ? String(conn.sshUser) : '',
          host: sshHost,
          port: conn.sshPort ? Number(conn.sshPort) : undefined,
          password: conn.password ? String(conn.password) : undefined,
          keyFile: conn.keyFile ? String(conn.keyFile) : undefined,
        }
        const avail = sshAvailability()
        pushLog(logLines, '建立 ssh 会话', true, `${auth.user !== '' ? auth.user + '@' : ''}${auth.host}`)
        if (auth.password && !auth.keyFile && avail.plink === null && avail.sshpass === null) {
          return { ok: false, log: [...logLines, { step: '认证', ok: false, detail: '密码登录需要 plink 或 sshpass；请使用密钥文件' }] }
        }
        // No explicit credential: reuse ~/.ssh/config via the alias. If the
        // alias itself needs authentication, report authRequired so the client
        // falls back to asking for user/password/key.
        if (!auth.password && !auth.keyFile) {
          const probeRes = await probeSshAuth(ctx, auth)
          pushLog(
            logLines,
            'ssh config 认证检查',
            probeRes.ok,
            probeRes.ok ? '通过（复用 ~/.ssh/config' + (auth.host !== String(conn.address) ? ` 别名 ${auth.host}` : '') + '）' : '该主机需要认证，请填写用户名/密码或密钥',
          )
          if (!probeRes.ok) {
            return { ok: false, authRequired: true, log: logLines }
          }
        }
        return connectRemote(ctx, auth, avail, conn as { address: string; port: number; startCommand?: string }, logLines)
      } finally {
        remoteProgress.running = false
      }
    }
    case 'ssh.status':
      return {
        running: remoteProgress.running,
        startedAt: remoteProgress.startedAt,
        steps: remoteProgress.steps.map(step => ({ ...step })),
      }
    case 'diag': {
      const probeMe = await probe(`http://127.0.0.1:${ctx.webServer.port}/`)
      const livePorts = Array.from(locals.keys())
      const tunnelCount = tunnels.size
      return { env, probeMe, locals: livePorts, tunnels: tunnelCount }
    }
    default:
      return { ok: false, error: `unknown op: ${op}` }
  }
}

/**
 * Non-interactive SSH auth probe: with password/key empty, reuse the local
 * `~/.ssh/config` alias blindly (BatchMode). A non-zero exit means the alias
 * needs authentication the plugin did not supply -> authRequired.
 */
async function probeSshAuth(ctx: Context, auth: Record<string, unknown>): Promise<{ ok: boolean }> {
  const res = await sshRun(ctx, auth, 'echo DSH_REMOTE_AUTH_OK', 20000)
  return { ok: res.exitCode === 0 && res.stdout.includes('DSH_REMOTE_AUTH_OK') }
}

/** Shared ssh base flags for the non-interactive route. */
const SSH_BASE_FLAGS = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']

/**
 * Append the loopback bind + target port to a start command unless it already
 * specifies them, so the backend only ever listens on the remote loopback and
 * is reached exclusively through the SSH tunnel. (`--hostname` is a different
 * flag and must not trip the `--host` check.)
 */
function appendServeFlags(command: string, port: number): string {
  const hasFlag = (name: string) => new RegExp(`(?:^|\\s)${name}(?:=|\\s|$)`).test(command)
  const flags: string[] = []
  if (!hasFlag('--host')) flags.push('--host 127.0.0.1')
  if (!hasFlag('--port')) flags.push(`--port ${port}`)
  const base = command.trim()
  return flags.length > 0 ? `${base} ${flags.join(' ')}` : base
}

/**
 * Secure remote pipeline (no deployment — start + forward only):
 *   1. precheck the remote toolchain (node/npm/tmux),
 *   2. ensure the `dsh-gui` tmux session is ALIVE; start/restart it bound to
 *      127.0.0.1 when missing or stale, using the configured start command
 *      (default `npx '@deepseek-ai/dsh' web`,
 *      env override `DSH_REMOTE_START_COMMAND`),
 *   3. discover the port the session's backend is serving on,
 *   4. open an SSH local port forward and wait until the local loopback URL is
 *      loadable (2xx) — never a direct address probe.
 *
 * Nothing is deployed to the remote: the startup command owns how dsh is run
 * there (its DSH_HOME/plugins stay on the remote side), and the dsh-gui tmux
 * session only keeps that process alive so the tunnel has something to reach.
 */
async function connectRemote(
  ctx: Context,
  auth: Record<string, unknown>,
  avail: { ssh: string | null; plink: string | null; sshpass: string | null },
  conn: { address: string; port: number; startCommand?: string },
  log: Array<{ step: string; ok: boolean; detail?: string }>,
): Promise<{ ok: boolean; authRequired?: boolean; log: Array<{ step: string; ok: boolean; detail?: string }>; url?: string; tunnelKey?: string }> {
  const tmuxName = 'dsh-gui'
  const startCommand = String(conn.startCommand ?? '').trim() || defaultStartCommand()

  // 1. toolchain precheck
  const tools = await checkRemoteToolchain(ctx, auth)
  pushLog(log, '远端工具预检', tools.ok, tools.ok ? tools.detail : tools.detail)
  if (!tools.ok) return { ok: false, log }

  // 2. ensure the tmux session is ALIVE, starting it with the configured
  //    command when missing or stale. The backend binds loopback ONLY — the
  //    frontend is reached via the SSH tunnel. The pane's output is redirected
  //    to $HOME/.dsh-gui-remote.log so failures are diagnosable even after the
  //    session exits (capture-pane would be empty then).
  const state = await sessionState(ctx, auth)
  pushLog(log, `tmux 会话 ${tmuxName}`, state === 'ALIVE', `state=${state}`)
  if (state !== 'ALIVE') {
    if (state === 'STALE') {
      const killed = await sshRun(ctx, auth, `tmux kill-session -t ${tmuxName} 2>/dev/null || true`, 20000)
      pushLog(log, '清理失效会话', killed.exitCode === 0, (killed.stdout + killed.stderr).trim() || 'ok')
    }
    const inner = `cd "$HOME" && ${appendServeFlags(startCommand, conn.port)} > ${REMOTE_LOG} 2>&1`
    pushLog(log, '启动远端 dsh', false, inner)
    const start = await sshRun(ctx, auth, [
      'set -e',
      `tmux new-session -d -s ${tmuxName} ${JSON.stringify(inner)}`,
      'exit 0',
    ].join('\n'), 30000)
    // tmux new-session itself returns at once; the command inside the pane
    // runs detached (first npx fetch may take a while), so the port wait below
    // covers the actual boot.
    replaceLog(log, log.length - 1, 'tmux 启动 dsh', start.exitCode === 0, (start.stdout + start.stderr).trim().slice(0, 2000))
    if (start.exitCode !== 0) return { ok: false, log }
  }

  /** Tail the remote start log for diagnostics ($HOME/.dsh-gui-remote.log). */
  async function remoteTail(lines = 12, chars = 1500): Promise<string> {
    const r = await sshRun(ctx, auth, `tail -n ${lines} ${REMOTE_LOG} 2>/dev/null || true`, 15000)
    return (r.stdout + r.stderr).trim().split('\n').slice(-lines).join('\n').slice(0, chars)
  }

  // 3. discover serving port from the session and wait until it is open
  const remotePort = await discoverSessionPort(ctx, auth, conn.port)
  pushLog(log, `服务端口 ${remotePort}`, true, `会话内后端监听 127.0.0.1:${remotePort}`)
  const openDeadline = Date.now() + 300000
  const openedAt = Date.now()
  let open = await sshPortOpen(ctx, auth, remotePort)
  let waitIter = 0
  while (!open && Date.now() < openDeadline) {
    await new Promise(r => setTimeout(r, 2000))
    open = await sshPortOpen(ctx, auth, remotePort)
    waitIter++
    const waited = Math.round((Date.now() - openedAt) / 1000)
    if (waitIter % 3 === 1) {
      const tail = await remoteTail(6)
      progress('等待服务端口开放', undefined, `127.0.0.1:${remotePort}（已等待 ${waited}s）${tail !== '' ? `\n远端日志:\n${tail}` : ''}`)
    } else {
      progress('等待服务端口开放', undefined, `127.0.0.1:${remotePort}（已等待 ${waited}s）`)
    }
  }
  if (!open) {
    const tail = await remoteTail(60, 4000)
    pushLog(log, '服务端口未就绪', false, `127.0.0.1:${remotePort} 未在 300s 内开放${tail !== '' ? `\n远端日志 (${REMOTE_LOG}):\n${tail}` : ''}`)
    return { ok: false, log }
  }

  // 4. open the SSH local port forward and wait for the local URL to load
  const tunnel = await openTunnel(ctx, auth, avail, remotePort)
  if (!tunnel.ok || tunnel.localPort === undefined) {
    pushLog(log, 'ssh 端口转发', false, tunnel.error || '无法建立转发')
    return { ok: false, log }
  }
  const key = `${auth.host}:${remotePort}`
  const localUrl = `http://127.0.0.1:${tunnel.localPort}/`
  pushLog(log, 'ssh 端口转发', true, `127.0.0.1:${tunnel.localPort} -> ${auth.host}:${remotePort}`)

  const deadline = Date.now() + 150000
  let ready = false
  let status: number | undefined
  while (Date.now() < deadline) {
    const p = await probe(localUrl)
    status = p.status
    if (p.loadable) { ready = true; break }
    progress('等待前端就绪', undefined, `${localUrl}（已等待 ${Math.round(150000 - (deadline - Date.now())) / 1000}s）`)
    await new Promise(r => setTimeout(r, 2000))
  }
  if (!ready) {
    const tail = await remoteTail(40, 3000)
    pushLog(log, '前端就绪', false, `${localUrl} 超时${tail !== '' ? `\n远端日志 (${REMOTE_LOG}):\n${tail}` : ''}`)
    return { ok: false, log }
  }
  pushLog(log, `前端就绪 ${localUrl}`, true, `HTTP ${status}`)
  return { ok: ready, log, url: localUrl, tunnelKey: key }
}
