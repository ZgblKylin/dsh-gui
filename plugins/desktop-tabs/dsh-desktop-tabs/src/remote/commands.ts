/**
 * The remote shell commands one connection runs, and parsing of their output.
 *
 * One transport-independent script set serves both channels: the same `dsh-gui`
 * tmux session, log, and token file are used over SSH and inside a WSL distro,
 * so a host shared by the two plugins (`plugins/remote/dsh-remote` and this one)
 * still has exactly one backend. Only the transport differs; `./ssh.ts` and
 * `./wsl.ts` own that, and `./session.ts` picks one per {@link RemoteChannel}.
 *
 * `sessionStateScript` reads whether the session is ALIVE, STALE, or MISSING;
 * `startSessionScript` restarts it with the configured command and clears the
 * stale token; `waitForLaunchUrlScript` waits for the launch URL in the session
 * log; `paneStartCommandScript` reads the port the pane was started with; and
 * the token helpers read, validate, and persist the launch token.
 *
 * The launch runs from the configured working directory: an empty `workdir` uses
 * the remote `$HOME`, and a `~`-rooted one is expanded through `$HOME` because a
 * quoted `~` would stay literal. An empty `startCommand` selects
 * {@link defaultStartCommand} with the runtime's own `DSH_HOME`; a user command
 * runs exactly as given and gets no environment prefix. Both forms have the
 * loopback bind and the port appended by {@link appendServeFlags}; a caller that
 * scans for a free port passes it through {@link startSessionScript}.
 *
 * Each script is one POSIX shell script passed to the transport (an `ssh` argv
 * element, or `wsl.exe`'s stdin). `$HOME` in the shared log and token paths
 * stays unquoted (single-quoting it would block the expansion).
 */

import type { RemoteTab } from './types.ts'
import { quotePosix, remotePath } from './ssh.ts'
import { stripAnsi } from './text.ts'

/** Remote runtime root used when a descriptor names none. */
const DEFAULT_RUNTIME_ROOT = '~/dsh-gui-home'

/** Remote node executable used when a descriptor names none. */
const DEFAULT_NODE = 'node'

/** Remote dsh CLI entry, relative to the runtime root. */
const DSH_BIN_RELATIVE = '.harness/node_modules/@deepseek-ai/dsh/lib/bin.js'

/** Remote log poll iterations; with the 0.5s sleep in the script, 75s. */
const LAUNCH_TICKS = 150

/** First port a WSL backend tries when its descriptor names none. */
export const DEFAULT_WSL_PORT = 3080

/** Marker the reachability probe prints on success. */
export const PROBE_MARKER = 'TABS_SSH_OK'

/** Marker the start pane prints when its working directory cannot be entered. */
export const CD_FAILED_MARKER = 'TABS_CD_FAILED='

/** Marker the launch wait prints when the pane died during boot. */
export const SESSION_DEAD_MARKER = 'TABS_SESSION_DEAD=1'

/** Marker the launch wait prints when the tmux session vanished during boot. */
export const SESSION_GONE_MARKER = 'TABS_SESSION_GONE=1'

/** Marker the launch wait prints when no launch URL appeared in time. */
export const URL_TIMEOUT_MARKER = 'TABS_URL_TIMEOUT=1'

/** Remote tmux session name, shared with `plugins/remote/dsh-remote`. */
export const TMUX_SESSION = 'dsh-gui'

/** Remote log the session pane redirects to, shared with dsh-remote. */
export const REMOTE_LOG = '$HOME/.dsh-gui-remote.log'

/** Remote launch-token file, shared with dsh-remote. */
export const REMOTE_TOKEN_FILE = '$HOME/.dsh-gui-remote.token'

/** How many characters of a command string the log line keeps. */
const MAX_COMMAND_CHARS = 300

/**
 * The transport one target is reached over.
 *
 * SSH: `host` is an `ssh` destination and `user` is passed as `ssh -l`.
 * WSL: `distro` is a distribution name (empty for the default one) and
 * `account` is passed as `wsl.exe -u`.
 */
export type RemoteChannel =
  | { readonly kind: 'ssh'; readonly host: string; readonly user?: string }
  | { readonly kind: 'wsl'; readonly distro: string; readonly account?: string }

/** A tab resolved into the remote values the launch commands need. */
export interface RemoteTarget {
  readonly id: string
  readonly channel: RemoteChannel
  readonly dshHome: string
  readonly dshBin: string
  readonly node: string
  readonly port: number
  /** Remote working directory; empty means the remote `$HOME`. */
  readonly workdir: string
  /** Remote start command; empty means {@link defaultStartCommand}. */
  readonly startCommand: string
}

