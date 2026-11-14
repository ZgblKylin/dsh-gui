/**
 * Child runtime and Node executable selection for remote tabs.
 *
 * The child must run on a *real* dsh runtime with a *real* Node. A packaged
 * desktop host runs on Electron with the application payload inside `app.asar`;
 * spawning the child from that runtime hangs: the ESM loader runs in a worker
 * that cannot resolve modules from an asar archive, so the first
 * `@deepseek-ai/*` import of the child never settles. The hosting process's
 * `process.execPath` is Electron too, which makes the same problem.
 *
 * The selection is therefore explicit and ordered, preferring a runtime and a
 * Node that have proven to work:
 *
 * - runtime: `DSH_REMOTE_TAB_RUNTIME` → `<runtimeRoot>/.harness` → a source
 *   checkout build (`<runtimeRoot>/.desktop/source/apps/cli/lib/bin.js` or the
 *   repository's `deepseek-harness` build) → the hosting runtime when it is a
 *   real directory → the hosting runtime (possibly an asar archive) as the last
 *   fallback;
 * - Node: `DSH_REMOTE_TAB_NODE` → (Electron host only) a non-Electron
 *   `npm_node_execpath` → `node`/`node.exe` on `PATH` → the primary runtime's
 *   bundled Node under the runtime root → Electron (`process.execPath`) as the
 *   last fallback, with a warning that the loader may not support asar paths.
 *
 * The chosen runtime carries both the child CLI and the loader's runtime anchor,
 * so the child host and its plugin core come from the same installation. The
 * chosen Node is a spawn-plan fact: command, flags, and whether
 * `ELECTRON_RUN_AS_NODE=1` is needed.
 */

import { lstatSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { expandHome } from './profile.ts'

/** Where a selected child runtime came from, for logs and tests. */
export type ChildRuntimeKind = 'env' | 'harness' | 'source' | 'parent-real' | 'parent-asar'

/** One selected child runtime. */
export interface ChildRuntime {
  /** Directory the child's dsh installation lives in (the runtime root). */
  readonly runtimeDir: string
  /** The `@deepseek-ai/dsh` CLI entry to run. */
  readonly cliPath: string
  /** `package.json` of the dsh installation, used as the loader runtime anchor. */
  readonly anchor: string
  readonly kind: ChildRuntimeKind
}

/** One runtime candidate, in selection order. */
export interface ChildRuntimeCandidate {
  readonly runtimeDir: string
  readonly kind: ChildRuntimeKind
}

/** Options of one runtime selection. */
export interface SelectChildRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv
  /** Parent Harness home; its parent directory is the runtime root. */
  readonly dshHome: string
  /** Hosting runtime directory (may be inside an asar archive). */
  readonly parentRuntimeDir?: string
  /** Repository root, when known (`DSH_GUI_ROOT`). */
  readonly repoRoot?: string
  /** Test seam: executable-existence probe; defaults to a file check. */
  readonly isFile?: (path: string) => boolean
}

/** The probed layout of one runtime directory. */
export interface ProbedRuntime {
  readonly cliPath: string
  readonly anchor: string
}

/** Where the selected child Node came from, for logs and tests. */
export type ChildNodeKind = 'env' | 'host-node' | 'npm-node' | 'path-node' | 'runtime-node' | 'electron-fallback'

/** One selected Node executable for the child. */
export interface ChildNode {
  readonly command: string
  /** Whether the executable is Electron and needs its Node mode. */
  readonly electron: boolean
  readonly kind: ChildNodeKind
  /** A problem worth surfacing even though a fallback was found. */
  readonly warning?: string
}

/** Options of one Node selection. */
export interface SelectChildNodeOptions {
  readonly env?: NodeJS.ProcessEnv
  /** Parent Harness home; its parent directory is the runtime root. */
  readonly dshHome: string
  /** Hosting runtime directory; its desktop resources carry a bundled Node. */
  readonly parentRuntimeDir?: string
  /** Hosting executable; defaults to `process.execPath`. */
  readonly hostExecPath?: string
  /** Whether the hosting process is Electron; defaults to detection. */
  readonly hostElectron?: boolean
  readonly platform?: NodeJS.Platform
  /** Test seam: executable-existence probe; defaults to a file check. */
  readonly isFile?: (path: string) => boolean
}

/** Minimum Node major version supporting `--experimental-loader` reliably. */
const MIN_LOADER_NODE_MAJOR = 18

/**
 * Whether a Node major version supports the generated ESM loader.
 * @param version - a Node version string (`process.versions.node` shape).
 * @returns whether `--experimental-loader` may be passed.
 */
export function nodeSupportsExperimentalLoader(version: string | undefined): boolean {
  if (version === undefined) return false
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major >= MIN_LOADER_NODE_MAJOR
}

/**
 * Derive the runtime root from a Harness home: `dirname(DSH_HOME)`.
 * @param dshHome - parent Harness home.
 * @returns the directory holding `.harness`, `.desktop`, `desktop`, …
 */
