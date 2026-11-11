/**
 * `wsl.exe` process plumbing for the remote-connection module.
 *
 * This is the WSL counterpart of `./ssh.ts`: every remote action is one
 * `wsl.exe` invocation, returning the same `{ child, done }` shape so the
 * connection manager can own, time out, and cancel it identically.
 *
 * Two WSL-specific properties drive the design:
 *
 * - **The script travels on stdin, to a login but non-interactive bash.**
 *   `wsl.exe ... -- bash -l -s` reads its commands from standard input, so
 *   nothing is handed to the Windows→Linux boundary as an argv element. A
 *   command-line script would be re-parsed by WSL's argument handoff, and every
 *   quote inside the shell script would need its own Windows escaping layer.
 *   `-l` is deliberate (the scripts need the user's login environment), but `-i`
 *   is not: an interactive bash decorates stdout with OSC shell-integration and
 *   title sequences and its prompt on stderr, which corrupts parsed probe/token
 *   output. The backend itself still runs as `bash -l -i -c` inside its tmux
 *   pane (see `./commands.ts`), so the launch keeps the full interactive rc
 *   environment (nvm, for example) — only this control channel is non-interactive.
 * - **`WSL_UTF8=1` is requested, with a UTF-16LE fallback.** Current `wsl.exe`
 *   honours the variable and emits UTF-8 for its own messages; builds that do
 *   not know it emit UTF-16LE, which decodes as NUL-laden mojibake if read as
 *   UTF-8. {@link decodeWslOutput} detects the byte pattern instead of trusting
 *   the variable, so an old distro or runtime still produces readable text.
 *
 * `wsl.exe` writes its own activation errors (unknown distro, unknown user) as
 * localized prose in one of the two streams, but it names a stable error code
 * (`Wsl/Service/WSL_E_DISTRO_NOT_FOUND`, `Wsl/WSL_E_USER_NOT_FOUND`); the
 * localized text is shown to the user, and the code is what makes the diagnosis
 * independent of the Windows display language.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { terminate } from './ssh.ts'
import { stripAnsi } from './text.ts'

/** The WSL client executable; Windows resolves it through PATH. */
const WSL_BINARY = 'wsl.exe'

/** Captured bytes per stream kept in memory. */
const MAX_CAPTURE = 64 * 1024

/** Diagnostic characters appended to an error message. */
const MAX_DIAGNOSTIC = 1500

/** Default budget of one distro-list read; the first call may start the WSL service. */
const LIST_TIMEOUT_MS = 20_000

/** Marker the port probe prints when nothing listens on the port inside WSL. */
export const WSL_PORT_FREE = 'WSL_PORT_FREE'

/** Marker the port probe prints when something listens on the port inside WSL. */
export const WSL_PORT_BUSY = 'WSL_PORT_BUSY'

/** Marker the port probe prints when neither `ss` nor `netstat` exists. */
export const WSL_PORT_UNKNOWN = 'WSL_PORT_UNKNOWN'

/** Port occupancy inside the WSL distro, as {@link wslPortFreeScript} reports it. */
export type WslPortState = 'free' | 'busy' | 'unknown'

/** One WSL distribution, as `wsl.exe -l -v` describes it. */
export interface WslHostEntry {
  /** Distribution name, usable verbatim as `wsl.exe -d <name>`. */
  readonly name: string
  /** Lifecycle state (`Running`, `Stopped`, …) when the verbose list reported one. */
  readonly state?: string
  /** WSL version (1 or 2) when the verbose list reported one. */
  readonly version?: number
  /** True for the distribution `wsl.exe` uses when no `-d` is given. */
  readonly default?: boolean
}

/** Whether WSL can be used at all on this machine. */
export interface WslAvailability {
  readonly available: boolean
  /** Present only when unavailable. */
  readonly error?: string
}

/** One failed WSL command, with the output needed to explain it. */
export class WslCommandError extends Error {
  /** Distribution the command targeted; empty means the default distribution. */
  readonly distro: string
  /** Captured stdout, empty when nothing was read. */
  readonly stdout: string
  /** Captured stderr, empty when nothing was read. */
  readonly stderr: string

  constructor(distro: string, stdout: string, stderr: string, reason: string) {
    super(`wsl ${distroLabel(distro)}: ${reason}${diagnostics(stdout, stderr)}`)
    this.name = 'WslCommandError'
    this.distro = distro
    this.stdout = stdout
    this.stderr = stderr
  }
}

/** One running WSL command. */
export interface WslRun {
  /** The `wsl.exe` client, exposed so a caller can abort the command. */
  readonly child: ChildProcess
  /** Captured output; rejects with {@link WslCommandError} on any failure. */
  readonly done: Promise<{ stdout: string; stderr: string }>
}

