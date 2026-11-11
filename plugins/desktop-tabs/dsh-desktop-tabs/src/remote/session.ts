/**
 * Connection lifecycle of one remote tab, backed by a remote tmux session.
 *
 * `up` runs one chain for both channels: prove the channel is reachable, ensure
 * the `dsh-gui` tmux session on the remote side runs the backend (starting it
 * when missing or stale, reusing it when alive), discover its serving port and
 * the launch token, and only report `up` once the port answers as the backend
 * does. The remote shell commands live in `./commands.ts`; whether they travel
 * over `ssh` or `wsl.exe` is decided by the resolved channel.
 *
 * What differs by channel:
 *
 * - **SSH** forwards the remote loopback port through `ssh -L`, and the health
 *   probe goes through that tunnel.
 * - **WSL** never opens a tunnel. WSL2's localhost forwarding already publishes
 *   a distro listener bound to `127.0.0.1` on the Windows loopback, so the
 *   health probe goes straight to `http://127.0.0.1:<port>/`. Because that
 *   mapping is the only path, a failed probe checks whether the port is still
 *   listening inside WSL and, if it is, names `localhostForwarding` as the
 *   likely cause.
 * - **WSL startup scans ports.** The descriptor's port (3080 by default) is the
 *   first candidate; a candidate is used only when it is free both inside the
 *   distro and on the Windows loopback. A launch that still fails with
 *   `EADDRINUSE` is classified as a port collision and retried on the next
 *   port, up to {@link MAX_PORT_ATTEMPTS}; any other failure is reported at
 *   once with the WSL log tail, because walking the port range would just
 *   repeat a genuine harness failure.
 *
 * A reused session that stays dead is restarted — but only after the channel is
 * proven reachable again, so a network drop around a tunnel never kills a
 * running backend. Failure paths tear down only what this attempt created: its
 * tunnel and a session this attempt started; a reused ALIVE session is never
 * killed on failure. Closing the tab or exiting (`down` / `dispose`) tears the
 * local side down only and never touches the remote session, so the backend
 * keeps serving and the next `up` reuses it.
 *
 * Every step writes one Chinese line into a bounded per-tab log, which `status`
 * exposes for the client's connection panel; the launch token never enters that
 * log, and the log is cleared when the connection goes down.
 */

import type { ChildProcess } from 'node:child_process'

import {
  CD_FAILED_MARKER,
  DEFAULT_WSL_PORT,
  PROBE_MARKER,
  REMOTE_LOG,
  SESSION_DEAD_MARKER,
  SESSION_GONE_MARKER,
  TMUX_SESSION,
  channelLabel,
  describeLaunch,
  healthVerdict,
  isValidToken,
  killSessionScript,
  launchUrlFromLogScript,
  parseLaunchToken,
  parseLaunchUrl,
  parsePanePort,
  parsePinnedPort,
  parseSessionState,
  paneStartCommandScript,
  persistTokenScript,
  probeScript,
  resolveTarget,
  sessionStateScript,
  startCommandPinsPort,
  startSessionScript,
  storedTokenScript,
  waitForLaunchUrlScript,
  type RemoteChannel,
  type RemoteLaunch,
  type RemoteTarget,
} from './commands.ts'
import { readConfiguredRemoteTabs } from './config.ts'
import { findFreeLocalPort, isLoopbackPortFree } from './ports.ts'
import { mergeTargetRows } from './rows.ts'
import { openTunnel, runSsh, terminate, SshCommandError, type TunnelHandle } from './ssh.ts'
import { errorExcerpt, redactToken, stripAnsi } from './text.ts'
import {
  classifyWslStartFailure,
  parseWslPortFree,
  runWsl,
  wslAvailable,
  wslChannelDiagnosis,
  wslPortFreeScript,
  WslCommandError,
  type WslPortState,
} from './wsl.ts'
import type {
  RemoteConnectionStatus,
  RemoteConnections,
  RemoteConnectionsOptions,
  RemoteTab,
} from './types.ts'

/** Budget of the reachability probe. */
const PROBE_TIMEOUT_MS = 20_000

/** Budget of the tmux session-state read. */
const STATE_TIMEOUT_MS = 20_000

/** Budget of the restart command, which returns as soon as the session is created. */
const START_TIMEOUT_MS = 30_000

/** Budget of the pane-command read used for port discovery. */
const DISCOVER_TIMEOUT_MS = 20_000

