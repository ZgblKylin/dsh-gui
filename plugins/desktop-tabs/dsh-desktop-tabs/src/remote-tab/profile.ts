/**
 * Child profile generation for remote tabs.
 *
 * Each remote tab runs its own `dsh web` process under a private `DSH_HOME`
 * (`<DSH_HOME>/gui/remote-tabs/<safeId>/home`), so the child needs its own
 * profile directory. Generating one by `pnpm add` would duplicate the whole
 * parent dependency tree; instead this module writes a child profile whose
 * `node_modules` is a junction to the parent profile's tree and whose
 * composition mirrors the parent:
 *
 * ```
 * <childHome>/profiles/remote-tab/
 *   package.json      parent dependencies + the parent's `dsh.profile.bundles`
 *   cordis.patch.yml  the parent's user patch + the provider's own patch layer
 *   node_modules      junction to <parentProfile>/node_modules
 * ```
 *
 * The child is a separate page/backend, not a second view of the parent page.
 * To render the same local UI it must load the parent composition — every
 * bundle the parent profile lists, plus the provider's own additions (its
 * bootstrap bundle and client configuration). The parent's `cordis.patch.yml`
 * user layer is copied verbatim so the child's local plugins start with the
 * same settings; only the provider's patch layer is appended, last, to pin its
 * client mode.
 *
 * The parent profile directory arrives from the hosting process (`argv[3]`,
 * `DSH_PROFILE_DIR`, or `DSH_HOME/profiles/<DSH_PROFILE|web>`), the runtime
 * directory from `argv[2]` or the entry path; nothing is hard-coded to one
 * installation layout.
 *
 * The child also needs the hosting runtime's core packages, which the profile
 * does not install; `./loader.ts` writes the ESM loader the supervisor passes
 * to the child so those imports resolve against the runtime first and the
 * profile second.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { writeRemoteTabLoader } from './loader.ts'
import type { RemoteTabHomeFile, RemoteTabProvider } from './types.ts'
import { resolveDshHome } from '../targets.ts'

/** Profile name the child boots with (`dsh --profile remote-tab`). */
export const REMOTE_TAB_PROFILE_NAME = 'remote-tab'

/** Maximum length of a generated device name, per the identity schema. */
export const MAX_DEVICE_NAME = 80

/** Parent-profile facts the child needs, resolved generically. */
export interface RemoteTabContext {
  /** Immutable runtime directory the hosting dsh process runs from. */
  readonly runtimeDir?: string
  /** Profile directory the hosting process boots (`--profile`). */
  readonly parentProfileDir?: string
  /** The `@deepseek-ai/dsh` CLI entry inside the runtime. */
  readonly cliPath?: string
}

/** Compatibility alias; the context is no longer desktop-specific. */
export type DesktopContext = RemoteTabContext

/** Options of one child profile write. */
export interface WriteRemoteTabProfileOptions {
  /** Parent profile whose composition and `node_modules` the child reuses. */
  readonly parentProfileDir: string
  /** Parent Harness home, whose user files the provider copies. */
  readonly parentDshHome: string
  /** The child's own Harness home. */
  readonly childHome: string
  /** Remote server URL the provider's client connects to. */
  readonly serverUrl: string
  /** The backend provider whose bundles/patch/files the child adds. */
  readonly provider: RemoteTabProvider
  /** Runtime directory the child boots from; the loader's first anchor derives from it. */
  readonly runtimeDir?: string
  /** Explicit loader runtime anchor (`package.json` of the dsh installation). */
  readonly runtimeAnchor?: string
  /** Explicit child CLI entry; overrides resolution. */
  readonly cliPath?: string
  /** Bundle candidates; defaults to the parent profile's verbatim bundle list. */
  readonly bundles?: readonly string[]
  /** Environment used for provider preparation. */
  readonly env?: NodeJS.ProcessEnv
}

/** What one profile write produced, for logs and the spawn plan. */
export interface RemoteTabProfile {
  readonly childHome: string
  readonly profileDir: string
  readonly cliPath: string
  readonly packagePath: string
  readonly patchPath: string
  /** Bundle names listed in the child `package.json`. */
  readonly bundles: string[]
  /** Generated ESM loader the child spawns with. */
  readonly loaderPath: string
  /** Runtime anchor baked into the loader; absent when the runtime is unknown. */
  readonly runtimeAnchor?: string
  /** Parent profile anchor baked into the loader. */
  readonly profileAnchor: string
  /** Provider home files that were copied into the child home (absolute targets). */
  readonly homeFiles: string[]
}

