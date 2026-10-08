/**
 * The remote shell commands one connection runs, and parsing of their output.
 *
 * Four commands drive a connection: `probeScript` proves the alias is reachable
 * without an interactive prompt, `startScript` detaches the backend and reports
 * its pid and process group, `waitScript` reads the launch URL out of the remote
 * log, and `stopScript` reclaims the process tree and the log.
 *
 * The launch runs from the configured working directory: an empty `workdir` uses
 * the remote `$HOME`, and a `~`-rooted one is expanded through `$HOME` because a
 * quoted `~` would stay literal. An empty `startCommand` selects
 * {@link defaultStartCommand} with the runtime's own `DSH_HOME`; a user command
 * runs exactly as given and gets no environment prefix. Both forms have the
 * loopback bind and the port appended by {@link appendServeFlags}.
 *
 * Each script is one POSIX shell script passed to `ssh` as a single argv element,
 * built with `quotePosix` / `remotePath`. The only double-quoted word is the
 * `$HOME` reference of the default working directory.
 */

import { randomBytes } from 'node:crypto'

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
const TOKEN_TICKS = 150

/** Marker the reachability probe prints on success. */
export const PROBE_MARKER = 'TABS_SSH_OK'

/** Marker the launch prints when its working directory cannot be entered. */
export const CD_FAILED_MARKER = 'TABS_CD_FAILED='

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

/** One started remote backend, with what reclaiming it needs. */
export interface RemoteLaunch {
  readonly host: string
  readonly pid: string
  readonly pgid: string
  readonly logPath: string
}

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
 * Name the remote log file of one attempt.
 * @param id - tab id, reduced to characters usable in a file name.
 * @returns an absolute path under the remote `/tmp`.
 */
export function logPathFor(id: string): string {
  return `/tmp/dsh-desktop-tabs-${safeFilePart(id)}-${randomBytes(4).toString('hex')}.log`
}

/**
 * Remote command proving the alias answers a non-interactive command.
 * @returns the script; its stdout carries {@link PROBE_MARKER} on success.
 */
export function probeScript(): string {
  return `printf '${PROBE_MARKER}\\n'`
}

/** Remote command: detach the backend and report the pid and process group. */
export function startScript(target: RemoteTarget, logPath: string): string {
  const cwd = cwdWord(target)
  const script = [
    `tabs_log=${quotePosix(logPath)}`,
    'rm -f $tabs_log',
    `cd ${cwd} || { printf '${CD_FAILED_MARKER}%s\\n' ${cwd} >&2; exit 6; }`,
    // After the `cd`: a failed `cd` must not leave a log behind, and the runtime
    // line names the exact Node the launch will use.
    "printf 'TABS_LAUNCH_RUNTIME=%s %s\\n' \"$(command -v node)\" \"$(node -v 2>&1)\" >> $tabs_log",
    `${launchCommand(target)} >> $tabs_log 2>&1 < /dev/null &`,
    'tabs_pid=$!',
    // `ps -o pgid=` pads its column and the remote shell may not word-split an
    // unquoted expansion, so the padding is stripped here rather than downstream.
    "tabs_pgid=$(ps -o pgid= -p $tabs_pid 2>/dev/null | tr -d ' ')",
    "printf 'TABS_PID=%s\\n' $tabs_pid",
    "printf 'TABS_PGID=%s\\n' $tabs_pgid",
  ].join('\n')
  // The launch must see the user's FULL login+interactive environment: an
  // nvm-managed Node/npm only reaches PATH from `~/.bashrc`, and a guarded rc
  // (`case $- in *i*) ;; *) return;; esac`) refuses to load in a non-interactive
  // shell — so a plain `ssh <host> <script>` stays on the bare system Node.
  // With Node 20 that silently breaks the harness CLI entry
  // (`if (import.meta.main) await runCli()`, and `import.meta.main` does not
  // exist there): npm prints its banner, the backend exits 0, no launch URL.
  // `bash -l -i -c` mirrors `plugins/remote/dsh-remote/src/index.ts`
  // (`startSession`), which connects to the same hosts.
  return `bash -l -i -c ${quotePosix(script)}`
}

/**
 * Read the pid and process group out of {@link startScript}'s output.
 * @param host - SSH destination, used in error messages only.
 * @param logPath - remote log the start command writes.
 * @param stdout - captured output of the start command.
 * @returns the launch record to reclaim later.
 */
