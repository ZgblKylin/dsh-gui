/**
 * Connection lifecycle of one remote tab, backed by a remote tmux session.
 *
 * `up` runs the chain verified by hand in
 * `docs/dsh-gui/2026-10-03-desktop-tabs-prototype.md` ("远程连接链路"): prove the
 * alias is reachable, ensure the `dsh-gui` tmux session on the remote host runs
 * the backend (starting it when missing or stale, reusing it when alive),
 * discover its serving port and the launch token, forward the port with
 * `ssh -L`, and only report `up` once the tunneled port answers `401` bare and
 * `303`/2xx with the token (a legacy dsh answers `2xx` bare). The remote shell
 * commands live in `./commands.ts`.
 *
 * A reused session that stays dead is restarted — but only after SSH is proven
 * reachable again, so a network drop around the tunnel never kills a running
 * backend. Failure paths tear down only what this attempt created: its tunnel
 * and a session this attempt started; a reused ALIVE session is never killed on
 * failure. Closing the tab or exiting (`down` / `dispose`) tears the local side
 * down only and never touches the remote session, so the backend keeps serving
 * and the next `up` reuses it.
 *
 * Every step writes one Chinese line into a bounded per-tab log, which `status`
 * exposes for the client's connection panel; the launch token never enters that
 * log, and the log is cleared when the connection goes down.
 */

import type { ChildProcess } from 'node:child_process'

import {
  CD_FAILED_MARKER,
  PROBE_MARKER,
  REMOTE_LOG,
  TMUX_SESSION,
  describeLaunch,
  healthVerdict,
  isValidToken,
  killSessionScript,
  launchUrlFromLogScript,
  parseLaunchToken,
  parseLaunchUrl,
  parsePanePort,
  parseSessionState,
  paneStartCommandScript,
  persistTokenScript,
  probeScript,
  resolveTarget,
  sessionStateScript,
  startSessionScript,
  storedTokenScript,
  waitForLaunchUrlScript,
  type RemoteLaunch,
  type RemoteTarget,
} from './commands.ts'
import { readConfiguredSshTabs } from './config.ts'
import { findFreeLocalPort } from './ports.ts'
import { mergeTargetRows } from './rows.ts'
import { openTunnel, runSsh, terminate, SshCommandError, type TunnelHandle } from './ssh.ts'
import { redactToken, stripAnsi } from './text.ts'
import type {
  RemoteConnectionStatus,
  RemoteConnections,
  RemoteConnectionsOptions,
  RemoteTab,
} from './types.ts'

/** Budget of the SSH reachability probe. */
const PROBE_TIMEOUT_MS = 20_000

/** Budget of the tmux session-state read. */
const STATE_TIMEOUT_MS = 20_000

/** Budget of the restart command, which returns as soon as the session is created. */
const START_TIMEOUT_MS = 30_000

/** Budget of the pane-command read used for port discovery. */
const DISCOVER_TIMEOUT_MS = 20_000

/** Budget of the launch-URL wait, which outlasts the loop in `waitForLaunchUrlScript`. */
const LAUNCH_WAIT_TIMEOUT_MS = 100_000

/** Budget of one token-file read or write. */
const TOKEN_READ_TIMEOUT_MS = 20_000

/** Budget of one token-file write. */
const TOKEN_WRITE_TIMEOUT_MS = 20_000

/** Budget of one session-cleanup command on a failed attempt. */
const CLEANUP_TIMEOUT_MS = 20_000

/** How long the health wait may last for a session this attempt just started. */
const BOOT_TIMEOUT_MS = 90_000

/** How long the health wait may last for a reused (presumably live) session. */
const REUSE_TIMEOUT_MS = 25_000

/** Pause between health probes. */
const HEALTH_INTERVAL_MS = 800

/** Pause between token re-harvests while the backend boots. */
const TOKEN_HARVEST_MS = 4_000

/** Connection-log lines kept per tab; the oldest lines are dropped first. */
const MAX_LOG_LINES = 200

/** Characters kept per log line, so one verbose command cannot flood the panel. */
const MAX_LOG_LINE = 400

/** One established connection. */
interface ActiveConnection {
  readonly url: string
  readonly tunnel: TunnelHandle
  readonly remote: RemoteLaunch
}

/** Mutable per-tab state behind {@link RemoteConnectionStatus}. */
interface ConnectionRecord {
  state: 'idle' | 'connecting' | 'up' | 'error'
  url?: string
  error?: string
  readonly log: string[]
}