/**
 * Resolve the launch facts a child needs from the hosting process.
 *
 * - runtime directory: `argv[2]` when it holds
 *   `node_modules/@deepseek-ai/dsh/package.json`, else the runtime root guessed
 *   by walking up from `argv[1]` (the desktop host entry, or the dsh CLI), else
 *   a `DSH_PLUGIN_DSH_CLI` / `DSH_DESKTOP_DSH_DIR` hint;
 * - parent profile: `argv[3]`, then `DSH_PROFILE_DIR`, then
 *   `$DSH_HOME/profiles/<DSH_PROFILE|web>`;
 * - child CLI: `<runtimeDir>/node_modules/@deepseek-ai/dsh/lib/bin.js`.
 *
 * Every candidate is validated on disk, so a non-desktop boot reports the
 * missing facts instead of failing later with a confusing path.
 * @param argv - process argv.
 * @param env - process environment.
 * @param home - platform home directory fallback.
 * @returns the resolved context; fields are absent when the facts cannot be resolved.
 */
export function resolveRemoteTabContext(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): RemoteTabContext {
  const runtimeDir = resolveRuntimeDir(argv, env)
  const parentProfileDir = resolveParentProfileDir(argv, env, home)
  const cliPath = resolveChildCli(runtimeDir)
  return {
    ...(runtimeDir === undefined ? {} : { runtimeDir }),
    ...(parentProfileDir === undefined ? {} : { parentProfileDir }),
    ...(cliPath === undefined ? {} : { cliPath }),
  }
}

/** Compatibility alias of {@link resolveRemoteTabContext}. */
export const resolveDesktopContext = resolveRemoteTabContext

/**
 * Resolve the dsh runtime directory the hosting process runs from.
 * @param argv - process argv.
 * @param env - process environment.
 * @returns the runtime root, or undefined when none can be found.
 */
export function resolveRuntimeDir(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = cleanPath(argv[2])
  if (explicit !== undefined && isRuntimeDir(explicit)) return explicit
  const fromEntry = runtimeRootFrom(argv[1])
  if (fromEntry !== undefined) return fromEntry
  const hinted = cleanPath(env.DSH_PLUGIN_DSH_CLI)
  if (hinted !== undefined) {
    const fromHint = runtimeRootFrom(hinted)
    if (fromHint !== undefined) return fromHint
  }
  const desktopDir = cleanPath(env.DSH_DESKTOP_DSH_DIR)
  if (desktopDir !== undefined && isRuntimeDir(desktopDir)) return desktopDir
  return undefined
}

/**
 * Resolve the profile directory the hosting process booted.
 * @param argv - process argv.
 * @param env - process environment.
 * @param home - platform home directory fallback.
 * @returns the parent profile directory, or undefined when none can be found.
 */
export function resolveParentProfileDir(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | undefined {
  const fromArgv = cleanPath(argv[3])
  if (fromArgv !== undefined && isProfileDir(fromArgv)) return fromArgv
  const fromEnv = cleanPath(env.DSH_PROFILE_DIR)
  if (fromEnv !== undefined && isProfileDir(fromEnv)) return fromEnv
  const profileName = cleanPath(env.DSH_PROFILE) ?? 'web'
  const fallback = join(resolveDshHome(env, home), 'profiles', profileName)
  return isProfileDir(fallback) ? fallback : undefined
}

/**
 * Resolve the child CLI inside a runtime directory.
 * @param runtimeDir - runtime root, or undefined.
 * @returns the existing CLI entry, or undefined.
 */
export function resolveChildCli(runtimeDir: string | undefined): string | undefined {
  if (runtimeDir === undefined) return undefined
  const candidate = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return isFile(candidate) ? candidate : undefined
}

/**
 * The child Harness home of one saved connection: `<DSH_HOME>/gui/remote-tabs/<safeId>/home`.
 * @param dshHome - the parent Harness home.
 * @param connectionId - the saved connection id.
 * @returns absolute child home path.
 */
export function remoteTabHome(dshHome: string, connectionId: string): string {
  return join(dshHome, 'gui', 'remote-tabs', safeConnectionId(connectionId), 'home')
}

/**
 * A filesystem-safe, collision-free directory name for a connection id.
 *
 * The readable part keeps the id recognizable in logs; the short hash keeps two
 * ids that sanitize to the same text apart, and makes a path-traversing id
 * harmless.
 * @param connectionId - the saved connection id.
 * @returns a name usable as one path segment.
 */
export function safeConnectionId(connectionId: string): string {
  const readable = connectionId
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[.-]+/u, '')
    .slice(0, 64)
  const hash = createHash('sha1').update(connectionId).digest('hex').slice(0, 8)
  return `${readable === '' ? 'remote' : readable}-${hash}`
}