export function parseLaunch(host: string, logPath: string, stdout: string): RemoteLaunch {
  const pid = field(stdout, 'TABS_PID')
  if (pid === undefined) throw new Error(`starting dsh on '${host}' reported no pid: ${summarize(stdout)}`)
  return { host, pid, pgid: field(stdout, 'TABS_PGID') ?? '', logPath }
}

/** Remote command: wait for the launch URL in the log, or report why it never came. */
export function waitScript(launch: RemoteLaunch): string {
  return [
    `tabs_log=${quotePosix(launch.logPath)}`,
    `tabs_pid=${launch.pid}`,
    'tabs_i=0',
    `while [ $tabs_i -lt ${TOKEN_TICKS} ]; do`,
    "  if grep -m1 -q -E 'dsh web:.*https?://' $tabs_log 2>/dev/null; then",
    "    grep -m1 -E 'dsh web:.*https?://' $tabs_log",
    '    exit 0',
    '  fi',
    '  if kill -0 $tabs_pid 2>/dev/null; then :; else',
    "    printf 'TABS_REMOTE_EXITED=1\\n' >&2",
    '    tail -n 40 $tabs_log >&2',
    '    exit 4',
    '  fi',
    '  tabs_i=$((tabs_i+1))',
    '  sleep 0.5',
    'done',
    "printf 'TABS_REMOTE_TIMEOUT=1\\n' >&2",
    'tail -n 40 $tabs_log >&2',
    'exit 5',
  ].join('\n')
}

/**
 * Read the remote port and token out of {@link waitScript}'s output.
 * @param host - SSH destination, used in error messages only.
 * @param stdout - captured output of the wait command.
 * @returns the remote port and the launch token.
 */
export function parseLaunchUrl(host: string, stdout: string): { remotePort: number; token: string } {
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
  if (token === null || token === '') throw new Error(`remote dsh on '${host}' reported no token in '${match[1]}'`)
  return { remotePort, token }
}

/** Remote command: reclaim the launched backend tree and its log. */
export function stopScript(launch: RemoteLaunch): string {
  const group = launch.pgid === '' ? '0' : launch.pgid
  return [
    `tabs_pid=${launch.pid}`,
    `tabs_pgid=${group}`,
    'if [ $tabs_pgid -gt 1 ] 2>/dev/null; then kill -TERM -$tabs_pgid 2>/dev/null; fi',
    'kill -TERM $tabs_pid 2>/dev/null',
    'sleep 0.5',
    'if [ $tabs_pgid -gt 1 ] 2>/dev/null; then kill -KILL -$tabs_pgid 2>/dev/null; fi',
    'kill -KILL $tabs_pid 2>/dev/null',
    `rm -f ${quotePosix(launch.logPath)}`,
    'if kill -0 $tabs_pid 2>/dev/null; then',
    "  printf 'TABS_REMOTE_STILL_ALIVE=1\\n'",
    'fi',
  ].join('\n')
}

/**
 * Whether {@link stopScript}'s output reports a surviving process.
 * @param stdout - captured output of the stop command.
 */
export function remoteSurvived(stdout: string): boolean {
  return stdout.includes('TABS_REMOTE_STILL_ALIVE=1')
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

/** The built-in backend launch, without the environment prefix {@link startScript} adds. */
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

/** The detached launch: a user command as given, or the built-in one with `DSH_HOME`. */
function launchCommand(target: RemoteTarget): string {
  if (target.startCommand === '') {
    return `DSH_HOME=${remotePath(target.dshHome)} nohup ${appendServeFlags(defaultStartCommand(target), target.port)}`
  }
  return `nohup ${appendServeFlags(target.startCommand, target.port)}`
}

/** Join one relative segment onto a remote root with POSIX separators. */
function joinRemote(root: string, relative: string): string {
  return `${root.replace(/\/+$/, '')}/${relative}`
}

/** Read one `KEY=value` line, tolerating padding around the value. */
function field(stdout: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=\\s*(\\S*)\\s*$`, 'm').exec(stdout)
  const value = match?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Reduce arbitrary output to a one-line excerpt for an error message. */
function summarize(text: string): string {
  const line = stripAnsi(text).split('\n').map(part => part.trim()).filter(part => part !== '').join(' / ')
  return line.length > 300 ? `${line.slice(0, 300)}…` : line
}

/** Keep a tab id usable inside one remote log file name. */
function safeFilePart(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
  return safe === '' ? 'tab' : safe
}
