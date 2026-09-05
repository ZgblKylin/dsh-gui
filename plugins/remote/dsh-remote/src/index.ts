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
 *    reached over an SSH local port forward (pure-JS `ssh2`, no native ssh
 *    binary): the pipeline establishes the session, checks the remote
 *    toolchain, starts/restarts the tmux session, discovers the session's
 *    serving port, forwards it to a free local loopback port, and only then
 *    reports the local URL as loadable,
 *  - `docker.connect` — Docker backend mode: starts (or reuses) dsh inside a
 *    running container with `docker exec -d`, then bridges the container's
 *    loopback port to a local 127.0.0.1 port via a `docker exec -i` stdio
 *    tunnel — no host port mapping is required,
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
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import { homedir, userInfo } from 'node:os'
import type { AddressInfo } from 'node:net'
import type { Server as NetServer } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import SSHConfig, { glob as sshGlob } from 'ssh-config'
import * as ssh2ns from 'ssh2'
import type { Client as SshClient, ConnectConfig } from 'ssh2'

/**
 * ssh2 is a CommonJS module and its named exports are detected by Node's
 * cjs-module-lexer inconsistently across Node versions (observed: `Client`
 * resolves, `Server`/`utils` do not on some runtimes). Always prefer the CJS
 * `default` (module.exports) when the namespace lacks the named export.
 */
function loadSshClient(): new () => SshClient {
  const ns = ssh2ns as unknown as { Client?: unknown; default?: { Client?: unknown } }
  const ctor = ns.Client ?? ns.default?.Client
  if (typeof ctor !== 'function') throw new Error('ssh2 Client is not available in this runtime')
  return ctor as unknown as new () => SshClient
}
const Client: new () => SshClient = loadSshClient()

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
 * SSH transport — pure ssh2 (no native ssh/plink/sshpass binaries involved).
 *
 * Password auth now works out of the box (this was the documented weak spot:
 * the old transport could only feed a password through `plink -pw` /
 * `sshpass -p`, so any Windows box with only OpenSSH silently rejected a
 * typed password). Private keys are read from the key file(s) through ssh2
 * directly (`~/.ssh/config` Host aliases like `ASUS`, plus HostName / User /
 * Port / IdentityFile, are honored so alias reuse keeps working), host keys
 * get accept-new treatment against `~/.ssh/known_hosts`, and the typed
 * password doubles as the passphrase for an uploaded encrypted key when a key
 * file is chosen ("密码 或 密钥文件").
 */

/** What the connection dialog sends for a remote target. */
export interface SshAuth {
  user?: string
  host?: string
  port?: number
  password?: string
  keyFile?: string
}

/** Effective connection plan after merging explicit fields + `~/.ssh/config`. */
export interface SshPlan {
  username: string
  hostname: string
  port: number
  password?: string
  keyPassphrase?: string
  keyFiles: string[]
}

/**
 * Resolved `~/.ssh/config` values for one host. `identityFiles` is ordered
 * (multiple `IdentityFile` lines accumulate); `identitiesOnly` is true when a
 * matching section sets `IdentitiesOnly yes`.
 */
export interface ResolvedSshConfig {
  user?: string
  hostname?: string
  port?: string
  identityFiles: string[]
  identitiesOnly: boolean
}

/** Local user's home directory (~/.ssh lives under it). */
function sshHome(): string {
  try {
    return homedir()
  } catch {
    return process.env.HOME || process.env.USERPROFILE || ''
  }
}

/** Expand a `~/...` path from ssh config / our default key list. */
export function expandTilde(path: string): string {
  if (path === '~') return sshHome()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(sshHome(), path.slice(2))
  return path
}

/** Default private keys tried when no explicit credential is provided. */
const DEFAULT_KEY_FILES = ['~/.ssh/id_ed25519', '~/.ssh/id_rsa', '~/.ssh/id_ecdsa']

/**
 * Resolve an ssh_config document for one host via the `ssh-config` library —
 * the OpenSSH-exact parser/stringifier (first-obtained-value wins per
 * ssh_config(5), Host/Match sections, `*`/`?`/`!` patterns, quoted values,
 * additive `IdentityFile`). `matchExec` is always off so a config can never
 * execute shell (`Match exec`) or `nslookup` (CanonicalizeHostName) inside
 * this process. `Include` directives are parsed but not followed (OpenSSH
 * would read them; documented limitation).
 */
