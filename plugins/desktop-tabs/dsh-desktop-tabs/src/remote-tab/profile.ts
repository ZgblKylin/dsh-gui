/**
 * Child profile generation for remote tabs.
 *
 * Each remote tab runs its own `dsh web` process under a private `DSH_HOME`
 * (`<DSH_HOME>/gui/remote-tabs/<safeId>/home`), so the child needs its own
 * profile directory. Generating one by `pnpm add` would duplicate the whole
 * desktop dependency tree; instead this module writes a minimal profile whose
 * `node_modules` is a junction to the parent profile's tree, lists only the
 * bundles the child actually needs, and pins `ds-harness-remote` in client mode
 * with `hostControl` disabled so the child never opens a host connection.
 *
 * The child profile layout is fixed by the CLI contract:
 *
 * ```
 * <childHome>/profiles/remote-tab/
 *   package.json      dependencies of the parent profile + the bundle whitelist
 *   cordis.patch.yml  ds-harness-remote client config
 *   node_modules      junction to <parentProfile>/node_modules
 * ```
 *
 * `<childHome>/settings.yaml` is copied once from the parent home when it
 * exists, so model/provider settings survive without carrying credentials into
 * the generated profile.
 *
 * The parent profile directory arrives as `process.argv[3]` and the immutable
 * runtime directory as `process.argv[2]` (the desktop host's launch contract);
 * `resolveDesktopContext` accepts them explicitly so the resolution is testable
 * without a desktop process.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

/** Profile name the child boots with (`dsh web --profile remote-tab`). */
export const REMOTE_TAB_PROFILE_NAME = 'remote-tab'

/** Maximum length of a generated device name, per the identity schema. */
export const MAX_DEVICE_NAME = 80

/**
 * Bundles the child profile should carry, in composition order: the base web
 * application, the remote plugin itself, the bootstrap plugin that opens the
 * remote workspace, and the desktop's user-visible plugins. A bundle is only
 * listed when its package directory resolves in the parent profile, so a
 * profile without (for example) the boot package still boots.
 */
export const CHILD_PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'ds-harness-remote',
  'dsh-remote-tab-boot',
  'dsh-better-sidebar',
  '@linxin666/dsh-client-ui-web-ui-settings',
  '@linxin666/dsh-usage',
  '@smalltailqwq/dsh-client-ui-skin-deep-whale-manager',
  '@smalltailqwq/dsh-client-ui-skin-maid-atelier',
  '@smalltailqwq/dsh-client-ui-skin-orca-link',
] as const

/** Bundle the child profile must always carry: the remote client runtime. */
const REQUIRED_BUNDLE = 'ds-harness-remote'

/** Parent profile directory, runtime directory, and the resolved child CLI. */
export interface DesktopContext {
  /** Immutable runtime directory (`process.argv[2]`); absent outside the desktop. */
  readonly runtimeDir?: string
  /** Desktop plugin profile directory (`process.argv[3]`, else `DSH_PROFILE_DIR`). */
  readonly parentProfileDir?: string
  /** Resolved `@deepseek-ai/dsh` CLI entry, when one exists. */
  readonly cliPath?: string
}

/** Options of one child profile write. */
export interface WriteRemoteTabProfileOptions {
  /** Desktop plugin profile whose `node_modules` the child reuses. */
  readonly parentProfileDir: string
  /** Parent Harness home, whose `settings.yaml` is copied. */
  readonly parentDshHome: string
  /** The child's own Harness home. */
  readonly childHome: string
  /** Remote server URL the child's `ds-harness-remote` client connects to. */
  readonly serverUrl: string
  /** Immutable runtime directory, used to resolve the child CLI. */
  readonly runtimeDir?: string
  /** Explicit child CLI entry; overrides resolution. */
  readonly cliPath?: string
  /** Bundle candidates; defaults to {@link CHILD_PROFILE_BUNDLES}. */
  readonly bundles?: readonly string[]
  /** Environment used for CLI fallback resolution. */
  readonly env?: NodeJS.ProcessEnv
  /** Explicit source of the ds-harness-remote peer package, for tests or unusual runtimes. */
  readonly peerSourceDir?: string
}

