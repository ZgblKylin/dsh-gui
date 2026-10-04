/**
 * `ssh` process plumbing for the remote-connection module.
 *
 * Every remote action is one `ssh` invocation with a command passed as a single
 * argv element: no local shell is involved, so nothing here quotes for Windows.
 * The remote side is a POSIX shell, so the command strings are built with
 * `quotePosix` and `remotePath` and use no double quotes — Windows argument
 * escaping of embedded `"` is the one thing this module refuses to depend on.
 *
 * Captured stderr needs two Windows-specific steps, both confined to the text a
 * user reads: `ssh.exe` prints its localized diagnostics in the system ANSI code
 * page rather than UTF-8, and it renders the non-ASCII bytes of such a message as
 * `\ooo` octal escapes. `stderrText` reverses both; stdout stays UTF-8, because it
 * carries the remote command's own output.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/** The SSH client; Windows resolves it to `ssh.exe` through PATH. */
const SSH_BINARY = 'ssh'

/** Connection options every remote command carries; BatchMode forbids prompts. */
const BASE_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']

/** Captured bytes per stream kept in memory. */
const MAX_CAPTURE = 64 * 1024

/** stderr characters appended to an error message. */
const MAX_DIAGNOSTIC = 1500

/** How long a tunnel must survive startup before it counts as bound. */
const TUNNEL_SETTLE_MS = 1_200

/** Decoder for stdout, which is the remote command's own UTF-8 output. */
const STDOUT_DECODER = decoderFor('utf-8')

/** Decoder for `ssh` diagnostics: the Windows ANSI code page, UTF-8 elsewhere. */
const STDERR_DECODER = decoderFor(process.platform === 'win32' ? 'gbk' : 'utf-8')

/**
 * A run of at least two `\ooo` byte escapes, the form Windows OpenSSH uses for
 * the non-ASCII bytes of a localized message. The leading digit is restricted to
 * 0-3 so every escape is a byte value, and two escapes are required so a single
 * literal backslash (a Windows path, say) is left alone.
 */
const OCTAL_ESCAPE_RUN = /(?:\\[0-3][0-7]{2}){2,}/g

/** One three-digit octal byte escape inside a run. */
const OCTAL_ESCAPE = /\\([0-3][0-7]{2})/g

/** One failed remote command, with the output needed to explain it. */
export class SshCommandError extends Error {
  /** SSH destination the command ran against. */
  readonly host: string
  /** Captured stdout, empty when nothing was read. */
  readonly stdout: string
  /** Captured stderr, empty when nothing was read. */
  readonly stderr: string

  constructor(host: string, stdout: string, stderr: string, reason: string) {
    super(`ssh ${host}: ${reason}${stderrDetail(stderr)}`)
    this.name = 'SshCommandError'
    this.host = host
    this.stdout = stdout
    this.stderr = stderr
  }
}

/** One running remote command. */
export interface SshRun {
  /** The ssh client, exposed so a caller can abort the command. */
  readonly child: ChildProcess
  /** Captured output; rejects with {@link SshCommandError} on any failure. */
  readonly done: Promise<{ stdout: string; stderr: string }>
}

/** One running local-forward tunnel. */
export interface TunnelHandle {
  /** The `ssh -N` client owning the forward. */
  readonly child: ChildProcess
  /** Local loopback port carrying the forward. */
  readonly localPort: number
  /** Remote loopback port the forward reaches. */
  readonly remotePort: number
}

/**
 * Run one command on a remote host.
 * @param host - SSH destination.
 * @param command - remote shell command, one argv element on the local side.
 * @param options - optional wall-clock budget for the command.
 * @returns the running client and its captured output.
 */
export function runSsh(host: string, command: string, options: { timeoutMs?: number } = {}): SshRun {
  const child = spawn(SSH_BINARY, [...BASE_OPTIONS, host, command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => { if (captured(out) < MAX_CAPTURE) out.push(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { if (captured(err) < MAX_CAPTURE) err.push(chunk) })
  const done = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      terminate(child)
      reject(new SshCommandError(host, text(out), stderrText(err), `timed out after ${options.timeoutMs ?? 0}ms`))
    }, options.timeoutMs)
    child.once('error', (error: Error) => {
      if (timer !== undefined) clearTimeout(timer)
      reject(new SshCommandError(host, text(out), stderrText(err), `could not start: ${error.message}`))
    })
    child.once('close', (code: number | null) => {
      if (timer !== undefined) clearTimeout(timer)
      const stdout = text(out)
      const stderr = stderrText(err)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new SshCommandError(host, stdout, stderr, `exited with code ${code ?? 'null'}`))
    })
  })
  return { child, done }
}

/**
 * Open a local-forward tunnel and wait out its startup window.
 *
 * `ExitOnForwardFailure=yes` makes a bind failure exit immediately, so surviving
 * the settle window is the evidence that the local port was actually bound; a
 * request through a tunnel that silently failed would otherwise reach whichever
 * local service holds the port.
 * @param options - SSH destination and the two ports to join.
 * @returns the running tunnel.
 */
