/**
 * The remote half of the tab configuration.
 *
 * `../targets.ts` owns the configured tab list and the resolvable `url` /
 * `port`+`tokenFile` URL forms. A tab whose target has to be started remotely
 * cannot be resolved into a URL ahead of the connection, so its descriptor is
 * read here instead: this module takes only the rows carrying `ssh` or `wsl`,
 * plus the flat `workdir` / `startCommand` launch fields and the flat `account`
 * login name, and leaves every other field to that normalization.
 *
 * Two descriptor kinds exist:
 *
 * - `ssh`: the destination is an `ssh` alias/`[user@]host`, optionally with an
 *   `account` login name passed as `ssh -l`.
 * - `wsl`: the destination is a WSL distribution, optionally with an `account`
 *   passed as `wsl.exe -u`. An empty `distro` means the default distribution.
 *
 * A row carrying both is read as SSH: the two descriptors address genuinely
 * different machines, and the established SSH behaviour must not change for an
 * existing configuration that happens to grow a `wsl` field.
 *
 * Reading never throws. A missing or malformed file is the reader's normal
 * first-run state; `../targets.ts` reports those problems once per host boot.
 */

import { readFileSync } from 'node:fs'

import { tabsFilePath } from '../targets.ts'

/** Connection fields shared by both descriptor kinds. */
interface RemoteSpecFields {
  /** Runtime root on the remote host. @default '~/dsh-gui-home' */
  readonly runtimeRoot?: string
  /** Remote Harness home. @default '<runtimeRoot>/.dsh' */
  readonly dshHome?: string
  /** Remote dsh CLI entry. @default '<runtimeRoot>/.harness/node_modules/@deepseek-ai/dsh/lib/bin.js' */
  readonly dshBin?: string
  /** Remote node executable. @default 'node' */
  readonly node?: string
  /**
   * Preferred remote port. For SSH, 0 asks the remote OS to pick one; for WSL it
   * is the first candidate of the port scan. @default 0 for SSH, 3080 for WSL
   */
  readonly port?: number
}

/** SSH connection descriptor of one tab. */
export interface SshSpec extends RemoteSpecFields {
  /** SSH destination: an alias from `~/.ssh/config`, or `[user@]host`. */
  readonly host: string
}

/** WSL connection descriptor of one tab. */
export interface WslSpec extends RemoteSpecFields {
  /** Distribution name; empty selects the distribution `wsl.exe` defaults to. */
  readonly distro: string
}

/** One configured tab that names a remote target, plus its launch settings. */
export interface ConfiguredRemoteTab {
  readonly id: string
  readonly title: string
  /** SSH descriptor; wins over `wsl` when both are present. */
  readonly ssh?: SshSpec
  /** WSL descriptor. */
  readonly wsl?: WslSpec
  /** Explicit remote login name (`ssh -l` / `wsl.exe -u`). */
  readonly account?: string
  /** Remote working directory of the launch; absent means the remote `$HOME`. */
  readonly workdir?: string
  /** Remote command that starts the backend; absent means the built-in default. */
  readonly startCommand?: string
}

/** One configured tab carrying an SSH descriptor; kept for the SSH-only readers. */
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
 * Read the configured tabs that name an SSH or WSL destination.
 * @param dshHome - Harness home holding `gui/desktop-tabs.json`.
 * @returns one row per usable descriptor, in file order.
 */
export function readConfiguredRemoteTabs(dshHome: string): ConfiguredRemoteTab[] {
  const rows = readTabRows(dshHome)
  const tabs: ConfiguredRemoteTab[] = []
  for (const row of rows) {
    const ssh = isRecord(row.raw.ssh) ? readSshSpec(row.raw.ssh) : undefined
    const wsl = isRecord(row.raw.wsl) ? readWslSpec(row.raw.wsl) : undefined
    if (ssh === undefined && wsl === undefined) continue
    const tab: MutableConfiguredRemoteTab = {
      id: row.id,
      title: row.title,
      ...(ssh === undefined ? {} : { ssh }),
      ...(wsl === undefined ? {} : { wsl }),
    }
    const account = optionalString(row.raw.account)
    if (account !== undefined) tab.account = account
    const workdir = optionalString(row.raw.workdir)
    if (workdir !== undefined) tab.workdir = workdir
    const startCommand = optionalString(row.raw.startCommand)
    if (startCommand !== undefined) tab.startCommand = startCommand
    tabs.push(tab)
  }
  return tabs
}

/**
 * Read the configured tabs that carry an SSH descriptor.
 * @param dshHome - Harness home holding `gui/desktop-tabs.json`.
 * @returns one row per usable tab, in file order.
 */
export function readConfiguredSshTabs(dshHome: string): ConfiguredSshTab[] {
  const tabs: ConfiguredSshTab[] = []
  for (const tab of readConfiguredRemoteTabs(dshHome)) {
    if (tab.ssh === undefined) continue
    tabs.push({
      id: tab.id,
      title: tab.title,
      ssh: tab.ssh,
      ...(tab.workdir === undefined ? {} : { workdir: tab.workdir }),
      ...(tab.startCommand === undefined ? {} : { startCommand: tab.startCommand }),
    })
  }
  return tabs
}

/** One raw tab row as this reader needs it. */
interface RawTabRow {
  id: string
  title: string
  readonly raw: Record<string, unknown>
}

/** {@link ConfiguredRemoteTab} with assignable optional fields, for stepwise construction. */
interface MutableConfiguredRemoteTab {
  id: string
  title: string
  ssh?: SshSpec
  wsl?: WslSpec
  account?: string
  workdir?: string
  startCommand?: string
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

/** {@link WslSpec} with assignable optional fields, for stepwise construction. */
interface MutableWslSpec {
  distro: string
  runtimeRoot?: string
  dshHome?: string
  dshBin?: string
  node?: string
  port?: number
}

/** Read the tab rows from the config file; an unreadable or malformed file has none. */
function readTabRows(dshHome: string): RawTabRow[] {
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
  const tabs: RawTabRow[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id === '') continue
    const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : id
    tabs.push({ id, title, raw: row })
  }
  return tabs
}

/** One raw `ssh` object -> a descriptor, or undefined when it names no host. */
function readSshSpec(record: Record<string, unknown>): SshSpec | undefined {
  const host = optionalString(record.host)
  if (host === undefined) return undefined
  const spec: MutableSshSpec = { host }
  copySharedFields(record, spec)
  return spec
}

/** One raw `wsl` object -> a descriptor; the object itself is the WSL marker. */
function readWslSpec(record: Record<string, unknown>): WslSpec | undefined {
  if (record.distro !== undefined && typeof record.distro !== 'string') return undefined
  // An absent or empty distro means the default distribution, which is a valid
  // descriptor: the user may only want to say "the default WSL target".
  const spec: MutableWslSpec = { distro: typeof record.distro === 'string' ? record.distro.trim() : '' }
  copySharedFields(record, spec)
  return spec
}

/** Copy the optional fields both descriptors accept. */
function copySharedFields(record: Record<string, unknown>, spec: MutableSshSpec | MutableWslSpec): void {
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
