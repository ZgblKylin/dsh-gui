#!/usr/bin/env node
/**
 * dsh-gui — cross-platform build/install/run commands for the desktop shell.
 *
 * One Node CLI so the same commands work on Windows, macOS, and Linux (WSL).
 * Every path resolves from the repository root regardless of the invoking cwd.
 *
 * Commands:
 *   setup    one-shot bootstrap: pinned pnpm -> harness clean+install+build ->
 *            entry exe (release unless --debug) -> plugins (each
 *            plugins/<id>/install.mjs) -> install agent presets
 *   build    harness clean+install+build (unless --skip-harness) -> entry exe ->
 *            plugins (each plugins/<id>/install.mjs) -> install agent presets
 *   install  run every plugins/<id>/install.mjs (alias: plugins)
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
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  BIN_NAME,
  HARNESS,
  IS_WINDOWS,
  PLUGINS,
  ROOT,
  STORE,
  WEB_HOME,
  bootstrapPnpm,
  pnpm,
  run,
} from './toolchain.mjs'

const SRC_TAURI = join(ROOT, 'src-tauri')

function step(name, fn) {
  console.log(`\n==> ${name}`)
  fn()
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

function harnessClean() {
  step('Clean previous harness build outputs', () => {
    // The harness is a pinned submodule; stale ignored build output can
    // survive a revision switch (lib/ + node_modules of packages that no
    // longer exist) and break tsdown's workspace enumeration with missing
    // exports, so clean every build before rebuilding. CI=true is required:
    // the pre-run `verify-deps-before-run` install aborts with
    // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY when it finds orphaned
    // modules without a TTY.
    pnpm(['run', 'clean'], { cwd: HARNESS, env: { CI: 'true' } })
  })
}

function harnessBuild() {
  harnessClean()
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

/**
 * Run every install script under plugins/.
 * Each `plugins/<id>/` directory is self-contained (`install.mjs` + whatever
 * source it owns); plugin wrappers land in the web profile
 * (`.dsh/profiles/web/`), while hybrid wrappers such as `dsh-web-ui`
 * first copy an agent preset into `.dsh/.agent-presets/` and then install
 * their package profile-side. The CLI delegates the
 * work to the wrapper script, so adding one never touches this CLI. Scripts
 * run in directory-name order for a deterministic install sequence.
 */
function installPluginScripts() {
  if (!existsSync(PLUGINS)) return
  const scripts = readdirSync(PLUGINS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PLUGINS, entry.name, 'install.mjs'))
    .filter((path) => existsSync(path))
    .sort()
  if (scripts.length === 0) {
    console.log('No plugin install scripts under plugins/ — nothing to build or install.')
    return
  }
  step('Run plugin install scripts', () => {
    for (const script of scripts) {
      console.log(`--- ${script}`)
      // The same DSH_HOME pin the desktop shell and the preset installer use.
      run('node', [script], { env: { DSH_HOME: WEB_HOME } })
    }
  })
}

function plugins() {
  bootstrapPnpm()
  installPluginScripts()
  console.log('\nDone. Plugin install scripts ran against the repo-local .dsh.')
  console.log('Restart dsh-gui for the composition and agent-preset roster to reload.')
}

/**
 * Install every agent preset under presets/ by running its own install
 * script. Each `presets/<id>/` directory is a self-contained preset package
 * (composition + metadata + `install.mjs`); the build delegates installation
 * to the preset's script, so a preset owns how it lands in the harness home
 * (`.dsh/.agent-presets/<id>/`) and adding one never touches this CLI. Scripts
 * run in directory-name order for a deterministic install sequence.
 */
function installPresets() {
  const dir = join(ROOT, 'presets')
  if (!existsSync(dir)) return
  const scripts = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, 'install.mjs'))
    .filter((path) => existsSync(path))
    .sort()
  if (scripts.length === 0) {
    console.log('No agent presets under presets/ — nothing to install.')
    return
  }
  step('Install agent presets into the harness home', () => {
    for (const script of scripts) {
      console.log(`--- ${script}`)
      // The same DSH_HOME pin the desktop shell and the plugin installer use.
      run('node', [script], { env: { DSH_HOME: WEB_HOME } })
    }
  })
}

function setup(options) {
  bootstrapPnpm()
  harnessInstall(true)
  harnessBuild()
  if (!options.skipExe) buildExe(options.debug)
  plugins()
  installPresets()
  console.log('\nDone. Entry exe at the repository root; plugins and agent presets installed.')
}

function build(options) {
  bootstrapPnpm()
  if (!options.skipHarness) {
    harnessInstall(false)
    harnessBuild()
  }
  if (!options.skipExe) buildExe(options.debug)
  plugins()
  installPresets()
  console.log('\nDone. Entry exe at the repository root; plugins and agent presets installed.')
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
  const child = spawn(exe, [], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: WEB_HOME },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
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
  setup       one-shot bootstrap: pinned pnpm -> harness clean+install+build ->
              entry exe (release unless --debug) -> plugins (each
              plugins/<id>/install.mjs) -> agent presets (each
              presets/<id>/install.mjs)
  build       harness clean+install+build (unless --skip-harness) -> entry exe ->
              plugins (each plugins/<id>/install.mjs) -> agent presets
  install     run every plugins/*/install.mjs (alias: plugins)
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
  npm run build -- --skip-exe
  npm run build:exe        (alias for build --skip-harness)
  npm run build:webui      (alias for build --skip-exe; harness web UI only, no desktop exe)
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
