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
 *
 * One location lies outside the checkout: {@link desktopCliPath} resolves the
 * dsh CLI shipped with the desktop application, which is the only carrier
 * allowed to write the application's reserved `desktop` profile.
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

/** Directories of the bundled dsh CLI, relative to the application layout root. */
const DESKTOP_CLI_DIRS: ReadonlyArray<readonly string[]> = [
  // Windows and Linux place `resources/` next to the executable.
  ['resources', 'runtime', 'cli', 'bin'],
  // macOS keeps the executable in Contents/MacOS and the payload in Contents.
  ['..', 'Resources', 'runtime', 'cli', 'bin'],
]

/**
 * Resolve the dsh CLI that the desktop application ships.
 *
 * `desktop` is the application's reserved profile: the repository's own dsh CLI
 * rejects it outright (`rejectElectronProfile` in the CLI's argument parsing),
 * because only the CLI bundled with the installed application knows how to
 * write that profile. A plugin wrapper reaches that CLI through
 * `DSH_PLUGIN_DSH_CLI`, the carrier `scripts/plugin-install.mjs` uses for its
 * `plugin` commands, so the update path has to name it as well.
 *
 * The executable is the anchor because the host runs as an Electron Node-mode
 * child (`ELECTRON_RUN_AS_NODE=1`): `process.execPath` is the application exe,
 * not a Node binary, so its directory is the application root. The override is
 * returned without a resolution or an existence check: the caller owns that
 * choice, and such a check would second-guess a carrier the wrapper may resolve
 * itself.
 *
 * @param execPath - the application executable; defaults to `process.execPath`.
 * @param env - process environment to read `DSH_PLUGIN_DSH_CLI` from.
 * @returns the carrier CLI path, or `undefined` when no candidate exists.
 */
export function desktopCliPath(execPath?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.DSH_PLUGIN_DSH_CLI?.trim() ?? ''
  if (override !== '') return override
  const root = dirname(execPath ?? process.execPath)
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh'] : ['dsh', 'dsh.cmd']
  for (const dir of DESKTOP_CLI_DIRS) {
    for (const name of names) {
      const candidate = join(root, ...dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** Profile the desktop host installs plugins into when `DSH_PROFILE` is unset. */
const DEFAULT_PLUGIN_PROFILE = 'desktop'

/**
 * The plugin profile the update panel reports against: `<DSH_HOME>/profiles/
 * <profile>`, where the profile is the one the host runs (`DSH_PROFILE`, the
 * same value `./update.ts` passes to the wrapper), defaulting to the desktop
 * app's `desktop` profile.
 * @param env - process environment to read `DSH_HOME` / `DSH_PROFILE` from.
 * @returns the absolute profile path, or `undefined` when DSH_HOME is unset.
 */
export function pluginProfileDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = dshHomeDir(env)
  if (home === undefined) return undefined
  const profile = env.DSH_PROFILE?.trim() || DEFAULT_PLUGIN_PROFILE
  return join(home, 'profiles', profile)
}

/**
 * The version installed in the plugin profile for one npm package, read from
 * the profile's `node_modules` (the hoisted linker keeps every dependency
 * there). This is an npm plugin row's `current` when its install script tracks
 * `<package>@latest` instead of pinning a version.
 * @param packageName - npm package name, scoped names included.
 * @param env - process environment to read `DSH_HOME` / `DSH_PROFILE` from.
 * @returns the installed manifest version, or `undefined` when the package is
 *   not installed (or the home is not configured).
 */
export function installedPackageVersion(packageName: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const profile = pluginProfileDir(env)
  if (profile === undefined) return undefined
  return manifestVersion(join(profile, 'node_modules', ...packageName.split('/'), 'package.json'))
}

/** Read one `package.json` file's `version`, or `undefined` when unreadable. */
function manifestVersion(path: string): string | undefined {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const value = (parsed as { version?: unknown }).version
    if (typeof value !== 'string') return undefined
    const version = value.trim()
    return version === '' ? undefined : version
  } catch {
    return undefined
  }
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
 *
 * Submodules under `plugins/` are skipped: they are source references for
 * npm-installed wrappers, and the update panel tracks those wrappers' npm pins
 * instead (`./plugin-specs.ts`). The filter stays correct after the plugin
 * checkouts are removed, since the manifest simply stops listing them.
 *
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
    // A plugin submodule's updates never change what runs: the profile installs
    // the wrapper's npm pin. It must not surface as a git row.
    if (entry.path.startsWith('plugins/')) continue
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