/**
 * The generated profile directory inside a child home.
 * @param childHome - the child Harness home.
 * @returns `<childHome>/profiles/remote-tab`.
 */
export function remoteTabProfileDir(childHome: string): string {
  return join(childHome, 'profiles', REMOTE_TAB_PROFILE_NAME)
}

/**
 * The generated device name of one child: the connection title plus a suffix,
 * truncated to the identity schema's 80-character limit. The limit counts
 * UTF-16 code units (the schema's `max(80)`), so an emoji cannot push the name
 * over it, and the cut never splits a surrogate pair.
 * @param title - the saved connection title.
 * @returns the child device name.
 */
export function remoteDeviceName(title: string): string {
  const trimmed = title.trim()
  const base = trimmed === '' ? '远程标签' : `${trimmed} · 远程标签`
  if (base.length <= MAX_DEVICE_NAME) return base
  let kept = ''
  for (const character of base) {
    const next = kept + character
    if (next.length > MAX_DEVICE_NAME) break
    kept = next
  }
  return kept
}

/**
 * Generate (or refresh) the child profile of one remote tab.
 *
 * Idempotent: re-running rewrites the manifest, patch, and loader from the
 * current parent profile while leaving the `node_modules` junction and an
 * existing child home file alone (a user's edits in one tab survive).
 * @param options - parent/child paths, the provider, and the remote server URL.
 * @returns the generated paths, for logs and the spawn plan.
 * @throws Error when the parent profile, a provider requirement, or the child CLI cannot be resolved.
 */
