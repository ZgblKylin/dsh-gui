/**
 * dsh-remote host half: owns the durable machinery behind the connection tab
 * bar. It registers the `/remote-api/*` HTTP JSON routes on the harness web
 * server and behind them:
 *
 *  - `local.start` — spawn an additional self-hosted `dsh web` backend on a
 *    free port (checked by `probe` first; started only when the port is dead),
 *  - `ssh.connect` — the VSCode-Remote-style deployment pipeline: establish an
 *    SSH session (key or password), git-deploy the harness to `~/.dsh-gui` on
 *    the remote, build it, launch it inside a `dsh-gui` tmux session, then wait
 *    until the remote frontend answers HTTP,
 *  - `creds.*` / `keyfile.write` — the credential store (Windows DPAPI,
 *    Linux gpg; keys and filenames carry `ZgblKylin+dsh-gui+<连接名>`), plus the
 *    uploaded SSH private-key files.
 *
 * Connection records (name/address/port/ssh fields) are kept by the browser
 * half in localStorage — dsh-gui manages the connection config, the remote
 * owns its own DSH_HOME (~/.dsh-gui/.dsh) and plugin configuration.
 *
 * This half is a real Node ESM bundle: node: builtins are used directly.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { get as httpGet } from 'node:http'
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

/** App passphrase for the Linux gpg credential store (self-hosted key). */
const GPG_PIN = 'dsh-remote-app-pin'

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