/**
 * Run one shell script inside a WSL distribution.
 * @param channel - distribution (empty for the default one) and optional account.
 * @param script - POSIX shell script fed to `bash -l -s` on stdin.
 * @param options - optional wall-clock budget for the script.
 * @returns the running client and its captured output.
 */
export function runWsl(channel: { distro: string; account?: string }, script: string, options: { timeoutMs?: number } = {}): WslRun {
  const args: string[] = []
  // An empty distro or account means "whatever the wsl.exe default is", and the
  // flag is omitted rather than passed empty.
  if (channel.distro !== '') args.push('-d', channel.distro)
  if (channel.account !== undefined && channel.account !== '') args.push('-u', channel.account)
  // Login, but NOT interactive: `-i` lets the shell's startup files decorate
  // stdout with OSC/title sequences and its prompt leak onto stderr, which would
  // corrupt every parsed value on this channel.
  args.push('--', 'bash', '-l', '-s')
  return runWslProcess(args, script, options.timeoutMs, channel.distro)
}

/**
 * Decode one captured WSL stream.
 *
 * UTF-8 is the expected encoding because every command sets `WSL_UTF8=1`. A
 * stream that is mostly NUL-interleaved bytes is UTF-16LE instead: wsl.exe's
 * own messages fall back to the wide API when it does not understand the
 * variable, and UTF-8 text (the remote command's own output) never carries NUL
 * bytes. Both decode paths are lossless enough to parse and to show to a user.
 * @param bytes - captured stdout or stderr bytes.
 * @returns the decoded text.
 */
export function decodeWslOutput(bytes: Uint8Array): string {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length === 0) return ''
  const text = looksUtf16Le(buffer)
    ? buffer.toString('utf16le').replace(/\u0000+$/g, '')
    : buffer.toString('utf8')
  // A BOM is an encoding marker, not content: drop it so a caller comparing the
  // first token (or validating a token file) is not defeated by it.
  return text.replace(/^\uFEFF/, '')
}

/**
 * Read the installed WSL distributions.
 *
 * The verbose list carries state, version, and the default marker; a very old
 * `wsl.exe` rejects `-v`, so the quiet list is the fallback.
 * @param options - optional budget override for one list command.
 * @returns one entry per distribution, in `wsl.exe` order; empty when WSL is unavailable.
 */
export async function readWslHosts(options: { timeoutMs?: number } = {}): Promise<WslHostEntry[]> {
  if (!wslAvailable().available) return []
  const timeoutMs = options.timeoutMs ?? LIST_TIMEOUT_MS
  let verboseError: unknown
  try {
    const verbose = await runWslArgs(['-l', '-v'], timeoutMs)
    const hosts = parseWslDistroList(verbose.stdout)
    if (hosts.length > 0) return hosts
  } catch (error) {
    verboseError = error
  }
  try {
    const quiet = await runWslArgs(['-l', '-q'], timeoutMs)
    return parseWslDistroList(quiet.stdout)
  } catch (error) {
    throw verboseError ?? error
  }
}

/**
 * Whether `wsl.exe` can be started on this machine.
 * @returns availability plus a Chinese explanation when it cannot.
 */
export function wslAvailable(): WslAvailability {
  if (process.platform !== 'win32') {
    return { available: false, error: 'WSL 只在 Windows 上可用（当前平台没有 wsl.exe）' }
  }
  if (locateWsl()) return { available: true }
  return { available: false, error: '在 PATH 与 System32 中都找不到 wsl.exe，请确认已安装 WSL' }
}

/**
 * Parse `wsl.exe -l -v` (or `-l -q`) output.
 *
 * The verbose form is `<name> <state> <version>` with a leading `*` on the
 * default distribution; the quiet form is one name per line. Parsing is
 * anchored from the end of a verbose line (state and numeric version) so a
 * distribution name containing spaces survives, and non-table lines (the
 * header, an "no installed distributions" notice, usage hints) are skipped.
 * @param text - captured list output, in either form.
 * @returns the parseable rows, in output order.
 */
export function parseWslDistroList(text: string): WslHostEntry[] {
  const hosts: WslHostEntry[] = []
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const isDefault = line.startsWith('*')
    const body = isDefault ? line.slice(1).trim() : line
    if (body === '' || isListNoise(body)) continue
    const entry = parseVerboseDistroLine(body) ?? parseQuietDistroLine(body)
    if (entry === undefined) continue
    if (isDefault) hosts.push({ ...entry, default: true })
    else hosts.push(entry)
  }
  return hosts
}

