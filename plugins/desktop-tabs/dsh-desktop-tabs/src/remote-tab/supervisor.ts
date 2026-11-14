/**
 * Child process lifecycle of one remote tab.
 *
 * Each saved remote connection owns one child `dsh web` process, started with
 * `--profile remote-tab` and a private `DSH_HOME`; the process prints
 * `dsh web: http://127.0.0.1:<port>/?token=...` once its web server is bound,
 * and the provider's bootstrap plugin prints `[remote-tab-boot] ready …` once
 * the remote workspace is open. `up` reports the loadable URL only after both
 * lines arrived, so the embedded webview never loads a half-initialized
 * backend.
 *
 * The child runs the hosting process's dsh runtime and is spawned with the
 * generated ESM loader (`./loader.ts`) so its profile plugins share the host's
 * core module instances and still reach profile-only packages. The whole
 * backend-specific half — identity, patch, bundles, home files — comes from the
 * {@link RemoteTabProvider}; this module only owns the process.
 *
 * The child environment is built, never inherited as-is: the hosting process
 * runs with `DSH_PROFILE` / `DSH_PROFILE_DIR` set, and passing `--profile`
 * inside a process that already selects one makes the CLI fail
 * (`select a profile only once`). Those keys are dropped, `DSH_HOME` points at
 * the child home, and the target rides in `DSH_REMOTE_TAB_TARGET`.
 *
 * The launch token appears only in the returned URL: child output goes through
 * {@link redactLogLine} before it reaches the status log, an error message, or
 * the host logger.
 *
 * Spawning and the readiness budget are injectable so the package test can run
 * a fake child instead of a real `dsh web` process.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { redactToken, stripAnsi } from '../remote/text.ts'
import type { RemoteLogger } from '../remote/types.ts'
import { remoteDeviceName, remoteTabHome, writeRemoteTabProfile } from './profile.ts'
import {
  nodeSupportsExperimentalLoader,
  selectChildNode,
  selectChildRuntime,
} from './runtime.ts'
import type { ChildNode, ChildRuntime } from './runtime.ts'
import type { RemoteConnectionSpec, RemoteTabProvider, RemoteTabRequest, RemoteTabStatus } from './types.ts'

/** Cap on one status-log line, so one verbose child line cannot flood the panel. */
const MAX_LOG_LINE = 400

/** Cap on the status log kept per tab. */
const MAX_LOG_LINES = 200

/** Lines quoted in one failure message. */
const MAX_TAIL_LINES = 8

/** Default readiness budget: a cold `dsh web` boot plus a remote workspace open. */
export const DEFAULT_READY_TIMEOUT_MS = 90_000

/** Default grace period between SIGTERM and the forced kill. */
export const DEFAULT_TERMINATE_TIMEOUT_MS = 8_000

/**
 * Environment keys the child must not inherit from the desktop Host: the parent
 * profile selection (the child selects `remote-tab` itself), the desktop's own
 * session and web URL, and the plugin-scoped shell hints.
 */
export const SCRUBBED_CHILD_ENV_KEYS = [
  'DSH_PROFILE',
  'DSH_PROFILE_DIR',
  'DSH_PLUGIN_PROFILE',
  'DSH_PLUGIN_DSH_CLI',
  'DSH_SESSION_ID',
  'DSH_SHELL',
  'DSH_WEB_URL',
] as const

