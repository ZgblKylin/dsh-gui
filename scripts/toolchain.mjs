/**
 * Shared, repo-local toolchain helpers for the dsh-gui build CLI and the
 * per-plugin install scripts under `plugins/<id>/install.mjs`.
 *
 * The repository root holds the sources, the pinned submodules and the build
 * scripts; the runtime root holds `.dsh`, `.harness`, `.toolchain`,
 * `.pnpm-store` and the entry exe. Both roots resolve regardless of the module
 * that imports this file, and every pnpm call is pinned to the bootstrap copy
 * under `.toolchain/` with the store at `.pnpm-store/` — a system pnpm or a
 * global store is never used.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRuntimeRoot } from './harness-runtime.mjs'

/** Repository root: scripts/toolchain.mjs -> <repo>/. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Runtime root: holds `.dsh`, `.harness`, `.toolchain`, `.pnpm-store` and the entry exe. */
export const RUNTIME_ROOT = resolveRuntimeRoot(ROOT)
export const TOOLCHAIN = join(RUNTIME_ROOT, '.toolchain')
export const STORE = join(RUNTIME_ROOT, '.pnpm-store')
export const HARNESS = join(ROOT, 'deepseek-harness')
export const PLUGINS = join(ROOT, 'plugins')
export const WEB_HOME = join(RUNTIME_ROOT, '.dsh')
/** Global agent-config template copied into `<WEB_HOME>/.agents/` on every build. */
export const GLOBAL_AGENTS_TEMPLATE = join(ROOT, 'global_template.agents')
export const IS_WINDOWS = process.platform === 'win32'
export const BIN_NAME = IS_WINDOWS ? 'dsh-gui.exe' : 'dsh-gui'
/** Entry exe the shell launches, written at the runtime root. */
export const ENTRY_EXE = join(RUNTIME_ROOT, BIN_NAME)
export const PNPM_VERSION = '11.7.0'

/**
 * Run a command with inherited stdio.
 * @param {string} command - executable to spawn.
 * @param {string[]} args - arguments, verbatim.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, shell?: boolean }} [options] - spawn options.
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: 'inherit',
    shell: options.shell ?? (IS_WINDOWS && /\.(cmd|bat)$/i.test(command)),
  })
  if (result.error) throw new Error(`failed to spawn ${command}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`)
  }
}

/** The pinned pnpm shim under .toolchain, or null when not bootstrapped yet. */
export function resolvePnpmShim() {
  const candidates = IS_WINDOWS
    ? [join(TOOLCHAIN, 'pnpm.cmd'), join(TOOLCHAIN, 'node_modules', '.bin', 'pnpm.cmd'), join(TOOLCHAIN, 'pnpm.CMD')]
    : [join(TOOLCHAIN, 'pnpm'), join(TOOLCHAIN, 'bin', 'pnpm'), join(TOOLCHAIN, 'node_modules', '.bin', 'pnpm')]
  return candidates.find(existsSync) ?? null
}

/**
 * pnpm's JS entry under .toolchain, or null. Calling `node <entry>` directly
 * avoids the platform shims (.cmd needs a shell on Windows, which also trips
 * the DEP0190 args-with-shell warning) and works identically everywhere.
 */
