/**
 * Lifecycle of the native overlay helper (`dsh-quick-assistant.exe`).
 *
 * The helper owns the global hotkey and the overlay window, so it must outlive
 * panel visibility and follow the plugin's lifetime: the host starts it, pipes
 * its diagnostics into `<DSH_HOME>/gui/quick-assistant.log`, restarts it after
 * an unexpected exit with exponential backoff, and terminates it on disposal.
 * A missing executable is not an error that disables the plugin — the HTTP
 * surface keeps working and `/api/health` reports why no window can appear.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { dshHomePath, resolveDshHome } from './settings.ts'

/** Environment variable that overrides the helper executable (debugging). */
export const HELPER_EXE_ENV = 'DSH_QUICK_ASSISTANT_EXE'

/** Restart attempts after consecutive unexpected exits. */
export const MAX_RESTARTS = 5

/** Backoff of the first restart, doubled per attempt. */
const RESTART_BASE_MS = 500

/** Backoff ceiling. */
const RESTART_MAX_MS = 30_000

/** A helper that stayed up this long resets the restart counter. */
const STABLE_UPTIME_MS = 60_000

/** How long disposal waits for a polite exit before force-killing. */
export const KILL_TIMEOUT_MS = 3_000

/** Log size beyond which the next start truncates it. */
const LOG_MAX_BYTES = 2 * 1024 * 1024

/** Minimal logger face used by the helper (a Cordis named logger satisfies it). */
export interface HelperLogger {
  /** Informational message. */
  info(...args: unknown[]): void
  /** Recoverable problem. */
  warn(...args: unknown[]): void
  /** Failure that changes behavior. */
  error(...args: unknown[]): void
}

/** Current helper availability. */
export interface HelperStatus {
  /** Whether the helper process is alive. */
  running: boolean
  /** Why the helper is not running, when it is not. */
  error?: string
}

/** Inputs of one helper process. */
export interface NativeHelperOptions {
  /** Overlay page URL including the one-time token. */
  url: string
  /** Native-state endpoint URL including the one-time token. */
  api: string
  /** Accelerator registered at startup; later changes arrive through polling. */
  shortcut: string
  /** WebView2 user-data directory. */
  dataDir: string
  /** Append-only diagnostic log. */
  logFile: string
  /** Explicit executable path from the plugin config, when set. */
  executable?: string
  /** Logger of the owning plugin. */
  log: HelperLogger
}

/**
 * Resolve the helper executable: the `DSH_QUICK_ASSISTANT_EXE` override first, then
 * the plugin config, then the file next to the DSH home directory
 * (`<dirname(DSH_HOME)>/dsh-quick-assistant[.exe]`).
 * @param configured - explicit path from the plugin config.
 * @returns the absolute executable path, whether or not it exists.
 */
export function helperExecutablePath(configured?: string): string {
  const fromEnv = process.env[HELPER_EXE_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  if (configured !== undefined && configured.trim() !== '') return resolve(configured.trim())
  const fileName = process.platform === 'win32' ? 'dsh-quick-assistant.exe' : 'dsh-quick-assistant'
  return join(dirname(resolveDshHome()), fileName)
}

/** Timestamped, size-capped append log for helper output. */
class HelperLog {
  private ready = false

  /**
   * @param file - log file path.
   * @param logger - plugin logger receiving the same lines at debug level.
   */
  constructor(private readonly file: string, private readonly logger: HelperLogger) {}

  /** Create the directory and reset an oversized log; failures are non-fatal. */
  prepare(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      if (existsSync(this.file) && statSync(this.file).size > LOG_MAX_BYTES) truncateSync(this.file, 0)
      this.ready = true
    } catch (error) {
      this.logger.warn('[quick-assistant] cannot prepare the helper log:', error)
    }
  }

  /**
   * Append one line with a timestamp prefix.
   * @param line - text without the trailing newline.
   */
  write(line: string): void {
    if (line === '') return
    const stamped = `[${new Date().toISOString()}] ${line}\n`
    this.logger.info('[quick-assistant] helper:', line)
    if (!this.ready) return
    try {
      appendFileSync(this.file, stamped, 'utf8')
    } catch {
      // Losing a diagnostic line must never fail the helper lifecycle.
      this.ready = false
    }
  }
}

/** Buffer child output into complete lines. */
class LineSplitter {
  private buffer = ''

  /**
   * @param onLine - receives each complete line.
   */
  constructor(private readonly onLine: (line: string) => void) {}

  /**
   * Feed one chunk.
   * @param chunk - raw child output.
   */
  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString()
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.onLine(line)
  }

  /** Deliver a trailing partial line (process exit). */
  flush(): void {
    if (this.buffer !== '') this.onLine(this.buffer)
    this.buffer = ''
  }
}

/**
 * Wait for a child process to exit, then escalate.
 *
 * The polite signal goes first; a process still alive after `timeoutMs` is
 * force-killed so disposal can never hang on a stuck helper.
 * @param child - process to stop.
 * @param timeoutMs - grace period before the force kill.
 * @returns fulfillment once the process exited (or the kill was issued).
 */
