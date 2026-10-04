/**
 * Connection lifecycle of one remote tab.
 *
 * `up` runs the chain verified by hand in
 * `docs/dsh-gui/2026-10-03-desktop-tabs-prototype.md` ("远程连接链路"): prove the
 * alias is reachable, start a detached backend on the remote host from the
 * configured working directory, read its launch URL and token from the remote
 * log, probe a free local port, forward it with `ssh -L`, and only report `up`
 * once the tunneled port answers `401` bare and `303`/2xx with the token. The
 * remote shell commands live in `./commands.ts`.
 *
 * Every step writes one Chinese line into a bounded per-tab log, which `status`
 * exposes for the client's connection panel; the launch token never enters that
 * log, and the log is cleared when the connection goes down.
 *
 * Both traps that document records are handled: the local port is probed instead
 * of hardcoded (a local service already holding it makes the forward land on that
 * service while looking healthy), and the remote process is detached with
 * `nohup`, then reclaimed by pid and process group.
 */

import type { ChildProcess } from 'node:child_process'

import {
  CD_FAILED_MARKER,
  PROBE_MARKER,
  describeLaunch,
  logPathFor,
  parseLaunch,
  parseLaunchUrl,
  probeScript,
  remoteSurvived,
  resolveTarget,
  startScript,
  stopScript,
  waitScript,
  type RemoteLaunch,
  type RemoteTarget,
} from './commands.ts'
import { readConfiguredSshTabs } from './config.ts'
import { findFreeLocalPort } from './ports.ts'
import { forgetRemoteProcess, rememberRemoteProcess } from './records.ts'
import { mergeTargetRows } from './rows.ts'
import { openTunnel, runSsh, spawnSshDetached, terminate, type TunnelHandle } from './ssh.ts'
import { redactToken, stripAnsi } from './text.ts'
import type {
  RemoteConnectionStatus,
  RemoteConnections,
  RemoteConnectionsOptions,
  RemoteTab,
} from './types.ts'

/** Budget of the SSH reachability probe. */
const PROBE_TIMEOUT_MS = 20_000

/** Budget of the remote start command, which returns as soon as the pid is known. */
const START_TIMEOUT_MS = 25_000

/** Budget of the remote wait command, which outlasts the loop in `waitScript`. */
const TOKEN_TIMEOUT_MS = 90_000

/** How long the tunneled URL may keep answering something unexpected. */
const HEALTH_TIMEOUT_MS = 20_000

/** Pause between health probes. */
const HEALTH_INTERVAL_MS = 300

