/**
 * The remote shell commands one connection runs, and parsing of their output.
 *
 * The remote backend lives in one long-lived `dsh-gui` tmux session shared by
 * every ssh tab to the same host — the session name, the log and the token file
 * are the ones `plugins/remote/dsh-remote` uses, so both plugins serve the same
 * remote backend on a host. `sessionStateScript` reads whether the session is
 * ALIVE, STALE, or MISSING; `startSessionScript` restarts it with the configured
 * command and clears the stale token; `waitForLaunchUrlScript` waits for the
 * launch URL in the session log; `paneStartCommandScript` reads the port the
 * pane was started with; and the token helpers read, validate, and persist the
 * launch token.
 *
 * The launch runs from the configured working directory: an empty `workdir` uses
 * the remote `$HOME`, and a `~`-rooted one is expanded through `$HOME` because a
 * quoted `~` would stay literal. An empty `startCommand` selects
 * {@link defaultStartCommand} with the runtime's own `DSH_HOME`; a user command
 * runs exactly as given and gets no environment prefix. Both forms have the
 * loopback bind and the port appended by {@link appendServeFlags}.
 *
 * Each script is one POSIX shell script passed to `ssh` as a single argv element,
 * built with `quotePosix` / `remotePath`. `$HOME` in the shared log and token
 * paths stays unquoted (single-quoting it would block the expansion).
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

/** Marker the reachability probe prints on success. */
export const PROBE_MARKER = 'TABS_SSH_OK'

/** Marker the start pane prints when its working directory cannot be entered. */
export const CD_FAILED_MARKER = 'TABS_CD_FAILED='

/** Remote tmux session name, shared with `plugins/remote/dsh-remote`. */
export const TMUX_SESSION = 'dsh-gui'

/** Remote log the session pane redirects to, shared with dsh-remote. */
export const REMOTE_LOG = '$HOME/.dsh-gui-remote.log'

/** Remote launch-token file, shared with dsh-remote. */
export const REMOTE_TOKEN_FILE = '$HOME/.dsh-gui-remote.token'

/** How many characters of a command string the log line keeps. */
const MAX_COMMAND_CHARS = 300

/** A tab resolved into the remote values the launch commands need. */
export interface RemoteTarget {
  readonly id: string
  readonly host: string
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
  readonly host: string
  /** Remote tmux session holding the backend. */
  readonly session: string
  /** Remote log the session's pane redirects to (`$HOME/.dsh-gui-remote.log`). */
  readonly logPath: string
}

/** Lifecycle of the remote tmux session, as {@link sessionStateScript} reads it. */
export type TmuxSessionState = 'MISSING' | 'STALE' | 'ALIVE'

/**
 * Apply the descriptor defaults and reject an unusable SSH destination.
 * @param id - tab id, used in error messages only.
 * @param row - configured tab or saved connection carrying the descriptor.
 * @returns the resolved remote values.
 */
export function resolveTarget(id: string, row: RemoteTab): RemoteTarget {
  const ssh = row.ssh
  if (ssh === undefined) {
    throw new Error(`tab '${id}' has no "ssh" descriptor (add {"ssh": {"host": "<alias>"}} to gui/desktop-tabs.json)`)
  }
  const host = ssh.host.trim()
  if (host === '' || /\s/.test(host)) throw new Error(`tab '${id}' has an unusable ssh host '${ssh.host}'`)
  const runtimeRoot = ssh.runtimeRoot ?? DEFAULT_RUNTIME_ROOT
  return {
    id,
    host,
    dshHome: ssh.dshHome ?? joinRemote(runtimeRoot, '.dsh'),
    dshBin: ssh.dshBin ?? joinRemote(runtimeRoot, DSH_BIN_RELATIVE),
    node: ssh.node ?? DEFAULT_NODE,
    port: ssh.port ?? 0,
    workdir: (row.workdir ?? '').trim(),
    startCommand: (row.startCommand ?? '').trim(),
  }
}

