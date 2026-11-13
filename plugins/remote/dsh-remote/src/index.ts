/**
 * dsh-remote host half: the local-backend and Docker machinery behind the
 * connection tab bar. It registers the `/remote-api/*` HTTP JSON routes on the
 * harness web server, behind which:
 *
 *  - `local.start` — spawn an additional self-hosted `dsh web` backend on a
 *    free port (checked by `probe` first; started only when the port is dead),
 *  - `docker.connect` — Docker backend mode: starts (or reuses) dsh inside a
 *    running container with `docker exec -d`, then bridges the container's
 *    loopback port to a local 127.0.0.1 port via a `docker exec -i` stdio
 *    tunnel — no host port mapping is required.
 *
 * SSH remote connections live in the `dsh-desktop-tabs` plugin's host half
 * (`/desktop-tabs/api/*`), shared by the Tauri shell and the desktop app; this
 * plugin deliberately owns no SSH transport, credentials or key files.
 *
 * The shell's UI keeps connection records in localStorage — dsh-gui manages
 * the connection config; the backend owns its own DSH_HOME (default `~/.dsh`,
 * or whatever the configured startup command sets) and plugin configuration.
 *
 * Security posture: `/remote-api` is an unauthenticated local RPC, so this
 * half refuses to serve when the web server is bound to anything but the
 * loopback address (see `apply`).
 *
 * This half is a real Node ESM bundle: node: builtins are used directly.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Server as NetServer } from 'node:net'
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

/** JSON request body cap (bytes), guarding memory. */
const MAX_JSON_BODY = 1 * 1024 * 1024

/** Default command used to start DSH inside a Docker container; override via env. */
export const defaultDockerStartCommand = (): string =>
  process.env.DSH_DOCKER_START_COMMAND || `npx -y '@deepseek-ai/dsh' web`

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

/**
 * Locate the self-hosted harness checkout from `DSH_GUI_ROOT`, then by walking
 * up from cwd and from `DSH_HOME`. The desktop shell exports `DSH_GUI_ROOT`
 * because the checkout lives below the runtime root in the nested layout, where
 * neither the harness working directory nor `DSH_HOME` sits inside the checkout.
 */