/** Default in-process implementation of {@link RemoteConnections}. */
export class RemoteConnectionManager implements RemoteConnections {
  private readonly options: RemoteConnectionsOptions
  /** Last known state and log per tab; absent means no attempt yet. */
  private readonly records = new Map<string, ConnectionRecord>()
  /** Established connections by tab id. */
  private readonly active = new Map<string, ActiveConnection>()
  /** In-flight `up` calls by tab id, so concurrent requests share one attempt. */
  private readonly pending = new Map<string, Promise<{ url: string }>>()
  /** Every ssh client currently owned by a tab, aborted by `down` and `dispose`. */
  private readonly children = new Map<string, Set<ChildProcess>>()
  private disposed = false

  constructor(options: RemoteConnectionsOptions) {
    this.options = options
  }

  /** @inheritdoc */
  status(): RemoteConnectionStatus[] {
    const rows = new Map<string, RemoteConnectionStatus>()
    for (const tab of readConfiguredSshTabs(this.options.dshHome)) rows.set(tab.id, { id: tab.id, state: 'idle', log: [] })
    for (const [id, record] of this.records) {
      rows.set(id, {
        id,
        state: record.state,
        log: [...record.log],
        ...(record.url === undefined ? {} : { url: record.url }),
        ...(record.error === undefined ? {} : { error: record.error }),
      })
    }
    return [...rows.values()]
  }

  /** @inheritdoc */
  async up(tabId: string): Promise<{ url: string }> {
    if (this.disposed) throw new Error('remote connections are disposed')
    const id = tabId.trim()
    if (id === '') throw new Error('a tab id is required')
    const established = this.active.get(id)
    if (established !== undefined) return { url: established.url }
    const inFlight = this.pending.get(id)
    if (inFlight !== undefined) return await inFlight
    const attempt = this.establish(id)
    this.pending.set(id, attempt)
    try {
      return await attempt
    } finally {
      this.pending.delete(id)
    }
  }

  /** @inheritdoc */
  async down(tabId: string): Promise<void> {
    const id = tabId.trim()
    if (id === '') return
    for (const child of [...(this.children.get(id) ?? [])]) terminate(child)
    const inFlight = this.pending.get(id)
    // An aborted attempt reports its own failure; `down` only has to outlast it.
    if (inFlight !== undefined) await inFlight.catch(() => undefined)
    const established = this.active.get(id)
    if (established !== undefined) {
      this.active.delete(id)
      terminate(established.tunnel.child)
    }
    // 只断开本地隧道，不发任何远端命令；后端继续在 tmux 会话中运行，下次 `up` 复用。
    this.records.delete(id)
    this.log('info', `[dsh-desktop-tabs] remote '${id}' is down`)
  }