/** One remote backend, identified by the tmux session it lives in. */
export interface RemoteLaunch {
  readonly channel: RemoteChannel
  /** Remote tmux session holding the backend. */
  readonly session: string
  /** Remote log the session's pane redirects to (`$HOME/.dsh-gui-remote.log`). */
  readonly logPath: string
}

/** Lifecycle of the remote tmux session, as {@link sessionStateScript} reads it. */
export type TmuxSessionState = 'MISSING' | 'STALE' | 'ALIVE'

/**
 * Apply the descriptor defaults and reject an unusable destination.
 * @param id - tab id, used in error messages only.
 * @param row - configured tab or saved connection carrying the descriptor.
 * @returns the resolved remote values.
 */
export function resolveTarget(id: string, row: RemoteTab): RemoteTarget {
  if (row.ssh !== undefined) return resolveSshTarget(id, row)
  if (row.wsl !== undefined) return resolveWslTarget(id, row)
  throw new Error(
    `tab '${id}' has no "ssh" descriptor and no "wsl" descriptor `
    + `(add {"ssh": {"host": "<alias>"}} or {"wsl": {"distro": "<name>"}} to gui/desktop-tabs.json)`,
  )
}

/** Resolve one SSH descriptor. */
function resolveSshTarget(id: string, row: RemoteTab): RemoteTarget {
  const ssh = row.ssh
  if (ssh === undefined) throw new Error(`tab '${id}' has no "ssh" descriptor`)
  const host = ssh.host.trim()
  if (host === '' || /\s/.test(host)) throw new Error(`tab '${id}' has an unusable ssh host '${ssh.host}'`)
  const user = accountOf(row)
  return {
    id,
    channel: user === undefined ? { kind: 'ssh', host } : { kind: 'ssh', host, user },
    dshHome: ssh.dshHome ?? joinRemote(ssh.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, '.dsh'),
    dshBin: ssh.dshBin ?? joinRemote(ssh.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, DSH_BIN_RELATIVE),
    node: ssh.node ?? DEFAULT_NODE,
    port: ssh.port ?? 0,
    workdir: (row.workdir ?? '').trim(),
    startCommand: (row.startCommand ?? '').trim(),
  }
}

/**
 * Resolve one WSL descriptor.
 *
 * The distribution name may be empty (default distribution) and may contain
 * spaces (imported distros can), so only characters that cannot survive a
 * command line or a log line are rejected. The port is the first port-scan
 * candidate, hence the WSL-specific default of {@link DEFAULT_WSL_PORT}.
 */
function resolveWslTarget(id: string, row: RemoteTab): RemoteTarget {
  const wsl = row.wsl
  if (wsl === undefined) throw new Error(`tab '${id}' has no "wsl" descriptor`)
  const distro = wsl.distro.trim()
  if (/[\r\n\u0000]/.test(distro)) throw new Error(`tab '${id}' has an unusable WSL distro name '${wsl.distro}'`)
  const account = accountOf(row)
  return {
    id,
    channel: account === undefined ? { kind: 'wsl', distro } : { kind: 'wsl', distro, account },
    dshHome: wsl.dshHome ?? joinRemote(wsl.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, '.dsh'),
    dshBin: wsl.dshBin ?? joinRemote(wsl.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, DSH_BIN_RELATIVE),
    node: wsl.node ?? DEFAULT_NODE,
    port: wsl.port ?? DEFAULT_WSL_PORT,
    workdir: (row.workdir ?? '').trim(),
    startCommand: (row.startCommand ?? '').trim(),
  }
}

/** The explicit login name of one row, or undefined when unset. */
function accountOf(row: RemoteTab): string | undefined {
  const account = (row.account ?? '').trim()
  return account === '' ? undefined : account
}

/**
 * Name one channel for logs and error messages.
 * @param channel - resolved transport.
 * @returns the SSH host, or the WSL distribution name (with a readable default).
 */
export function channelLabel(channel: RemoteChannel): string {
  if (channel.kind === 'ssh') return channel.host
  return channel.distro === '' ? '默认发行版' : channel.distro
}

/**
 * Remote command proving the channel answers a command.
 * @returns the script; its stdout carries {@link PROBE_MARKER} on success.
 */
export function probeScript(): string {
  return `printf '${PROBE_MARKER}\\n'`
}

/**
 * Remote command reading the lifecycle of the `dsh-gui` tmux session.
 * @returns a script echoing `ALIVE`, `STALE`, or `MISSING`.
 */