export function resolveSshConfigFromText(host: string, text: string): ResolvedSshConfig {
  const out: ResolvedSshConfig = { identityFiles: [], identitiesOnly: false }
  let computed: Record<string, unknown>
  try {
    computed = SSHConfig.parse(text).compute(host, { ignoreCase: true, matchExec: false })
  } catch {
    return out
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  const user = str(computed['user'])
  const hostname = str(computed['hostname'])
  const port = str(computed['port'])
  const identityFile = computed['identityfile']
  if (user !== undefined) out.user = user
  if (hostname !== undefined) out.hostname = hostname
  if (port !== undefined) out.port = port
  if (Array.isArray(identityFile)) out.identityFiles = identityFile.filter((v): v is string => typeof v === 'string')
  else if (typeof identityFile === 'string' && identityFile !== '') out.identityFiles = [identityFile]
  if (typeof computed['identitiesonly'] === 'string' && /^(yes|true|1)$/i.test(computed['identitiesonly'])) out.identitiesOnly = true
  return out
}

/** File-backed `~/.ssh/config` lookup (best effort). */
function sshConfigFromFile(host: string): ResolvedSshConfig {
  try {
    const file = join(sshHome(), '.ssh', 'config')
    if (!existsSync(file)) return { identityFiles: [], identitiesOnly: false }
    return resolveSshConfigFromText(host, readFileSync(file, 'utf8'))
  } catch {
    return { identityFiles: [], identitiesOnly: false }
  }
}

/** Build the effective connection plan for one target. */
export function buildSshPlan(auth: SshAuth): SshPlan {
  const host = String(auth.host ?? '')
  let username = String(auth.user ?? '').trim()
  let hostname = host
  let port: number = auth.port !== undefined && Number.isInteger(auth.port) && auth.port > 0 && auth.port <= 65535 ? auth.port : 22
  let keyFiles: string[] = []
  if (host !== '') {
    const cfg = sshConfigFromFile(host)
    if (cfg.user !== undefined && username === '') username = cfg.user
    if (cfg.hostname !== undefined && cfg.hostname !== '') hostname = cfg.hostname
    if (cfg.port !== undefined) {
      const p = Number(cfg.port)
      if (Number.isInteger(p) && p > 0 && p <= 65535) port = p
    }
    keyFiles = cfg.identityFiles.map(expandTilde)
  }
  if (auth.keyFile !== undefined && auth.keyFile !== '') keyFiles = [String(auth.keyFile)]
  if (username === '') {
    try { username = userInfo().username } catch { username = '' }
  }
  const plan: SshPlan = { username, hostname, port, keyFiles }
  if (auth.keyFile !== undefined && auth.keyFile !== '') {
    // A key file was chosen: any typed password is the key's passphrase.
    if (auth.password !== undefined && auth.password !== '') plan.keyPassphrase = String(auth.password)
  } else {
    plan.password = auth.password !== undefined && auth.password !== '' ? String(auth.password) : undefined
  }
  return plan
}

/**
 * accept-new host-key check against a known_hosts document. Returns whether
 * the connection may proceed and whether the host was already known (callers
 * append the key once after a successful first connect).
 */
export function checkHostKeyAcceptNew(host: string, key: Buffer, knownText: string): { ok: boolean; known: boolean } {
  const keyB64 = key.toString('base64')
  for (const raw of knownText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('@')) continue // markers: @cert-authority / @revoked
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const hostList = parts[0]
    if (hostList.includes('|')) continue // hashed host entry (`|1|salt|hash`) — cannot match here
    if (!sshGlob(hostList, host)) continue
    if (parts[2] === keyB64) return { ok: true, known: true } // same key → trust
    return { ok: false, known: false } // key changed for a known host → refuse (possible MITM)
  }
  return { ok: true, known: false } // not present → accept-new
}

function knownHostsPath(): string {
  return join(sshHome(), '.ssh', 'known_hosts')
}