  /** @inheritdoc */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const owned of this.children.values()) for (const child of owned) terminate(child)
    this.children.clear()
    for (const [id, established] of [...this.active]) {
      this.active.delete(id)
      terminate(established.tunnel.child)
    }
    // 远端后端由 tmux 会话持有，退出不触碰，下次启动直接复用。
    this.records.clear()
  }

  /** Run one attempt and record its outcome; teardown runs on every failure path. */
  private async establish(id: string): Promise<{ url: string }> {
    const record = this.record(id)
    record.state = 'connecting'
    record.log.length = 0
    delete record.url
    delete record.error
    this.note(id, `开始连接 ${id}`)
    let launch: RemoteLaunch | undefined
    let tunnel: TunnelHandle | undefined
    let startedHere = false
    try {
      const target = await this.targetFor(id)
      this.note(id, `目标 ${target.host}，工作目录 ${target.workdir === '' ? '$HOME' : target.workdir}`)
      await this.probeRemote(id, target)
      const ensured = await this.ensureSession(id, target)
      launch = ensured.launch
      startedHere = ensured.startedHere
      let url: string | undefined
      let attempt = 0
      while (url === undefined) {
        attempt++
        const remotePort = await this.discoverRemotePort(id, target)
        this.note(id, `已采集远端端口 ${remotePort}`)
        const localPort = await findFreeLocalPort()
        tunnel = await this.track(id, openTunnel({ host: target.host, localPort, remotePort }))
        this.note(id, `隧道已建立：127.0.0.1:${localPort} → ${target.host}:${remotePort}`)
        try {
          const health = await this.waitForHealthy(id, target.host, tunnel, attempt === 1 && !startedHere ? REUSE_TIMEOUT_MS : BOOT_TIMEOUT_MS)
          url = health.url
          this.note(id, `健康检查通过：/ 返回 ${health.bare}，/?token=... 返回 ${health.withToken ?? '—'}`)
        } catch (error) {
          // 拆掉的隧道或断开的网络从不构成重启理由：只有「隧道仍在、后端不答」才可能
          // 判断后端已死，且重启前必须先证 SSH 仍可达，避免误杀正在运行的后端。
          if (tunnel !== undefined && (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null)) throw error
          if (startedHere || attempt > 1) throw error
          await this.probeRemote(id, target)
          this.note(id, '远端后端未响应，判定失效，在 tmux 中重启 dsh', 'warn')
          startedHere = await this.startSession(id, target, true)
          // 重启会换端口，先撤掉旧隧道的本地转发，下一轮再开新隧道。
          if (tunnel !== undefined) {
            terminate(tunnel.child)
            tunnel = undefined
          }
        }
      }
      // 循环只在隧道建立且健康检查通过后才设置 `url`，因此此处隧道必已就绪。
      const establishedTunnel: TunnelHandle = tunnel as TunnelHandle
      this.active.set(id, { url, tunnel: establishedTunnel, remote: launch })
      record.state = 'up'
      record.url = url
      this.note(id, `连接就绪：${url}`)
      return { url }
    } catch (error) {
      terminate(tunnel?.child)
      if (startedHere && launch !== undefined) {
        await this.killSession(id, launch.host, `failed connection to '${id}'`)
      }
      const reason = withPortHint(redactToken(message(error)))
      record.state = 'error'
      record.error = reason
      this.note(id, `连接失败：${reason}`, 'warn')
      throw new Error(reason)
    }
  }

  /** Resolve the tab's SSH descriptor from the callback rows, then the config file. */
  private async targetFor(id: string): Promise<RemoteTarget> {
    const fromSource = mergeTargetRows(await this.options.tabs()).find(row => row.id === id)
    const fromConfig = readConfiguredSshTabs(this.options.dshHome).find(row => row.id === id)
    const candidates = [fromSource, fromConfig].filter((row): row is RemoteTab => row !== undefined)
    const described = candidates.find(row => row.ssh !== undefined)
    if (described !== undefined) return resolveTarget(id, described)
    if (candidates.length === 0) {
      throw new Error(`tab '${id}' is not a configured SSH target: no row with that id in the tab or connection list`)
    }
    throw new Error(`tab '${id}' has no "ssh" descriptor (add {"ssh": {"host": "<alias>"}} to its row in gui/desktop-tabs.json)`)
  }

  /** Prove the alias answers a non-interactive command before anything is started. */
  private async probeRemote(id: string, target: RemoteTarget): Promise<void> {
    const stdout = await this.runTracked(id, target.host, probeScript(), PROBE_TIMEOUT_MS)
    if (!stdout.includes(PROBE_MARKER)) {
      throw new Error(`ssh '${target.host}' answered without the reachability marker`)
    }
    this.note(id, `SSH 连通性正常：${target.host}`)
  }

  /**
   * Ensure the remote session is running the backend, reusing one that is
   * ALIVE. A MISSING/STALE session is restarted with the configured launch;
   * `startedHere` tells the caller which sessions a later failure may clean up.
   */
  private async ensureSession(id: string, target: RemoteTarget): Promise<{ launch: RemoteLaunch; startedHere: boolean }> {
    const stdout = await this.runTracked(id, target.host, sessionStateScript(), STATE_TIMEOUT_MS)
    const state = parseSessionState(stdout)
    if (state === 'ALIVE') {
      this.note(id, `复用远端 tmux 会话 ${TMUX_SESSION}（后端已存在）`)
      return { launch: launchFor(target.host), startedHere: false }
    }
    this.note(id, `远端 tmux 会话 ${TMUX_SESSION} 状态：${state}，启动远端 dsh：${describeLaunch(target)}`)
    // 仅在确认会话已死（STALE）时先 kill；MISSING 分支直接 new，避免并发首连互相杀会话。
    const startedHere = await this.startSession(id, target, state === 'STALE')
    return { launch: launchFor(target.host), startedHere }
  }

  /**
   * Create the remote session with the configured launch, clearing the stale
   * token first. A `new-session` "duplicate session" failure means a concurrent
   * tab for the same host created it in between: an ALIVE session is reused and
   * reported as not-ours, and a MISSING-branch attempt that finds only a stale
   * duplicate retries once with the stale session cleaned first.
   * @param cleanExisting - kill any existing session before creating a new one.
   * @returns whether this call created the session.
   */
  private async startSession(id: string, target: RemoteTarget, cleanExisting: boolean): Promise<boolean> {
    try {
      await this.runTracked(id, target.host, startSessionScript(target, cleanExisting), START_TIMEOUT_MS)
      return true
    } catch (error) {
      const state = parseSessionState(await this.runTracked(id, target.host, sessionStateScript(), STATE_TIMEOUT_MS).catch(() => ''))
      if (state === 'ALIVE') return false
      if (!cleanExisting) return await this.startSession(id, target, true)
      throw new Error(`tmux 会话 ${TMUX_SESSION} 启动失败：${message(error)}`)
    }
  }

  /** Discover the remote serving port: the pane's `--port` first, the launch URL otherwise. */
  private async discoverRemotePort(id: string, target: RemoteTarget): Promise<number> {
    const pane = await this.runTracked(id, target.host, paneStartCommandScript(), DISCOVER_TIMEOUT_MS)
    const port = parsePanePort(pane)
    if (port > 0) return port
    // `--port 0` (or an unparsable pane) means the real port is in the launch URL.
    const stdout = await this.waitForLaunchUrl(id, target)
    return parseLaunchUrl(target.host, stdout).remotePort
  }

  /** Wait for the launch URL in the session log, translating a bad workdir. */
  private async waitForLaunchUrl(id: string, target: RemoteTarget): Promise<string> {
    try {
      return await this.runTracked(id, target.host, waitForLaunchUrlScript(), LAUNCH_WAIT_TIMEOUT_MS)
    } catch (error) {
      const text = error instanceof SshCommandError ? `${error.stderr}\n${error.stdout}` : message(error)
      const missing = new RegExp(`${CD_FAILED_MARKER}(.*)$`, 'm').exec(text)
      if (missing !== null) {
        const path = (missing[1] ?? '').trim() || target.workdir
        throw new Error(`远端工作目录不可进入：${path}（${target.host}）`)
      }
      throw new Error(`远端 dsh 未在限定时间内输出启动地址（${target.host}）：${summarize(text)}`)
    }
  }

  /** Read the launch token: the persisted file first, then the session log (persisted back). */
  private async readRemoteToken(id: string, host: string): Promise<string | null> {
    const stored = (await this.runTracked(id, host, storedTokenScript(), TOKEN_READ_TIMEOUT_MS)).trim()
    if (isValidToken(stored)) return stored
    const tail = await this.runTracked(id, host, launchUrlFromLogScript(), TOKEN_READ_TIMEOUT_MS)
    const token = parseLaunchToken(tail)
    if (token === null) return null
    await this.runTracked(id, host, persistTokenScript(token), TOKEN_WRITE_TIMEOUT_MS).catch(() => undefined)
    return token
  }

  /** One token read per attempt, with a quiet window while the backend boots. */
  private tokenHarvester(id: string, host: string): () => Promise<string | null> {
    let cached: string | null | undefined
    let lastTry = 0
    return async () => {
      const now = Date.now()
      if (cached !== undefined && cached !== null) return cached
      if (now - lastTry < TOKEN_HARVEST_MS) return cached ?? null
      lastTry = now
      cached = await this.readRemoteToken(id, host)
      return cached
    }
  }

  /**
   * Wait until the tunneled port answers as the remote backend does, probing the
   * bare path and, once a token is available, the tokenized path. The token is
   * re-harvested while the backend boots; the launch token never appears in any
   * log line.
   * @returns the loadable URL (with the token when one authenticates) and the observed statuses.
   */
  private async waitForHealthy(id: string, host: string, tunnel: TunnelHandle, budgetMs: number): Promise<{ url: string; bare: number; withToken: number | undefined }> {
    const { localPort } = tunnel
    const harvest = this.tokenHarvester(id, host)
    const base = `http://127.0.0.1:${localPort}/`
    const deadline = Date.now() + budgetMs
    let bare: number | undefined
    let withToken: number | undefined
    let lastError = ''
    while (Date.now() < deadline) {
      if (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) {
        throw new Error(`the local forward 127.0.0.1:${localPort} -> ${host}:${tunnel.remotePort} exited before the health check passed`)
      }
      try {
        bare = await probe(base)
        if (healthVerdict(bare, undefined)) return { url: base, bare, withToken: undefined }
        const token = await harvest()
        if (token !== null) {
          const tokened = `${base}?token=${encodeURIComponent(token)}`
          withToken = await probe(tokened)
          if (healthVerdict(bare, withToken)) return { url: tokened, bare, withToken }
        }
      } catch (error) {
        lastError = message(error)
      }
      await delay(HEALTH_INTERVAL_MS)
    }
    throw new Error(
      `health check through 127.0.0.1:${localPort} timed out: / answered ${bare ?? 'nothing'}, `
      + `/?token=... answered ${withToken ?? 'nothing'}`
      + (lastError === '' ? '' : `; last error: ${lastError}`),
    )
  }

  /** Reclaim one remote session this attempt created, best-effort. */
  private async killSession(id: string, host: string, reason: string): Promise<void> {
    try {
      await this.runTracked(id, host, killSessionScript(), CLEANUP_TIMEOUT_MS)
    } catch (error) {
      this.log('warn', `[dsh-desktop-tabs] remote tmux cleanup on '${host}' failed (${reason}): ${message(error)}`)
    }
  }

  /** Run one remote command with the tab's ownership recorded. */
  private async runTracked(id: string, host: string, command: string, timeoutMs: number): Promise<string> {
    const run = runSsh(host, command, { timeoutMs })
    this.track(id, run.child)
    return (await run.done).stdout
  }

  /** Record one owned ssh client, or a pending tunnel's client once it exists. */
  private track(id: string, pending: Promise<TunnelHandle>): Promise<TunnelHandle>
  private track(id: string, child: ChildProcess): ChildProcess
  private track(id: string, value: ChildProcess | Promise<TunnelHandle>): ChildProcess | Promise<TunnelHandle> {
    if (value instanceof Promise) {
      return value.then((tunnel) => {
        this.track(id, tunnel.child)
        return tunnel
      })
    }
    let owned = this.children.get(id)
    if (owned === undefined) {
      owned = new Set()
      this.children.set(id, owned)
    }
    owned.add(value)
    value.once('exit', () => {
      owned.delete(value)
      if (owned.size === 0) this.children.delete(id)
    })
    return value
  }

  /** The tab's mutable record, created on first use. */
  private record(id: string): ConnectionRecord {
    let record = this.records.get(id)
    if (record === undefined) {
      record = { state: 'idle', log: [] }
      this.records.set(id, record)
    }
    return record
  }

  /** Append one bounded, token-free line to the tab's log and to the host logger. */
  private note(id: string, line: string, level: 'info' | 'warn' = 'info'): void {
    const text = oneLine(redactToken(line))
    const log = this.record(id).log
    log.push(text)
    if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES)
    this.log(level, `[dsh-desktop-tabs] ${id}: ${text}`)
  }

  /** Report one lifecycle line when the caller supplied a logger. */
  private log(level: 'info' | 'warn', text: string): void {
    this.options.logger?.[level](text)
  }
}

/** The launch record of one host, whose backend lives in the shared session. */
function launchFor(host: string): RemoteLaunch {
  return { host, session: TMUX_SESSION, logPath: REMOTE_LOG }
}

/**
 * Add an actionable hint when the remote port was already taken.
 * @param text - the failure text.
 * @returns the text, with the hint appended when it reports a taken port.
 */
function withPortHint(text: string): string {
  if (!/EADDRINUSE/i.test(text)) return text
  return `${text}（远端已有实例占用该端口：默认启动命令会走 --port 0，或先结束旧实例）`
}

/** Reduce text to one bounded log line without ANSI colours or line breaks. */
function oneLine(text: string): string {
  const flat = stripAnsi(text).replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LOG_LINE ? `${flat.slice(0, MAX_LOG_LINE)}…` : flat
}

/** Status of one manual-redirect probe. */
async function probe(url: string): Promise<number> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3_000) })
  await response.body?.cancel()
  return response.status
}

/** Pause for a bounded interval. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Reduce arbitrary text to a one-line excerpt for an error message. */
function summarize(text: string): string {
  const line = stripAnsi(text).split('\n').map(part => part.trim()).filter(part => part !== '').join(' / ')
  return line.length > 400 ? `${line.slice(0, 400)}…` : line
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}