#!/usr/bin/env node
/**
 * dsh-gui — cross-platform build/install/run commands for the desktop shell.
 *
 * Replaces the PowerShell scripts (setup.ps1 / build.ps1 / install-plugins.ps1
 * / run.ps1 / make-shortcut.ps1) with one Node CLI so the same commands work
 * on Windows, macOS, and Linux (WSL). Every path resolves from the repository
 * root regardless of the invoking cwd.
 *
 * Commands:
 *   setup    one-shot bootstrap: pinned pnpm -> harness install+build -> entry
 *            exe (release unless --debug) -> build+install+mount plugins
 *   build    harness install+build (unless --skip-harness) -> entry exe ->
 *            build+install+mount plugins
 *   install  build + install + mount the plugins under plugins/ (alias: plugins)
 *   run      launch the entry exe detached; the invoking terminal returns at
 *            once and closing it never kills dsh-gui (or its harness child)
 *   shortcut create a Windows desktop shortcut to the entry exe (Windows only)
 *
 * Flags (after the command):
 *   --debug         cargo debug build instead of release (release is default)
 *   --skip-harness  build: skip the harness pnpm install + build
 *   --skip-exe      skip the cargo build + exe copy (harness/plugins only —
 *                   useful on Linux without Tauri system deps)
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLCHAIN = join(ROOT, '.toolchain')
const STORE = join(ROOT, '.pnpm-store')
const HARNESS = join(ROOT, 'deepseek-harness')
const SRC_TAURI = join(ROOT, 'src-tauri')
const PLUGINS = join(ROOT, 'plugins')
const WEB_HOME = join(ROOT, '.dsh')
const PROFILE_DIR = join(WEB_HOME, 'profiles', 'web')
const HARNESS_BIN = join(HARNESS, 'apps', 'cli', 'lib', 'bin.js')
const IS_WINDOWS = platform() === 'win32'
const BIN_NAME = IS_WINDOWS ? 'dsh-gui.exe' : 'dsh-gui'
const PNPM_VERSION = '11.7.0'

function step(name, fn) {
  console.log(`\n==> ${name}`)
  fn()
}

/** Run a command with inherited stdio; a `.cmd` shim needs a shell on Windows (CVE-2024-27980). */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: 'inherit',
    shell: IS_WINDOWS && /\.(cmd|bat)$/i.test(command),
  })
  if (result.error) throw new Error(`failed to spawn ${command}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`)
  }
}

