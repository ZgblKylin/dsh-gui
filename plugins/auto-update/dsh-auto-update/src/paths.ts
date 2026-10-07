/**
 * Repository-root and manifest resolution for the auto-update host half.
 *
 * The host process runs from inside an unpacked desktop application, so the
 * dsh-gui checkout it updates is never `process.cwd()`. {@link resolveGuiRoot}
 * tries, in order, and takes the first candidate that passes its check:
 *
 * 1. `DSH_GUI_ROOT` — the explicit override `scripts/desktop.mjs` injects into
 *    the desktop runtime; it only has to be an existing directory, so an
 *    operator can point the plugin at a worktree (where `.git` is a file) or at
 *    a checkout with an unusual name;
 * 2. `<dirname(DSH_HOME)>/dsh-gui` — the nested-clone layout, where the runtime
 *    root holds `.dsh/` beside the `dsh-gui/` checkout;
 * 3. `<dirname(DSH_HOME)>` itself — the single-directory layout, where the
 *    runtime root *is* the checkout.
 *
 * Candidates 2 and 3 must actually look like a checkout (`.git` present), so a
 * mis-set `DSH_HOME` cannot silently make an unrelated directory the update
 * target. Every failure raises {@link GuiRootError}, whose message is written
 * straight into the route's 500 body.
 *
 * The submodule list is read from the checkout's own `.gitmodules` — the same
 * authority `git submodule status` uses — because the dialog needs a row for a
 * submodule that has not been initialized yet, where git cannot answer.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Root row id; fixed by the interface contract. */
export const ROOT_PROJECT_ID = 'dsh-gui'

/** Raised when the dsh-gui checkout cannot be located; routes answer 500. */
export class GuiRootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuiRootError'
  }
}

/** One update row's location, resolved from the repository root. */
export interface ProjectRef {
  /** Stable id: {@link ROOT_PROJECT_ID} for the root, else the `.gitmodules` name. */
  id: string
  /** Display name: the directory's `package.json` name, else the id. */
  name: string
  /** Path relative to the repository root, POSIX; empty for the root row. */
  path: string
  /** Absolute working-tree directory. */
  dir: string
  /** `.gitmodules` URL of a submodule row; `undefined` for the root row. */
  url?: string
}

/** One `[submodule "<name>"]` entry of `.gitmodules`. */
export interface SubmoduleEntry {
  /** Submodule name, exactly as the section header writes it. */
  name: string
  /** Manifest path relative to the repository root, POSIX. */
  path: string
  /** Working-tree directory (the manifest path joined to the root). */
  dir: string
  /** Upstream URL the manifest records; empty when the section has none. */
  url: string
}

/**
 * Resolve the dsh-gui checkout root.
 * @param env - process environment to read `DSH_GUI_ROOT` / `DSH_HOME` from.
 * @returns the absolute checkout root.
 * @throws {GuiRootError} when no candidate is an existing (checkout) directory.
 */
export function resolveGuiRoot(env: NodeJS.ProcessEnv = process.env): string {
  const candidates: Array<{ dir: string; requireCheckout: boolean }> = []
  const override = env.DSH_GUI_ROOT?.trim() ?? ''
  if (override !== '') candidates.push({ dir: resolve(override), requireCheckout: false })
  const dshHome = env.DSH_HOME?.trim() ?? ''
  if (dshHome !== '') {
    const runtimeRoot = dirname(resolve(dshHome))
    candidates.push({ dir: join(runtimeRoot, 'dsh-gui'), requireCheckout: true })
    candidates.push({ dir: runtimeRoot, requireCheckout: true })
  }
  for (const candidate of candidates) {
    if (!isDirectory(candidate.dir)) continue
    if (candidate.requireCheckout && !existsSync(join(candidate.dir, '.git'))) continue
    return candidate.dir
  }
  throw new GuiRootError(
    '无法定位 dsh-gui 仓库根：请设置环境变量 DSH_GUI_ROOT 指向 dsh-gui 检出目录，'
      + '或让 DSH_HOME 指向运行时根的 .dsh（其父目录下应存在 dsh-gui/ 检出）',
  )
}

/**
 * Resolve the Harness home directory from `DSH_HOME`. The desktop runtime pins
 * it to `<runtime-root>/.dsh`; an unset or empty value yields `undefined` so
 * callers can skip every home-relative read instead of guessing a location.
 * @param env - process environment to read `DSH_HOME` from.
 * @returns the absolute home path, or `undefined` when it is not configured.
 */
export function dshHomeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DSH_HOME?.trim() ?? ''
  return raw === '' ? undefined : resolve(raw)
}

/**
 * Parse the top-level `[submodule …]` entries of the repository's `.gitmodules`.
 * A section missing `path`, or whose path is absolute or escapes the root
 * (`..`), is dropped: every git write this plugin performs is confined to the
 * paths the manifest declares relative to the checkout.
 * @param root - repository root holding `.gitmodules`.
 * @returns the entries in manifest order (empty when the file is absent/unreadable).
 */
export function submoduleEntries(root: string): SubmoduleEntry[] {
  let text = ''
  try {
    text = readFileSync(join(root, '.gitmodules'), 'utf8')
  } catch {
    return []
  }
  const entries: SubmoduleEntry[] = []
  let name: string | undefined
  let path: string | undefined
  let url = ''
  const flush = (): void => {
    if (name !== undefined && path !== undefined) {
      const relative = path.replace(/\\/g, '/').replace(/^\.\//, '')
      if (isSafeRelativePath(relative)) {
        entries.push({ name, path: relative, dir: join(root, ...relative.split('/')), url })
      }
    }
    name = undefined
    path = undefined
    url = ''
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[submodule')) {
      flush()
      const header = line.slice('[submodule'.length).replace(/\]$/, '').trim().replace(/^"|"$/g, '')
      if (header !== '') name = header
      continue
    }
    const separator = line.indexOf('=')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim().replace(/^"|"$/g, '')
    if (key === 'path') path = value
    else if (key === 'url') url = value
  }
  flush()
  return entries
}

/**
 * The full project list the dialog renders: the root row first (deterministic
 * order for the update stream), then every `.gitmodules` submodule.
 * @param root - repository root.
 * @returns one {@link ProjectRef} per row.
 */
export function listProjects(root: string): ProjectRef[] {
  const projects: ProjectRef[] = [{
    id: ROOT_PROJECT_ID,
    name: packageName(root) ?? ROOT_PROJECT_ID,
    path: '',
    dir: root,
  }]
  for (const entry of submoduleEntries(root)) {
    projects.push({
      id: entry.name,
      name: packageName(entry.dir) ?? entry.name,
      path: entry.path,
      dir: entry.dir,
      url: entry.url,
    })
  }
  return projects
}

/**
 * Read a directory's `package.json` name.
 * @param dir - directory that may hold a `package.json`.
 * @returns the trimmed `name`, or `undefined` when absent/unreadable/not a string.
 */
export function packageName(dir: string): string | undefined {
  let text = ''
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const value = (parsed as { name?: unknown }).name
    if (typeof value !== 'string') return undefined
    const name = value.trim()
    return name === '' ? undefined : name
  } catch {
    return undefined
  }
}

/** Whether `path` is an existing directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether a `.gitmodules` path may be joined to the repository root: relative,
 * no drive/UNC prefix, and no `.`/`..`/empty segment.
 * @param value - manifest path with `/` separators.
 */
function isSafeRelativePath(value: string): boolean {
  if (value === '' || isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}
