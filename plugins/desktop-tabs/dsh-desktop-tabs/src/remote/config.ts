/**
 * The SSH half of the tab configuration.
 *
 * `../targets.ts` owns the configured tab list and the resolvable `url` /
 * `port`+`tokenFile` URL forms. A tab whose target has to be started remotely
 * cannot be resolved into a URL ahead of the connection, so its descriptor is
 * read here instead: this module takes only the rows carrying `ssh`, plus the
 * flat `workdir` / `startCommand` launch fields, and leaves every other field to
 * that normalization.
 *
 * Reading never throws. A missing or malformed file is the reader's normal
 * first-run state; `../targets.ts` reports those problems once per host boot.
 */

import { readFileSync } from 'node:fs'

import { tabsFilePath } from '../targets.ts'

/** SSH connection descriptor of one tab. */
export interface SshSpec {
  /** SSH destination: an alias from `~/.ssh/config`, or `[user@]host`. */
  readonly host: string
  /** Runtime root on the remote host. @default '~/dsh-gui-home' */
  readonly runtimeRoot?: string
  /** Remote Harness home. @default '<runtimeRoot>/.dsh' */
  readonly dshHome?: string
  /** Remote dsh CLI entry. @default '<runtimeRoot>/.harness/node_modules/@deepseek-ai/dsh/lib/bin.js' */
  readonly dshBin?: string
  /** Remote node executable. @default 'node' */
  readonly node?: string
  /** Remote `dsh web` port; 0 asks the remote OS to pick one. @default 0 */
  readonly port?: number
}

/** One configured tab carrying an SSH descriptor and its launch settings. */
export interface ConfiguredSshTab {
  readonly id: string
  readonly title: string
  readonly ssh: SshSpec
  /** Remote working directory of the launch; absent means the remote `$HOME`. */
  readonly workdir?: string
  /** Remote command that starts the backend; absent means the built-in default. */
  readonly startCommand?: string
}

/**
 * Read the configured tabs that carry an SSH descriptor.
 * @param dshHome - Harness home holding `gui/desktop-tabs.json`.
 * @returns one row per usable descriptor, in file order.
 */
export function readConfiguredSshTabs(dshHome: string): ConfiguredSshTab[] {
  const path = tabsFilePath(dshHome)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // No config yet is the normal first-run state.
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Malformed JSON is reported by the tab-list reader; this reader adds nothing.
    return []
  }
  const rows = isRecord(parsed) ? parsed.tabs : undefined
  if (!Array.isArray(rows)) return []
  const tabs: ConfiguredSshTab[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id === '') continue
    const ssh = isRecord(row.ssh) ? readSshSpec(row.ssh) : undefined
    if (ssh === undefined) continue
    const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : id
    const tab: MutableConfiguredSshTab = { id, title, ssh }
    const workdir = optionalString(row.workdir)
    if (workdir !== undefined) tab.workdir = workdir
    const startCommand = optionalString(row.startCommand)
    if (startCommand !== undefined) tab.startCommand = startCommand
    tabs.push(tab)
  }
  return tabs
}

/** {@link ConfiguredSshTab} with assignable optional fields, for stepwise construction. */
interface MutableConfiguredSshTab {
  id: string
  title: string
  ssh: SshSpec
  workdir?: string
  startCommand?: string
}

/** One raw `ssh` object -> a descriptor, or undefined when it names no host. */
function readSshSpec(record: Record<string, unknown>): SshSpec | undefined {
  const host = optionalString(record.host)
  if (host === undefined) return undefined
  const spec: MutableSshSpec = { host }
  const runtimeRoot = optionalString(record.runtimeRoot)
  if (runtimeRoot !== undefined) spec.runtimeRoot = runtimeRoot
  const dshHome = optionalString(record.dshHome)
  if (dshHome !== undefined) spec.dshHome = dshHome
  const dshBin = optionalString(record.dshBin)
  if (dshBin !== undefined) spec.dshBin = dshBin
  const node = optionalString(record.node)
  if (node !== undefined) spec.node = node
  const port = optionalPort(record.port)
  if (port !== undefined) spec.port = port
  return spec
}

/** {@link SshSpec} with assignable optional fields, for stepwise construction. */
interface MutableSshSpec {
  host: string
  runtimeRoot?: string
  dshHome?: string
  dshBin?: string
  node?: string
  port?: number
}

/** @returns a trimmed non-empty string field, or undefined. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/** @returns an integer port field in range, or undefined. */
function optionalPort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= 0 && value <= 65535 ? value : undefined
}

/** Narrow an unknown JSON value to an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