function discover(): Discovery {
  const home = process.env.DSH_HOME || ''
  const explicit = process.env.DSH_GUI_ROOT || ''
  const cwd = process.cwd()
  let root = explicit !== '' && existsSync(join(explicit, 'harness.json')) ? explicit : ''
  let p = cwd
  if (root === '') {
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(p, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'))) { root = p; break }
      const q = dirname(p)
      if (q === p) break
      p = q
    }
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
 * Resolve a usable executable for a tool name, preferring a real non-zero
 * binary over empty PATH shims.
 * @returns an absolute executable path, or the bare name when nothing usable resolves.
 */
function resolveTool(tool: string): string {
  const candidates: string[] = []
  if (process.platform === 'win32') {
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

/** Shared log line -> plugin console. */
function log(ctx: Context, message: string): void {
  ctx.logger?.info(`[dsh-remote] ${message}`)
}

/** Live progress of the in-flight docker connect; polled by the shell via `docker.status`. */
const remoteProgress: {
  running: boolean
  startedAt: number
  steps: Array<{ step: string; ok?: boolean; detail?: string }>
} = {
  running: false,
  startedAt: 0,
  steps: [],
}

/** Cancellation handle for the single in-flight `docker.connect` (one at a time).
 *
 *  `docker.cancel` sets `cancelled`; a newer `docker.connect` bumps `token`, which
 *  also invalidates any older in-flight attempt. Checked at each await point. */
const remoteConnectControl: { token: number; cancelled: boolean } = { token: 0, cancelled: false }

/** True when the in-flight connect was cancelled or superseded by a newer one. */
function connectCancelled(token: number): boolean {
  return token !== remoteConnectControl.token || remoteConnectControl.cancelled
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
  if (index < remoteProgress.steps.length) {
    remoteProgress.steps[index] = { step, ok, detail }
    return
  }
  progress(step, ok, detail)
}

/** Find a free loopback port for the local side of a Docker exec tunnel. */
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

/* ── Docker backend (no published ports needed) ────────────────────────
 *
 * The target container's DSH backend is reached through a `docker exec`
 * bidirectional stdio tunnel: the host half listens on a loopback-only local
 * port and answers every inbound TCP connection with a fresh
 * `docker exec -i <container> node -e '<stdio↔TCP bridge>'`. That bridges the
 * connection to the container's 127.0.0.1:<port>, so the container needs no
 * `-p` / port mapping (and no socat / nc / ssh server). Node is guaranteed to
 * exist: it is the runtime DSH itself runs on.
 */

/** Container-side log/pid file paths (under /tmp so any `-u` user can write them; port-suffixed so several backends can coexist in one container). */
const dockerLogPath = (port: number): string => `/tmp/dsh-gui-docker-${port}.log`
const dockerPidPath = (port: number): string => `/tmp/dsh-gui-docker-${port}.pid`

/** A live Docker exec tunnel: local 127.0.0.1:<localPort> -> container 127.0.0.1:<remotePort>. */
interface DockerTunnel {
  key: string
  container: string
  localPort: number
  remotePort: number
  server: NetServer
  children: Set<ChildProcess>
}

/** All live Docker tunnels, keyed `${container}:${remotePort}`; killed on teardown. */
const dockerTunnels = new Map<string, DockerTunnel>()

/** Docker CLI + daemon availability. `error` carries the daemon failure when the CLI exists. */
function dockerAvailability(): { docker: string | null; server?: string; error?: string } {
  const docker = resolveTool('docker')
  if (docker === 'docker') return { docker: null, error: 'docker CLI 未找到' }
  const r = runSync([docker, 'version', '--format', '{{.Server.Version}}'], undefined, 12000)
  if (r.exitCode !== 0) {
    return { docker, error: (r.stderr || r.stdout).trim().slice(0, 500) || 'docker daemon 不可用' }
  }
  return { docker, server: r.stdout.trim() }
}

/** Options carried into `docker exec` (user / extra env) for the Docker backend. */
interface DockerExecOpts {
  user?: string
  env?: string[]
}

/** Run a short-lived command inside a running container via `docker exec -i`. */
function dockerExecSync(container: string, args: string[], opts: DockerExecOpts = {}, input?: string, timeoutMs = 20000): { exitCode: number; stdout: string; stderr: string } {
  const argv = ['docker', 'exec', '-i']
  if (opts.user !== undefined && opts.user !== '') argv.push('-u', opts.user)
  for (const entry of opts.env ?? []) argv.push('-e', entry)
  argv.push(container, ...args)
  return runSync(argv, input, timeoutMs)
}

/** Find a running container by exact name or by id prefix. */
function findDockerContainer(query: string): { name: string; id: string } | null {
  const q = String(query ?? '').trim()
  if (q === '') return null
  const r = runSync(['docker', 'ps', '--format', '{{.Names}}\t{{.ID}}'], undefined, 15000)
  if (r.exitCode !== 0) return null
  for (const line of r.stdout.split(/\r?\n/)) {
    const [name, id] = line.trim().split('\t')
    if (name === undefined || id === undefined || name === '' || id === '') continue
    if (name === q || id.startsWith(q) || q.startsWith(id)) return { name, id }
  }
  return null
}

/** List running containers (name / id / image) for the dialog / diagnostics. */
function listDockerContainers(): Array<{ name: string; id: string; image: string }> {
  const r = runSync(['docker', 'ps', '--format', '{{.Names}}\t{{.ID}}\t{{.Image}}'], undefined, 15000)
  if (r.exitCode !== 0) return []
  const out: Array<{ name: string; id: string; image: string }> = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const [name, id, image] = line.trim().split('\t')
    if (name !== undefined && id !== undefined && name !== '' && id !== '') out.push({ name, id, image: image ?? '' })
  }
  return out
}

/** Normalize the UI's configurable env list into `docker exec -e` entries: `KEY=VALUE` strings or `{key,value}` pairs. */
function normalizeDockerEnv(env: unknown): string[] {
  if (!Array.isArray(env)) return []
  const out: string[] = []
  for (const item of env) {
    if (typeof item === 'string') {
      const s = item.trim()
      if (s !== '' && s.includes('=')) out.push(s)
      continue
    }
    if (item !== null && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const key = String(rec.key ?? '').trim()
      if (key === '' || key.includes('=')) continue
      out.push(`${key}=${String(rec.value ?? '')}`)
    }
  }
  return out
}

/** True when the container-side DSH process started by this plugin is alive. */
function dockerProcessAlive(container: string, port: number, user?: string): boolean {
  const pid = dockerPidPath(port)
  const r = dockerExecSync(
    container,
    ['sh', '-c', `test -f "${pid}" && kill -0 $(cat "${pid}" 2>/dev/null) 2>/dev/null && echo ALIVE || echo NO`],
    { user },
    undefined,
    10000,
  )
  return r.exitCode === 0 && r.stdout.includes('ALIVE')
}

/** Start options: `workdir` runs the command from this container path (`$HOME` when empty). */
interface DockerStartOpts extends DockerExecOpts {
  workdir?: string
}

/**
 * Start DSH inside the container detached (`docker exec -d`). The inner shell
 * writes its own PID to the pid file and `exec`s the start command, so the PID
 * file names the actual long-lived DSH process (safe to kill for cleanup).
 * Output goes to the port-suffixed log for post-mortem diagnostics. `-u`
 * switches the container user and every `env` entry becomes `docker exec -e
 * KEY=VALUE` (so values need no shell escaping; `$HOME` etc. in values stay
 * literal unless the user writes a shell command).
 */
function dockerStart(container: string, startCommand: string, port: number, opts: DockerStartOpts = {}): { exitCode: number; stdout: string; stderr: string } {
  const serveFlags = appendServeFlags(startCommand, port)
  // In a headless container there is no browser; dsh web tries to open one and
  // can hang before serving. Pass --no-open unless the command already does.
  const flags = /--no-open(?:\s|=|$)/.test(serveFlags) ? serveFlags : `${serveFlags} --no-open`
  // Workdir: user path wins; otherwise fall back to the container HOME (or / if
  // HOME is unset, e.g. a custom `-u` user without a home). `cd` (not `-w`) is
  // used so a bad path lands in the tail log instead of a bare exec error.
  const workdir = opts.workdir === undefined ? '' : String(opts.workdir).trim()
  const cd = workdir !== '' ? `cd ${JSON.stringify(workdir)} && ` : `cd "\${HOME:-/}" && `
  const log = dockerLogPath(port)
  const pid = dockerPidPath(port)
  const inner = `${cd}echo $$ > "${pid}" && { node -v; exec sh -c ${JSON.stringify(flags)}; } > "${log}" 2>&1`
  const argv = ['docker', 'exec', '-d']
  if (opts.user !== undefined && opts.user !== '') argv.push('-u', opts.user)
  for (const entry of opts.env ?? []) argv.push('-e', entry)
  argv.push(container, 'sh', '-c', inner)
  return runSync(argv, undefined, 30000)
}

/** Best-effort stop of a plugin-started container-side DSH process (children first). */
function dockerStop(container: string, port: number, user?: string): boolean {
  const pid = dockerPidPath(port)
  const r = dockerExecSync(
    container,
    ['sh', '-c', `pid=$(cat "${pid}" 2>/dev/null); [ -n "$pid" ] && { pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; }; true`],
    { user },
    undefined,
    10000,
  )
  return r.exitCode === 0
}

/** TCP-open probe on the container's 127.0.0.1:<port> (Node is guaranteed by DSH itself). */
function dockerPortOpen(container: string, port: number, user?: string): boolean {
  const script = `const n=require('net');const s=n.connect(${port},'127.0.0.1',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000)`
  const r = dockerExecSync(container, ['node', '-e', script], { user }, undefined, 5000)
  return r.exitCode === 0
}

/** Tail the container-side start log for diagnostics. */
async function dockerLogTail(container: string, port: number, user: string | undefined, lines = 12, chars = 1500): Promise<string> {
  const log = dockerLogPath(port)
  const r = dockerExecSync(container, ['sh', '-c', `tail -n ${lines} "${log}" 2>/dev/null || true`], { user }, undefined, 15000)
  return (r.stdout + r.stderr).trim().split('\n').slice(-lines).join('\n').slice(0, chars)
}

/** Harvest the one-time launch token from the container-side log. */
async function dockerLaunchToken(container: string, port: number, user?: string): Promise<string | null> {
  const log = dockerLogPath(port)
  const r = dockerExecSync(
    container,
    ['sh', '-c', `tail -n 200 "${log}" 2>/dev/null | grep -a 'dsh web:' | tail -1 | grep -ao 'token=[^ )&]*' | tail -1`],
    { user },
    undefined,
    15000,
  )
  const m = /^token=([^\s]+)/.exec((r.stdout ?? '').trim())
  return m !== null && m[1] !== '' ? m[1] : null
}

/**
 * Open a Docker exec tunnel. Every inbound TCP connection spawns a fresh
 * `docker exec -i <container> node -e '<stdio↔TCP bridge>'` so the local
 * loopback port acts exactly like a port forward into the container's own
 * loopback. Reuses a live tunnel for the same container:remotePort.
 */
async function openDockerTunnel(ctx: Context, container: string, remotePort: number, user?: string): Promise<{ ok: boolean; localPort?: number; error?: string }> {
  const key = `${container}:${remotePort}`
  const existing = dockerTunnels.get(key)
  if (existing !== undefined && existing.server.listening) {
    void log(ctx, `reuse docker tunnel ${key} (local ${existing.localPort})`)
    return { ok: true, localPort: existing.localPort }
  }
  if (existing !== undefined) closeDockerTunnel(key)

  const localPort = await freeLocalPort()
  const script = [
    `const n=require('net');`,
    `const s=n.connect(${remotePort},'127.0.0.1');`,
    `process.stdin.pipe(s);`,
    `s.pipe(process.stdout);`,
    `s.on('error',()=>process.exit(1));`,
    `process.stdin.on('end',()=>s.end());`,
    `s.on('close',()=>process.exit(0));`,
  ].join('')
  const children = new Set<ChildProcess>()
  const server = createServer((socket) => {
    const execArgs = ['exec', '-i']
    if (user !== undefined && user !== '') execArgs.push('-u', user)
    execArgs.push(container, 'node', '-e', script)
    const child = spawn('docker', execArgs, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    children.add(child)
    child.once('exit', () => {
      children.delete(child)
      try { socket.destroy() } catch { /* already gone */ }
    })
    socket.on('error', () => { try { socket.destroy() } catch { /* already gone */ } })
    socket.on('close', () => {
      try { child.stdin?.end() } catch { /* already gone */ }
      try { child.kill() } catch { /* already gone */ }
    })
    if (child.stdout !== null) {
      child.stdout.on('error', () => { try { socket.destroy() } catch { /* already gone */ } })
      child.stdout.pipe(socket)
    }
    if (child.stdin !== null) {
      child.stdin.on('error', () => { try { socket.destroy() } catch { /* already gone */ } })
      socket.pipe(child.stdin)
    }
  })

  let listenError: string | null = null
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(localPort, '127.0.0.1', () => resolve())
  }).catch((error: unknown) => {
    listenError = error instanceof Error ? error.message : String(error)
    try { server.close() } catch { /* not listening */ }
  })
  if (listenError !== null) return { ok: false, error: listenError }

  dockerTunnels.set(key, { key, container, localPort, remotePort, server, children })
  void log(ctx, `docker tunnel open ${key} -> 127.0.0.1:${localPort}`)
  return { ok: true, localPort }
}

/** Close a live Docker tunnel by container:remotePort. */
function closeDockerTunnel(key: string): boolean {
  const tunnel = dockerTunnels.get(key)
  if (tunnel === undefined) return false
  try { tunnel.server.close() } catch { /* not listening */ }
  for (const child of [...tunnel.children]) {
    try { child.kill() } catch { /* already gone */ }
  }
  tunnel.children.clear()
  dockerTunnels.delete(key)
  return true
}

export function apply(ctx: Context): void {
  // /remote-api can start local backends and run container commands: never
  // serve it over a non-loopback bind.
  if (ctx.webServer.host !== '127.0.0.1') {
    ctx.logger?.error('[dsh-remote] refusing to start: /remote-api is unauthenticated and must stay on the loopback bind (webServer.host is not 127.0.0.1)')
    return
  }
  const locals = new Map<number, LocalHandle>()
  const startedAt = Date.now()

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: '/remote-api',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      // A rejection escaping dispatch (e.g. `res.end` racing an aborted client)
      // would surface as an unhandled rejection and terminate the whole host —
      // the local dsh process every /remote-api op depends on. dispatch already
      // reports every real op failure in-band; only swallow the terminal case.
      dispatch(ctx, req, res, locals).catch(() => { try { res.end() } catch { /* already closed */ } })
    },
  })

  // Kill locally started backends and every Docker tunnel on teardown.
  ctx.effect(() => () => {
    disposeRoute()
    for (const handle of locals.values()) {
      try { stopLocal(handle) } catch { /* already gone */ }
    }
    locals.clear()
    for (const key of [...dockerTunnels.keys()]) closeDockerTunnel(key)
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
      return { ...env, docker: dockerAvailability() }
    case 'probe':
      return probe(String(args.url ?? ''))
    case 'local.start': {
      const port = Number(args.port)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: 'invalid port' }
      if (locals.has(port)) return { ok: true, already: true, port }
      if (env.bin === '' || env.node === '') return { ok: false, error: 'no harness bin found' }
      const home = env.home !== '' ? env.home : join(env.repoRoot, '.dsh')
      const logFile = join(home, 'gui', `remote-${port}.log`)
      mkdirSync(dirname(logFile), { recursive: true })
      const out = openSync(logFile, 'a')
      const child = spawn(env.node, [env.bin, 'web', '--port', String(port), '--no-open'], {
        cwd: env.harnessDir !== '' ? env.harnessDir : env.repoRoot,
        // Second instance of the same installation: only DSH_HOME is pinned, so
        // the shared agents root keeps its default while the global agent
        // template (AGENTS.md + docs/ + skills/) is read from the harness home
        // exactly like the primary backend.
        env: { ...process.env, DSH_HOME: home },
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
    case 'docker.available':
      return dockerAvailability()
    case 'docker.list':
      return { containers: listDockerContainers() }
    case 'docker.connect': {
      remoteProgress.running = true
      remoteProgress.startedAt = Date.now()
      remoteProgress.steps = []
      // Bump the token so this attempt owns the (single) in-flight pipeline, and
      // clear any earlier cancel request.
      remoteConnectControl.token += 1
      const connectToken = remoteConnectControl.token
      remoteConnectControl.cancelled = false
      try {
        const conn = (args.conn ?? {}) as Record<string, unknown>
        const logLines: Array<{ step: string; ok: boolean; detail?: string }> = []
        if (!conn.container || !conn.port) {
          return { ok: false, log: [{ step: 'connect', ok: false, detail: 'container and port required' }] }
        }
        return connectDocker(
          ctx,
          {
            container: String(conn.container),
            port: Number(conn.port),
            startCommand: conn.startCommand ? String(conn.startCommand) : undefined,
            workdir: conn.workdir ? String(conn.workdir) : undefined,
            user: conn.user ? String(conn.user) : undefined,
            env: conn.env,
          },
          logLines,
          connectToken,
        )
      } finally {
        remoteProgress.running = false
      }
    }
    case 'docker.cancel':
      remoteConnectControl.cancelled = true
      return { ok: true }
    case 'docker.status':
      return {
        running: remoteProgress.running,
        startedAt: remoteProgress.startedAt,
        steps: remoteProgress.steps.map(step => ({ ...step })),
      }
    case 'diag': {
      const probeMe = await probe(`http://127.0.0.1:${ctx.webServer.port}/`)
      const livePorts = Array.from(locals.keys())
      return { env, probeMe, locals: livePorts, dockerTunnels: dockerTunnels.size }
    }
    default:
      return { ok: false, error: `unknown op: ${op}` }
  }
}

/**
 * Append the loopback bind + target port to a start command unless it already
 * specifies them, so the backend only ever listens on the container loopback
 * and is reached exclusively through the Docker exec tunnel. (`--hostname` is a
 * different flag and must not trip the `--host` check.)
 */
function appendServeFlags(command: string, port: number): string {
  const hasFlag = (name: string) => new RegExp(`(?:^|\\s)${name}(?:=|\\s|$)`).test(command)
  const flags: string[] = []
  if (!hasFlag('--host')) flags.push('--host 127.0.0.1')
  if (!hasFlag('--port')) flags.push(`--port ${port}`)
  const base = command.trim()
  if (flags.length === 0) return base
  // `npm|pnpm|bun run <script>` only forwards further argv after a `--`
  // separator; without it npm yells `Unknown cli flags: --host/--port`.
  const pmRun = /^(?:npm|pnpm|bun)\s+(?:(?:-C|--dir)\s+\S+\s+)*run\s+\S/.test(base)
  const sep = pmRun && !/\s--\s*$/.test(base) ? ' -- ' : ' '
  return `${base}${sep}${flags.join(' ')}`
}

/**
 * Wait until a tunneled loopback URL is frontend-ready. A legacy profile
 * serves 2xx on the bare URL, while dsh v0.1.2-alpha.1+ gates behind a
 * one-time launch token (bare URL = 401, tokenized first visit = 303 +
 * Set-Cookie). Both are accepted; the token is re-harvested every round when
 * the first probe stays 401. Returns the exact URL to load (with token when
 * present) and the observed HTTP status.
 */
async function waitFrontendReady(
  ctx: Context,
  baseLocalUrl: string,
  harvestToken: () => Promise<string | null>,
  tail: (lines?: number, chars?: number) => Promise<string>,
  log: Array<{ step: string; ok: boolean; detail?: string }>,
  token: number,
  logLabel: string,
): Promise<{ ok: boolean; cancelled?: boolean; url: string; status?: number }> {
  let launchToken = await harvestToken()
  if (connectCancelled(token)) return { ok: false, cancelled: true, url: baseLocalUrl }
  let reportUrl = launchToken !== null ? `${baseLocalUrl}?token=${encodeURIComponent(launchToken)}` : baseLocalUrl
  const deadline = Date.now() + 150000
  const startedAt = Date.now()
  let ready = false
  let status: number | undefined
  let waitIter = 0
  while (Date.now() < deadline) {
    // Legacy profile: bare URL answers 2xx directly.
    const bare = await probe(baseLocalUrl)
    if (bare.loadable) {
      status = bare.status
      reportUrl = baseLocalUrl
      ready = true
      break
    }
    // Token-gated profile: harvest (re-)the launch token and probe the
    // authenticated URL; a 303 (token accepted, cookie mint pending) or a
    // 2xx counts as ready. A persistent 401 means the harvested token is
    // stale — the loop re-harvests next round.
    launchToken = await harvestToken()
    if (launchToken !== null) reportUrl = `${baseLocalUrl}?token=${encodeURIComponent(launchToken)}`
    const authed = await probe(reportUrl)
    status = authed.status
    if (authed.reachable && (authed.loadable || authed.status === 303)) {
      ready = true
      break
    }
    waitIter++
    const waited = Math.round((Date.now() - startedAt) / 1000)
    if (waitIter % 3 === 1) {
      const tailText = await tail(6, 1500)
      progress('等待前端就绪', undefined, `${reportUrl}（已等待 ${waited}s）${tailText !== '' ? `\n${logLabel}:\n${tailText}` : ''}`)
    } else {
      progress('等待前端就绪', undefined, `${reportUrl}（已等待 ${waited}s）`)
    }
    await new Promise(r => setTimeout(r, 2000))
    if (connectCancelled(token)) return { ok: false, cancelled: true, url: reportUrl }
  }
  return { ok: ready, url: reportUrl, status }
}

/**
 * Docker backend pipeline (no container port mapping required):
 *   1. precheck the docker CLI + daemon,
 *   2. locate the running container (name or id prefix),
 *   3. start (or reuse) DSH inside the container via `docker exec -d`, bound to
 *      the container's 127.0.0.1 only,
 *   4. open a Docker exec stdio tunnel (`docker exec -i ... node -e` bridge)
 *      from a free local loopback port into the container loopback,
 *   5. wait for the tunneled port and the frontend (bare 2xx or token 303/2xx).
 *
 * The container is never modified: no `-p`, no restart, no extra binaries
 * (node is DSH's own runtime). Teardown only kills a DSH process started by
 * THIS attempt (via the container-side pid file) and closes this tunnel.
 */
async function connectDocker(
  ctx: Context,
  conn: { container: string; port: number; startCommand?: string; workdir?: string; user?: string; env?: unknown },
  log: Array<{ step: string; ok: boolean; detail?: string }>,
  token: number,
): Promise<{ ok: boolean; cancelled?: boolean; log: Array<{ step: string; ok: boolean; detail?: string }>; url?: string; tunnelKey?: string }> {
  const container = String(conn.container ?? '').trim()
  const startCommand = String(conn.startCommand ?? '').trim() || defaultDockerStartCommand()
  const user = String(conn.user ?? '').trim() || undefined
  const workdir = String(conn.workdir ?? '').trim() || undefined
  const env = normalizeDockerEnv(conn.env)
  let startedHere = false
  let tunnelKey: string | undefined

  /** Best-effort teardown of resources THIS attempt created. */
  async function teardown(): Promise<void> {
    if (startedHere) dockerStop(container, conn.port, user)
    if (tunnelKey !== undefined) closeDockerTunnel(tunnelKey)
  }

  /** Abort point: the shell cancelled (or a newer connect superseded us). */
  async function bailCancelled(): Promise<{ ok: false; cancelled: true; log: Array<{ step: string; ok: boolean; detail?: string }> }> {
    pushLog(log, '已取消', false, '连接被用户取消')
    await teardown()
    return { ok: false, cancelled: true, log }
  }

  // 1. docker CLI + daemon
  const avail = dockerAvailability()
  pushLog(log, 'docker 可用性', avail.docker !== null, avail.docker !== null ? (avail.server ?? '客户端已就绪') : (avail.error ?? 'docker 不可用'))
  if (connectCancelled(token)) return bailCancelled()
  if (avail.docker === null) return { ok: false, log }
  if (avail.error !== undefined) {
    pushLog(log, 'docker daemon', false, avail.error)
    return { ok: false, log }
  }

  // 2. locate the running container
  const found = findDockerContainer(container)
  pushLog(log, `容器 ${container}`, found !== null, found !== null ? `运行中 (${found.name})` : '未找到运行中的容器')
  if (connectCancelled(token)) return bailCancelled()
  if (found === null) return { ok: false, log }
  const ctr = found.name

  // 3. start or reuse container-side DSH (with the configured user/workdir/env)
  const configDetail = [`工作目录: ${workdir ?? '$HOME'}`]
  if (user !== undefined) configDetail.push(`用户: ${user}`)
  if (env.length > 0) configDetail.push(`环境变量: ${env.length} 项`)
  pushLog(log, '容器启动配置', true, configDetail.join('；'))
  const alive = dockerProcessAlive(ctr, conn.port, user)
  if (alive) {
    pushLog(log, '容器内 dsh', true, '进程存活，复用')
  } else {
    pushLog(log, '启动容器内 dsh', false, startCommand)
    const start = dockerStart(ctr, startCommand, conn.port, { workdir, user, env })
    replaceLog(log, log.length - 1, 'docker exec 启动 dsh', start.exitCode === 0, (start.stdout + start.stderr).trim().slice(0, 2000))
    if (connectCancelled(token)) return bailCancelled()
    if (start.exitCode !== 0) return { ok: false, log }
    startedHere = true
    // Fail fast: a bad npm script / missing binary kills the container-side
    // process within a second; surface the tail log instead of waiting out the
    // full 300s port deadline. A slow first-run (npx download) stays alive, so
    // this only catches real startup deaths.
    await new Promise(r => setTimeout(r, 5000))
    if (connectCancelled(token)) return bailCancelled()
    if (!dockerProcessAlive(ctr, conn.port, user)) {
      const tail = await dockerLogTail(ctr, conn.port, user, 30, 3000)
      pushLog(log, '启动失败（进程已退出）', false, tail !== '' ? tail : '容器内 dsh 进程未存活')
      await teardown()
      return { ok: false, log }
    }
  }

  // 4. Docker exec stdio tunnel
  const tunnel = await openDockerTunnel(ctx, ctr, conn.port, user)
  if (connectCancelled(token)) return bailCancelled()
  if (!tunnel.ok || tunnel.localPort === undefined) {
    pushLog(log, 'docker exec 隧道', false, tunnel.error || '无法建立隧道')
    await teardown()
    return { ok: false, log }
  }
  tunnelKey = `${ctr}:${conn.port}`
  const baseLocalUrl = `http://127.0.0.1:${tunnel.localPort}/`
  pushLog(log, 'docker exec 隧道', true, `127.0.0.1:${tunnel.localPort} -> ${ctr}:${conn.port}`)

  // 5a. wait until the container loopback port is open (first npx fetch can be slow)
  const openDeadline = Date.now() + 300000
  const openedAt = Date.now()
  let open = false
  let waitIter = 0
  while (!open && Date.now() < openDeadline) {
    await new Promise(r => setTimeout(r, 2000))
    if (connectCancelled(token)) return bailCancelled()
    open = dockerPortOpen(ctr, conn.port, user)
    waitIter++
    const waited = Math.round((Date.now() - openedAt) / 1000)
    if (waitIter % 3 === 1) {
      const tail = await dockerLogTail(ctr, conn.port, user, 6)
      progress('等待服务端口开放', undefined, `127.0.0.1:${conn.port}（已等待 ${waited}s）${tail !== '' ? `\n容器日志:\n${tail}` : ''}`)
    } else {
      progress('等待服务端口开放', undefined, `127.0.0.1:${conn.port}（已等待 ${waited}s）`)
    }
  }
  if (!open) {
    const tail = await dockerLogTail(ctr, conn.port, user, 60, 4000)
    pushLog(log, '服务端口未就绪', false, `127.0.0.1:${conn.port} 未在 300s 内开放${tail !== '' ? `\n容器日志:\n${tail}` : ''}`)
    await teardown()
    return { ok: false, log }
  }

  // 5b. wait until the tunneled local URL is frontend-ready
  const ready = await waitFrontendReady(
    ctx,
    baseLocalUrl,
    () => dockerLaunchToken(ctr, conn.port, user),
    (lines?: number, chars?: number) => dockerLogTail(ctr, conn.port, user, lines ?? 12, chars ?? 1500),
    log,
    token,
    '容器日志',
  )
  if (ready.cancelled) return bailCancelled()
  if (!ready.ok) {
    const tail = await dockerLogTail(ctr, conn.port, user, 40, 3000)
    pushLog(log, '前端就绪', false, `${ready.url} 超时${tail !== '' ? `\n容器日志 (${dockerLogPath(conn.port)}):\n${tail}` : ''}`)
    await teardown()
    return { ok: false, log }
  }
  pushLog(log, `前端就绪 ${ready.url}`, true, `HTTP ${ready.status}`)
  return { ok: true, log, url: ready.url, tunnelKey }
}