function verifyKnownHosts(host: string, key: Buffer): { ok: boolean; known: boolean } {
  try {
    const file = knownHostsPath()
    if (!existsSync(file)) return { ok: true, known: false }
    return checkHostKeyAcceptNew(host, key, readFileSync(file, 'utf8'))
  } catch {
    return { ok: true, known: false }
  }
}

/** Fall back to the algorithm tag parsed from the key blob. */
function keyAlgorithm(key: Buffer): string {
  try {
    const len = key.readUInt32BE(0)
    if (len > 0 && len < 256 && key.length >= 4 + len) return key.subarray(4, 4 + len).toString('ascii')
  } catch { /* unparsable */ }
  return 'ssh-rsa'
}

/** Best-effort append of a newly accepted host key (accept-new persistence). */
function appendKnownHostKey(host: string, key: Buffer): void {
  if (host === '') return
  try {
    const file = knownHostsPath()
    if (!existsSync(dirname(file))) return
    let existing = ''
    if (existsSync(file)) existing = readFileSync(file, 'utf8')
    for (const raw of existing.split(/\r?\n/)) {
      const parts = raw.trim().split(/\s+/)
      if (parts.length >= 1 && parts[0].split(',').includes(host)) return // already recorded
    }
    appendFileSync(file, `${host} ${keyAlgorithm(key)} ${key.toString('base64')}\n`)
  } catch { /* best-effort */ }
}

/** One authentication attempt payload for a fresh connection. */
type SshCandidate =
  | { kind: 'password'; password: string }
  | { kind: 'key'; path: string; passphrase?: string }
  | { kind: 'agent'; sock: string }

/**
 * One live ssh2 connection (exec + local port forwarding). Owns the client,
 * any forwarded-port servers/sockets, and the host-key accept-new bookkeeping.
 */
export class SshSession {
  readonly auth: SshAuth
  readonly plan: SshPlan
  private client: SshClient | null = null
  private servers: ReturnType<typeof createServer>[] = []
  private sockets = new Set<import('node:net').Socket>()
  private pendingAppend: { host: string; key: Buffer } | null = null

  constructor(auth: SshAuth) {
    this.auth = auth
    this.plan = buildSshPlan(auth)
  }

  get label(): string {
    const p = this.plan
    return `${p.username}@${p.hostname}:${p.port}`
  }

  get connected(): boolean {
    return this.client !== null
  }

  get current(): SshClient {
    if (this.client === null) throw new Error('ssh session not connected')
    return this.client
  }

  /** Auth candidates in the order ssh would try them. */
  private candidates(): SshCandidate[] {
    const p = this.plan
    if (p.keyFiles.length === 0 && p.password !== undefined) return [{ kind: 'password', password: p.password }]
    const list: SshCandidate[] = []
    const seen = new Set<string>()
    for (const path of p.keyFiles) {
      const abs = expandTilde(path)
      if (!existsSync(abs) || seen.has(abs)) continue
      seen.add(abs)
      list.push({ kind: 'key', path: abs, passphrase: p.keyPassphrase })
    }
    if (p.password === undefined) {
      // No explicit credential: fall through to ssh-agent + default keys.
      if (process.env.SSH_AUTH_SOCK) list.push({ kind: 'agent', sock: process.env.SSH_AUTH_SOCK })
      for (const rel of DEFAULT_KEY_FILES) {
        const abs = expandTilde(rel)
        if (existsSync(abs) && !seen.has(abs)) {
          seen.add(abs)
          list.push({ kind: 'key', path: abs })
        }
      }
    }
    if (list.length === 0) list.push({ kind: 'password', password: p.password ?? '' })
    return list
  }

  private hostVerifier(): (key: Buffer) => boolean {
    return (key: Buffer) => {
      const res = verifyKnownHosts(this.plan.hostname, key)
      if (res.ok && !res.known) this.pendingAppend = { host: this.plan.hostname, key: Buffer.from(key) }
      return res.ok
    }
  }