/**
 * Remote command proving the alias answers a non-interactive command.
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
 * @returns the script; a non-zero exit means the session could not be created.
 */
export function startSessionScript(target: RemoteTarget, cleanExisting: boolean): string {
  const lines: string[] = []
  if (cleanExisting) lines.push(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null || true`)
  lines.push(`rm -f ${homePathWord(REMOTE_TOKEN_FILE)}`)
  lines.push(`tmux new-session -d -s ${TMUX_SESSION} ${quotePosix(`bash -l -i -c ${quotePosix(paneCommand(target))}`)}`)
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
 * it never came. The pane-dead check covers a backend that exits during boot
 * (there is no pid to probe once the backend runs inside tmux).
 * @returns a script that prints the `dsh web:` line, or exits 4 (pane dead) / 5 (timeout).
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
    "    printf 'TABS_SESSION_DEAD=1\\n' >&2",
    `    grep -m1 '${CD_FAILED_MARKER}' "$tabs_log" 2>/dev/null || true`,
    '    tail -n 40 "$tabs_log" >&2',
    '    exit 4',
    '  fi',
    '  tabs_i=$((tabs_i+1))',
    '  sleep 0.5',
    'done',
    "printf 'TABS_URL_TIMEOUT=1\\n' >&2",
    'tail -n 40 "$tabs_log" >&2',
    'exit 5',
  ].join('\n')
}

/**
 * Read the remote port and (optional) token out of a `dsh web:` launch line.
 * @param host - SSH destination, used in error messages only.
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
 * Whether one probe round proves the tunneled backend is alive: a legacy dsh
 * serves `2xx` bare, a token-gated one refuses the bare path with `401` and
 * answers the tokenized path with `303` or `2xx`.
 * @param bare - status of the bare path, or undefined when it could not be read.
 * @param withToken - status of the tokenized path, or undefined when unused.
 */
export function healthVerdict(bare: number | undefined, withToken: number | undefined): boolean {
  if (bare !== undefined && bare >= 200 && bare < 300) return true
  return bare === 401 && withToken !== undefined && (withToken === 303 || (withToken >= 200 && withToken < 300))
}

/**
 * The launch as one readable line for the connection log.
 * @param target - resolved remote values.
 * @returns `cd <workdir> && <command>`, bounded in length and token-free by construction.
 */
export function describeLaunch(target: RemoteTarget): string {
  const line = `cd ${cwdWord(target)} && ${launchCommand(target)}`
  return line.length > MAX_COMMAND_CHARS ? `${line.slice(0, MAX_COMMAND_CHARS)}…` : line
}

/** The built-in backend launch, without the environment prefix {@link startSessionScript} adds. */
export function defaultStartCommand(target: RemoteTarget): string {
  return `${remotePath(target.node)} ${remotePath(target.dshBin)} web --no-open`
}

/**
 * Append the loopback bind and target port to a start command unless it already
 * names them, so the backend listens only on the remote loopback and is reached
 * exclusively through the SSH tunnel. Mirrors `appendServeFlags` in
 * `plugins/remote/dsh-remote/src/index.ts`; `--hostname` is a different flag and
 * must not satisfy the `--host` check.
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
function paneCommand(target: RemoteTarget): string {
  const cwd = cwdWord(target)
  return `{ node -v; cd ${cwd} || { printf '${CD_FAILED_MARKER}%s\\n' ${cwd} >&2; exit 6; }; ${launchCommand(target)}; } > ${homePathWord(REMOTE_LOG)} 2>&1`
}

/** The launch: a user command as given, or the built-in one with `DSH_HOME`. */
function launchCommand(target: RemoteTarget): string {
  if (target.startCommand === '') {
    return `DSH_HOME=${remotePath(target.dshHome)} ${appendServeFlags(defaultStartCommand(target), target.port)}`
  }
  return appendServeFlags(target.startCommand, target.port)
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