async function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process already died between the timeout and the kill.
      }
      resolvePromise()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
    try {
      child.kill()
    } catch {
      clearTimeout(timer)
      resolvePromise()
    }
  })
}

/**
 * One native helper process with restart bookkeeping.
 *
 * Shortcut changes do not restart the process: the helper polls the native
 * state endpoint every few seconds and re-registers a changed accelerator
 * itself. Only an unexpected exit (crash) triggers a restart.
 */
export class NativeHelper {
  private child: ChildProcess | undefined
  private restarts = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private lastError: string | undefined
  private startedAt = 0
  private readonly log: HelperLog
  private readonly executable: string

  /**
   * @param options - URLs, shortcut, directories, and logging.
   */
  constructor(private readonly options: NativeHelperOptions) {
    this.executable = helperExecutablePath(options.executable)
    this.log = new HelperLog(options.logFile, options.log)
  }

  /** Current availability, including the reason no process is running. */
  get status(): HelperStatus {
    if (this.child !== undefined && this.child.exitCode === null) return { running: true }
    return this.lastError === undefined ? { running: false } : { running: false, error: this.lastError }
  }

  /** Start the helper once; a missing executable leaves the plugin otherwise usable. */
  start(): void {
    if (this.disposed || this.child !== undefined) return
    this.log.prepare()
    if (!existsSync(this.executable)) {
      this.lastError = `找不到原生助手可执行文件：${this.executable}`
      this.log.write(this.lastError)
      this.options.log.error('[quick-assistant]', this.lastError)
      return
    }
    try {
      mkdirSync(this.options.dataDir, { recursive: true })
    } catch (error) {
      this.lastError = `无法创建助手数据目录：${this.options.dataDir}（${String(error)}）`
      this.log.write(this.lastError)
      this.options.log.error('[quick-assistant]', this.lastError)
      return
    }
    this.spawnChild()
  }

  /** Stop the helper and cancel any pending restart. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    this.log.write('helper termination requested by the plugin')
    await stopChild(child, KILL_TIMEOUT_MS)
  }

  /** Spawn one helper process and wire its output. */
  private spawnChild(): void {
    const { url, api, shortcut, dataDir } = this.options
    const args = ['--url', url, '--api', api, '--shortcut', shortcut, '--data-dir', dataDir]
    this.log.write(`starting ${this.executable} (shortcut: ${shortcut || 'none'})`)
    const child = spawn(this.executable, args, {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.startedAt = Date.now()
    const splitter = new LineSplitter(line => this.log.write(line))
    child.stdout?.on('data', (chunk: Buffer) => splitter.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => splitter.push(chunk))
    let settled = false
    child.once('error', (error: Error) => {
      if (settled) return
      settled = true
      this.child = undefined
      this.lastError = `原生助手启动失败：${error.message}`
      this.log.write(this.lastError)
      this.options.log.error('[quick-assistant]', this.lastError)
      this.scheduleRestart()
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      splitter.flush()
      this.child = undefined
      const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      this.log.write(`helper exited (${detail})`)
      if (this.disposed) return
      this.lastError = `原生助手已退出（${detail}）`
      this.options.log.warn('[quick-assistant]', this.lastError)
      this.scheduleRestart()
    })
  }

  /** Schedule one restart with exponential backoff, up to {@link MAX_RESTARTS}. */
  private scheduleRestart(): void {
    if (this.disposed) return
    if (Date.now() - this.startedAt >= STABLE_UPTIME_MS) this.restarts = 0
    if (this.restarts >= MAX_RESTARTS) {
      this.lastError = `原生助手连续退出，已放弃重启（${MAX_RESTARTS} 次）`
      this.log.write(this.lastError)
      this.options.log.error('[quick-assistant]', this.lastError)
      return
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** this.restarts, RESTART_MAX_MS)
    this.restarts += 1
    this.log.write(`restarting the helper in ${delay} ms (attempt ${this.restarts}/${MAX_RESTARTS})`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.disposed) return
      this.spawnChild()
    }, delay)
    // A pending restart must not keep the host process alive on shutdown.
    this.restartTimer.unref?.()
  }
}

/**
 * Build the helper options for one plugin instance.
 * @param origin - web server origin, e.g. `http://127.0.0.1:1234`.
 * @param token - one-time token the helper's page and polling calls carry.
 * @param shortcut - accelerator registered at startup.
 * @param executable - explicit executable path from the plugin config.
 * @param log - plugin logger.
 * @returns options for {@link NativeHelper}.
 */
export function nativeHelperOptions(
  origin: string,
  token: string,
  shortcut: string,
  executable: string | undefined,
  log: HelperLogger,
): NativeHelperOptions {
  return {
    url: `${origin}/quick-assistant/?token=${token}`,
    api: `${origin}/quick-assistant/api/native?token=${token}`,
    shortcut,
    dataDir: dshHomePath('gui', 'quick-assistant-webview'),
    logFile: dshHomePath('gui', 'quick-assistant.log'),
    ...executable === undefined ? {} : { executable },
    log,
  }
}