  private openOnce(cand: SshCandidate): Promise<SshClient> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { client.end() } catch { /* already closed */ }
        reject(new Error('SSH 握手超时'))
      }, 15000)
      const cfg: ConnectConfig = {
        host: this.plan.hostname,
        port: this.plan.port,
        username: this.plan.username,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: this.hostVerifier(),
      }
      if (cand.kind === 'password') {
        cfg.password = cand.password
        cfg.tryKeyboard = true // many servers expose password auth as keyboard-interactive
      } else if (cand.kind === 'key') {
        try {
          cfg.privateKey = readFileSync(cand.path)
        } catch (err) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`密钥读取失败: ${err instanceof Error ? err.message : String(err)}`))
          return
        }
        if (cand.passphrase !== undefined) cfg.passphrase = cand.passphrase
      } else {
        cfg.agent = cand.sock
      }
      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => (cand.kind === 'password' ? cand.password : '')))
      })
      client.once('ready', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.pendingAppend !== null) {
          appendKnownHostKey(this.pendingAppend.host, this.pendingAppend.key)
          this.pendingAppend = null
        }
        resolve(client)
      })
      client.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { client.end() } catch { /* already closed */ }
        reject(err)
      })
      client.connect(cfg)
    })
  }

  /** Open the connection; tries each auth candidate until one succeeds. */
  async connect(): Promise<void> {
    if (this.client !== null) return
    const failures: string[] = []
    for (const cand of this.candidates()) {
      try {
        this.client = await this.openOnce(cand)
        return
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err))
      }
    }
    throw new Error(failures.join('；') || '认证失败')
  }

  /** Run one remote command via `bash -s` on this session. */
  async exec(script: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const client = this.client
    if (client === null) return { exitCode: 1, stdout: '', stderr: '会话未连接' }
    return new Promise((resolve) => {
      const out: Buffer[] = []
      const err: Buffer[] = []
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let exitCode = 1
      const finish = (code: number, signal?: string) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        resolve({
          exitCode: signal !== undefined && signal !== '' ? 1 : code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        })
      }
      client.exec('bash -s', (execErr, stream) => {
        if (execErr !== undefined && execErr !== null) {
          err.push(Buffer.from(String(execErr)))
          finish(1)
          return
        }
        stream.on('data', (chunk: Buffer) => out.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        ;(stream.stderr as unknown as import('node:stream').Readable).on('data', (chunk: Buffer) => err.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        stream.on('exit', (code: number | null, signal?: string) => {
          if (typeof code === 'number') exitCode = code
          else if (signal !== undefined && signal !== '') exitCode = 1
        })
        stream.on('close', (code?: number | null, signal?: string) => {
          if (typeof code === 'number') exitCode = code
          finish(exitCode, signal)
        })
        stream.on('error', (streamErr: Error) => {
          err.push(Buffer.from(String(streamErr)))
          finish(1)
        })
        try {
          ;(stream.stdin ?? stream).end(script)
        } catch { /* channel already closed — nothing to feed */ }
        timer = setTimeout(() => {
          try { stream.end() } catch { /* already closed */ }
          err.push(Buffer.from(`(timeout after ${timeoutMs}ms)`))
          finish(124)
        }, timeoutMs)
      })
    })
  }

  /** Register a forwarded-port net.Server so it is torn down with the session. */
  trackServer(server: ReturnType<typeof createServer>): void {
    this.servers.push(server)
    server.once('close', () => {
      const i = this.servers.indexOf(server)
      if (i >= 0) this.servers.splice(i, 1)
    })
  }

  trackSocket(socket: import('node:net').Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
  }

  close(): void {
    this.sockets.forEach((s) => { try { s.destroy() } catch { /* gone */ } })
    this.sockets.clear()
    for (const server of this.servers) {
      try { server.close() } catch { /* gone */ }
    }
    this.servers = []
    const c = this.client
    this.client = null
    if (c !== null) {
      try { c.end() } catch { /* gone */ }
    }
  }
}

/** The transient ssh2 session backing the in-flight `sshRun`; `ssh.cancel` closes it to abort. */
const activeSession: { current: SshSession | null } = { current: null }