export function runtimeRootOf(dshHome: string): string {
  return dirname(resolve(dshHome))
}

/**
 * The runtime candidates in selection order.
 * @param options - environment, parent home, hosting runtime, and repository root.
 * @returns candidates; a candidate may not exist on disk yet.
 */
export function childRuntimeCandidates(options: SelectChildRuntimeOptions): ChildRuntimeCandidate[] {
  const env = options.env ?? process.env
  const runtimeRoot = runtimeRootOf(options.dshHome)
  const repoRoot = cleanPath(options.repoRoot) ?? cleanPath(env.DSH_GUI_ROOT)
  const candidates: ChildRuntimeCandidate[] = []
  const explicit = cleanPath(env.DSH_REMOTE_TAB_RUNTIME)
  if (explicit !== undefined) candidates.push({ runtimeDir: expandHome(explicit), kind: 'env' })
  candidates.push({ runtimeDir: join(runtimeRoot, '.harness'), kind: 'harness' })
  candidates.push({ runtimeDir: join(runtimeRoot, '.desktop', 'source'), kind: 'source' })
  if (repoRoot !== undefined) {
    candidates.push({ runtimeDir: join(repoRoot, 'deepseek-harness'), kind: 'source' })
  }
  const parent = cleanPath(options.parentRuntimeDir)
  if (parent !== undefined) {
    candidates.push({ runtimeDir: parent, kind: isAsarPath(parent) ? 'parent-asar' : 'parent-real' })
  }
  return candidates
}

/**
 * Probe one runtime directory for the layouts this module accepts: an installed
 * runtime (`node_modules/@deepseek-ai/dsh/lib/bin.js`, the npm/asar layout) or a
 * source checkout build (`apps/cli/lib/bin.js`).
 * @param runtimeDir - runtime directory candidate.
 * @param isFile - executable-existence probe (test seam).
 * @returns the CLI and loader anchor, or undefined when the layout is not a dsh runtime.
 */