/** Budget of one in-WSL port probe; a `wsl.exe` round-trip includes a login shell. */
const PORT_PROBE_TIMEOUT_MS = 15_000

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

/** Ports one WSL port scan may try before giving up. */
export const MAX_PORT_SCAN = 20

/** Launch attempts one WSL startup may spend on port collisions. */
export const MAX_PORT_ATTEMPTS = 10

/** Connection-log lines kept per tab; the oldest lines are dropped first. */
const MAX_LOG_LINES = 200

/** Characters kept per log line, so one verbose command cannot flood the panel. */
const MAX_LOG_LINE = 400

/** One established connection. */
interface ActiveConnection {
  readonly url: string
  /** SSH only; a WSL connection reaches the backend through localhost forwarding. */
  readonly tunnel?: TunnelHandle
  readonly remote: RemoteLaunch
}

/** Mutable per-tab state behind {@link RemoteConnectionStatus}. */
interface ConnectionRecord {
  state: 'idle' | 'connecting' | 'up' | 'error'
  url?: string
  error?: string
  readonly log: string[]
}

/**
 * What one failed attempt may have to clean up.
 *
 * `startedHere` stays false for a reused session, so a failure while reusing it
 * never kills a backend another attempt (or another tab) owns.
 */
interface AttemptState {
  launch?: RemoteLaunch
  startedHere: boolean
  tunnel?: TunnelHandle
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
  /** Every ssh/wsl client currently owned by a tab, aborted by `down` and `dispose`. */
  private readonly children = new Map<string, Set<ChildProcess>>()
  /** Tabs whose in-WSL port probe already reported that neither tool exists. */
  private readonly portProbeUnknownNoted = new Set<string>()
  private disposed = false

  constructor(options: RemoteConnectionsOptions) {
    this.options = options
  }