/** One remote command fed to `bash -s` over an ssh2 session (own connection, closed afterwards). */
async function sshRun(_ctx: Context, auth: SshAuth, script: string, timeoutMs = 120000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const session = new SshSession(auth)
  activeSession.current = session
  try {
    await session.connect()
    return await session.exec(script, timeoutMs)
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  } finally {
    if (activeSession.current === session) activeSession.current = null
    session.close()
  }
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

/** Cancellation handle for the single in-flight `ssh.connect` (one at a time).

 *  `ssh.cancel` sets `cancelled`; a newer `ssh.connect` bumps `token`, which
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

/** Remote diagnostics log tail (redirect of the tmux pane) + a wait counter. */
const REMOTE_LOG = '$HOME/.dsh-gui-remote.log'

/** A live SSH local port forward (remote service reached via 127.0.0.1). */
interface Tunnel {
  key: string
  localPort: number
  remotePort: number
  session: SshSession
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
 * Open an SSH local port forward over a long-lived ssh2 session:
 * local 127.0.0.1:<localPort> -> remote 127.0.0.1:<remotePort>. The traffic
 * rides the authenticated pure-JS connection (password / key / config all
 * work), so no external ssh/plink/sshpass binary is involved. The tunnel
 * process stays alive until closeTunnel / teardown; a live tunnel for the
 * same host:remotePort is reused.
 */
async function openTunnel(ctx: Context, auth: SshAuth, remotePort: number): Promise<{ ok: boolean; localPort?: number; error?: string }> {
  const key = `${auth.host}:${remotePort}`
  const existing = tunnels.get(key)
  if (existing !== undefined && existing.session.connected) {
    void log(ctx, `reuse tunnel ${key} (local ${existing.localPort})`)
    return { ok: true, localPort: existing.localPort }
  }
  if (existing !== undefined) closeTunnel(key)

  const localPort = await freeLocalPort()
  const session = new SshSession(auth)
  try {
    await session.connect()
  } catch (error) {
    session.close()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const server = createServer((socket) => {
    let client: SshClient
    try {
      client = session.current
    } catch {
      try { socket.destroy() } catch { /* gone */ }
      return
    }
    session.trackSocket(socket)
    socket.on('error', () => { try { socket.destroy() } catch { /* gone */ } })
    client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (forwardErr, stream) => {
      if (forwardErr !== undefined && forwardErr !== null || stream === undefined) {
        try { socket.destroy() } catch { /* gone */ }
        return
      }
      stream.on('error', () => { try { socket.destroy() } catch { /* gone */ } })
      socket.pipe(stream).pipe(socket)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(localPort, '127.0.0.1', () => resolve())
  })
  session.trackServer(server)
  tunnels.set(key, { key, localPort, remotePort, session })
  void log(ctx, `tunnel open ${key} -> 127.0.0.1:${localPort}`)
  return { ok: true, localPort }
}

/** Close a live tunnel by host:remotePort. */
function closeTunnel(key: string): boolean {
  const tunnel = tunnels.get(key)
  if (tunnel !== undefined) {
    tunnel.session.close()
    tunnels.delete(key)
    return true
  }
  return false
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

/** Harvest the one-time launch token from the container-side log (see remoteLaunchToken). */
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
    if (child.stdout !== null) child.stdout.pipe(socket)
    if (child.stdin !== null) socket.pipe(child.stdin)
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

/** Remote TCP-open probe on 127.0.0.1:<port> through ssh. */
async function sshPortOpen(ctx: Context, auth: SshAuth, port: number): Promise<boolean> {
  const res = await sshRun(ctx, auth, `(echo > /dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1 && echo OPEN || echo CLOSED`, 20000)
  return res.exitCode === 0 && res.stdout.includes('OPEN')
}

/** Remote toolchain presence check; reports each missing tool. */
async function checkRemoteToolchain(ctx: Context, auth: SshAuth): Promise<{ ok: boolean; detail: string }> {
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
async function discoverSessionPort(ctx: Context, auth: SshAuth, fallback: number): Promise<number> {
  const res = await sshRun(ctx, auth, 'tmux list-panes -t dsh-gui -F \'#{pane_start_command}\' 2>/dev/null | head -1', 20000)
  const m = /--port(?:\s+|=)(\d+)/.exec(res.stdout)
  const port = m ? Number(m[1]) : fallback
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}

/** ACTIVE when the tmux session exists and its pane is not dead. */
async function sessionState(ctx: Context, auth: SshAuth): Promise<'MISSING' | 'STALE' | 'ALIVE'> {
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

/**
 * Harvest the one-time launch token from the remote start log line
 * `dsh web: http://127.0.0.1:<port>/?token=<token>`. dsh v0.1.2-alpha.1+ Web
 * profiles gate every auto-opened page behind this browser-auth token
 * (`packages/client/connection/src/browser-auth.ts`); the shell's own
 * `spawn_harness` (src-tauri) does exactly this on the harness log. Returns
 * null when the profile prints no launch line (legacy dsh web serves 2xx
 * directly and needs no token).
 */
async function remoteLaunchToken(ctx: Context, auth: SshAuth): Promise<string | null> {
  const res = await sshRun(
    ctx,
    auth,
    `tail -n 200 "$HOME/.dsh-gui-remote.log" 2>/dev/null | grep -a 'dsh web:' | tail -1 | grep -ao 'token=[^ )&]*' | tail -1`,
    15000,
  )
  const m = /^token=([^\s]+)/.exec((res.stdout ?? '').trim())
  return m !== null && m[1] !== '' ? m[1] : null
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

  // Kill locally started backends, every SSH tunnel and every Docker tunnel on teardown.
  ctx.effect(() => () => {
    disposeRoute()
    for (const handle of locals.values()) {
      try { stopLocal(handle) } catch { /* already gone */ }
    }
    locals.clear()
    for (const tunnel of tunnels.values()) {
      try { tunnel.session.close() } catch { /* already gone */ }
    }
    tunnels.clear()
    for (const key of [...dockerTunnels.keys()]) closeDockerTunnel(key)
    if (activeSession.current !== null) {
      try { activeSession.current.close() } catch { /* already gone */ }
      activeSession.current = null
    }
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
      return { ...env, ssh: sshAvailability(), docker: dockerAvailability() }
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
      const remotePort = Number(conn.port)
      if (conn.container) {
        const key = `${conn.container}:${remotePort}`
        return { ok: closeDockerTunnel(key), key }
      }
      if (!conn.sshHost && !conn.address) return { ok: false, error: 'no host' }
      const host = String(conn.sshHost ?? conn.address)
      const key = `${host}:${remotePort}`
      return { ok: closeTunnel(key), key }
    }
    case 'ssh.connect': {
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
        if (!conn.address || !conn.port) {
          return { ok: false, log: [{ step: 'connect', ok: false, detail: 'address and port required' }] }
        }
        // SSH target is its own field (an ssh-config alias like `ASUS` or an
        // explicit host), distinct from the DSH frontend address. When left
        // empty it falls back to the DSH address.
        const sshHost = String(conn.sshHost ?? conn.address)
        const auth: SshAuth = {
          user: conn.sshUser ? String(conn.sshUser) : '',
          host: sshHost,
          port: conn.sshPort ? Number(conn.sshPort) : undefined,
          password: conn.password ? String(conn.password) : undefined,
          keyFile: conn.keyFile ? String(conn.keyFile) : undefined,
        }
        pushLog(logLines, '建立 ssh 会话', true, `${auth.user !== '' ? auth.user + '@' : ''}${auth.host}`)
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
        return connectRemote(ctx, auth, conn as { address: string; port: number; startCommand?: string }, logLines, connectToken)
      } finally {
        remoteProgress.running = false
      }
    }
    case 'ssh.cancel':
      remoteConnectControl.cancelled = true
      // Abort the in-flight command by tearing down its session immediately
      // (the old transport could only set a flag and wait for the current
      // spawnSync to finish).
      if (activeSession.current !== null) {
        try { activeSession.current.close() } catch { /* already gone */ }
        activeSession.current = null
      }
      return { ok: true }
    case 'ssh.status':
      return {
        running: remoteProgress.running,
        startedAt: remoteProgress.startedAt,
        steps: remoteProgress.steps.map(step => ({ ...step })),
      }
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
      const tunnelCount = tunnels.size
      return { env, probeMe, locals: livePorts, tunnels: tunnelCount, dockerTunnels: dockerTunnels.size }
    }
    default:
      return { ok: false, error: `unknown op: ${op}` }
  }
}

/**
 * ssh2 auth probe for the no-credential path: connect using the resolved
 * `~/.ssh/config` alias (or default keys / agent) and run a trivial command.
 * A failure means the alias needs authentication the plugin was not given →
 * authRequired.
 */
async function probeSshAuth(ctx: Context, auth: SshAuth): Promise<{ ok: boolean }> {
  const res = await sshRun(ctx, auth, 'echo DSH_REMOTE_AUTH_OK', 20000)
  return { ok: res.exitCode === 0 && res.stdout.includes('DSH_REMOTE_AUTH_OK') }
}

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
  if (flags.length === 0) return base
  // `npm|pnpm|bun run <script>` only forwards further argv after a `--`
  // separator; without it npm yells `Unknown cli flags: --host/--port`.
  const pmRun = /^(?:npm|pnpm|bun)\s+(?:(?:-C|--dir)\s+\S+\s+)*run\s+\S/.test(base)
  const sep = pmRun && !/\s--\s*$/.test(base) ? ' -- ' : ' '
  return `${base}${sep}${flags.join(' ')}`
}

/**
 * Wait until a tunneled loopback URL is frontend-ready. Shared by the SSH and
 * Docker pipelines: a legacy profile serves 2xx on the bare URL, while dsh
 * v0.1.2-alpha.1+ gates behind a one-time launch token (bare URL = 401,
 * tokenized first visit = 303 + Set-Cookie). Both are accepted; the token is
 * re-harvested every round when the first probe stays 401. Returns the exact
 * URL to load (with token when present) and the observed HTTP status.
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
  auth: SshAuth,
  conn: { address: string; port: number; startCommand?: string },
  log: Array<{ step: string; ok: boolean; detail?: string }>,
  token: number,
): Promise<{ ok: boolean; authRequired?: boolean; cancelled?: boolean; log: Array<{ step: string; ok: boolean; detail?: string }>; url?: string; tunnelKey?: string }> {
  const tmuxName = 'dsh-gui'
  const startCommand = String(conn.startCommand ?? '').trim() || defaultStartCommand()
  let startedSession = false
  let tunnelKey: string | undefined

  /** Best-effort teardown of resources THIS attempt created (so a cancelled /
   *  failed connect leaves no remote tmux session or SSH tunnel behind). */
  async function teardown(): Promise<void> {
    if (startedSession) {
      await sshRun(ctx, auth, `tmux kill-session -t ${tmuxName} 2>/dev/null || true`, 15000)
    }
    if (tunnelKey !== undefined) closeTunnel(tunnelKey)
  }

  /** Abort point: the shell cancelled (or a newer connect superseded us). */
  async function bailCancelled(): Promise<{ ok: false; cancelled: true; log: Array<{ step: string; ok: boolean; detail?: string }> }> {
    pushLog(log, '已取消', false, '连接被用户取消')
    await teardown()
    return { ok: false, cancelled: true, log }
  }

  // 1. toolchain precheck
  const tools = await checkRemoteToolchain(ctx, auth)
  pushLog(log, '远端工具预检', tools.ok, tools.ok ? tools.detail : tools.detail)
  if (connectCancelled(token)) return bailCancelled()
  if (!tools.ok) return { ok: false, log }

  // 2. ensure the tmux session is ALIVE, starting it with the configured
  //    command when missing or stale. The backend binds loopback ONLY — the
  //    frontend is reached via the SSH tunnel. The pane's output is redirected
  //    to $HOME/.dsh-gui-remote.log so failures are diagnosable even after the
  //    session exits (capture-pane would be empty then).
  const state = await sessionState(ctx, auth)
  pushLog(log, `tmux 会话 ${tmuxName}`, state === 'ALIVE', `state=${state}`)
  if (connectCancelled(token)) return bailCancelled()
  if (state !== 'ALIVE') {
    if (state === 'STALE') {
      const killed = await sshRun(ctx, auth, `tmux kill-session -t ${tmuxName} 2>/dev/null || true`, 20000)
      pushLog(log, '清理失效会话', killed.exitCode === 0, (killed.stdout + killed.stderr).trim() || 'ok')
    }
    // The remote usually needs the user's FULL login+interactive environment:
    // an nvm-managed Node (or other tools) only reaches PATH from ~/.bashrc,
    // and a guarded `.bashrc` (`case $- in *i*) ;; *) return;; esac`) refuses
    // to load in a non-interactive shell — so the plain `bash -s` (and even
    // `bash -l -c`) pane stays on the bare system Node and the backend's
    // plugin tree fails (`Cannot find package '@deepseek-ai/...'`). Run the
    // detached pane as an INTERACTIVE login bash (`-l -i`) so the profile
    // AND rc load exactly like the user's interactive ssh terminal. `node -v`
    // is captured first so the log proves which runtime the start used.
    const serveFlags = appendServeFlags(startCommand, conn.port)
    const paneCommand = `{ node -v; cd "$HOME" && ${serveFlags}; } > ${REMOTE_LOG} 2>&1`
    const inner = `bash -l -i -c ${JSON.stringify(paneCommand)}`
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
    if (connectCancelled(token)) return bailCancelled()
    if (start.exitCode !== 0) return { ok: false, log }
    startedSession = true
  }

  /** Tail the remote start log for diagnostics ($HOME/.dsh-gui-remote.log). */
  async function remoteTail(lines = 12, chars = 1500): Promise<string> {
    const r = await sshRun(ctx, auth, `tail -n ${lines} ${REMOTE_LOG} 2>/dev/null || true`, 15000)
    return (r.stdout + r.stderr).trim().split('\n').slice(-lines).join('\n').slice(0, chars)
  }

  // 3. discover serving port from the session and wait until it is open
  const remotePort = await discoverSessionPort(ctx, auth, conn.port)
  pushLog(log, `服务端口 ${remotePort}`, true, `会话内后端监听 127.0.0.1:${remotePort}`)
  if (connectCancelled(token)) return bailCancelled()
  const openDeadline = Date.now() + 300000
  const openedAt = Date.now()
  let open = await sshPortOpen(ctx, auth, remotePort)
  let waitIter = 0
  while (!open && Date.now() < openDeadline) {
    await new Promise(r => setTimeout(r, 2000))
    if (connectCancelled(token)) return bailCancelled()
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
    await teardown()
    return { ok: false, log }
  }

  // 4. open the SSH local port forward and wait for the local URL to load
  const tunnel = await openTunnel(ctx, auth, remotePort)
  if (connectCancelled(token)) return bailCancelled()
  if (!tunnel.ok || tunnel.localPort === undefined) {
    pushLog(log, 'ssh 端口转发', false, tunnel.error || '无法建立转发')
    await teardown()
    return { ok: false, log }
  }
  const key = `${auth.host}:${remotePort}`
  tunnelKey = key
  const baseLocalUrl = `http://127.0.0.1:${tunnel.localPort}/`
  pushLog(log, 'ssh 端口转发', true, `127.0.0.1:${tunnel.localPort} -> ${auth.host}:${remotePort}`)

  // dsh v0.1.2-alpha.1+ Web profiles gate every auto-opened page behind a
  // one-time launch token (`dsh web: http://127.0.0.1:<port>/?token=...`):
  // a bare GET answers 401 and a tokenized one 303 + Set-Cookie — neither is
  // the 2xx the readiness probe alone expects. Mirror the shell's own
  // `spawn_harness` (src-tauri): harvest the token from the remote start log
  // and authenticate the tunneled URL with it. Legacy dsh web prints no
  // token and serves 2xx directly — both are supported below.
  const ready = await waitFrontendReady(
    ctx,
    baseLocalUrl,
    () => remoteLaunchToken(ctx, auth),
    (lines?: number, chars?: number) => remoteTail(lines ?? 12, chars ?? 1500),
    log,
    token,
    '远端日志',
  )
  if (ready.cancelled) return bailCancelled()
  if (!ready.ok) {
    const tail = await remoteTail(40, 3000)
    pushLog(log, '前端就绪', false, `${ready.url} 超时${tail !== '' ? `\n远端日志 (${REMOTE_LOG}):\n${tail}` : ''}`)
    await teardown()
    return { ok: false, log }
  }
  pushLog(log, `前端就绪 ${ready.url}`, true, `HTTP ${ready.status}`)
  return { ok: ready.ok, log, url: ready.url, tunnelKey: key }
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