export function probeChildRuntime(runtimeDir: string, isFile: (path: string) => boolean = isFileSync): ProbedRuntime | undefined {
  const installedCli = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (isFile(installedCli)) {
    return { cliPath: installedCli, anchor: join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') }
  }
  const sourceCli = join(runtimeDir, 'apps', 'cli', 'lib', 'bin.js')
  if (isFile(sourceCli)) {
    return { cliPath: sourceCli, anchor: join(runtimeDir, 'apps', 'cli', 'package.json') }
  }
  return undefined
}

/**
 * Select the child runtime, preferring a real installation over the packaged
 * asar runtime.
 * @param options - environment, parent home, hosting runtime, and repository root.
 * @returns the selected runtime.
 * @throws Error when no candidate is a usable dsh runtime, or the explicit one is invalid.
 */
export function selectChildRuntime(options: SelectChildRuntimeOptions): ChildRuntime {
  const isFile = options.isFile ?? isFileSync
  const candidates = childRuntimeCandidates(options)
  const explicit = candidates.find((candidate) => candidate.kind === 'env')
  if (explicit !== undefined && probeChildRuntime(explicit.runtimeDir, isFile) === undefined) {
    throw new Error(
      `DSH_REMOTE_TAB_RUNTIME 指向的目录不是可用的 dsh 运行时：${explicit.runtimeDir}`
      + '（需要 node_modules/@deepseek-ai/dsh/lib/bin.js 或 apps/cli/lib/bin.js）',
    )
  }
  for (const candidate of candidates) {
    const probed = probeChildRuntime(candidate.runtimeDir, isFile)
    if (probed !== undefined) return { runtimeDir: candidate.runtimeDir, ...probed, kind: candidate.kind }
  }
  throw new Error(
    '未找到可用于子后端的真实 dsh 运行时：请设置 DSH_REMOTE_TAB_RUNTIME，'
    + '或先构建运行时（npm 运行时 .harness / 源码构建 apps/cli/lib/bin.js）',
  )
}

/**
 * Select the child Node executable, preferring a real Node over Electron.
 * @param options - environment, parent home, hosting executable, and platform.
 * @returns the selected Node facts; `warning` is set when only Electron remains.
 * @throws Error when an explicit `DSH_REMOTE_TAB_NODE` is not an executable.
 */
export function selectChildNode(options: SelectChildNodeOptions): ChildNode {
  const env = options.env ?? process.env
  const isFile = options.isFile ?? isFileSync
  const platform = options.platform ?? process.platform
  const hostExecPath = cleanPath(options.hostExecPath) ?? process.execPath
  const hostElectron = options.hostElectron ?? process.versions.electron !== undefined

  // A real Node host already is the executable the child needs.
  if (!hostElectron) {
    return { command: hostExecPath, electron: false, kind: 'host-node' }
  }
  const explicit = cleanPath(env.DSH_REMOTE_TAB_NODE)
  if (explicit !== undefined) {
    const command = expandHome(explicit)
    if (!isFile(command)) {
      throw new Error(`DSH_REMOTE_TAB_NODE 指向的可执行文件不存在：${command}`)
    }
    return { command, electron: isElectronExecutable(command, hostExecPath), kind: 'env' }
  }
  const npmNode = cleanPath(env.npm_node_execpath)
  if (npmNode !== undefined && isFile(npmNode) && !isElectronExecutable(npmNode, hostExecPath)) {
    return { command: npmNode, electron: false, kind: 'npm-node' }
  }
  const onPath = findOnPath(env.PATH, platform, isFile)
  if (onPath !== undefined) return { command: onPath, electron: false, kind: 'path-node' }
  const bundled = findRuntimeNode(runtimeRootOf(options.dshHome), platform, isFile, options.parentRuntimeDir)
  if (bundled !== undefined) return { command: bundled, electron: false, kind: 'runtime-node' }
  return {
    command: hostExecPath,
    electron: true,
    kind: 'electron-fallback',
    warning: '未找到真实 Node，回退到 Electron 作为子后端：ESM loader 可能无法解析 asar 路径，'
      + '请设置 DSH_REMOTE_TAB_NODE 或把真实 Node 加入 PATH',
  }
}

/**
 * Find a real `node` on `PATH`.
 * @param pathValue - the PATH value.
 * @param platform - target platform.
 * @param isFile - executable probe.
 * @returns the first existing Node executable, or undefined.
 */
export function findOnPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
  isFile: (path: string) => boolean = isFileSync,
): string | undefined {
  if (pathValue === undefined) return undefined
  const names = platform === 'win32' ? ['node.exe'] : ['node']
  for (const directory of pathValue.split(platform === 'win32' ? ';' : ':')) {
    const cleaned = directory.trim().replace(/^"|"$/gu, '')
    if (cleaned === '') continue
    for (const name of names) {
      const candidate = join(cleaned, name)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Find a Node executable bundled under the runtime root (the desktop's primary
 * runtime or the pinned toolchain), or beside the hosting runtime's asar
 * archive (the packaged application carries its own Node there).
 * @param runtimeRoot - directory holding `.harness`, `desktop`, `.toolchain`, …
 * @param platform - target platform.
 * @param isFile - executable probe.
 * @param parentRuntimeDir - hosting runtime directory, when known.
 * @returns the first existing candidate, or undefined.
 */
export function findRuntimeNode(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
  isFile: (path: string) => boolean = isFileSync,
  parentRuntimeDir?: string,
): string | undefined {
  const executable = platform === 'win32' ? 'node.exe' : 'node'
  const binary = join('primary-runtime', 'dependencies', 'node', 'bin', executable)
  const candidates = [
    join(runtimeRoot, 'desktop', 'resources', 'runtime', binary),
    join(runtimeRoot, 'desktop', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', executable),
    join(runtimeRoot, '.toolchain', 'node_modules', '.bin', executable),
  ]
  // A packaged application's asar lives in `<resources>/app.asar`; its bundled
  // Node is a sibling of the archive, whichever directory DSH_HOME points at.
  const resources = resourcesDirectoryOf(parentRuntimeDir)
  if (resources !== undefined) candidates.push(join(resources, 'runtime', binary))
  return candidates.find((candidate) => isFile(candidate))
}

/** The `<resources>` directory holding one asar archive path, when present. */
function resourcesDirectoryOf(runtimeDir: string | undefined): string | undefined {
  if (runtimeDir === undefined) return undefined
  const segments = resolve(runtimeDir).split(/[\\/]/u)
  const asarIndex = segments.findIndex((segment) => segment.toLowerCase().endsWith('.asar'))
  if (asarIndex < 0) return undefined
  return segments.slice(0, asarIndex).join(platformSeparator())
}

/** The native path separator of the running platform. */
function platformSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

/** Whether one path points inside an asar archive. */
export function isAsarPath(path: string): boolean {
  return path.split(/[\\/]/u).some((segment) => segment.toLowerCase().endsWith('.asar'))
}

/** Whether one executable is the hosting Electron executable (or named like Electron). */
function isElectronExecutable(command: string, hostExecPath: string): boolean {
  if (samePath(command, hostExecPath)) return true
  return basename(command).toLowerCase().includes('electron')
}

/** Compare two absolute paths case-insensitively on Windows. */
function samePath(left: string, right: string): boolean {
  if (process.platform !== 'win32') return left === right
  return left.toLowerCase() === right.toLowerCase()
}

/** @returns a trimmed non-empty string, or undefined. */
function cleanPath(value: string | undefined): string | undefined {
  const text = value?.trim() ?? ''
  return text === '' ? undefined : text
}

/** Whether the path names an existing regular file (or a symlink to one). */
function isFileSync(path: string): boolean {
  try {
    return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