/** Budget of one remote cleanup command. */
const CLEANUP_TIMEOUT_MS = 20_000

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
      await this.stopRemote(established.remote, `tab '${id}' closed`)
      forgetRemoteProcess(this.options.dshHome, id)
    }
    // The log describes an attempt, so it goes with the connection.
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
      spawnSshDetached(established.remote.host, stopScript(established.remote))
      // The record is kept on purpose: this teardown is detached and best-effort, so
      // if it never runs, the next start reaps the group instead of leaking it.
    }
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
    try {
      const target = await this.targetFor(id)
      this.note(id, `目标 ${target.host}，工作目录 ${target.workdir === '' ? '$HOME' : target.workdir}`)
      await this.probeRemote(id, target)
      this.note(id, `启动远端 dsh：${describeLaunch(target)}`)
      launch = await this.startRemote(id, target)
      this.note(id, `远端进程已启动（pid ${launch.pid}）`)
      this.remember(id, launch)
      const { remotePort, token } = await this.readLaunchUrl(id, target.host, launch)
      this.note(id, `已采集远端端口 ${remotePort} 与登录 token`)
      const localPort = await findFreeLocalPort()
      tunnel = await this.track(id, openTunnel({ host: target.host, localPort, remotePort }))
      this.note(id, `隧道已建立：127.0.0.1:${localPort} → ${target.host}:${remotePort}`)
      const health = await waitForHealthy({ localPort, token, tunnel })
      this.note(id, `健康检查通过：无 token ${health.bare}，带 token ${health.withToken}`)
      const url = `http://127.0.0.1:${localPort}/?token=${encodeURIComponent(token)}`
      this.active.set(id, { url, tunnel, remote: launch })
      record.state = 'up'
      record.url = url
      this.note(id, `连接就绪：${url}`)
      return { url }
    } catch (error) {
      terminate(tunnel?.child)
      if (launch !== undefined) {
        await this.stopRemote(launch, `failed connection to '${id}'`)
        // The attempt stopped its own process, so its record must not survive to be reaped later.
        forgetRemoteProcess(this.options.dshHome, id)
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

  /** Start the remote backend and read back the pid and process group. */
  private async startRemote(id: string, target: RemoteTarget): Promise<RemoteLaunch> {
    const logPath = logPathFor(id)
    let stdout: string
    try {
      stdout = await this.runTracked(id, target.host, startScript(target, logPath), START_TIMEOUT_MS)
    } catch (error) {
      const reason = message(error)
      const missing = new RegExp(`${CD_FAILED_MARKER}(.*)$`, 'm').exec(reason)
      if (missing !== null) {
        const path = (missing[1] ?? '').trim() || target.workdir
        throw new Error(`远端工作目录不可进入：${path}（${target.host}）`)
      }
      throw error
    }
    return parseLaunch(target.host, logPath, stdout)
  }

  /** Wait for the remote log to carry the launch URL, then split it apart. */
  private async readLaunchUrl(id: string, host: string, launch: RemoteLaunch): Promise<{ remotePort: number; token: string }> {
    const stdout = await this.runTracked(id, host, waitScript(launch), TOKEN_TIMEOUT_MS)
    return parseLaunchUrl(host, stdout)
  }

  /** Reclaim one remote backend tree and its log. */
  private async stopRemote(launch: RemoteLaunch, reason: string): Promise<void> {
    try {
      const run = runSsh(launch.host, stopScript(launch), { timeoutMs: CLEANUP_TIMEOUT_MS })
      const { stdout } = await run.done
      if (remoteSurvived(stdout)) {
        this.log('warn', `[dsh-desktop-tabs] remote pid ${launch.pid} on '${launch.host}' survived kill (${reason})`)
      }
    } catch (error) {
      this.log('warn', `[dsh-desktop-tabs] remote cleanup on '${launch.host}' failed (${reason}): ${message(error)}`)
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

  /**
   * Persist the launched process so a later start can reap it when this run is
   * killed before `down`. A launch without a usable group is not recorded: there
   * would be nothing to signal.
   */
  private remember(id: string, launch: RemoteLaunch): void {
    const pid = Number(launch.pid)
    const pgid = Number(launch.pgid)
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(pgid) || pgid <= 1) return
    rememberRemoteProcess(this.options.dshHome, id, {
      host: launch.host,
      pid,
      pgid,
      at: new Date().toISOString(),
    })
  }
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

/**
 * Probe the tunneled port until it answers as the remote backend does.
 *
 * A bare path must be refused with `401` and the tokened path must be accepted
 * with `303` or 2xx. Requiring the refusal matters: a tunnel that silently landed
 * on another local service answers `200` or `404`, which must not pass as `up`.
 * @param options - local port, launch token, and the tunnel being checked.
 * @returns the two observed statuses.
 */
async function waitForHealthy(options: { localPort: number; token: string; tunnel: TunnelHandle }): Promise<{ bare: number; withToken: number }> {
  const { localPort, token, tunnel } = options
  const base = `http://127.0.0.1:${localPort}/`
  const tokened = `${base}?token=${encodeURIComponent(token)}`
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let bare: number | undefined
  let withToken: number | undefined
  let lastError = ''
  while (Date.now() < deadline) {
    if (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) {
      throw new Error(`the local forward 127.0.0.1:${localPort} -> 127.0.0.1:${tunnel.remotePort} exited before the health check passed`)
    }
    try {
      bare = await probe(base)
      withToken = await probe(tokened)
      if (bare === 401 && isAuthenticatedStatus(withToken)) return { bare, withToken }
    } catch (error) {
      lastError = message(error)
    }
    await delay(HEALTH_INTERVAL_MS)
  }
  throw new Error(
    `health check through 127.0.0.1:${localPort} timed out: / answered ${bare ?? 'nothing'} (expected 401), `
    + `/?token=... answered ${withToken ?? 'nothing'} (expected 303 or 2xx)`
    + (lastError === '' ? '' : `; last error: ${lastError}`),
  )
}

/** Status of one manual-redirect probe. */
async function probe(url: string): Promise<number> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3_000) })
  await response.body?.cancel()
  return response.status
}

/** Whether a tokened response is the cookie-setting redirect or an accepted page. */
function isAuthenticatedStatus(status: number): boolean {
  return status === 303 || (status >= 200 && status < 300)
}

/** Pause for a bounded interval. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