/** What one profile write produced, for logs and tests. */
export interface RemoteTabProfile {
  readonly childHome: string
  readonly profileDir: string
  readonly cliPath: string
  readonly packagePath: string
  readonly patchPath: string
  /** Bundle names actually listed in the child `package.json`. */
  readonly bundles: string[]
  /** `settings.yaml` destination when the parent home had one to copy. */
  readonly settingsPath?: string
  /** The `@deepseek-ai/dsh-client-connection` link the child's plugin import needs. */
  readonly peerPath?: string
}

/**
 * Resolve the desktop launch facts the child needs.
 *
 * `runtimeDir` is `process.argv[2]`; `parentProfileDir` is `process.argv[3]`,
 * falling back to `DSH_PROFILE_DIR` when the argv slot is not a profile (an
 * ordinary `dsh web` boot leaves unrelated words there). Both are only accepted
 * when the path exists, so a non-desktop boot reports "not available" instead
 * of failing later with a confusing path.
 * @param argv - process argv (`[execPath, entry, runtimeDir, parentProfileDir, ...]` in the desktop).
 * @param env - process environment.
 * @returns the resolved context; fields are absent when the desktop facts are absent.
 */
export function resolveDesktopContext(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): DesktopContext {
  const runtimeCandidate = cleanPath(argv[2])
  const profileCandidate = cleanPath(argv[3])
  const envProfile = cleanPath(env.DSH_PROFILE_DIR)
  const parentProfileDir = profileCandidate !== undefined && isDirectory(profileCandidate)
    ? profileCandidate
    : envProfile !== undefined && isDirectory(envProfile) ? envProfile : undefined
  const runtimeDir = runtimeCandidate !== undefined && isDirectory(runtimeCandidate) ? runtimeCandidate : undefined
  const cliPath = resolveChildCli({ runtimeDir, parentProfileDir, env, home })
  return {
    ...(runtimeDir === undefined ? {} : { runtimeDir }),
    ...(parentProfileDir === undefined ? {} : { parentProfileDir }),
    ...(cliPath === undefined ? {} : { cliPath }),
  }
}

/**
 * Resolve the `@deepseek-ai/dsh` CLI entry the child runs.
 *
 * The desktop host's runtime directory is the primary source (its
 * `node_modules` is the immutable payload); the parent profile's healed
 * `node_modules` and a `DSH_PLUGIN_DSH_CLI` hint are fallbacks for a desktop
 * launched from a development checkout.
 * @param options - context paths and environment.
 * @returns the existing CLI entry, or undefined when none of the candidates exist.
 */