export async function openTunnel(options: { host: string; localPort: number; remotePort: number }): Promise<TunnelHandle> {
  const { host, localPort, remotePort } = options
  const child = spawn(SSH_BINARY, [
    '-N',
    ...BASE_OPTIONS,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    host,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const err: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => { if (captured(err) < MAX_CAPTURE) err.push(chunk) })
  child.stdout?.on('data', () => { /* -N writes nothing; the stream is drained to keep the pipe open */ })
  child.once('error', () => { /* the settle window below reports it */ })
  await delay(TUNNEL_SETTLE_MS)
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new SshCommandError(host, '', stderrText(err), `the forward 127.0.0.1:${localPort} -> 127.0.0.1:${remotePort} exited during startup`)
  }
  return { child, localPort, remotePort }
}

/**
 * Run one command without keeping the host process alive: the client is unref'd
 * and its output discarded, so teardown never blocks on a remote host.
 * @param host - SSH destination.
 * @param command - remote shell command.
 */
export function spawnSshDetached(host: string, command: string): void {
  try {
    const child = spawn(SSH_BINARY, [...BASE_OPTIONS, host, command], { stdio: 'ignore', windowsHide: true })
    // A rejection here means the host is already unreachable; nothing is left to reclaim.
    child.once('error', () => { /* fire-and-forget cleanup */ })
    child.unref()
  } catch {
    // spawn() throws only for an unusable argv; the awaited path reports that case.
  }
}

/**
 * Stop one SSH client process.
 *
 * Node's `kill()` is `TerminateProcess` on Windows and `SIGTERM` elsewhere, which
 * is enough here: an ssh client owns no child processes of its own.
 * @param child - process to stop; an already-exited process is ignored.
 */
export function terminate(child: ChildProcess | undefined): void {
  if (child === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill()
  } catch {
    // The process is already gone.
  }
}

/**
 * Quote one literal as a POSIX shell word.
 * @param value - literal text, arbitrary characters included.
 * @returns a single-quoted word safe to embed in a remote command.
 */
export function quotePosix(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/**
 * Express a possibly-`~`-rooted remote path as one shell word.
 *
 * `~` and `~/` expand to `$HOME`, which is left unquoted so the remote shell
 * resolves it; everything after it is single-quoted. A bare `~user` form is left
 * literal rather than guessed at.
 * @param value - remote path from the tab descriptor.
 * @returns the shell word for that path.
 */
export function remotePath(value: string): string {
  if (value === '~') return '$HOME'
  if (value.startsWith('~/')) return `$HOME${quotePosix(value.slice(1))}`
  return quotePosix(value)
}

/** Bytes accumulated in one capture buffer. */
function captured(chunks: readonly Buffer[]): number {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  return total
}

/** Decode a captured stdout stream, which the remote command produced as UTF-8. */
function text(chunks: readonly Buffer[]): string {
  return decode(STDOUT_DECODER, Buffer.concat(chunks))
}

/**
 * Decode a captured stderr stream.
 *
 * Windows `ssh.exe` writes its localized diagnostics in the system ANSI code
 * page, so they are decoded with that page; it also renders their non-ASCII bytes
 * as `\ooo` octal escapes, which {@link recoverEscapedBytes} collapses back into
 * text. Elsewhere stderr is UTF-8 and neither step applies.
 * @param chunks - captured stderr buffers.
 * @returns the diagnostic text a user can read.
 */
function stderrText(chunks: readonly Buffer[]): string {
  const decoded = decode(STDERR_DECODER, Buffer.concat(chunks))
  return process.platform === 'win32' ? recoverEscapedBytes(decoded, STDERR_DECODER) : decoded
}

/**
 * Replace `\ooo` escape runs with the text of the bytes they encode.
 * @param text - decoded stderr.
 * @param decoder - decoder to apply to the recovered bytes.
 * @returns the text, with each run whose bytes decode cleanly substituted.
 */
function recoverEscapedBytes(text: string, decoder: TextDecoder | undefined): string {
  return text.replace(OCTAL_ESCAPE_RUN, (run: string) => {
    const bytes: number[] = []
    for (const match of run.matchAll(OCTAL_ESCAPE)) {
      const digits = match[1]
      if (digits !== undefined) bytes.push(Number.parseInt(digits, 8))
    }
    const recovered = decode(decoder, Buffer.from(bytes))
    return recovered.includes('\uFFFD') ? run : recovered
  })
}

/**
 * Build a decoder, falling back to UTF-8 when this runtime cannot supply the label.
 * @param label - WHATWG encoding label.
 * @returns the decoder, or undefined when no decoder can be constructed at all.
 */
function decoderFor(label: string): TextDecoder | undefined {
  try {
    return new TextDecoder(label)
  } catch {
    try {
      return new TextDecoder('utf-8')
    } catch {
      return undefined
    }
  }
}

/**
 * Decode bytes, never losing the diagnostic to a decoder failure.
 * @param decoder - decoder to use.
 * @param bytes - captured bytes.
 * @returns the decoded text; a missing or failing decoder falls back to UTF-8,
 * which substitutes undecodable bytes instead of throwing.
 */
function decode(decoder: TextDecoder | undefined, bytes: Buffer): string {
  if (decoder === undefined) return bytes.toString('utf8')
  try {
    return decoder.decode(bytes)
  } catch {
    // A failed decode must not become a second failure the user has to interpret.
    return bytes.toString('utf8')
  }
}

/** Append the tail of a remote stderr stream to a failure reason. */
function stderrDetail(stderr: string): string {
  const trimmed = stderr.trim()
  return trimmed === '' ? '' : `; stderr: ${trimmed.slice(-MAX_DIAGNOSTIC)}`
}