/** The line the child web app prints once its listener is bound. */
const LAUNCH_LINE = /\bdsh web: (http:\/\/127\.0\.0\.1:\d+\/?\?token=[^\s'"]+)/u

/** The sentinel the child's bootstrap plugin prints once the workspace is open. */
const BOOT_READY_LINE = /^\[remote-tab-boot\] ready(?:\s|$)/u

/** One child process as this module drives it. */
export interface MinimalChildProcess {
  readonly pid?: number | undefined
  readonly stdout: ChunkStream | null
  readonly stderr: ChunkStream | null
  readonly exitCode?: number | null | undefined
  readonly signalCode?: NodeJS.Signals | null | undefined
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

/** One readable child stream. */
interface ChunkStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

/** The complete spawn request, built once and injected into the spawner. */
export interface ChildSpawnPlan {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  /** Whether the selected executable is Electron and runs in Node mode. */
  readonly electron: boolean
}

/** Injectable spawner; the default spawns a real child process. */
export type ChildSpawner = (plan: ChildSpawnPlan) => MinimalChildProcess

/** Options of one spawn plan. */
export interface ChildSpawnPlanOptions {
  /** Resolved `@deepseek-ai/dsh/lib/bin.js` of the selected child runtime. */
  readonly cliPath: string
  /** Child Harness home; also the working directory. */
  readonly childHome: string
  /** Remote target handed to the bootstrap plugin. */
  readonly target: RemoteConnectionSpec
  /** Selected Node executable (a real Node, or Electron as the last fallback). */
  readonly node: ChildNode
  /** Generated ESM loader the child loads before the CLI. */
  readonly loaderPath?: string
  /** Whether the selected executable supports `--experimental-loader`; defaults to the host's Node version. */
  readonly supportsLoader?: boolean
  /** Parent environment to build the child environment from. */
  readonly env?: NodeJS.ProcessEnv
}

/** Resolved child profile facts one `up` needs. */
export interface PreparedChildProfile {
  readonly cliPath: string
  readonly profileDir?: string
  /** Bundle list the generated profile carries; absent when a test seam prepared it. */
  readonly bundles?: readonly string[]
  /** Generated ESM loader the child loads. */
  readonly loaderPath?: string
}

/** Arguments of the injected profile preparer. */
export interface PrepareChildProfileArgs {
  readonly childHome: string
  readonly serverUrl: string
  /** Selected child runtime; absent when a test seam prepares the profile itself. */
  readonly runtime?: ChildRuntime
}

/** Construction options of one supervisor. */
export interface RemoteTabSupervisorOptions {
  /** Parent Harness home; contains `gui/remote-tabs/`. */
  readonly dshHome: string
  /** Backend provider; absent only when the feature is not composed. */
  readonly provider?: RemoteTabProvider
  /** Hosting profile the child profile links into; resolved generically. */
  readonly parentProfileDir?: string
  /** Hosting runtime directory (may be inside an asar archive). */
  readonly parentRuntimeDir?: string
  /** Explicit child runtime override; selected when absent. */
  readonly childRuntime?: ChildRuntime
  /** Explicit child Node override; selected when absent. */
  readonly childNode?: ChildNode
  /** Explicit child CLI entry; overrides the selected runtime's CLI. */
  readonly cliPath?: string
  /** Hosting executable; defaults to `process.execPath`. */
  readonly hostExecPath?: string
  /** Whether the hosting process is Electron; defaults to detection. */
  readonly hostElectron?: boolean
  /** Parent environment used for selection and for the child environment. */
  readonly env?: NodeJS.ProcessEnv
  /** Injected spawner, for tests. */
  readonly spawn?: ChildSpawner
  /** Readiness budget in milliseconds. */
  readonly readyTimeoutMs?: number
  /** Grace period before the forced kill, in milliseconds. */
  readonly terminateTimeoutMs?: number
  readonly logger?: RemoteLogger
  /** Generate the child profile; defaults to {@link writeRemoteTabProfile}. */
  readonly prepareProfile?: (args: PrepareChildProfileArgs) => Promise<PreparedChildProfile>
}

/** One running child. */
interface ActiveChild {
  readonly url: string
  readonly childHome: string
}

/** Mutable per-tab status record. */
interface StatusRecord {
  state: 'idle' | 'connecting' | 'up' | 'error'
  url?: string
  error?: string
  readonly log: string[]
}

/**
 * Build the spawn plan of one child backend.
 * @param options - CLI, child home, target, selected Node, and loader.
 * @returns command, arguments, environment, and working directory.
 */
export function childSpawnPlan(options: ChildSpawnPlanOptions): ChildSpawnPlan {
  const electron = options.node.electron
  const supportsLoader = options.supportsLoader ?? nodeSupportsExperimentalLoader(process.versions.node)
  // `--profile` selects the profile whose shell bundles boot the web
  // application; `web` is only its shorthand alias, not a subcommand, so it is
  // not passed here. The loader flag must precede the CLI entry.
  const args = [
    ...(electron ? ['--expose-internals'] : []),
    ...(options.loaderPath === undefined || !supportsLoader
      ? []
      : ['--experimental-loader', pathToFileURL(options.loaderPath).href]),
    options.cliPath,
    '--profile',
    'remote-tab',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ]
  return {
    command: options.node.command,
    args,
    env: childEnvironment(options.env ?? process.env, options.childHome, options.target, electron),
    cwd: options.childHome,
    electron,
  }
}

/**
 * Build the child environment: the parent's, minus the desktop's own profile and
 * session selection, plus the child home and target.
 * @param parentEnv - environment to copy.
 * @param childHome - child Harness home.
 * @param target - remote target for the bootstrap plugin.
 * @param electron - whether the child runs under Electron's Node mode.
 * @returns a fresh environment object (the input is never mutated).
 */
export function childEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  childHome: string,
  target: RemoteConnectionSpec,
  electron: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv }
  for (const key of SCRUBBED_CHILD_ENV_KEYS) delete env[key]
  env.DSH_HOME = childHome
  env.DSH_REMOTE_TAB_TARGET = JSON.stringify(target)
  if (electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/**
 * Parse the child's launch line.
 * @param line - one output line.
 * @returns the tokenized loopback URL, or undefined.
 */
export function parseChildLaunchLine(line: string): string | undefined {
  const match = LAUNCH_LINE.exec(line)
  return match?.[1]
}

/** Whether one output line is the bootstrap ready sentinel. */
export function isBootReadyLine(line: string): boolean {
  return BOOT_READY_LINE.test(line)
}

/**
 * Normalize one child output line for the status log and error tails: drop
 * terminal control sequences, mask `token=` values, collapse whitespace, cap
 * the length.
 * @param text - raw line.
 * @returns a single bounded, token-free line.
 */
export function redactLogLine(text: string): string {
  const flat = stripAnsi(text).replace(/\s+/gu, ' ').trim()
  const safe = redactToken(flat)
  return safe.length > MAX_LOG_LINE ? `${safe.slice(0, MAX_LOG_LINE)}…` : safe
}

/**
 * In-process supervisor of the remote-tab children.
 *
 * One child per connection id; `up` reuses an established child, `down` stops
 * it while keeping the child home and identity, `forget` also revokes the child
 * device and removes the home, and `dispose` stops everything without deleting
 * homes.
 */
export class RemoteTabSupervisor {
  private readonly options: RemoteTabSupervisorOptions
  private readonly children = new Map<string, MinimalChildProcess>()
  private readonly active = new Map<string, ActiveChild>()
  private readonly pending = new Map<string, Promise<{ url: string }>>()
  private readonly records = new Map<string, StatusRecord>()
  /** Tabs whose child this supervisor is deliberately stopping. */
  private readonly stopping = new Set<string>()
  private disposed = false

  constructor(options: RemoteTabSupervisorOptions) {
    this.options = options
  }

  /** One row per tab with recorded state. */
  status(): RemoteTabStatus[] {
    return [...this.records].map(([id, record]) => ({
      id,
      state: record.state,
      log: [...record.log],
      ...(record.url === undefined ? {} : { url: record.url }),
      ...(record.error === undefined ? {} : { error: record.error }),
    }))
  }

  /**
   * Start (or reuse) the child backend of one remote tab.
   * @param request - the saved row's id/title plus its `remote` descriptor.
   * @returns the loadable tokenized URL.
   */
  async up(request: RemoteTabRequest): Promise<{ url: string }> {
    if (this.disposed) throw new Error('remote-tab supervisor is disposed')
    const id = request.id.trim()
    if (id === '') throw new Error('a remote tab id is required')
    const established = this.active.get(id)
    if (established !== undefined) return { url: established.url }
    const inFlight = this.pending.get(id)
    if (inFlight !== undefined) return await inFlight
    const attempt = this.establish(id, request)
    this.pending.set(id, attempt)
    try {
      return await attempt
    } finally {
      this.pending.delete(id)
    }
  }

  /**
   * Stop the child backend of one tab. The child home and identity stay, so the
   * next `up` reuses the same device.
   * @param rawId - the saved connection id.
   */
  async down(rawId: string): Promise<void> {
    const id = rawId.trim()
    if (id === '') return
    const inFlight = this.pending.get(id)
    // An aborted attempt reports its own failure; `down` only has to outlast it.
    if (inFlight !== undefined) await inFlight.catch(() => undefined)
    await this.stop(id)
    this.active.delete(id)
    this.records.delete(id)
    this.options.logger?.info(`[dsh-desktop-tabs] remote-tab '${id}' is down`)
  }

  /**
   * Stop the child backend, revoke its device, and remove its home. A failed
   * revocation is logged but does not keep the home alive.
   * @param rawId - the saved connection id.
   */
  async forget(rawId: string): Promise<void> {
    const id = rawId.trim()
    if (id === '') return
    const childHome = remoteTabHome(this.options.dshHome, id)
    await this.down(id)
    const provider = this.options.provider
    if (provider !== undefined) {
      try {
        await provider.revokeIdentity({ childHome })
      } catch (error: unknown) {
        this.options.logger?.warn(`[dsh-desktop-tabs] remote-tab '${id}' device revocation failed: ${redactLogLine(message(error))}`)
      }
    }
    rmSync(childHome, { recursive: true, force: true })
    this.options.logger?.info(`[dsh-desktop-tabs] remote-tab '${id}' forgotten`)
  }

  /** Stop every child; child homes and identities are kept. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const ids = [...this.children.keys()]
    await Promise.all(ids.map(async (id) => await this.stop(id)))
    this.active.clear()
    this.records.clear()
    this.pending.clear()
  }

  /** Run one attempt and record its outcome. */
  private async establish(id: string, request: RemoteTabRequest): Promise<{ url: string }> {
    const record = this.record(id)
    record.state = 'connecting'
    record.log.length = 0
    delete record.url
    delete record.error
    this.note(record, `开始启动远程标签：${request.remote.targetName ?? request.remote.targetDeviceId} · ${request.remote.workspacePath}`)

    try {
      this.assertRemoteTabContext()
      const provider = this.requireProvider()
      // Pick the real runtime and Node before any network work: a broken launch
      // environment must fail with a clear message, not a hung child. A test
      // seam that prepares the profile itself may omit the runtime entirely.
      const runtime = this.options.prepareProfile === undefined ? this.childRuntime() : this.options.childRuntime
      const node = this.childNode()
      if (node.kind === 'electron-fallback' && runtime?.kind === 'parent-asar') {
        throw new Error(
          '找不到真实 Node：子后端的 ESM loader 无法从 asar 运行时解析模块。'
          + '请设置 DSH_REMOTE_TAB_NODE 指向 node，或把 node 加入 PATH，'
          + `或通过 DSH_REMOTE_TAB_RUNTIME 指定真实运行时（当前回退：${runtime.runtimeDir}）`,
        )
      }
      if (node.warning !== undefined) this.log('warn', `[dsh-desktop-tabs] ${node.warning}`)
      if (runtime?.kind === 'parent-asar') {
        this.log('warn', '[dsh-desktop-tabs] 子后端回退到 asar 打包运行时：真实 Node 无法加载 asar 内的模块，'
          + '请在宿主运行环境安装 .harness 运行时或设置 DSH_REMOTE_TAB_RUNTIME')
      }
      const childHome = remoteTabHome(this.options.dshHome, id)
      const deviceName = remoteDeviceName(request.title)
      const identity = await provider.ensureIdentity({ childHome, deviceName })
      this.note(record, `子设备已就绪（${identity.deviceId.slice(0, 8)}），目标 ${request.remote.targetDeviceId.slice(0, 8)}`)
      this.note(record, runtime === undefined
        ? `子后端 Node：${node.command}（${node.kind}）`
        : `子后端运行时：${runtime.runtimeDir}（${runtime.kind}）；Node：${node.command}（${node.kind}）`)
      mkdirSync(childHome, { recursive: true })
      const prepared = await this.prepareProfile(childHome, identity.serverUrl, runtime)
      const readyBundle = provider.readyBundle
      if (prepared.bundles !== undefined && readyBundle !== undefined && !prepared.bundles.includes(readyBundle)) {
        // Without the bootstrap plugin the child would boot its UI but never open
        // the remote workspace nor print the ready sentinel; fail fast instead of
        // waiting out the 90-second budget.
        throw new Error(
          `远程标签启动插件 ${readyBundle} 尚未安装：请先在宿主应用中构建并安装该插件，再打开远程标签`,
        )
      }
      const plan = childSpawnPlan({
        cliPath: prepared.cliPath,
        childHome,
        target: request.remote,
        node,
        ...(prepared.loaderPath === undefined ? {} : { loaderPath: prepared.loaderPath }),
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
      })
      this.note(record, `启动子后端（${plan.command}${plan.electron ? ' [Electron node 模式]' : ''}${plan.args.includes('--experimental-loader') ? ' --experimental-loader <loader>' : ''} --profile remote-tab --host 127.0.0.1 --port 0 --no-open）`)
      const child = this.spawner(plan)
      this.children.set(id, child)
      this.watchExit(id, child)
      const { url } = await waitForChildReady(child, {
        timeoutMs: this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        log: record.log,
      })
      this.active.set(id, { url, childHome })
      record.state = 'up'
      record.url = url
      this.note(record, '子后端已就绪')
      return { url }
    } catch (error: unknown) {
      await this.stop(id)
      const reason = redactToken(message(error))
      record.state = 'error'
      record.error = reason
      this.note(record, `启动失败：${reason}`)
      throw new Error(reason)
    }
  }

  /**
   * Generate the child profile (default) or ask the injected preparer. The
   * provider's bundles, patch, and home files all come from the provider
   * descriptor, so the generic core never names a backend plugin; the chosen
   * runtime supplies the child CLI and the loader's first anchor.
   */
  private async prepareProfile(
    childHome: string,
    serverUrl: string,
    runtime: ChildRuntime | undefined,
  ): Promise<PreparedChildProfile> {
    if (this.options.prepareProfile !== undefined) {
      return await this.options.prepareProfile({
        childHome,
        serverUrl,
        ...(runtime === undefined ? {} : { runtime }),
      })
    }
    if (runtime === undefined) throw new Error('远程标签功能不可用：未选择子后端运行时')
    const profile = writeRemoteTabProfile({
      parentProfileDir: this.parentProfileDir(),
      parentDshHome: this.options.dshHome,
      childHome,
      serverUrl,
      provider: this.requireProvider(),
      runtimeDir: runtime.runtimeDir,
      runtimeAnchor: runtime.anchor,
      cliPath: this.options.cliPath ?? runtime.cliPath,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    })
    return {
      cliPath: profile.cliPath,
      profileDir: profile.profileDir,
      bundles: profile.bundles,
      loaderPath: profile.loaderPath,
    }
  }

  /** Select (or accept) the child runtime, preferring a real installation over asar. */
  private childRuntime(): ChildRuntime {
    if (this.options.childRuntime !== undefined) return this.options.childRuntime
    return selectChildRuntime({
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      dshHome: this.options.dshHome,
      ...(this.options.parentRuntimeDir === undefined ? {} : { parentRuntimeDir: this.options.parentRuntimeDir }),
    })
  }

  /** Select (or accept) the child Node, preferring a real Node over Electron. */
  private childNode(): ChildNode {
    if (this.options.childNode !== undefined) return this.options.childNode
    return selectChildNode({
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      dshHome: this.options.dshHome,
      ...(this.options.parentRuntimeDir === undefined ? {} : { parentRuntimeDir: this.options.parentRuntimeDir }),
      hostExecPath: this.options.hostExecPath ?? process.execPath,
      hostElectron: this.options.hostElectron ?? process.versions.electron !== undefined,
    })
  }

  /** Fail fast with an actionable message when the feature was not composed. */
  private requireProvider(): RemoteTabProvider {
    const provider = this.options.provider
    if (provider === undefined) {
      throw new Error('远程标签功能不可用：未配置远程后端 provider')
    }
    return provider
  }

  /** Fail fast with an actionable message when the launch facts are absent. */
  private assertRemoteTabContext(): void {
    if (this.options.prepareProfile !== undefined) {
      this.requireProvider()
      return
    }
    this.requireProvider()
    if (this.options.parentProfileDir === undefined) {
      throw new Error('远程标签功能不可用：无法解析父 profile 目录（argv[3] / DSH_PROFILE_DIR / DSH_HOME/profiles/<profile>）')
    }
  }

  /** The parent profile directory, or a clear error. */
  private parentProfileDir(): string {
    const directory = this.options.parentProfileDir
    if (directory === undefined) {
      throw new Error('远程标签功能不可用：无法解析父 profile 目录')
    }
    return directory
  }

  /** The spawner: injected by tests, the real `child_process.spawn` by default. */
  private spawner(plan: ChildSpawnPlan): MinimalChildProcess {
    const inject = this.options.spawn
    if (inject !== undefined) return inject(plan)
    return nodeSpawn(plan.command, [...plan.args], {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as MinimalChildProcess
  }

  /** Mark an unexpected child exit as an error, unless this supervisor stopped it. */
  private watchExit(id: string, child: MinimalChildProcess): void {
    child.once('exit', (code, signal) => {
      if (this.children.get(id) === child) this.children.delete(id)
      if (this.stopping.has(id)) return
      const established = this.active.get(id)
      if (established === undefined) return
      this.active.delete(id)
      const record = this.record(id)
      record.state = 'error'
      record.error = `子后端已退出（code ${code ?? 'null'}${signal === null ? '' : `, signal ${signal}`}）`
      delete record.url
      this.note(record, record.error)
    })
  }

  /** Stop one child, keeping homes and identities. */
  private async stop(id: string): Promise<void> {
    const child = this.children.get(id)
    if (child === undefined) return
    this.children.delete(id)
    this.stopping.add(id)
    try {
      await terminateChild(child, this.options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS, this.options.logger)
    } finally {
      this.stopping.delete(id)
    }
  }

  /** The tab's mutable record, created on first use. */
  private record(id: string): StatusRecord {
    let record = this.records.get(id)
    if (record === undefined) {
      record = { state: 'idle', log: [] }
      this.records.set(id, record)
    }
    return record
  }

  /** Append one bounded, token-free line to the tab log and the host logger. */
  private note(record: StatusRecord, line: string): void {
    const text = redactLogLine(line)
    record.log.push(text)
    if (record.log.length > MAX_LOG_LINES) record.log.splice(0, record.log.length - MAX_LOG_LINES)
    this.options.logger?.info(`[dsh-desktop-tabs] ${text}`)
  }
}

/**
 * Create a remote-tab supervisor.
 * @param options - paths, injected identity/profile hooks, and test seams.
 * @returns the supervisor the routes and host entry drive.
 */
export function createRemoteTabSupervisor(options: RemoteTabSupervisorOptions): RemoteTabSupervisor {
  return new RemoteTabSupervisor(options)
}

/**
 * Wait for both child readiness signals: the web launch line and the bootstrap
 * sentinel. Either arrival order is accepted.
 * @param child - spawned child process.
 * @param options - readiness budget and the log the child output is mirrored to.
 * @returns the loadable tokenized URL.
 */
export function waitForChildReady(
  child: MinimalChildProcess,
  options: { timeoutMs: number; log: string[] },
): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    let url: string | undefined
    let ready = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (error !== undefined) reject(error)
      else if (url === undefined) reject(new Error('子后端没有输出启动地址'))
      else resolve({ url })
    }
    const check = (): void => {
      if (url !== undefined && ready) finish()
    }
    const onLine = (raw: string): void => {
      const line = redactLogLine(raw)
      if (line === '') return
      options.log.push(line)
      if (options.log.length > MAX_LOG_LINES) options.log.splice(0, options.log.length - MAX_LOG_LINES)
      if (url === undefined) {
        const parsed = parseChildLaunchLine(raw)
        if (parsed !== undefined) url = parsed
      }
      if (!ready && isBootReadyLine(raw)) ready = true
      check()
    }
    const stdout = lineReader(onLine)
    const stderr = lineReader(onLine)
    child.stdout?.on('data', stdout)
    child.stderr?.on('data', stderr)
    child.once('exit', (code, signal) => {
      finish(new Error(`子后端在就绪前退出（code ${code ?? 'null'}${signal === null ? '' : `, signal ${signal}`}）：${tail(options.log)}`))
    })
    child.once('error', (error) => {
      finish(new Error(`子后端启动失败：${redactLogLine(message(error))}`))
    })
    timer = setTimeout(() => {
      finish(new Error(`等待子后端就绪超时（${options.timeoutMs} 毫秒）：${tail(options.log)}`))
    }, options.timeoutMs)
  })
}

/** One line-splitting reader for a child stream, reporting each complete line. */
function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = ''
  return (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/u, '')
      buffer = buffer.slice(index + 1)
      onLine(line)
      index = buffer.indexOf('\n')
    }
    // A child that never emits a newline must not grow the buffer without bound.
    if (buffer.length > 64 * 1024) {
      onLine(buffer)
      buffer = ''
    }
  }
}