/**
 * Build the script that reports whether one TCP port is listened on inside WSL.
 *
 * The scan has to happen in both places because WSL2's network is separate from
 * Windows': a port can be busy inside the distro (the backend would fail to
 * bind) while Windows loopback is free, or busy on Windows loopback (WSL's
 * localhost forwarding already owns it) while the distro port is free. `ss` is
 * the modern tool; `netstat` covers minimal distros; when neither exists the
 * probe says so, and the caller falls back to the start-time error.
 * @param port - candidate TCP port.
 * @returns the script; its stdout carries one {@link WSL_PORT_FREE} /
 * {@link WSL_PORT_BUSY} / {@link WSL_PORT_UNKNOWN} marker.
 */
export function wslPortFreeScript(port: number): string {
  const pattern = `(^|[:.])${port}$`
  return [
    `tabs_ss=$(command -v ss 2>/dev/null)`,
    'if [ -n "$tabs_ss" ]; then',
    `  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '${pattern}'; then printf '${WSL_PORT_BUSY}\\n'; else printf '${WSL_PORT_FREE}\\n'; fi`,
    '  exit 0',
    'fi',
    `tabs_netstat=$(command -v netstat 2>/dev/null)`,
    'if [ -n "$tabs_netstat" ]; then',
    `  if netstat -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -Eq '${pattern}'; then printf '${WSL_PORT_BUSY}\\n'; else printf '${WSL_PORT_FREE}\\n'; fi`,
    '  exit 0',
    'fi',
    `printf '${WSL_PORT_UNKNOWN}\\n'`,
  ].join('\n')
}

/**
 * Parse {@link wslPortFreeScript}'s output.
 * @param stdout - captured stdout.
 * @returns the reported state; anything unrecognised is `unknown`.
 */
export function parseWslPortFree(stdout: string): WslPortState {
  const text = stripAnsi(stdout)
  if (text.includes(WSL_PORT_BUSY)) return 'busy'
  if (text.includes(WSL_PORT_FREE)) return 'free'
  return 'unknown'
}

/**
 * Tell a port collision apart from a genuine launch failure.
 *
 * Node reports a taken port as `EADDRINUSE` (or the OS message "address already
 * in use") in the remote log tail. Only that case is worth retrying on the next
 * port; every other failure means the harness itself did not start, and walking
 * the port range would just repeat it ten times.
 * @param text - failure text, including the remote log tail.
 * @returns the category of the failure.
 */
export function classifyWslStartFailure(text: string): 'port-in-use' | 'start-failed' {
  return /EADDRINUSE|address already in use/i.test(text) ? 'port-in-use' : 'start-failed'
}

/**
 * Translate a WSL activation failure into an actionable Chinese message.
 *
 * `wsl.exe`'s prose is localized, so the classification keys on its stable error
 * codes instead. Only the two failures the user can act on by editing the
 * connection (`distro` / `account`) are translated; anything else keeps its raw
 * output.
 * @param channel - distribution and optional account the command targeted.
 * @param text - stdout and stderr of the failed command, concatenated.
 * @returns the actionable message, or undefined when the codes are not present.
 */
export function wslChannelDiagnosis(channel: { distro: string; account?: string }, text: string): string | undefined {
  if (/WSL_E_DISTRO_NOT_FOUND/.test(text)) {
    const name = channel.distro === '' ? '（默认发行版）' : channel.distro
    return `WSL 发行版 ${name} 不存在：请用 wsl.exe -l -v 确认已安装的发行版名称`
  }
  if (/WSL_E_USER_NOT_FOUND/.test(text)) {
    const name = channel.account === undefined || channel.account === '' ? '（未指定）' : channel.account
    return `WSL 账号 ${name} 不存在：请修正连接的账号，或留空使用发行版的默认用户`
  }
  return undefined
}

/** Run one `wsl.exe` invocation with fixed arguments (list commands). */
function runWslArgs(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return runWslProcess(args, '', timeoutMs, args.join(' ')).done
}

/**
 * Spawn one `wsl.exe` invocation and capture both streams.
 * @param args - arguments after the executable.
 * @param script - script fed to stdin; empty leaves stdin closed immediately.
 * @param timeoutMs - optional wall-clock budget; on expiry the client is terminated.
 * @param scope - diagnostic label used in {@link WslCommandError}.
 * @returns the running client and its captured output.
 */