export function pnpmEntry() {
  const candidates = [
    join(TOOLCHAIN, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join(TOOLCHAIN, 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ]
  return candidates.find(existsSync) ?? null
}

export function hasPnpm() {
  return pnpmEntry() !== null || resolvePnpmShim() !== null
}

/** PATH that resolves `pnpm` (and any nested pnpm it spawns) to the pinned toolchain. */
export function pinnedPath() {
  return `${TOOLCHAIN}${delimiter}${process.env.PATH ?? ''}`
}

/**
 * Env for the pinned pnpm. Prepending the toolchain forces any nested `pnpm`
 * (the `verify-deps-before-run` install that `pnpm run build` spawns when deps
 * are stale) to resolve to the pinned build rather than a system pnpm, and
 * pinning the store makes that nested install share the repo-local store.
 * @param {NodeJS.ProcessEnv} [extra] - additional environment overrides.
 */
export function pnpmEnv(extra = {}) {
  return { ...extra, PATH: pinnedPath(), pnpm_config_store_dir: STORE }
}

/**
 * Run the pinned pnpm (bootstrap it first if needed).
 * @param {string[]} args - pnpm arguments.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options] - spawn options.
 */
export function pnpm(args, options = {}) {
  const env = pnpmEnv(options.env)
  const entry = pnpmEntry()
  if (entry) {
    run('node', [entry, ...args], { ...options, env })
    return
  }
  const shim = resolvePnpmShim()
  if (!shim) throw new Error('pnpm is not bootstrapped yet — run "npm run setup" once.')
  run(shim, args, { ...options, env })
}

/**
 * npm's JS entry beside the running node, or null. On Windows `npm` is only a
 * `.cmd` shim: Node refuses to spawn it directly (ENOENT) and rejects the shim
 * path itself, so the bootstrap runs the JS entry through `node` instead of
 * going through a shell.
 */
export function npmEntry() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find(existsSync) ?? null
}

/** Install pnpm@11.7.0 into .toolchain with a repo-local npm cache. */
export function bootstrapPnpm() {
  if (hasPnpm()) return
  mkdirSync(TOOLCHAIN, { recursive: true })
  const args = ['install', '--global', '--prefix', TOOLCHAIN, '--cache', join(TOOLCHAIN, 'npm-cache'), `pnpm@${PNPM_VERSION}`]
  const entry = npmEntry()
  if (entry !== null) run('node', [entry, ...args])
  else run('npm', args, { shell: IS_WINDOWS })
  if (!hasPnpm()) throw new Error('pnpm bootstrap did not produce an entry under .toolchain')
}

/**
 * Fill a directory tree from a template without overwriting anything: a target
 * file that already exists is left byte-for-byte intact, so edits a user made
 * to the installed copy survive every build, and only genuinely missing files
 * are written. Files with no template counterpart are likewise left alone.
 * @param {string} source - template directory to copy from.
 * @param {string} target - directory to fill.
 * @returns {number} how many files were written.
 */
export function fillTreeFromTemplate(source, target) {
  mkdirSync(target, { recursive: true })
  let written = 0
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) written += fillTreeFromTemplate(from, to)
    else if (entry.isFile() && !existsSync(to)) {
      copyFileSync(from, to)
      written += 1
    }
  }
  return written
}

/**
 * Resolve a spawnable cargo/rustc pair.
 *
 * On Windows, `cargo` on PATH is often a rustup PROXY SYMLINK
 * (cargo.exe -> rustup.exe). Some restricted execution contexts (the dsh-gui
 * shell hosting this build) refuse to spawn through that reparse point
 * (EPERM), while the real toolchain binary under
 * `<rustupHome>/toolchains/<tc>/bin/cargo.exe` spawns fine. When the PATH
 * `cargo` cannot be spawned, prefer the real toolchain binary; the caller then
 * also pins RUSTC/RUSTUP_TOOLCHAIN through {@link cargoToolchainEnv} so cargo
 * resolves rustc to a real binary as well.
 * @returns {string|null} absolute path to a real cargo.exe, or null to keep bare `cargo`.
 */
export function resolveCargo() {
  if (!IS_WINDOWS) return null
  // Prefer a bare `cargo` that actually spawns (normal terminals, non-rustup installs).
  const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: false })
  if (probe.error === undefined || probe.error.code !== 'EPERM') return null
  // Bare cargo is blocked: hunt the rustup toolchains for a real cargo.exe.
  const homes = [join(process.env.USERPROFILE ?? '', '.rustup'), join(process.env.RUSTUP_HOME ?? '', '').trim(), 'D:\\.rustup']
    .filter((p) => p !== '' && p !== '.')
  for (const home of homes) {
    const tc = join(home, 'toolchains')
    if (!existsSync(tc)) continue
    let entries = []
    try { entries = readdirSync(tc) } catch { continue }
    const candidates = entries
      .map((name) => join(tc, name, 'bin', 'cargo.exe'))
      .filter((p) => { try { return existsSync(p) && statSync(p).size > 0 } catch { return false } })
    if (candidates.length > 0) return candidates[0]
  }
  return null
}

/**
 * The RUSTC/RUSTUP_TOOLCHAIN overrides that a resolved real `cargo.exe` needs,
 * or an empty object for a bare cargo. `cargoBinary` is
 * `<rustupHome>/toolchains/<tc>/bin/cargo.exe`, so the toolchain directory
 * carries both the matching rustc and the toolchain name.
 * @param {string|null} cargoBinary - result of {@link resolveCargo}.
 * @returns {NodeJS.ProcessEnv} environment overrides to merge into the spawn env.
 */
export function cargoToolchainEnv(cargoBinary) {
  if (cargoBinary === null) return {}
  const toolchainDir = dirname(dirname(cargoBinary))
  return {
    RUSTC: join(toolchainDir, 'bin', 'rustc.exe'),
    RUSTUP_TOOLCHAIN: basename(toolchainDir),
  }
}