export function writeRemoteTabProfile(options: WriteRemoteTabProfileOptions): RemoteTabProfile {
  const parentPackagePath = join(options.parentProfileDir, 'package.json')
  const parentPackage = readJsonRecord(parentPackagePath, '父 profile 的 package.json')
  const profileDir = remoteTabProfileDir(options.childHome)
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(options.childHome, { recursive: true })

  const parentNodeModules = join(options.parentProfileDir, 'node_modules')
  if (!isDirectory(parentNodeModules)) {
    throw new Error(`父 profile 的 node_modules 不存在：${parentNodeModules}；请先在宿主应用中完成依赖安装`)
  }
  // The provider may need to repair parent-profile resolution before the child
  // boots; it owns everything that is specific to its backend plugin.
  options.provider.prepareParent?.({
    parentProfileDir: options.parentProfileDir,
    parentDshHome: options.parentDshHome,
    ...(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  linkNodeModules(parentNodeModules, join(profileDir, 'node_modules'))

  const runtimeAnchor = resolveRuntimeAnchor(options)
  // Bundle resolution mirrors the loader: the dsh installation first (the in-box
  // bundles live only in the runtime), then the profile itself. This is only
  // used to decide which *provider additions* can be listed; the parent's own
  // bundle list is carried verbatim.
  const anchors = bundleAnchors(options.parentProfileDir, runtimeAnchor)
  const parentBundles = options.bundles ?? readParentBundles(parentPackage)
  const bundles = [...parentBundles]
  for (const required of options.provider.requiredBundles) {
    if (!resolvesBundle(required, anchors)) {
      throw new Error(
        `远程标签后端 ${options.provider.id} 不可用：父 profile 中缺少 ${required}；请先安装并启用该插件`,
      )
    }
  }
  for (const bundle of options.provider.bundles) {
    if (resolvesBundle(bundle, anchors) && !bundles.includes(bundle)) bundles.push(bundle)
  }

  const dependencies = readDependencies(parentPackage)
  const childPackage = {
    name: `dsh-profile-${REMOTE_TAB_PROFILE_NAME}`,
    private: true,
    ...(Object.keys(dependencies).length === 0 ? {} : { dependencies }),
    dsh: { profile: { bundles } },
  }
  const packagePath = join(profileDir, 'package.json')
  writeTextAtomically(packagePath, `${JSON.stringify(childPackage, null, 2)}\n`)

  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeTextAtomically(patchPath, childPatchYaml(
    options.parentProfileDir,
    options.provider.renderPatch({ serverUrl: options.serverUrl }),
  ))

  const homeFiles = copyHomeFiles(options.parentDshHome, options.childHome, options.provider.homeFiles)

  const cliPath = options.cliPath ?? resolveChildCli(options.runtimeDir)
  if (cliPath === undefined) {
    throw new Error(
      '找不到子后端 CLI（<runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js）：'
      + '无法从宿主进程解析 dsh 运行时，请先启动宿主应用，或显式指定 cliPath',
    )
  }

  const profileAnchor = join(options.parentProfileDir, 'package.json')
  const loader = writeRemoteTabLoader({
    childHome: options.childHome,
    ...(runtimeAnchor === undefined ? {} : { runtimeAnchor }),
    profileAnchor,
  })
  return {
    childHome: options.childHome,
    profileDir,
    cliPath,
    packagePath,
    patchPath,
    bundles,
    loaderPath: loader.path,
    ...(runtimeAnchor === undefined ? {} : { runtimeAnchor }),
    profileAnchor,
    homeFiles,
  }
}

/**
 * Resolve the loader runtime anchor of one profile write: an explicit anchor
 * wins, otherwise the installed-runtime layout under the runtime directory.
 * @param options - profile write options.
 * @returns the dsh installation's `package.json`, or undefined for no runtime.
 */
function resolveRuntimeAnchor(options: WriteRemoteTabProfileOptions): string | undefined {
  if (options.runtimeAnchor !== undefined) return options.runtimeAnchor
  if (options.runtimeDir === undefined) return undefined
  return join(options.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}

/**
 * The two anchors the loader resolves a bundle / package from, in order.
 * @param parentProfileDir - parent profile directory.
 * @param runtimeAnchor - the chosen dsh installation's `package.json`, when known.
 * @returns the runtime anchor first (when present), then the profile manifest.
 */
export function bundleAnchors(parentProfileDir: string, runtimeAnchor: string | undefined): string[] {
  const anchors: string[] = []
  if (runtimeAnchor !== undefined) anchors.push(runtimeAnchor)
  anchors.push(join(parentProfileDir, 'package.json'))
  return anchors
}

/**
 * Copy one provider home file into the child home once, creating its directory.
 * Existing child files win, so a user's edits in one tab survive regeneration.
 * @param parentDshHome - parent Harness home.
 * @param childHome - child Harness home.
 * @param files - provider-declared home files.
 * @returns absolute target paths of the files that exist after the copy.
 */
function copyHomeFiles(
  parentDshHome: string,
  childHome: string,
  files: readonly RemoteTabHomeFile[],
): string[] {
  const copied: string[] = []
  for (const file of files) {
    const source = join(parentDshHome, file.source)
    const target = join(childHome, file.target)
    if (isFile(source) && !existsSync(target)) {
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, readFileSync(source))
      } catch {
        // Home-file copies are a convenience; a failure must not stop the child boot.
      }
    }
    if (isFile(target)) copied.push(target)
  }
  return copied
}

/**
 * Compose the child's patch layer: the parent profile's user patch first, then
 * the provider's own layer last so it wins for its entry.
 * @param parentProfileDir - parent profile holding `cordis.patch.yml`.
 * @param providerPatch - the provider's patch text.
 * @returns the child patch file content.
 */
function childPatchYaml(parentProfileDir: string, providerPatch: string): string {
  const parent = readParentPatch(parentProfileDir)
  if (parent === '') return providerPatch
  return `${parent}\n\n${providerPatch}`
}

/**
 * Read the parent profile's user patch, ignoring the default empty template.
 * @param parentProfileDir - parent profile directory.
 * @returns the patch text without the default `[]` placeholder, or ''.
 */
function readParentPatch(parentProfileDir: string): string {
  let text: string
  try {
    text = readFileSync(join(parentProfileDir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return ''
  }
  const meaningful = text
    .split(/\r?\n/u)
    .filter((line) => !line.trim().startsWith('#') && line.trim() !== '')
    .join('\n')
    .trim()
  if (meaningful === '' || meaningful === '[]') return ''
  return text.trimEnd()
}

/**
 * Read the parent profile's ordered bundle list.
 * @param parentPackage - parsed parent `package.json`.
 * @returns bundle names in composition order (empty when absent).
 */
function readParentBundles(parentPackage: Record<string, unknown>): string[] {
  const dsh = asRecord(parentPackage.dsh)
  const profile = dsh === undefined ? undefined : asRecord(dsh.profile)
  const bundles = profile?.bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((bundle): bundle is string => typeof bundle === 'string' && bundle.trim() !== '')
}

/** Narrow an unknown value to a record, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Create the child `node_modules` junction to the parent tree, when absent. */
function linkNodeModules(target: string, link: string): void {
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(link)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    // A junction from an earlier attempt (or a user-made link) is reused as-is.
    if (existing.isSymbolicLink() || existing.isDirectory()) return
    rmSync(link, { recursive: true, force: true })
  }
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Whether a package resolves from one of the loader's anchors.
 *
 * Mirrors `resolveBundleDir` of `@deepseek-ai/dsh-app-boot`:
 * `createRequire(anchor).resolve.paths(name)` yields the node_modules search
 * directories; the first one carrying `<name>/package.json` wins.
 * @param name - package name.
 * @param anchors - install anchor first, the profile manifest second.
 * @returns whether the loader would find the package.
 */
function resolvesBundle(name: string, anchors: readonly string[]): boolean {
  const segments = name.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return false
  for (const anchor of anchors) {
    let searchPaths: string[] | null
    try {
      searchPaths = createRequire(anchor).resolve.paths(name)
    } catch {
      continue
    }
    if (searchPaths === null) continue
    for (const searchPath of searchPaths) {
      if (existsSync(join(searchPath, ...segments, 'package.json'))) return true
    }
  }
  return false
}

/** The `dependencies` map of a parent profile manifest, or an empty map. */
function readDependencies(parentPackage: Record<string, unknown>): Record<string, unknown> {
  const dependencies = parentPackage.dependencies
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) return {}
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(dependencies)) {
    if (typeof value === 'string') out[name] = value
  }
  return out
}

/** Read one JSON object file, with a caller-named error message. */
function readJsonRecord(path: string, label: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new Error(`无法读取${label}（${path}）：${message(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new Error(`${label} 不是合法 JSON（${path}）：${message(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} 不是 JSON 对象（${path}）`)
  }
  return parsed as Record<string, unknown>
}

/** Write one text file through a sibling temporary file and a rename. */
function writeTextAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, path)
  } catch (error: unknown) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Best-effort cleanup; the original error is the report.
    }
    throw error
  }
}

/** @returns a trimmed non-empty path string, or undefined. */
function cleanPath(value: string | undefined): string | undefined {
  const text = value?.trim() ?? ''
  return text === '' ? undefined : text
}

/** Walk up from one file path to the runtime root containing the dsh package. */
function runtimeRootFrom(file: string | undefined): string | undefined {
  const start = cleanPath(file)
  if (start === undefined) return undefined
  let directory = dirname(resolve(start))
  for (let depth = 0; depth < 12; depth += 1) {
    if (isRuntimeDir(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

/** Whether the directory is a dsh runtime root. */
function isRuntimeDir(directory: string): boolean {
  return isFile(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

/** Whether the directory is a dsh profile (its manifest is present). */
function isProfileDir(directory: string): boolean {
  return isDirectory(directory) && isFile(join(directory, 'package.json'))
}

/** Whether the path names an existing directory. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Whether the path names an existing regular file (or a symbolic link to one). */
function isFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** Expand a leading `~` (or `~/`, `~\`) platform-style. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/** Resolve an absolute path, expanding `~` and anchoring relative paths at the process cwd. */
export function absolutePath(path: string, home: string = homedir()): string {
  const expanded = expandHome(path, home)
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