/** The last lines of a child log, for one failure message. */
function tail(lines: readonly string[]): string {
  const selected = lines.slice(-MAX_TAIL_LINES)
  if (selected.length === 0) return '（子后端没有输出）'
  const joined = selected.join(' / ')
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined
}

/**
 * Stop one child: SIGTERM, then a forced kill after the grace period (on
 * Windows `taskkill /T /F` first, so a wrapper's children die too).
 * @param child - child to stop.
 * @param timeoutMs - grace period between the polite and forced kill.
 * @param logger - optional warning sink.
 */
export async function terminateChild(
  child: MinimalChildProcess,
  timeoutMs: number,
  logger?: RemoteLogger,
): Promise<void> {
  if (child.exitCode !== null && child.exitCode !== undefined) return
  if (child.signalCode !== null && child.signalCode !== undefined) return
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => { resolve() })
  })
  try {
    child.kill('SIGTERM')
  } catch (error: unknown) {
    logger?.warn(`[dsh-desktop-tabs] remote-tab child SIGTERM failed: ${message(error)}`)
  }
  if (await within(exited, timeoutMs)) return
  logger?.warn(`[dsh-desktop-tabs] remote-tab child did not exit after SIGTERM; forcing termination`)
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      child.kill('SIGKILL')
    } catch (error: unknown) {
      logger?.warn(`[dsh-desktop-tabs] remote-tab child SIGKILL failed: ${message(error)}`)
    }
  }
  await within(exited, 5_000)
}

/** Whether a promise settled within the budget. */
async function within(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, timeoutMs)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
