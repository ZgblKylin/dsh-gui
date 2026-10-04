/**
 * Text normalisation shared by the remote-connection module.
 *
 * Both transformations serve the same rule: what a user reads must be plain
 * single-line text, and it must never contain a launch token.
 */

/** Remove ANSI colour sequences, which a remote log may carry around the launch URL. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
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
