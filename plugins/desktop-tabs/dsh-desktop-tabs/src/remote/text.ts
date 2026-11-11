/**
 * Text normalisation shared by the remote-connection module.
 *
 * Both transformations serve the same rule: what a user reads must be plain
 * single-line text, and it must never contain a launch token.
 *
 * The control-sequence stripping is broader than colour codes because the WSL
 * channel runs its control scripts through a login shell, whose startup files
 * may still decorate stdout/stderr with OSC 3008 / title sequences, and because
 * the launch pane itself is an interactive shell whose log this module tails.
 * Those markers are not prose, and leaving them in would corrupt parsed values
 * (a token read back from a file would carry them) and log lines.
 */

/** One ESC `]` … BEL / ST operating-system-command sequence (window title, shell hook). */
const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g

/** One ESC `[` control-sequence-parameter … final-byte sequence (colour and cursor codes). */
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[A-Za-z]/g

/** One two-character ESC sequence, e.g. the `ESC \` string terminator on its own. */
const SHORT_ESCAPE = /\u001b[@-_]/g

/**
 * A line that looks like the root cause of a failure.
 *
 * A remote log tail is noisy: startup chatter first, then the actual error, then
 * stack frames and hints. The excerpt must never lose the error line, so it is
 * matched explicitly instead of relying on its position.
 */
const ERROR_HINT = /\berror\b|EADDRINUSE|failed|Cannot find|MODULE_NOT_FOUND|not found/i

/** Lines kept verbatim from the start of the output (who/what started). */
const HEAD_LINES = 3

/** Lines kept verbatim from the end of the output (the shell's last words). */
const TAIL_LINES = 6

/** Remove ANSI/OSC control sequences a decorated interactive shell may emit. */
export function stripAnsi(text: string): string {
  return text.replace(OSC_SEQUENCE, '').replace(CSI_SEQUENCE, '').replace(SHORT_ESCAPE, '')
}

/**
 * Build a single-line excerpt of a failed command's output that keeps its root cause.
 *
 * A log tail is long and its layout is hostile to naive slicing: keeping only the
 * end drops the one line that names the failure (`Error: Cannot find module …`,
 * `startup failed: EADDRINUSE`) once stack frames or a "Full diagnostics" block
 * follow it; keeping only the head drops the shell's final words. This excerpt
 * keeps a small head, the first line that looks like an error, and a small tail,
 * joined with ` / ` so it fits one connection-log line.
 * @param text - captured stdout/stderr of the failed command.
 * @param limit - maximum characters of the returned excerpt.
 * @returns the excerpt; empty when the input has no non-blank text.
 */
export function errorExcerpt(text: string, limit = 500): string {
  const lines = stripAnsi(text).split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return ''
  const hint = lines.find(line => ERROR_HINT.test(line))
  const selected: string[] = []
  const push = (line: string | undefined): void => {
    if (line !== undefined && !selected.includes(line)) selected.push(line)
  }
  for (const line of lines.slice(0, HEAD_LINES)) push(line)
  // The root-cause line goes before the tail so a plain head-keeping cut cannot
  // remove it when the joined form exceeds the limit.
  push(hint)
  for (const line of lines.slice(-TAIL_LINES)) push(line)
  let joined = selected.join(' / ')
  if (joined.length <= limit) return joined
  // Still too long: reorder the root cause to the front, because the cut below
  // keeps the head and the hint is the one line the user must not lose.
  if (hint !== undefined) joined = [hint, ...selected.filter(line => line !== hint)].join(' / ')
  return `${joined.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Replace launch-token values with `***`.
 *
 * A token belongs only in the URL `up` returns. Everything else — connection-log
 * lines, error messages, the `/connections` response — passes through here, so a
 * message that quotes a launch URL cannot leak the credential.
 * @param text - arbitrary text that may contain a `token=<value>` pair.
 * @returns the text with every token value masked.
 */
export function redactToken(text: string): string {
  return text.replace(/(token=)[^\s&'"]+/gi, '$1***')
}