function runWslProcess(args: string[], script: string, timeoutMs: number | undefined, scope: string): WslRun {
  const child = spawn(WSL_BINARY, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Opt into UTF-8 for wsl.exe's own messages; older builds ignore it and
    // {@link decodeWslOutput} recovers the UTF-16LE output.
    env: { ...process.env, WSL_UTF8: '1' },
  })
  // The remote shell can exit before reading its script (an unknown distro or
  // user fails during activation), which surfaces as EPIPE here. It is not a
  // second failure: the exit code and the captured streams explain the run.
  child.stdin?.on('error', () => { /* reported through the exit path */ })
  child.stdin?.end(script === '' ? '' : script.endsWith('\n') ? script : `${script}\n`)
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => { if (captured(out) < MAX_CAPTURE) out.push(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { if (captured(err) < MAX_CAPTURE) err.push(chunk) })
  const done = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      terminate(child)
      reject(new WslCommandError(scope, textOf(out), textOf(err), `timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', (error: Error) => {
      if (timer !== undefined) clearTimeout(timer)
      reject(new WslCommandError(scope, textOf(out), textOf(err), `could not start: ${error.message}`))
    })
    child.once('close', (code: number | null) => {
      if (timer !== undefined) clearTimeout(timer)
      const stdout = textOf(out)
      const stderr = textOf(err)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new WslCommandError(scope, stdout, stderr, `exited with code ${normalizeExitCode(code)}`))
    })
  })
  return { child, done }
}

/** Whether a captured byte stream is UTF-16LE rather than UTF-8. */
function looksUtf16Le(bytes: Buffer): boolean {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return true
  // ASCII UTF-16LE text is half NUL bytes, always in the high byte of a code
  // unit. UTF-8 text has no NUL byte at all, so a quarter of the bytes being
  // NUL is unambiguous.
  let zeros = 0
  for (const byte of bytes) if (byte === 0) zeros += 1
  return zeros * 4 >= bytes.length
}

/** Decode every captured chunk of one stream. */
function textOf(chunks: readonly Buffer[]): string {
  return decodeWslOutput(Buffer.concat(chunks))
}

/** Bytes accumulated in one capture buffer. */
function captured(chunks: readonly Buffer[]): number {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  return total
}

/** Render one line of the distro list that is prose rather than a table row. */
function isListNoise(body: string): boolean {
  return /^NAME\b/i.test(body)
    || /^名称/.test(body)
    || /--(?:install|list|help)\b/i.test(body)
    || /no installed distribution|没有已安装|可通过|wsl\.exe/i.test(body)
    || /[：:]$/.test(body)
}

/** @returns a verbose `name state version` row, or undefined for any other line. */
function parseVerboseDistroLine(body: string): WslHostEntry | undefined {
  const tokens = body.split(/\s+/)
  if (tokens.length < 3) return undefined
  const version = Number(tokens[tokens.length - 1])
  const state = tokens[tokens.length - 2]
  if (!Number.isInteger(version) || version <= 0) return undefined
  if (state === undefined || !/^[A-Za-z]+$/.test(state)) return undefined
  const name = tokens.slice(0, -2).join(' ')
  return name === '' ? undefined : { name, state, version }
}

/** @returns a quiet-list name line, or undefined for prose (a quiet name is one word). */
function parseQuietDistroLine(body: string): WslHostEntry | undefined {
  if (/\s/.test(body)) return undefined
  return { name: body }
}

/** Locate `wsl.exe` without starting it. */
function locateWsl(): boolean {
  try {
    const result = spawnSync('where.exe', ['wsl.exe'], { windowsHide: true, encoding: 'utf8' })
    if (result.status === 0 && (result.stdout ?? '').trim() !== '') return true
  } catch {
    // where.exe itself is missing; the fixed system location is the fallback.
  }
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return existsSync(join(root, 'System32', 'wsl.exe'))
}

/** The label {@link WslCommandError} uses for one scope. */
function distroLabel(distro: string): string {
  return distro === '' ? '默认发行版' : distro
}

/**
 * Append the streams that carry a diagnostic.
 *
 * `wsl.exe` activation errors and the remote command's stderr can land in
 * different streams (some builds put the localized activation prose on stdout
 * and the relay error on stderr), and either may be the only evidence, so both
 * non-empty tails are included.
 */
function diagnostics(stdout: string, stderr: string): string {
  const parts: string[] = []
  const err = stderr.trim()
  if (err !== '') parts.push(`stderr: ${err.slice(-MAX_DIAGNOSTIC)}`)
  const out = stdout.trim()
  if (out !== '') parts.push(`stdout: ${out.slice(-MAX_DIAGNOSTIC)}`)
  return parts.length === 0 ? '' : `; ${parts.join('; ')}`
}

/**
 * Recover a signed exit code from the unsigned 32-bit value Windows reports.
 * `wsl.exe` returns -1 (0xFFFFFFFF) for activation failures; passing that
 * through unchanged would render as 4294967295 in a user-facing message.
 */
function normalizeExitCode(code: number | null): number | null {
  if (code === null) return null
  return code > 0x7fffffff ? code - 0x1_0000_0000 : code
}