/** The pinned pnpm shim under .toolchain, or null when not bootstrapped yet. */
function resolvePnpmShim() {
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
function pnpmEntry() {
  const candidates = [
    join(TOOLCHAIN, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join(TOOLCHAIN, 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ]
  return candidates.find(existsSync) ?? null
}

function hasPnpm() {
  return pnpmEntry() !== null || resolvePnpmShim() !== null
}

/** PATH that resolves `pnpm` (and any nested pnpm it spawns) to the pinned toolchain. */
function pinnedPath() {
  return `${TOOLCHAIN}${delimiter}${process.env.PATH ?? ''}`
}

/**
 * Env for the pinned pnpm. Prepending the toolchain forces any nested `pnpm`
 * (the `verify-deps-before-run` install that `pnpm run build` spawns when deps
 * are stale) to resolve to the pinned build rather than a system pnpm, and
 * pinning the store makes that nested install share the repo-local store.
 */
function pnpmEnv(extra = {}) {
  return { ...extra, PATH: pinnedPath(), pnpm_config_store_dir: STORE }
}

/** Run the pinned pnpm (bootstrap it first if needed). */
function pnpm(args, options = {}) {
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

/** Install pnpm@11.7.0 into .toolchain with a repo-local npm cache. */
function bootstrapPnpm() {
  if (hasPnpm()) return
  step(`Bootstrap pnpm@${PNPM_VERSION} into .toolchain`, () => {
    mkdirSync(TOOLCHAIN, { recursive: true })
    run('npm', ['install', '--global', '--prefix', TOOLCHAIN, '--cache', join(TOOLCHAIN, 'npm-cache'), `pnpm@${PNPM_VERSION}`])
    if (!hasPnpm()) throw new Error('pnpm bootstrap did not produce an entry under .toolchain')
  })
}

function harnessInstall(frozen) {
  step('Install harness dependencies (repo-local store)', () => {
    // CI=true skips the harness's dev-only lefthook git-hook setup, which
    // fails inside a submodule checkout.
    pnpm(['install', '--store-dir', STORE, ...(frozen ? ['--frozen-lockfile'] : [])], {
      cwd: HARNESS,
      env: { CI: 'true' },
    })
  })
}

function harnessBuild() {
  step('Build harness (host lib + web dist)', () => {
    // CI=true keeps `verify-deps-before-run` from re-running the harness's
    // lefthook postinstall (in the nested `pnpm install` it spawns), which
    // fails inside the submodule checkout.
    pnpm(['run', 'build'], { cwd: HARNESS, env: { CI: 'true' } })
  })
}

/**
 * Resolve a spawnable cargo/rustc pair.
 *
 * On Windows, `cargo` on PATH is often a rustup PROXY SYMLINK
 * (cargo.exe -> rustup.exe). Some restricted execution contexts (the dsh-gui
 * shell hosting this build) refuse to spawn through that reparse point
 * (EPERM), while the real toolchain binary under
 * `<rustupHome>/toolchains/<tc>/bin/cargo.exe` spawns fine. When the PATH
 * `cargo` cannot be spawned, prefer the real toolchain binary and pin the
 * RUSTC/RUSTUP_TOOLCHAIN env so cargo also resolves rustc to a real binary.
 * @returns {string|null} absolute path to a real cargo.exe, or null to keep bare `cargo`.
 */
function resolveCargo() {
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

function buildExe(debug) {
  const profile = debug ? 'debug' : 'release'
  const cargoBinary = resolveCargo()
  const env = { ...process.env }
  if (cargoBinary !== null) {
    // cargoBinary = <rustupHome>/toolchains/<tc>/bin/cargo.exe
    const toolchainDir = dirname(dirname(cargoBinary))
    env.RUSTC = join(toolchainDir, 'bin', 'rustc.exe')
    env.RUSTUP_TOOLCHAIN = basename(toolchainDir)
  }
  step(`Build entry exe (cargo build ${debug ? '--debug' : '--release'})`, () => {
    run(cargoBinary ?? 'cargo', ['build', ...(debug ? [] : ['--release'])], { cwd: SRC_TAURI, env })
  })
  const built = join(SRC_TAURI, 'target', profile, BIN_NAME)
  if (!existsSync(built)) throw new Error(`build did not produce ${built}`)
  step('Copy entry exe to the repository root', () => {
    try {
      copyFileSync(built, join(ROOT, BIN_NAME))
    } catch (error) {
      throw new Error(`could not copy ${built} to the repository root (is dsh-gui running? close it first): ${error.message}`)
    }
  })
}

/** Every subdirectory of plugins/ that holds a package.json. */
function pluginDirs() {
  if (!existsSync(PLUGINS)) return []
  return readdirSync(PLUGINS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PLUGINS, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
}

function buildPlugins() {
  const dirs = pluginDirs()
  step('Build plugin packages', () => {
    for (const dir of dirs) {
      console.log(`--- build ${basename(dir)}`)
      pnpm(['install', '--store-dir', STORE], { cwd: dir, env: { CI: 'true' } })
      pnpm(['run', 'build'], { cwd: dir })
    }
  })
}

/**
 * Pin the profile's pnpm store. `dsh plugin` runs pnpm with the profile as cwd
 * and without --store-dir; pnpm >=10 reads its settings from
 * pnpm-workspace.yaml, and the unset default store resolves from the invoking
 * environment's home variables, which differ between a plain terminal and the
 * desktop shell. Without the pin, an install made from one context fails the
 * other with ERR_PNPM_UNEXPECTED_STORE.
 */
function pinProfileStore() {
  mkdirSync(PROFILE_DIR, { recursive: true })
  const workspacePath = join(PROFILE_DIR, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    // Mirror the harness's profile template (hoisted linker, no auto peers).
    writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  }
  let lines = readFileSync(workspacePath, 'utf8').split(/\r?\n/).filter((line) => !/^\s*storeDir\s*:/.test(line))
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  lines.push('', `storeDir: '${STORE.replace(/'/g, "''")}'`, '')
  writeFileSync(workspacePath, lines.join('\n'))
}

function installPlugins() {
  const dirs = pluginDirs()
  step('Install plugins into the web profile', () => {
    // `dsh plugin` forwards to `pnpm` on PATH; prepend the pinned toolchain so
    // the compatible pnpm is used no matter which system pnpm is installed.
    const env = {
      ...process.env,
      PATH: pinnedPath(),
      DSH_HOME: WEB_HOME,
    }
    for (const dir of dirs) {
      console.log(`--- install ${basename(dir)}`)
      run('node', [HARNESS_BIN, 'plugin', '--profile', 'web', 'add', `link:${dir}`], { env })
    }
  })
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Mount every plugin into the web composition. `dsh plugin add` only records
 * the dependency; the harness scans the Loader's ENTRIES for `dsh.client`
 * declarations, so a plugin stays inert until a cordis.patch.yml insert turns
 * it into an entry. The entry id comes from the plugin's `dsh.gui.mountId`
 * declaration, or is derived from the package name by stripping a leading
 * `dsh-`. Appends are idempotent; user content is preserved.
 */
function mountPlugins() {
  const dirs = pluginDirs()
  step('Mount plugins into the web composition', () => {
    mkdirSync(PROFILE_DIR, { recursive: true })
    const patchPath = join(PROFILE_DIR, 'cordis.patch.yml')
    if (!existsSync(patchPath)) {
      // Mirror the harness's profile patch template.
      writeFileSync(patchPath, [
        '# Your patch layer for this dsh profile, applied after every bundle layer:',
        '# a top-level YAML array of loader patch entries (id-targeted config',
        '# overrides, disables, and insert lists; `!!js` expressions allowed).',
        '[]',
        '',
      ].join('\n'))
    }
    const text = readFileSync(patchPath, 'utf8')

    const mounts = []
    for (const dir of dirs) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const pkgName = String(manifest.name ?? '')
      let mountId = manifest.dsh?.gui?.mountId
      if (!mountId) {
        mountId = pkgName.replace(/^dsh-/, '')
        console.log(`  mount id for ${basename(dir)} derived as '${mountId}' from its package name (declare "dsh.gui.mountId" in its package.json to override)`)
      }
      if (!mounts.some((m) => m.id === mountId && m.name === pkgName)) {
        mounts.push({ id: mountId, name: pkgName })
      }
    }

    const toWrite = mounts.filter((m) => {
      // Inline modifiers ((?m) etc.) are rejected under Node's default
      // type-stripping parse path, so flags go through the constructor.
      const pattern = `^\\s*-\\s*insert\\s*:\\s*$[^\\r\\n]*\\r?\\n[^\\r\\n]*-\\s*id:\\s*${escapeRegExp(m.id)}[^\\r\\n]*\\r?\\n[^\\r\\n]*name:\\s*${escapeRegExp(m.name)}\\s*$`
      return !new RegExp(pattern, 'm').test(text)
    })
    if (toWrite.length === 0) {
      console.log('  all plugins already mounted')
      return
    }
    const blocks = toWrite.map((m) => `- insert:\n    - id: ${m.id}\n      name: ${m.name}`).join('\n')
    const body = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line) && !/^\s*$/.test(line)).join('\n')
    let newText
    if (body.trim() === '[]') {
      // Replace the empty default; keep the template comments.
      newText = text.split(/\r?\n/).filter((line) => !/^\s*\[\]\s*$/.test(line)).join('\n').trimEnd() + '\n' + blocks + '\n'
    } else {
      newText = text.trimEnd() + '\n' + blocks + '\n'
    }
    writeFileSync(patchPath, newText)
    for (const m of toWrite) console.log(`  mounted ${m.name} as entry '${m.id}'`)
  })
}

function plugins() {
  bootstrapPnpm()
  const dirs = pluginDirs()
  if (dirs.length === 0) {
    console.log('No plugin packages under plugins/ — nothing to build or install.')
    return
  }
  buildPlugins()
  pinProfileStore()
  installPlugins()
  mountPlugins()
  console.log('\nDone. Plugins built, installed, and mounted into .dsh/profiles/web.')
  console.log('Restart dsh-gui for the composition to reload and the plugins to appear.')
}

function setup(options) {
  bootstrapPnpm()
  harnessInstall(true)
  harnessBuild()
  if (!options.skipExe) buildExe(options.debug)
  plugins()
  console.log('\nDone. Entry exe at the repository root; plugins built, installed, and mounted.')
}

function build(options) {
  bootstrapPnpm()
  if (!options.skipHarness) {
    harnessInstall(false)
    harnessBuild()
  }
  if (!options.skipExe) buildExe(options.debug)
  plugins()
  console.log('\nDone. Entry exe at the repository root; plugins built, installed, and mounted.')
}

/** Launch the entry exe detached so the invoking terminal returns at once. */
function runApp() {
  const candidates = [
    join(ROOT, BIN_NAME),
    join(SRC_TAURI, 'target', 'release', BIN_NAME),
    join(SRC_TAURI, 'target', 'debug', BIN_NAME),
  ]
  const exe = candidates.find(existsSync)
  if (!exe) throw new Error(`entry exe not found (looked at ${candidates.join(', ')}) — run "npm run setup" first`)
  const child = spawn(exe, [], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  console.log(`launched ${exe}`)
}

/** Create a Windows shortcut (.lnk) to the entry exe. */
function makeShortcut(outputPath) {
  if (!IS_WINDOWS) throw new Error('shortcut creates a .lnk via WScript.Shell and is Windows-only')
  const candidates = [
    join(ROOT, BIN_NAME),
    join(SRC_TAURI, 'target', 'release', BIN_NAME),
    join(SRC_TAURI, 'target', 'debug', BIN_NAME),
  ]
  const exe = candidates.find(existsSync)
  if (!exe) throw new Error(`entry exe not found (looked at ${candidates.join(', ')}) — run "npm run setup" first`)
  const target = outputPath || join(process.env.USERPROFILE ?? '', 'Desktop', 'DeepSeek Harness.lnk')
  const ps = (s) => s.replace(/'/g, "''")
  const script = [
    `$s = New-Object -ComObject WScript.Shell`,
    `$l = $s.CreateShortcut('${ps(target)}')`,
    `$l.TargetPath = '${ps(exe)}'`,
    `$l.WorkingDirectory = '${ps(ROOT)}'`,
    `$l.Description = 'DeepSeek Harness (self-hosted webview)'`,
    `$l.IconLocation = '${ps(exe)},0'`,
    `$l.Save()`,
  ].join('; ')
  run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  console.log(`Created shortcut: ${target}`)
}

function help() {
  console.log(`dsh-gui — build, install, and run the desktop shell.

Usage:
  node scripts/dsh-gui.mjs <command> [flags]
  npm run <command> -- [flags]        (from the repository root)

Commands:
  setup       one-shot bootstrap: pinned pnpm -> harness install+build -> entry
              exe (release unless --debug) -> plugins (build+install+mount)
  build       harness install+build (unless --skip-harness) -> entry exe ->
              plugins (build+install+mount)
  install     build + install + mount the plugins under plugins/ (alias: plugins)
  run         launch the entry exe detached; the terminal returns immediately
  shortcut    create a Windows desktop shortcut (Windows only)
  help        show this help

Flags:
  --debug         cargo debug build instead of release (release is default)
  --skip-harness  build: skip the harness pnpm install + build
  --skip-exe      skip the cargo build + exe copy (harness/plugins only)

Examples:
  npm run setup
  npm run build -- --debug
  npm run build -- --skip-harness
  npm run install:plugins
  npm start
  npm run shortcut -- "D:\\x.lnk"`)
}

function main() {
  const argv = process.argv.slice(2)
  const command = argv.find((arg) => !arg.startsWith('-')) ?? 'help'
  const flags = new Set(argv.filter((arg) => arg.startsWith('-')))
  const options = {
    debug: flags.has('--debug'),
    skipHarness: flags.has('--skip-harness'),
    skipExe: flags.has('--skip-exe'),
  }
  switch (command) {
    case 'setup': setup(options); break
    case 'build': build(options); break
    case 'install':
    case 'plugins': plugins(); break
    case 'run': runApp(); break
    case 'shortcut': makeShortcut(argv[argv.indexOf('shortcut') + 1] ?? ''); break
    case 'help':
    case '--help':
    case '-h': help(); break
    default:
      console.error(`unknown command: ${command}`)
      help()
      process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  console.error(`\n[error] ${error.message}`)
  process.exit(1)
}