  /** @inheritdoc */
  status(): RemoteConnectionStatus[] {
    const rows = new Map<string, RemoteConnectionStatus>()
    for (const tab of readConfiguredRemoteTabs(this.options.dshHome)) rows.set(tab.id, { id: tab.id, state: 'idle', log: [] })
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
      terminate(established.tunnel?.child)
    }
    // 只断开本地隧道与本地 wsl.exe，不发任何远端/WSL 内命令；后端继续在 tmux 会话中
    // 运行，下次 `up` 复用。
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
      terminate(established.tunnel?.child)
    }
    // 远端后端由 tmux 会话持有，退出不触碰，下次启动直接复用。
    this.records.clear()
    this.portProbeUnknownNoted.clear()
  }

  /** Run one attempt and record its outcome; teardown runs on every failure path. */
  private async establish(id: string): Promise<{ url: string }> {
    const record = this.record(id)
    record.state = 'connecting'
    record.log.length = 0
    delete record.url
    delete record.error
    this.note(id, `开始连接 ${id}`)
    const attempt: AttemptState = { startedHere: false }
    let target: RemoteTarget | undefined
    try {
      target = await this.targetFor(id)
      this.note(id, targetLine(target))
      await this.probeRemote(id, target)
      const url = target.channel.kind === 'wsl'
        ? await this.establishWsl(id, target, attempt)
        : await this.establishSsh(id, target, attempt)
      if (attempt.launch === undefined) throw new Error(`tab '${id}' 的连接流程没有记录远端 tmux 会话`)
      this.active.set(id, {
        url,
        ...(attempt.tunnel === undefined ? {} : { tunnel: attempt.tunnel }),
        remote: attempt.launch,
      })
      record.state = 'up'
      record.url = url
      this.note(id, `连接就绪：${url}`)
      return { url }
    } catch (error) {
      terminate(attempt.tunnel?.child)
      if (attempt.startedHere && attempt.launch !== undefined) {
        await this.killSession(id, attempt.launch.channel, `failed connection to '${id}'`)
      }
      const reason = withPortHint(redactToken(message(error)), target === undefined || target.channel.kind === 'ssh')
      record.state = 'error'
      record.error = reason
      this.note(id, `连接失败：${reason}`, 'warn')
      throw new Error(reason)
    }
  }

  /** SSH chain: ensure the session, tunnel its port, wait for the tunneled backend. */
  private async establishSsh(id: string, target: RemoteTarget, attempt: AttemptState): Promise<string> {
    const channel = target.channel
    if (channel.kind !== 'ssh') throw new Error(`tab '${id}' has a non-ssh channel on the ssh path`)
    const ensured = await this.ensureSession(id, target)
    attempt.launch = ensured.launch
    attempt.startedHere = ensured.startedHere
    let url: string | undefined
    let round = 0
    while (url === undefined) {
      round += 1
      const remotePort = await this.discoverRemotePort(id, target)
      this.note(id, `已采集远端端口 ${remotePort}`)
      const localPort = await findFreeLocalPort()
      attempt.tunnel = await this.track(id, openTunnel({
        host: channel.host,
        ...(channel.user === undefined ? {} : { user: channel.user }),
        localPort,
        remotePort,
      }))
      this.note(id, `隧道已建立：127.0.0.1:${localPort} → ${channel.host}:${remotePort}`)
      try {
        const budget = round === 1 && !attempt.startedHere ? REUSE_TIMEOUT_MS : BOOT_TIMEOUT_MS
        const health = await this.waitForHealth(id, target, `http://127.0.0.1:${localPort}/`, budget, attempt.tunnel)
        this.note(id, healthLine(health))
        url = health.url
      } catch (error) {
        // 拆掉的隧道或断开的网络从不构成重启理由：只有「隧道仍在、后端不答」才可能
        // 判断后端已死，且重启前必须先证 SSH 仍可达，避免误杀正在运行的后端。
        const tunnel = attempt.tunnel
        if (tunnel !== undefined && (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null)) throw error
        if (attempt.startedHere || round > 1) throw error
        await this.probeRemote(id, target)
        this.note(id, '远端后端未响应，判定失效，在 tmux 中重启 dsh', 'warn')
        attempt.startedHere = await this.startSession(id, target, true)
        // 重启会换端口，先撤掉旧隧道的本地转发，下一轮再开新隧道。
        if (attempt.tunnel !== undefined) {
          terminate(attempt.tunnel.child)
          attempt.tunnel = undefined
        }
      }
    }
    return url
  }

  /**
   * WSL chain: ensure the session, start it on a scanned port, then probe the
   * port through WSL2's localhost forwarding — no tunnel at all.
   */
  private async establishWsl(id: string, target: RemoteTarget, attempt: AttemptState): Promise<string> {
    const state = parseSessionState(await this.runTracked(id, target.channel, sessionStateScript(), STATE_TIMEOUT_MS))
    if (state === 'ALIVE') {
      this.note(id, `复用远端 tmux 会话 ${TMUX_SESSION}（后端已存在）`)
      attempt.launch = launchFor(target.channel)
      const remotePort = await this.discoverRemotePort(id, target)
      this.note(id, `已采集远端端口 ${remotePort}`)
      this.note(id, localhostForwardLine(remotePort))
      try {
        const health = await this.waitForWslHealthy(id, target, remotePort, REUSE_TIMEOUT_MS)
        this.note(id, healthLine(health))
        return health.url
      } catch (error) {
        // 复用的 ALIVE 会话不健康才重启，且重启前先证传输可达，避免把网络抖动当成后端死亡。
        await this.probeRemote(id, target)
        this.note(id, `WSL 内后端未响应，判定失效，在 tmux 中重启 dsh（${errorExcerpt(message(error))}）`, 'warn')
      }
    } else {
      // The command itself is logged once the scan has chosen a port (the log
      // must not claim the descriptor's first candidate when the real one differs).
      this.note(id, `远端 tmux 会话 ${TMUX_SESSION} 状态：${state}`)
    }
    const restartExisting = state !== 'MISSING'
    const started = await this.startWslSessionWithRetry(id, target, attempt, restartExisting)
    this.note(id, localhostForwardLine(started))
    const health = await this.waitForWslHealthy(id, target, started, BOOT_TIMEOUT_MS)
    this.note(id, healthLine(health))
    return health.url
  }

  /** Resolve the tab's remote descriptor from the callback rows, then the config file. */
  private async targetFor(id: string): Promise<RemoteTarget> {
    const fromSource = mergeTargetRows(await this.options.tabs()).find(row => row.id === id)
    const fromConfig = readConfiguredRemoteTabs(this.options.dshHome).find(row => row.id === id)
    const candidates = [fromSource, fromConfig].filter((row): row is RemoteTab => row !== undefined)
    const described = candidates.find(row => row.ssh !== undefined || row.wsl !== undefined)
    if (described !== undefined) return resolveTarget(id, described)
    if (candidates.length === 0) {
      throw new Error(`tab '${id}' is not a configured remote target: no row with that id in the tab or connection list`)
    }
    throw new Error(
      `tab '${id}' has no "ssh" descriptor and no "wsl" descriptor `
      + `(add {"ssh": {"host": "<alias>"}} or {"wsl": {"distro": "<name>"}} to its row in gui/desktop-tabs.json)`,
    )
  }

  /** Prove the channel answers a command before anything is started. */
  private async probeRemote(id: string, target: RemoteTarget): Promise<void> {
    let stdout: string
    try {
      stdout = await this.runTracked(id, target.channel, probeScript(), PROBE_TIMEOUT_MS)
    } catch (error) {
      throw channelError(target.channel, error)
    }
    if (!stdout.includes(PROBE_MARKER)) {
      throw channelError(target.channel, new Error(`'${channelLabel(target.channel)}' answered without the reachability marker`))
    }
    this.note(id, target.channel.kind === 'wsl'
      ? `WSL 连通性正常：${channelLabel(target.channel)}`
      : `SSH 连通性正常：${channelLabel(target.channel)}`)
  }

  /**
   * Ensure the remote session is running the backend, reusing one that is
   * ALIVE. A MISSING/STALE session is restarted with the configured launch;
   * `startedHere` tells the caller which sessions a later failure may clean up.
   */
  private async ensureSession(id: string, target: RemoteTarget): Promise<{ launch: RemoteLaunch; startedHere: boolean }> {
    const state = parseSessionState(await this.runTracked(id, target.channel, sessionStateScript(), STATE_TIMEOUT_MS))
    if (state === 'ALIVE') {
      this.note(id, `复用远端 tmux 会话 ${TMUX_SESSION}（后端已存在）`)
      return { launch: launchFor(target.channel), startedHere: false }
    }
    this.note(id, `远端 tmux 会话 ${TMUX_SESSION} 状态：${state}，启动远端 dsh：${describeLaunch(target)}`)
    // 仅在确认会话已死（STALE）时先 kill；MISSING 分支直接 new，避免并发首连互相杀会话。
    const startedHere = await this.startSession(id, target, state === 'STALE')
    return { launch: launchFor(target.channel), startedHere }
  }

  /**
   * Create the remote session with the configured launch, clearing the stale
   * token first. A `new-session` "duplicate session" failure means a concurrent
   * tab for the same host created it in between: an ALIVE session is reused and
   * reported as not-ours, and a dead one may be retried once.
   *
   * The retry is deliberately conservative: only a session that is provably
   * STALE may be killed. A MISSING read — including a state read that failed and
   * therefore says nothing — can hide a session a concurrent first connect has
   * just created, so the retry runs without the kill and only once.
   * @param cleanExisting - kill a stale existing session before creating a new one.
   * @param port - port the start command should request.
   * @param retried - set on the single retry, so the catch cannot recurse.
   * @returns whether this call created the session.
   */
  private async startSession(
    id: string,
    target: RemoteTarget,
    cleanExisting: boolean,
    port: number = target.port,
    retried = false,
  ): Promise<boolean> {
    try {
      await this.runTracked(id, target.channel, startSessionScript(target, cleanExisting, port), START_TIMEOUT_MS)
      return true
    } catch (error) {
      const state = parseSessionState(
        await this.runTracked(id, target.channel, sessionStateScript(), STATE_TIMEOUT_MS).catch(() => ''),
      )
      if (state === 'ALIVE') return false
      if (retried) throw new Error(`tmux 会话 ${TMUX_SESSION} 启动失败：${message(error)}`)
      // 仅在确认会话已死（STALE）时先 kill；MISSING 分支（含状态读取失败）重试一次
      // 且不 kill，避免并发首连接把对方刚建好的会话杀掉。
      if (state === 'STALE') return await this.startSession(id, target, true, port, true)
      return await this.startSession(id, target, false, port, true)
    }
  }

  /**
   * Start the WSL backend on the first usable port, retrying when the launch
   * reports a port collision.
   *
   * The scan and the launch can race with anything outside this process, so a
   * launch may still die with `EADDRINUSE` after a successful scan; that case
   * walks on to the next port. Every other failure is final and carries the WSL
   * log tail. A start command that fixes its own `--port` cannot be helped by
   * walking on, so it fails at once with an actionable hint.
   * @param cleanExisting - kill the (known dead) session before the first launch.
   * @returns the port the backend actually reported.
   */
  private async startWslSessionWithRetry(id: string, target: RemoteTarget, attempt: AttemptState, cleanExisting: boolean): Promise<number> {
    // A start command that pins `--port` binds that port whatever this loop
    // requests, so the scan starts there: a free pinned port needs no scan at all.
    const pinnedPort = parsePinnedPort(target.startCommand)
    let port = pinnedPort > 0 ? pinnedPort : target.port > 0 ? target.port : DEFAULT_WSL_PORT
    let clean = cleanExisting
    let lastText = ''
    for (let round = 1; round <= MAX_PORT_ATTEMPTS; round += 1) {
      port = await this.pickWslPort(id, target, port)
      // The scan starts at a numeric pinned port, so landing on a different one
      // means the pinned port is taken. Launching anyway would bind where the
      // Windows loopback cannot reach it (or, worse, let the health probe hit
      // whichever program holds the Windows side), so fail at once.
      if (pinnedPort > 0 && port !== pinnedPort) throw pinnedPortFailure(pinnedPort)
      // Logged after the scan, so the command line shows the port that is really
      // requested instead of the descriptor's first candidate.
      this.note(id, `启动远端 dsh（端口 ${port}）：${describeLaunch(target, port)}`)
      try {
        const started = await this.startSession(id, target, clean, port)
        if (started) attempt.startedHere = true
        attempt.launch = launchFor(target.channel)
        const stdout = await this.runTracked(id, target.channel, waitForLaunchUrlScript(), LAUNCH_WAIT_TIMEOUT_MS)
        const parsed = parseLaunchUrl(channelLabel(target.channel), stdout)
        // The launch URL carries the token the backend was started with; persist it
        // now so the health probe and later reuses read the same shared file as SSH.
        if (parsed.token !== null) {
          await this.runTracked(id, target.channel, persistTokenScript(parsed.token), TOKEN_WRITE_TIMEOUT_MS).catch(() => undefined)
        }
        return parsed.remotePort
      } catch (error) {
        const text = errorText(error)
        lastText = text
        if (classifyWslStartFailure(text) !== 'port-in-use') throw new Error(wslFailureText(target, text))
        if (startCommandPinsPort(target.startCommand)) {
          // A non-numeric pin (`--port $PORT`) cannot be checked by the scan; the
          // launch's own EADDRINUSE is the only evidence, and walking on is useless.
          throw pinnedPortFailure(pinnedPort > 0 ? pinnedPort : port)
        }
        if (round >= MAX_PORT_ATTEMPTS) {
          throw new Error(
            `连续 ${MAX_PORT_ATTEMPTS} 次尝试都因端口被占用而失败（起始端口 ${target.port}，最后尝试 ${port}）：${errorExcerpt(text)}`,
          )
        }
        this.note(id, `端口 ${port} 被占用，递增到下一个端口重试`, 'warn')
        port += 1
        // 上一轮尝试留下的会话 pane 已死（STALE），重试必须先把死会话清掉。
        clean = true
      }
    }
    throw new Error(`WSL 内 dsh 启动失败（不是端口占用）：${errorExcerpt(lastText)}`)
  }

  /**
   * Pick the first port that is free both inside the WSL distro and on the
   * Windows loopback.
   *
   * The Windows bind probe is a millisecond operation while the In-WSL probe
   * costs a `wsl.exe` round-trip, so a Windows collision skips the second probe.
   * An `unknown` In-WSL answer counts as free: the only tool that could have
   * said `busy` is missing, and the launch-time `EADDRINUSE` classification is
   * the backstop.
   * @param from - first candidate.
   * @returns the selected port.
   */
  private async pickWslPort(id: string, target: RemoteTarget, from: number): Promise<number> {
    for (let offset = 0; offset < MAX_PORT_SCAN; offset += 1) {
      const port = from + offset
      if (port > 65535) break
      const windowsFree = await isLoopbackPortFree(port)
      const wslState: WslPortState = windowsFree ? await this.wslPortState(id, target, port) : 'unknown'
      if (windowsFree && wslState !== 'busy') {
        if (wslState === 'unknown') this.notePortProbeUnknown(id)
        this.note(id, `端口 ${port} 可用（WSL 与 Windows 均空闲）`)
        return port
      }
      this.note(id, `端口 ${port} 被占用（WSL 内 / Windows 本机），向上递增`)
    }
    throw new Error(
      `从 ${from} 起连续 ${MAX_PORT_SCAN} 个端口都不可用（${from}-${Math.min(from + MAX_PORT_SCAN - 1, 65535)}）：`
      + `请先释放端口，或修改连接的起始端口`,
    )
  }

  /** Probe one port inside WSL; a failed probe is `unknown` rather than fatal. */
  private async wslPortState(id: string, target: RemoteTarget, port: number): Promise<WslPortState> {
    try {
      const stdout = await this.runTracked(id, target.channel, wslPortFreeScript(port), PORT_PROBE_TIMEOUT_MS)
      return parseWslPortFree(stdout)
    } catch {
      return 'unknown'
    }
  }

  /** Note once per tab that the distro has neither `ss` nor `netstat`. */
  private notePortProbeUnknown(id: string): void {
    if (this.portProbeUnknownNoted.has(id)) return
    this.portProbeUnknownNoted.add(id)
    this.note(id, 'WSL 内既没有 ss 也没有 netstat，端口占用只能由启动结果判定', 'warn')
  }

  /** Discover the remote serving port: the pane's `--port` first, the launch URL otherwise. */
  private async discoverRemotePort(id: string, target: RemoteTarget): Promise<number> {
    const pane = await this.runTracked(id, target.channel, paneStartCommandScript(), DISCOVER_TIMEOUT_MS)
    const port = parsePanePort(pane)
    if (port > 0) return port
    // `--port 0` (or an unparsable pane) means the real port is in the launch URL.
    const stdout = await this.waitForLaunchUrl(id, target)
    return parseLaunchUrl(channelLabel(target.channel), stdout).remotePort
  }

  /** Wait for the launch URL in the session log, translating the failure. */
  private async waitForLaunchUrl(id: string, target: RemoteTarget): Promise<string> {
    try {
      return await this.runTracked(id, target.channel, waitForLaunchUrlScript(), LAUNCH_WAIT_TIMEOUT_MS)
    } catch (error) {
      throw new Error(launchFailureText(target, errorText(error)))
    }
  }

  /** Read the launch token: the persisted file first, then the session log (persisted back). */
  private async readRemoteToken(id: string, target: RemoteTarget): Promise<string | null> {
    // The channel is non-interactive, but a user's login rc may still decorate
    // stdout; the persisted value must be compared without those sequences.
    const stored = stripAnsi(await this.runTracked(id, target.channel, storedTokenScript(), TOKEN_READ_TIMEOUT_MS)).trim()
    if (isValidToken(stored)) return stored
    const tail = await this.runTracked(id, target.channel, launchUrlFromLogScript(), TOKEN_READ_TIMEOUT_MS)
    const token = parseLaunchToken(tail)
    if (token === null) return null
    await this.runTracked(id, target.channel, persistTokenScript(token), TOKEN_WRITE_TIMEOUT_MS).catch(() => undefined)
    return token
  }

  /** One token read per attempt, with a quiet window while the backend boots. */
  private tokenHarvester(id: string, target: RemoteTarget): () => Promise<string | null> {
    let cached: string | null | undefined
    let lastTry = 0
    return async () => {
      const now = Date.now()
      if (cached !== undefined && cached !== null) return cached
      if (now - lastTry < TOKEN_HARVEST_MS) return cached ?? null
      lastTry = now
      cached = await this.readRemoteToken(id, target)
      return cached
    }
  }

  /**
   * Wait until the probed port answers as the remote backend does, probing the
   * bare path and, once a token is available, the tokenized path. The token is
   * re-harvested while the backend boots; the launch token never appears in any
   * log line.
   * @param base - the URL prefix to probe (tunnel port for SSH, backend port for WSL).
   * @param tunnel - SSH tunnel whose death invalidates the wait; absent for WSL.
   * @returns the loadable URL (with the token when one authenticates) and the observed statuses.
   */
  private async waitForHealth(
    id: string,
    target: RemoteTarget,
    base: string,
    budgetMs: number,
    tunnel?: TunnelHandle,
  ): Promise<{ url: string; bare: number; withToken: number | undefined }> {
    const harvest = this.tokenHarvester(id, target)
    const deadline = Date.now() + budgetMs
    let bare: number | undefined
    let withToken: number | undefined
    let lastError = ''
    while (Date.now() < deadline) {
      if (tunnel !== undefined && (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null)) {
        throw new Error(`the local forward 127.0.0.1:${tunnel.localPort} -> ${channelLabel(target.channel)}:${tunnel.remotePort} exited before the health check passed`)
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
      `health check through ${base} timed out: / answered ${bare ?? 'nothing'}, `
      + `/?token=... answered ${withToken ?? 'nothing'}`
      + (lastError === '' ? '' : `; last error: ${lastError}`),
    )
  }

  /**
   * WSL health wait: the backend is reached through WSL2's localhost forwarding,
   * so a timeout while the port still listens inside the distro points at that
   * forwarding rather than at the backend.
   */
  private async waitForWslHealthy(
    id: string,
    target: RemoteTarget,
    port: number,
    budgetMs: number,
  ): Promise<{ url: string; bare: number; withToken: number | undefined }> {
    const base = `http://127.0.0.1:${port}/`
    try {
      return await this.waitForHealth(id, target, base, budgetMs)
    } catch (error) {
      const state = await this.wslPortState(id, target, port)
      if (state !== 'busy') throw error
      throw new Error(
        `${message(error)}；WSL 内端口 ${port} 仍在监听，但 Windows 侧 ${base} 无法访问：`
        + `请确认 WSL2 的 localhostForwarding 已开启（不要关闭），或执行 wsl --shutdown 后重试`,
      )
    }
  }

  /** Reclaim one remote session this attempt created, best-effort. */
  private async killSession(id: string, channel: RemoteChannel, reason: string): Promise<void> {
    try {
      await this.runTracked(id, channel, killSessionScript(), CLEANUP_TIMEOUT_MS)
    } catch (error) {
      this.log('warn', `[dsh-desktop-tabs] remote tmux cleanup on '${channelLabel(channel)}' failed (${reason}): ${message(error)}`)
    }
  }

  /** Run one remote command with the tab's ownership recorded. */
  private async runTracked(id: string, channel: RemoteChannel, command: string, timeoutMs: number): Promise<string> {
    const run = channel.kind === 'ssh'
      ? runSsh(channel.host, command, { timeoutMs, ...(channel.user === undefined ? {} : { user: channel.user }) })
      : runWsl(
          { distro: channel.distro, ...(channel.account === undefined ? {} : { account: channel.account }) },
          command,
          { timeoutMs },
        )
    this.track(id, run.child)
    return (await run.done).stdout
  }

  /** Record one owned child process, or a pending tunnel's client once it exists. */
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

/** The launch record of one channel, whose backend lives in the shared session. */
function launchFor(channel: RemoteChannel): RemoteLaunch {
  return { channel, session: TMUX_SESSION, logPath: REMOTE_LOG }
}

/** One Chinese log line naming the resolved target. */
function targetLine(target: RemoteTarget): string {
  const workdir = target.workdir === '' ? '$HOME' : target.workdir
  if (target.channel.kind === 'ssh') return `目标 ${target.channel.host}，工作目录 ${workdir}`
  const account = target.channel.account === undefined ? '默认用户' : target.channel.account
  return `目标 WSL 发行版 ${channelLabel(target.channel)}，账号 ${account}，工作目录 ${workdir}`
}

/** One Chinese log line naming the no-tunnel WSL path. */
function localhostForwardLine(port: number): string {
  return `WSL2 localhost 转发直连：http://127.0.0.1:${port}/（无 SSH 隧道）`
}

/** The health-check log line shared by both channels. */
function healthLine(health: { bare: number; withToken: number | undefined }): string {
  return `健康检查通过：/ 返回 ${health.bare}，/?token=... 返回 ${health.withToken ?? '—'}`
}

/**
 * Turn a channel failure into the most useful error.
 *
 * A machine without WSL is reported before anything else ("WSL 不可用"), and
 * WSL activation failures carry stable error codes, so they become actionable
 * Chinese messages (unknown distro / unknown account); other failures keep their
 * own error, which already carries the captured output.
 */
function channelError(channel: RemoteChannel, error: unknown): Error {
  if (channel.kind === 'wsl') {
    const availability = wslAvailable()
    if (!availability.available) return new Error(`WSL 不可用：${availability.error ?? '未知原因'}`)
  }
  const text = errorText(error)
  if (channel.kind === 'wsl') {
    const diagnosis = wslChannelDiagnosis(channel, text)
    if (diagnosis !== undefined) return new Error(`${diagnosis}；原始输出：${errorExcerpt(text)}`)
  }
  return error instanceof Error ? error : new Error(text)
}

/**
 * Describe a launch that never produced a URL.
 *
 * `TABS_CD_FAILED=` is translated to the path the pane could not enter, and the
 * two fast-failure markers get their own lines so the user is not told to "wait"
 * when the session or its pane has already gone. Both markers keep a log excerpt:
 * "the session vanished" is only an explanation once the log says why it exited.
 */
function launchFailureText(target: RemoteTarget, text: string): string {
  const label = channelLabel(target.channel)
  const missing = new RegExp(`${CD_FAILED_MARKER}(.*)$`, 'm').exec(text)
  if (missing !== null) {
    const path = (missing[1] ?? '').trim() || target.workdir
    return target.channel.kind === 'wsl' ? `WSL 工作目录不可进入：${path}` : `远端工作目录不可进入：${path}（${label}）`
  }
  if (text.includes(SESSION_GONE_MARKER)) {
    return `远端 tmux 会话 ${TMUX_SESSION} 在启动过程中消失（${label}）：启动命令立即退出，或 tmux 会话被外部关闭；日志尾部：${errorExcerpt(text)}`
  }
  if (text.includes(SESSION_DEAD_MARKER)) {
    return `远端 tmux 会话 ${TMUX_SESSION} 的 pane 已退出（${label}）：${errorExcerpt(text)}`
  }
  return `${target.channel.kind === 'wsl' ? 'WSL 内' : '远端'} dsh 未在限定时间内输出启动地址（${label}）：${errorExcerpt(text)}`
}

/**
 * Describe a WSL launch that failed for a reason other than a port collision.
 *
 * The wording says "不是端口占用" explicitly: the retry loop already ruled out
 * `EADDRINUSE`, and the user must not be sent hunting for a port that is free.
 * The excerpt keeps a head, the root-cause line, and a tail, so a stack trace or
 * a "Full diagnostics" block after the error cannot push it out of view.
 */
function wslFailureText(target: RemoteTarget, text: string): string {
  const label = channelLabel(target.channel)
  const missing = new RegExp(`${CD_FAILED_MARKER}(.*)$`, 'm').exec(text)
  if (missing !== null) {
    const path = (missing[1] ?? '').trim() || target.workdir
    return `WSL 工作目录不可进入：${path}（不是端口占用）`
  }
  if (/tmux: (?:command )?not found|tmux：未找到命令/i.test(text)) {
    return `WSL 发行版 ${label} 内没有 tmux（不是端口占用），请先安装 tmux（例如 sudo pacman -S tmux 或 sudo apt install tmux）：${errorExcerpt(text)}`
  }
  if (text.includes(SESSION_GONE_MARKER)) {
    return `WSL 内 tmux 会话 ${TMUX_SESSION} 在启动过程中消失（不是端口占用）：启动命令立即退出，或 tmux 会话被外部关闭；日志尾部：${errorExcerpt(text)}`
  }
  if (text.includes(SESSION_DEAD_MARKER)) {
    return `WSL 内 dsh 启动后立即退出（tmux pane 已结束，不是端口占用）：${errorExcerpt(text)}`
  }
  return `WSL 内 dsh 启动失败（不是端口占用）：${errorExcerpt(text)}`
}

/**
 * The failure of a start command that fixes its own `--port`.
 *
 * Increasing the scan port cannot change where such a command binds, so the
 * message names the real port and both ways out: drop the flag, or free the port.
 */
function pinnedPortFailure(port: number): Error {
  return new Error(
    `WSL 内端口 ${port} 被占用，但启动命令里已写死 --port（${port}），递增端口不会生效：`
    + `请去掉启动命令中的 --port 让连接流程自行分配端口，或先结束占用该端口的进程`
    + `（WSL 内查看：ss -ltnp | grep :${port}）`,
  )
}

/**
 * Add an actionable hint when the remote port was already taken.
 * @param text - the failure text.
 * @param ssh - whether the failed channel is SSH (the hint names the SSH default).
 * @returns the text, with the hint appended when it reports a taken port.
 */
function withPortHint(text: string, ssh: boolean): string {
  if (!ssh || !/EADDRINUSE/i.test(text)) return text
  return `${text}（远端已有实例占用该端口：默认启动命令会走 --port 0，或先结束旧实例）`
}

/** The complete output of a failed command, without the shell's decorative codes. */
function errorText(error: unknown): string {
  let text: string
  if (error instanceof WslCommandError) text = [error.stderr, error.stdout].filter(part => part.trim() !== '').join('\n')
  else if (error instanceof SshCommandError) text = [error.stderr, error.stdout].filter(part => part.trim() !== '').join('\n')
  else text = message(error)
  return text.trim() === '' ? message(error) : text
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

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