export function sessionStateScript(): string {
  return [
    `if tmux has-session -t ${TMUX_SESSION} 2>/dev/null; then`,
    `  if tmux list-panes -t ${TMUX_SESSION} -F '#{pane_dead}' 2>/dev/null | grep -q 1; then echo STALE; else echo ALIVE; fi`,
    'else echo MISSING; fi',
  ].join('\n')
}

/** Parse {@link sessionStateScript}'s output. */
export function parseSessionState(stdout: string): TmuxSessionState {
  const out = stripAnsi(stdout)
  if (out.includes('ALIVE')) return 'ALIVE'
  if (out.includes('STALE')) return 'STALE'
  return 'MISSING'
}

/**
 * Remote command (re)creating the `dsh-gui` tmux session with the configured
 * launch, and clearing the stale persisted token so a previous boot's token can
 * never masquerade as this one's. `cleanExisting` only applies to a session that
 * is known dead (STALE, or a restart after a failed liveness check): the MISSING
 * branch must not kill, so two first connects to one host cannot tear down each
 * other's freshly created session — a racing `new-session` simply fails, and the
 * caller reuses the session the other attempt created.
 * @param target - resolved remote values.
 * @param cleanExisting - kill any existing session before creating the new one.
 * @param port - port to request from the backend; defaults to the target's port.
 * A WSL caller passes the port its scan selected, which may differ from the
 * descriptor's first candidate.
 * @returns the script; a non-zero exit means the session could not be created.
 */