/** Read the request body and JSON.parse it (empty body -> {}). */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { resolve(text === '' ? {} : JSON.parse(text)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/** Finite-timeout HTTP GET returning status or an error string. */
function probe(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = httpGet(url, { timeout: 4000 }, (res) => {
      resolve({ ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500 ? true : false, status: res.statusCode })
      res.resume()
    })
    req.on('error', (error: Error) => resolve({ ok: false, error: error.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
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
 * reused unchanged.
 */
function buildSshArgv(auth: Record<string, unknown>, avail: { ssh: string | null; plink: string | null; sshpass: string | null }): string[] | null {
  const user = String(auth.user ?? '')
  const userHost = (user !== '' ? `${user}@` : '') + String(auth.host)
  // Only force -p when an explicit, non-default SSH port was supplied; an
  // ssh-config alias must keep its own Port.
  const explicitPort = auth.port !== undefined && auth.port !== null && Number(auth.port) !== 22
  const port = String(auth.port ?? 22)
  if (auth.password && !auth.keyFile) {
    if (avail.sshpass !== null) {
      const argv = [avail.sshpass, '-p', String(auth.password), avail.ssh ?? 'ssh', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15']
      if (explicitPort) argv.push('-p', port)
      argv.push(userHost, 'bash -s')
      return argv
    }
    if (avail.plink !== null) {
      return [avail.plink, '-batch', '-pw', String(auth.password), '-P', port, userHost, 'bash -s']
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

export function apply(ctx: Context): void {
  const locals = new Map<number, LocalHandle>()
  const startedAt = Date.now()

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: '/remote-api',
    handler: (req: IncomingMessage, res: ServerResponse) => { void dispatch(ctx, req, res, locals) },
  })

  // Kill every locally started backend when this fiber tears down.
  ctx.effect(() => () => {
    disposeRoute()
    for (const handle of locals.values()) {
      try { stopLocal(handle) } catch { /* already gone */ }
    }
    locals.clear()
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
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
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
const WIN_DECRYPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$b=[Convert]::FromBase64String($env:B64)',
  "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
  '[Console]::Write([Text.Encoding]::UTF8.GetString($p))',
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

/** Decrypt a payload file (win32: DPAPI; else gpg). */
function credRead(file: string): { exists: boolean; payload: unknown } {
  if (!existsSync(file)) return { exists: false, payload: null }
  if (process.platform === 'win32') {
    const encoded = powerShellEncoded(WIN_DECRYPT)
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      env: { ...process.env, B64: readFileSync(file).toString('base64') },
    })
    const text = (r.stdout ?? '').trim()
    if (text === '') return { exists: false, payload: null }
    let payload: unknown = null
    try { payload = JSON.parse(text) } catch { /* legacy plain text */ }
    return { exists: true, payload }
  }
  const r = runSync(['gpg', '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', GPG_PIN, '--decrypt', file], undefined, 20000)
  const text = r.stdout.trim()
  if (text === '') return { exists: false, payload: null }
  let payload: unknown = null
  try { payload = JSON.parse(text) } catch { /* legacy plain text */ }
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
      const dir = join(base, 'gui', 'keys')
      const file = join(dir, `${name}.pem`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, Buffer.from(String(args.b64 ?? ''), 'base64'), { mode: 0o600 })
      return { ok: true, path: file }
    }
    case 'auth.available':
      return sshAvailability()
    case 'ssh.connect': {
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
      logLines.push({ step: '建立 ssh 会话', ok: true, detail: `${auth.user !== '' ? auth.user + '@' : ''}${auth.host}` })
      if (auth.password && !auth.keyFile && avail.plink === null && avail.sshpass === null) {
        return { ok: false, log: [...logLines, { step: '认证', ok: false, detail: '密码登录需要 plink 或 sshpass；请使用密钥文件' }] }
      }
      // No explicit credential: reuse ~/.ssh/config via the alias. If the
      // alias itself needs authentication, report authRequired so the client
      // falls back to asking for user/password/key.
      if (!auth.password && !auth.keyFile) {
        const probeRes = await probeSshAuth(ctx, auth)
        logLines.push({
          step: 'ssh config 认证检查',
          ok: probeRes.ok,
          detail: probeRes.ok ? '通过（复用 ~/.ssh/config' + (auth.host !== String(conn.address) ? ` 别名 ${auth.host}` : '') + '）' : '该主机需要认证，请填写用户名/密码或密钥',
        })
        if (!probeRes.ok) {
          return { ok: false, authRequired: true, log: logLines }
        }
      }
      return deployRemote(ctx, auth, conn as { address: string; port: number }, logLines)
    }
    case 'diag': {
      const probeMe = await probe('http://127.0.0.1:3080/')
      return { env, probeMe, locals: Array.from(locals.keys()) }
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

/** Common auth-failure markers in ssh stderr. */
const AUTH_MARKERS = ['Permission denied', 'publickey', 'password', 'No supported authentication methods', 'Authentication failed', 'password authentication']

/** VSCode-Remote-style pipeline: clone/deploy -> build -> tmux -> probe -> ready URL. */
async function deployRemote(
  ctx: Context,
  auth: Record<string, unknown>,
  conn: { address: string; port: number },
  log: Array<{ step: string; ok: boolean; detail?: string }>,
): Promise<{ ok: boolean; authRequired?: boolean; log: Array<{ step: string; ok: boolean; detail?: string }>; url?: string }> {
  const url = `http://${conn.address}:${conn.port}/`
  const tmuxName = 'dsh-gui'

  const have = await sshRun(ctx, auth, [
    'set -e',
    'if [ -d "$HOME/.dsh-gui/.git" ]; then echo DIR_OK; else echo DIR_MISSING; fi',
  ].join('\n'), 30000)
  const haveErr = (have.stdout + have.stderr)
  log.push({ step: '检查 ~/.dsh-gui', ok: have.exitCode === 0, detail: haveErr.trim() })
  if (have.exitCode !== 0) {
    // An auth requirement anywhere in the first hop means the credential set
    // is incomplete: fail the connection and fall back to the config form.
    const authRequired = AUTH_MARKERS.some(m => haveErr.toLowerCase().includes(m.toLowerCase()))
    return { ok: false, authRequired, log }
  }

  if (have.stdout.includes('DIR_MISSING')) {
    log.push({ step: 'git 部署到 ~/.dsh-gui', ok: false, detail: '开始克隆…' })
    const clone = await sshRun(ctx, auth, [
      'set -e',
      'git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git "$HOME/.dsh-gui" || { rm -rf "$HOME/.dsh-gui"; exit 10; }',
    ].join('\n'), 600000)
    log[log.length - 1] = { step: 'git clone', ok: clone.exitCode === 0, detail: (clone.stdout + clone.stderr).trim().slice(0, 2000) }
    if (clone.exitCode !== 0) return { ok: false, log }

    log.push({ step: '编译项目', ok: false, detail: 'pnpm install && pnpm run build（可能较长）' })
    const build = await sshRun(ctx, auth, [
      'set -e',
      'cd "$HOME/.dsh-gui"',
      'corepack enable 2>/dev/null || true',
      'pnpm install --frozen-lockfile || pnpm install',
      'pnpm run build',
    ].join('\n'), 1800000)
    log[log.length - 1] = { step: 'build', ok: build.exitCode === 0, detail: (build.stdout + build.stderr).trim().slice(0, 4000) }
    if (build.exitCode !== 0) return { ok: false, log }
  } else {
    log.push({ step: '~/.dsh-gui 已存在', ok: true, detail: '跳过部署' })
  }

  const tmux = await sshRun(ctx, auth, `if tmux has-session -t ${tmuxName} 2>/dev/null; then echo TMUX_YES; else echo TMUX_NO; fi`, 20000)
  log.push({ step: `tmux 会话 ${tmuxName}`, ok: tmux.exitCode === 0, detail: tmux.stdout.trim() })
  if (tmux.exitCode !== 0) return { ok: false, log }

  if (tmux.stdout.includes('TMUX_NO')) {
    log.push({ step: '启动后端 (tmux)', ok: false, detail: 'start' })
    const inner = `cd "$HOME/.dsh-gui" && DSH_HOME="$HOME/.dsh-gui/.dsh" node apps/cli/lib/bin.js web --port ${conn.port}`
    const start = await sshRun(ctx, auth, [
      'set -e',
      `tmux new-session -d -s ${tmuxName} ${JSON.stringify(inner)}`,
      'exit 0',
    ].join('\n'), 30000)
    log[log.length - 1] = { step: 'tmux new-session', ok: start.exitCode === 0, detail: (start.stdout + start.stderr).trim().slice(0, 2000) }
    if (start.exitCode !== 0) return { ok: false, log }
  }

  const deadline = Date.now() + 150000
  let ready = false
  let status: number | undefined
  while (Date.now() < deadline) {
    const p = await probe(url)
    status = p.status
    if (p.ok) { ready = true; break }
    await new Promise((r) => setTimeout(r, 2000))
  }
  log.push({ step: `后端就绪 ${url}`, ok: ready, detail: ready ? `HTTP ${status}` : '超时' })
  return { ok: ready, log, url }
}