export function resolveChildCli(options: {
  readonly runtimeDir?: string
  readonly parentProfileDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
}): string | undefined {
  const env = options.env ?? process.env
  const candidates: string[] = []
  if (options.runtimeDir !== undefined) candidates.push(join(options.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  if (options.parentProfileDir !== undefined) candidates.push(join(options.parentProfileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const hinted = cleanPath(env.DSH_PLUGIN_DSH_CLI)
  if (hinted !== undefined) candidates.push(hinted)
  const desktopDir = cleanPath(env.DSH_DESKTOP_DSH_DIR)
  if (desktopDir !== undefined) candidates.push(join(desktopDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  return candidates.find((candidate) => isFile(candidate))
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
 * Idempotent: re-running rewrites `package.json` and `cordis.patch.yml` from the
 * current parent profile while leaving the `node_modules` junction and an
 * existing child `settings.yaml` alone.
 * @param options - parent/child paths plus the remote server URL.
 * @returns the generated paths, for logs and the spawn plan.
 * @throws Error when the parent profile or the child CLI cannot be resolved.
 */
export function writeRemoteTabProfile(options: WriteRemoteTabProfileOptions): RemoteTabProfile {
  const parentPackagePath = join(options.parentProfileDir, 'package.json')
  const parentPackage = readJsonRecord(parentPackagePath, '父 profile 的 package.json')
  const profileDir = remoteTabProfileDir(options.childHome)
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(options.childHome, { recursive: true })

  const parentNodeModules = join(options.parentProfileDir, 'node_modules')
  if (!isDirectory(parentNodeModules)) {
    throw new Error(`父 profile 的 node_modules 不存在：${parentNodeModules}；请先在桌面应用中完成依赖安装`)
  }
  // ds-harness-remote's dist imports @deepseek-ai/dsh-client-connection, which the
  // Desktop profile install does not hoist (it is an optional peer, and the
  // package exists in the immutable runtime). The child reuses the parent tree,
  // so the peer link must exist before the child can import the plugin at all.
  const peerPath = ensureRemotePluginPeer({
    parentProfileDir: options.parentProfileDir,
    parentDshHome: options.parentDshHome,
    ...(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir }),
    ...(options.peerSourceDir === undefined ? {} : { peerSourceDir: options.peerSourceDir }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  linkNodeModules(parentNodeModules, join(profileDir, 'node_modules'))

  // Resolve bundles exactly as the loader does: the dsh installation first (the
  // in-box bundles live only in the asar runtime), then the profile itself. A
  // plain `node_modules` existence check would drop `@deepseek-ai/dsh-base` and
  // `@deepseek-ai/dsh-web-app`, which are not installed into the profile.
  const anchors = bundleAnchors(options.parentProfileDir, options.runtimeDir)
  const candidateBundles = options.bundles ?? CHILD_PROFILE_BUNDLES
  const bundles = candidateBundles.filter((bundle) => resolvesBundle(bundle, anchors))
  if (!bundles.includes(REQUIRED_BUNDLE)) {
    throw new Error(`父 profile 中没有 ${REQUIRED_BUNDLE}；请先在 Remote 面板安装并启用 ds-harness-remote`)
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
  writeTextAtomically(patchPath, remoteTabPatchYaml(options.serverUrl))

  const settingsSource = join(options.parentDshHome, 'settings.yaml')
  const settingsPath = join(options.childHome, 'settings.yaml')
  if (isFile(settingsSource) && !existsSync(settingsPath)) {
    try {
      writeFileSync(settingsPath, readFileSync(settingsSource))
    } catch {
      // Settings are a convenience copy; a failure must not stop the child boot.
    }
  }

  const cliPath = options.cliPath ?? resolveChildCli({
    ...(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir }),
    parentProfileDir: options.parentProfileDir,
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  if (cliPath === undefined) {
    throw new Error(
      '找不到子后端 CLI（@deepseek-ai/dsh/lib/bin.js）：运行时目录和父 profile 中都没有，'
      + '请在桌面应用中启动，或显式指定 cliPath',
    )
  }
  return {
    childHome: options.childHome,
    profileDir,
    cliPath,
    packagePath,
    patchPath,
    bundles,
    ...(isFile(settingsPath) ? { settingsPath } : {}),
    ...(peerPath === undefined ? {} : { peerPath }),
  }
}

/** Options of one peer-link repair. */
export interface EnsureRemotePluginPeerOptions {
  /** Desktop plugin profile whose `node_modules` receives the link. */
  readonly parentProfileDir: string
  /** Parent Harness home; its parent is the runtime root. */
  readonly parentDshHome: string
  /** Immutable runtime directory, when the desktop provides one. */
  readonly runtimeDir?: string
  /** Explicit peer package directory; otherwise the runtime locations are probed. */
  readonly peerSourceDir?: string
  /** Environment used to locate the repository checkout. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Ensure the parent profile can resolve the missing optional peer of
 * ds-harness-remote.
 *
 * The packaged plugin imports `@deepseek-ai/dsh-client-connection` at module load,
 * but the Desktop profile's pnpm install does not hoist that optional peer. The
 * immutable runtime (`.harness`, the source checkout, or the Desktop app's source
 * tree) carries the package; linking it into the parent profile makes both the
 * child import and the parent plugin load deterministic without copying the
 * runtime.
 * @param options - parent profile/home plus optional explicit peer source.
 * @returns the peer path when the link exists (created or already present).
 * @throws Error when no runtime copy of the peer package can be found.
 */
export function ensureRemotePluginPeer(options: EnsureRemotePluginPeerOptions): string | undefined {
  const env = options.env ?? process.env
  const peerPath = join(options.parentProfileDir, 'node_modules', '@deepseek-ai', 'dsh-client-connection')
  if (isDirectory(peerPath)) return peerPath
  const runtimeRoot = dirname(options.parentDshHome)
  const repoRoot = cleanPath(env.DSH_GUI_ROOT)
  const sourceCandidates: Array<string | undefined> = [
    options.peerSourceDir,
    join(runtimeRoot, '.harness', 'node_modules', '@deepseek-ai', 'dsh-client-connection'),
    join(runtimeRoot, '.desktop', 'source', 'node_modules', '@deepseek-ai', 'dsh-client-connection'),
    ...(repoRoot === undefined ? [] : [join(repoRoot, 'deepseek-harness', 'node_modules', '@deepseek-ai', 'dsh-client-connection')]),
    ...(options.runtimeDir === undefined
      ? []
      : [join(options.runtimeDir, '..', 'node_modules', '@deepseek-ai', 'dsh-client-connection')]),
  ]
  const source = sourceCandidates.find((candidate): candidate is string => candidate !== undefined && isDirectory(candidate))
  if (source === undefined) {
    throw new Error(
      '缺少 @deepseek-ai/dsh-client-connection（ds-harness-remote 的 peer）：桌面 profile 未安装该可选依赖，'
      + `运行时 .harness / 源码树中也没有找到。请确认 ${join(runtimeRoot, '.harness')} 的安装完整，`
      + `或手动把它链接到 ${peerPath}`,
    )
  }
  mkdirSync(dirname(peerPath), { recursive: true })
  linkNodeModules(source, peerPath)
  return peerPath
}

/** The `cordis.patch.yml` written into a child profile. */
function remoteTabPatchYaml(serverUrl: string): string {
  return [
    '# Generated by dsh-desktop-tabs for the remote-tab child profile.',
    '# One owned client device per saved connection; never opens a host connection.',
    '- id: ds-harness-remote',
    '  name: ds-harness-remote',
    '  config:',
    '    enabled: true',
    '    role: client',
    `    serverUrl: ${JSON.stringify(serverUrl)}`,
    '    hostControl:',
    '      enabled: false',
    '    terminal:',
    '      enabled: false',
    '    remoteTools:',
    '      enabled: false',
    '    codex:',
    '      enabled: false',
    '    acp:',
    '      enabled: false',
    '',
  ].join('\n')
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

/** The two anchors the loader resolves a profile bundle from, in its order. */
function bundleAnchors(parentProfileDir: string, runtimeDir: string | undefined): string[] {
  const anchors: string[] = []
  if (runtimeDir !== undefined) anchors.push(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  anchors.push(join(parentProfileDir, 'package.json'))
  return anchors
}

/**
 * Whether a bundle package resolves from one of the loader's anchors.
 *
 * Mirrors `resolveBundleDir` of `@deepseek-ai/dsh-app-boot`:
 * `createRequire(anchor).resolve.paths(name)` yields the node_modules search
 * directories; the first one carrying `<name>/package.json` wins.
 * @param bundle - package name from the profile bundle list.
 * @param anchors - install anchor first, the profile manifest second.
 * @returns whether the loader would find the bundle.
 */
function resolvesBundle(bundle: string, anchors: readonly string[]): boolean {
  const segments = bundle.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return false
  for (const anchor of anchors) {
    let searchPaths: string[] | null
    try {
      searchPaths = createRequire(anchor).resolve.paths(bundle)
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