export function startSessionScript(target: RemoteTarget, cleanExisting: boolean, port: number = target.port): string {
  const lines: string[] = []
  if (cleanExisting) lines.push(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null || true`)
  lines.push(`rm -f ${homePathWord(REMOTE_TOKEN_FILE)}`)
  lines.push(`tmux new-session -d -s ${TMUX_SESSION} ${quotePosix(`bash -l -i -c ${quotePosix(paneCommand(target, port))}`)}`)
  return lines.join('\n')
}

/** Remote command killing the `dsh-gui` session; best-effort, no-op when absent. */
export function killSessionScript(): string {
  return `tmux kill-session -t ${TMUX_SESSION} 2>/dev/null || true`
}

/**
 * Remote command naming the port the live pane was started with.
 * @returns a script printing the pane's start command (its `--port` value is
 * used first when it is a real port; a `--port 0` must fall back to the log).
 */
export function paneStartCommandScript(): string {
  return `tmux list-panes -t ${TMUX_SESSION} -F '#{pane_start_command}' 2>/dev/null | head -1`
}

/** Parse a real `--port` out of {@link paneStartCommandScript}'s output; 0 when absent or `--port 0`. */
export function parsePanePort(stdout: string): number {
  const match = /--port(?:\s+|=)(\d+)/.exec(stripAnsi(stdout))
  if (match === null) return 0
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
}

/**
 * Remote command waiting for the launch URL in the session log, or reporting why
 * it never came.
 *
 * Three fast-failure cases are distinguished, because each needs a different
 * user action: the pane died (the backend exited — its log tail explains why),
 * the whole tmux session disappeared (the launch command exited so fast that
 * tmux reaped the session), and the timeout (the backend is still booting, or
 * never printed). In every case the log tail follows the marker so the caller
 * can classify the failure and show it.
 * @returns a script that prints the `dsh web:` line, or exits 4 (pane dead, or
 * session gone) / 5 (timeout) with a marker on stderr.
 */
export function waitForLaunchUrlScript(): string {
  return [
    `tabs_log=${homePathWord(REMOTE_LOG)}`,
    'tabs_i=0',
    `while [ $tabs_i -lt ${LAUNCH_TICKS} ]; do`,
    "  if grep -m1 -q -E 'dsh web:.*https?://' \"$tabs_log\" 2>/dev/null; then",
    "    grep -m1 -E 'dsh web:.*https?://' \"$tabs_log\"",
    '    exit 0',
    '  fi',
    `  if tmux list-panes -t ${TMUX_SESSION} -F '#{pane_dead}' 2>/dev/null | grep -q 1; then`,
    `    printf '${SESSION_DEAD_MARKER}\\n' >&2`,
    `    grep -m1 '${CD_FAILED_MARKER}' "$tabs_log" 2>/dev/null || true`,
    '    tail -n 40 "$tabs_log" >&2',
    '    exit 4',
    '  fi',
    `  if ! tmux has-session -t ${TMUX_SESSION} 2>/dev/null; then`,
    `    printf '${SESSION_GONE_MARKER}\\n' >&2`,
    '    tail -n 40 "$tabs_log" >&2',
    '    exit 4',
    '  fi',
    '  tabs_i=$((tabs_i+1))',
    '  sleep 0.5',
    'done',
    `printf '${URL_TIMEOUT_MARKER}\\n' >&2`,
    'tail -n 40 "$tabs_log" >&2',
    'exit 5',
  ].join('\n')
}

/**
 * Read the remote port and (optional) token out of a `dsh web:` launch line.
 * @param host - channel label, used in error messages only.
 * @param stdout - captured output carrying the launch URL.
 * @returns the remote port and the launch token; `null` token means a legacy dsh.
 */
export function parseLaunchUrl(host: string, stdout: string): { remotePort: number; token: string | null } {
  const text = stripAnsi(stdout)
  const match = /dsh web:\s*(\S+)/.exec(text)
  if (match === null) throw new Error(`remote dsh on '${host}' printed no launch URL: ${summarize(text)}`)
  let parsed: URL
  try {
    parsed = new URL(match[1])
  } catch {
    throw new Error(`remote dsh on '${host}' printed an unusable launch URL '${match[1]}'`)
  }
  const remotePort = Number(parsed.port)
  if (!Number.isInteger(remotePort) || remotePort <= 0) {
    throw new Error(`remote dsh on '${host}' reported no port in '${match[1]}'`)
  }
  const token = parsed.searchParams.get('token')
  return { remotePort, token: token !== null && isValidToken(token) ? token : null }
}

/** Remote command reading the last `dsh web:` line from the session log. */
export function launchUrlFromLogScript(): string {
  return `tail -n 2000 ${homePathWord(REMOTE_LOG)} 2>/dev/null | grep -a 'dsh web:' | tail -1`
}

/** Remote command reading the persisted launch token, whitespace stripped. */
export function storedTokenScript(): string {
  return `cat ${homePathWord(REMOTE_TOKEN_FILE)} 2>/dev/null | tr -d '[:space:]' | head -c 256`
}

/**
 * Remote command persisting the launch token with an owner-only file.
 * @param token - validated launch token.
 * @returns a script writing the token under `umask 077`.
 */
export function persistTokenScript(token: string): string {
  return `umask 077; printf '%s\\n' ${quotePosix(token)} > ${homePathWord(REMOTE_TOKEN_FILE)}`
}

/** Whether a launch token is shaped like the persisted one dsh-remote writes. */
export function isValidToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,}$/.test(value)
}

/**
 * Extract a valid launch token from a log excerpt carrying a `dsh web:` line.
 * @param text - log text that may hold the launch URL.
 * @returns the token, or null when none is present or valid (legacy dsh).
 */
export function parseLaunchToken(text: string): string | null {
  const match = /dsh web:\s*(\S+)/.exec(stripAnsi(text))
  if (match === null) return null
  try {
    const token = new URL(match[1]).searchParams.get('token')
    return token !== null && isValidToken(token) ? token : null
  } catch {
    return null
  }
}

/**
 * Whether one probe round proves the backend is alive: a legacy dsh serves `2xx`
 * bare, a token-gated one refuses the bare path with `401` and answers the
 * tokenized path with `303` or `2xx`.
 * @param bare - status of the bare path, or undefined when it could not be read.
 * @param withToken - status of the tokenized path, or undefined when unused.
 */
export function healthVerdict(bare: number | undefined, withToken: number | undefined): boolean {
  if (bare !== undefined && bare >= 200 && bare < 300) return true
  return bare === 401 && withToken !== undefined && (withToken === 303 || (withToken >= 200 && withToken < 300))
}

/**
 * Whether a start command already fixes its own `--port`.
 *
 * A WSL port scan picks the port it passes to the launch, but
 * {@link appendServeFlags} never overrides a flag the command already carries.
 * Retrying on the next port would therefore not change anything: the failure is
 * the user's own flag, so the caller stops at once and says so.
 * @param command - the user's start command; empty means the built-in default.
 */
export function startCommandPinsPort(command: string): boolean {
  return /(?:^|\s)--port(?:=|\s|$)/.test(command)
}

/**
 * The numeric port a start command fixes with `--port`.
 *
 * The WSL port scan starts from this port rather than the descriptor's, because
 * it is the port the launch will actually bind. 0 means the command pins no
 * numeric port (the built-in default, or a shell variable this module cannot
 * evaluate).
 * @param command - the user's start command.
 * @returns the pinned port, or 0.
 */
export function parsePinnedPort(command: string): number {
  const match = /(?:^|\s)--port(?:=|\s+)(\d+)/.exec(command)
  if (match === null) return 0
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
}

/**
 * The launch as one readable line for the connection log.
 * @param target - resolved remote values.
 * @param port - port the launch will request; defaults to the target's own port.
 * A WSL caller passes the port its scan selected, so the logged command matches
 * what actually runs instead of the descriptor's first candidate.
 * @returns `cd <workdir> && <command>`, bounded in length and token-free by construction.
 */
export function describeLaunch(target: RemoteTarget, port: number = target.port): string {
  const line = `cd ${cwdWord(target)} && ${launchCommand(target, port)}`
  return line.length > MAX_COMMAND_CHARS ? `${line.slice(0, MAX_COMMAND_CHARS)}…` : line
}

/** The built-in backend launch, without the environment prefix {@link startSessionScript} adds. */
export function defaultStartCommand(target: RemoteTarget): string {
  return `${remotePath(target.node)} ${remotePath(target.dshBin)} web --no-open`
}

/**
 * Append the loopback bind and target port to a start command unless it already
 * names them, so the backend listens only on the remote loopback and is reached
 * exclusively through the SSH tunnel or WSL2's localhost forwarding. Mirrors
 * `appendServeFlags` in `plugins/remote/dsh-remote/src/index.ts`; `--hostname` is
 * a different flag and must not satisfy the `--host` check.
 * @param command - the user's or the built-in start command.
 * @param port - remote port to request; 0 asks the remote OS to pick one.
 * @returns the command with whichever flags are missing appended.
 */
export function appendServeFlags(command: string, port: number): string {
  const hasFlag = (name: string) => new RegExp(`(?:^|\\s)${name}(?:=|\\s|$)`).test(command)
  const flags: string[] = []
  if (!hasFlag('--host')) flags.push('--host 127.0.0.1')
  if (!hasFlag('--port')) flags.push(`--port ${port}`)
  const base = command.trim()
  if (flags.length === 0) return base
  // `npm|pnpm|bun run <script>` forwards further argv only after a `--`
  // separator; without it the package manager rejects the flags.
  const packageManagerRun = /^(?:npm|pnpm|bun)\s+(?:(?:-C|--dir)\s+\S+\s+)*run\s+\S/.test(base)
  const separator = packageManagerRun && !/\s--\s*$/.test(base) ? ' -- ' : ' '
  return `${base}${separator}${flags.join(' ')}`
}

/** The working directory as one shell word; empty means the remote `$HOME`. */
function cwdWord(target: RemoteTarget): string {
  return target.workdir === '' ? '"$HOME"' : remotePath(target.workdir)
}

/**
 * The command one tmux pane runs, redirected to the shared session log. The
 * pane runs as an interactive login bash so the user's full environment (an
 * nvm-managed node/npm behind `~/.bashrc`, say) is present; the first line
 * records the Node the launch used.
 */
function paneCommand(target: RemoteTarget, port: number): string {
  const cwd = cwdWord(target)
  return `{ node -v; cd ${cwd} || { printf '${CD_FAILED_MARKER}%s\\n' ${cwd} >&2; exit 6; }; ${launchCommand(target, port)}; } > ${homePathWord(REMOTE_LOG)} 2>&1`
}

/** The launch: a user command as given, or the built-in one with `DSH_HOME`. */
function launchCommand(target: RemoteTarget, port: number): string {
  if (target.startCommand === '') {
    return `DSH_HOME=${remotePath(target.dshHome)} ${appendServeFlags(defaultStartCommand(target), port)}`
  }
  return appendServeFlags(target.startCommand, port)
}

/**
 * A remote `$HOME`-rooted path as one safe shell word: the whole `$HOME` +
 * literal suffix sits inside double quotes, so `$HOME` expands and a home path
 * with spaces is not word-split. Single-quoting only the suffix would leave the
 * quote characters literal inside the double quotes.
 */
function homePathWord(value: string): string {
  if (value.startsWith('$HOME')) return `"$HOME${value.slice('$HOME'.length)}"`
  return quotePosix(value)
}

/** Join one relative segment onto a remote root with POSIX separators. */
function joinRemote(root: string, relative: string): string {
  return `${root.replace(/\/+$/, '')}/${relative}`
}

/** Reduce arbitrary output to a one-line excerpt for an error message. */
function summarize(text: string): string {
  const line = stripAnsi(text).split('\n').map(part => part.trim()).filter(part => part !== '').join(' / ')
  return line.length > 300 ? `${line.slice(0, 300)}…` : line
}
