/**
 * SSH destination discovery for the tab configuration UI.
 *
 * The user's `~/.ssh/config` is the only source: it names the destinations the
 * `ssh` client can already reach without a password, which is exactly the set of
 * hosts this plugin may connect to. No credential material is read — not the
 * config's `IdentityFile`, not the harness credential store — and nothing here
 * touches the network; authentication stays inside `ssh` itself.
 *
 * Only `Host` blocks and their `HostName` / `User` / `Port` directives are
 * returned. Wildcard and negated patterns (`*`, `*.example.com`, `!bad`) are not
 * destinations, and `Include` is not followed: the file is read as it lies.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One SSH destination declared in the user's `~/.ssh/config`. */
export interface SshHostEntry {
  /** The `Host` pattern, usable verbatim as an `ssh` destination. */
  readonly alias: string
  /** `HostName` of the same block, when declared. */
  readonly hostName?: string
  /** `User` of the same block, when declared. */
  readonly user?: string
  /** `Port` of the same block, when declared and in range. */
  readonly port?: number
}

/**
 * Read the SSH destinations from the user's `~/.ssh/config`.
 * @param home - platform home directory; defaults to the current user's.
 * @returns one row per literal `Host` pattern, in file order; empty when unreadable.
 */
export function readSshHosts(home: string = homedir()): SshHostEntry[] {
  let text: string
  try {
    text = readFileSync(join(home, '.ssh', 'config'), 'utf8')
  } catch {
    // No SSH config, or no permission to read it, means no importable hosts.
    return []
  }
  const hosts: SshHostEntry[] = []
  let block: MutableHostEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [keyword, ...rest] = line.split(/[\s=]+/)
    const value = rest.join(' ').trim()
    if (keyword.toLowerCase() === 'host') {
      block = value.split(/\s+/).filter(pattern => isAlias(pattern)).map(alias => ({ alias }))
      hosts.push(...block)
      continue
    }
    if (block.length === 0) continue
    const lower = keyword.toLowerCase()
    for (const entry of block) {
      if (lower === 'hostname' && value !== '') entry.hostName ??= value
      else if (lower === 'user' && value !== '') entry.user ??= value
      else if (lower === 'port' && entry.port === undefined) {
        const port = Number(value)
        if (Number.isInteger(port) && port > 0 && port <= 65535) entry.port = port
      }
    }
  }
  return hosts
}

/** {@link SshHostEntry} with assignable optional fields, for stepwise construction. */
interface MutableHostEntry {
  alias: string
  hostName?: string
  user?: string
  port?: number
}

/** Whether a `Host` pattern names a concrete destination rather than a pattern. */
function isAlias(pattern: string): boolean {
  return pattern !== '' && !pattern.startsWith('!') && !/[*?[\]]/.test(pattern)
}
