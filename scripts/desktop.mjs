/**
 * dsh-gui — build and launch the Electron desktop app from source.
 *
 * The desktop app is a second product beside the Tauri shell: it compiles the
 * pinned `deepseek-harness` submodule with Electron, needs its own full
 * dependency tree, the Electron binary and electron-builder's toolset. The chain
 * therefore works in a dedicated checkout and keeps every artifact under the
 * runtime root, so the repository root stays free of build products:
 *
 *   <runtime-root>/.desktop/source             harness checkout to build
 *   <runtime-root>/.desktop/source-revision.json  commit that checkout holds
 *   <runtime-root>/.desktop/shim-target        desktop shim cargo target
 *   <runtime-root>/desktop                     landed unpacked app
 *   <runtime-root>/dsh-gui-desktop.exe         landed console-less shim
 *   <runtime-root>/.cache/electron             Electron binary cache
 *   <runtime-root>/.cache/electron-builder     electron-builder toolset cache
 *
 * `npm run build` never enters this chain: it costs a full dependency install
 * (about 1.8 GB) and an unpacked app of about 1 GB, while the Tauri shell and
 * the plugins share neither. `npm run build:desktop` runs the chain and
 * `npm run desktop` launches the landed app.
 *
 * Run this outside a strict sandbox: the source sync uses git's local transport
 * (a shell script on Windows), and the packaging step runs electron-builder.
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  HARNESS,
  ROOT,
  RUNTIME_ROOT,
  STORE,
  WEB_HOME,
  bootstrapPnpm,
  cargoToolchainEnv,
  pinnedPath,
  pnpm,
  pnpmEntry,
  resolveCargo,
  run,
} from './toolchain.mjs'
import { submoduleRevision, submoduleVersion } from './harness-runtime.mjs'

/** Desktop build workspace under the runtime root. */
const DESKTOP_ROOT = join(RUNTIME_ROOT, '.desktop')
/** Out-of-tree checkout of the pinned submodule that this chain builds. */
const SOURCE = join(DESKTOP_ROOT, 'source')
/** Records the commit the source checkout holds. */
const SOURCE_REVISION_FILE = join(DESKTOP_ROOT, 'source-revision.json')
/** Where the unpacked app lands, as the runtime-root `desktop/` directory. */
const LANDING = join(RUNTIME_ROOT, 'desktop')
/** Entry executable of the landed app. */
const APP_EXE = 'DeepSeek Harness.exe'
/** electron-builder output of the unpacked win-x64 build. */
const UNPACKED = join(SOURCE, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts', 'win-unpacked')
/** Package environment the desktop packaging chain reads (`apps/desktop/.env.windows`). */
const PACKAGE_ENV_FILE = join(SOURCE, 'apps', 'desktop', '.env.windows')
const ELECTRON_CACHE = join(RUNTIME_ROOT, '.cache', 'electron')
const BUILDER_CACHE = join(RUNTIME_ROOT, '.cache', 'electron-builder')
/** Standalone crate of the console-less launcher that starts `npm run desktop`. */
const SHIM_MANIFEST = join(ROOT, 'src-tauri', 'desktop-shim', 'Cargo.toml')
/** Cargo target directory of the shim, kept inside the desktop workspace. */
const SHIM_TARGET = join(DESKTOP_ROOT, 'shim-target')
/** Where the shim lands: the runtime root, beside the Tauri entry exe. */
const SHIM_EXE = join(RUNTIME_ROOT, 'dsh-gui-desktop.exe')

function step(name, fn) {
  console.log(`\n==> ${name}`)
  return fn()
}

/**
 * `git <args>` in `dir` with stdout and stderr written to files instead of
 * pipes. The dsh Windows sandbox rejects child processes that capture through
 * pipes, so the file form keeps the captured diagnostics available inside a
 * sandboxed session; `GIT_TERMINAL_PROMPT=0` turns a missing credential into a
 * failure instead of a prompt that never returns.
 * @param {string[]} args - git arguments.
 * @param {string} dir - repository or checkout to run in.
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, error: Error|undefined }}
 */
function captureGit(args, dir) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-gui-desktop-'))
  const outPath = join(scratch, 'stdout')
  const errPath = join(scratch, 'stderr')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync('git', ['-C', dir, ...args], {
      cwd: ROOT,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const captured = {
    ok: result.status === 0 && result.error === undefined,
    status: result.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
    error: result.error,
  }
  rmSync(scratch, { recursive: true, force: true })
  return captured
}

/** `git <args>` in `dir`, failing with `what` when the command does not succeed. */
function gitOrThrow(args, dir, what) {
  const result = captureGit(args, dir)
  if (!result.ok) {
    const detail = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)
    throw new Error(`${what} failed: ${detail}`)
  }
  return result.stdout.trim()
}

/**
 * The commit the desktop checkout must hold: the pinned submodule revision.
 *
 * A submodule checkout on a branch keeps a symbolic HEAD, which
 * `submoduleRevision` refuses; asking git resolves that case the same way the
 * checkout content does.
 * @returns {string} 40-character commit hash.
 */
function pinnedRevision() {
  const pinned = submoduleRevision(ROOT)
  if (pinned !== null) return pinned
  return gitOrThrow(['rev-parse', 'HEAD'], HARNESS, `git rev-parse HEAD in ${HARNESS}`)
}

/**
 * Replace the source checkout with a fresh one at `revision`.
 *
 * `--no-checkout` plus a detached checkout mirrors the submodule pointer rather
 * than the clone's default branch, and `--local` hardlinks the pinned
 * submodule's objects, so creating the workspace costs no network transfer.
 * @param {string} revision - commit to check out.
 */
function cloneSource(revision) {
  rmSync(SOURCE, { recursive: true, force: true })
  mkdirSync(DESKTOP_ROOT, { recursive: true })
  run('git', ['clone', '--local', '--no-checkout', HARNESS, SOURCE], { cwd: DESKTOP_ROOT })
  run('git', ['-C', SOURCE, 'checkout', '--detach', revision])
}

/**
 * Bring `<runtime-root>/.desktop/source` onto the pinned submodule revision.
 * @param {{ forceSource?: boolean }} options - `forceSource` deletes the checkout first.
 * @returns {string} the revision the checkout holds.
 */
function syncSource(options) {
  const revision = pinnedRevision()
  step('Sync the desktop source workspace', () => {
    if (options.forceSource && existsSync(SOURCE)) {
      console.log(`removing the existing checkout (--force-source): ${SOURCE}`)
      rmSync(SOURCE, { recursive: true, force: true })
    }
    if (!existsSync(SOURCE)) {
      console.log(`cloning the pinned submodule into ${SOURCE}`)
      cloneSource(revision)
    } else if (!existsSync(join(SOURCE, '.git'))) {
      // An interrupted clone leaves a directory without a gitdir; the path
      // belongs to this chain, so replacing it is the only way forward.
      console.log(`${SOURCE} is not a git checkout — replacing it`)
      cloneSource(revision)
    } else {
      const dirty = gitOrThrow(['status', '--porcelain'], SOURCE, `git status in ${SOURCE}`)
      if (dirty !== '') {
        throw new Error(
          `${SOURCE} has uncommitted changes; commit or discard them, or re-run with --force-source:\n${dirty}`,
        )
      }
      const head = gitOrThrow(['rev-parse', 'HEAD'], SOURCE, `git rev-parse HEAD in ${SOURCE}`)
      if (head === revision) {
        console.log(`already at ${revision}`)
      } else {
        console.log(`moving ${head} -> ${revision}`)
        run('git', ['-C', SOURCE, 'fetch', '--prune', HARNESS])
        run('git', ['-C', SOURCE, 'checkout', '--detach', revision])
      }
    }
    const checkedOut = gitOrThrow(['rev-parse', 'HEAD'], SOURCE, `git rev-parse HEAD in ${SOURCE}`)
    if (checkedOut !== revision) {
      throw new Error(`expected ${revision} in ${SOURCE}, found ${checkedOut}`)
    }
    writeFileSync(
      SOURCE_REVISION_FILE,
      `${JSON.stringify({
        revision,
        version: submoduleVersion(ROOT),
        syncedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    )
    console.log(`source revision: ${revision}`)
  })
  return revision
}

/**
 * Whether the source checkout already holds a completed dependency install.
 * `.modules.yaml` is written only after pnpm links every package, and a
 * non-empty `.pnpm` proves the store links exist rather than an empty
 * directory left by an aborted install.
 * @returns {boolean}
 */
function dependenciesInstalled() {
  if (!existsSync(join(SOURCE, 'node_modules', '.modules.yaml'))) return false
  try {
    return readdirSync(join(SOURCE, 'node_modules', '.pnpm'), { withFileTypes: true }).length > 0
  } catch {
    return false
  }
}

/**
 * Install the source checkout's dependencies with the pinned pnpm.
 * @param {{ forceInstall?: boolean }} options - `forceInstall` skips the current-install check.
 */
function installSourceDependencies(options) {
  step('Install desktop source dependencies (repo-local store)', () => {
    if (!options.forceInstall && dependenciesInstalled()) {
      console.log('node_modules is complete — skipping (--force-install reinstalls)')
      return
    }
    // --frozen-lockfile is required: the checkout mirrors the pinned submodule,
    // whose lockfile is version-controlled, so an install must never rewrite it.
    // CI=true keeps the install non-interactive (this CLI spawns without a TTY)
    // and skips the harness's dev-only git-hook postinstall.
    pnpm(['install', '--frozen-lockfile'], { cwd: SOURCE, env: { CI: 'true' } })
  })
}

/**
 * Ensure `apps/desktop/.env.windows` with the minimum an unsigned local build
 * needs.
 *
 * The packaging chain strips ambient `DSH_DESKTOP_*` variables and reads this
 * file instead, so every required value has to live here. The `test` deployment
 * (the default) requires a mandatory-update origin and a non-empty
 * `allowedAuthOrigins` list; the file itself is git-ignored inside the checkout.
 */
function writePackageEnvironment() {
  step('Ensure the desktop package environment', () => {
    if (existsSync(PACKAGE_ENV_FILE)) {
      console.log(`already present: ${PACKAGE_ENV_FILE}`)
      return
    }
    const origin = 'https://desktop-updates.example.com'
    const body = [
      '# Generated by dsh-gui for an unsigned local build; apps/desktop/.env.windows is git-ignored.',
      'DSH_DESKTOP_APP_ID=com.deepseek.dsh.desktop.local',
      'DSH_DESKTOP_AUTO_UPDATE_ENV=test',
      `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=${origin}`,
      `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG='{"allowedAuthOrigins":["${origin}"]}'`,
      '',
    ].join('\n')
    writeFileSync(PACKAGE_ENV_FILE, body)
    console.log(`wrote ${PACKAGE_ENV_FILE}`)
  })
}

/**
 * Download the Electron binary when the install did not.
 *
 * The workspace's `allowBuilds` does not list `electron`, so its postinstall
 * never runs and the archive is fetched explicitly. `electron_config_cache`
 * keeps the download under the runtime root; `ELECTRON_MIRROR` is inherited
 * from the caller's environment when set, so no mirror is hardcoded here.
 */
function ensureElectron() {
  const electronDir = join(SOURCE, 'apps', 'desktop', 'node_modules', 'electron')
  step('Ensure the Electron binary', () => {
    if (existsSync(join(electronDir, 'dist', 'electron.exe'))) {
      console.log('electron.exe is already installed')
      return
    }
    if (!existsSync(join(electronDir, 'install.js'))) {
      throw new Error(`${electronDir} has no install.js — run the dependency step first`)
    }
    run('node', ['install.js'], { cwd: electronDir, env: { electron_config_cache: ELECTRON_CACHE } })
  })
}

/** Compile the harness, the web bundle and the desktop app in one pass. */
function buildOfficial() {
  step('Build the harness and the desktop app (build:official)', () => {
    // The pre-run dependency check spawns a nested pnpm install when it judges
    // node_modules stale; without a TTY that install aborts with
    // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, so it warns instead.
    pnpm(['run', 'build:official'], { cwd: SOURCE, env: { pnpm_config_verify_deps_before_run: 'warn' } })
  })
}

/**
 * Package the desktop app into an unpacked win-x64 directory.
 *
 * The packaged `prepare-package-set.ts` hands absolute Windows paths to `tar`,
 * which GNU tar reads as `host:path` and fails on. Prepending `%SystemRoot%
 * \System32` makes the Windows bundled bsdtar win over a Git-installed GNU tar;
 * both the toolchain probe and the real call then use the same implementation.
 *
 * This step goes through `run` and the pinned pnpm entry instead of `pnpm()`
 * because `pnpmEnv` pins PATH itself and would drop that prefix. `ELECTRON_BUILDER_CACHE`
 * keeps electron-builder's toolset under the runtime root, and `DSH_HOME` is
 * unset explicitly: the step needs no harness home, and `run` merges
 * `process.env`, so the inherited value has to be overridden with `undefined`
 * rather than deleted.
 */
function packageDesktop() {
  step('Package the desktop app (win x64, unsigned, unpacked)', () => {
    const entry = pnpmEntry()
    if (entry === null) throw new Error('pnpm is not bootstrapped yet — run "npm run setup" once.')
    const system32 = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32')
    const env = {
      PATH: `${system32}${delimiter}${pinnedPath()}`,
      pnpm_config_store_dir: STORE,
      ELECTRON_BUILDER_CACHE: BUILDER_CACHE,
      // The pre-run dependency check would abort without a TTY; see buildOfficial.
      pnpm_config_verify_deps_before_run: 'warn',
      DSH_HOME: undefined,
    }
    run('node', [entry, 'run', 'package:desktop:win:x64:unsigned', '--', '--dir'], { cwd: SOURCE, env })
  })
}

/** File count and byte total of a directory tree. */
function directoryStats(dir) {
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = directoryStats(path)
      files += nested.files
      bytes += nested.bytes
    } else if (entry.isFile()) {
      files += 1
      bytes += statSync(path).size
    }
  }
  return { files, bytes }
}

/** Human-readable byte count for the build summary. */
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${bytes} bytes`
}

/** Copy the unpacked app to the runtime root, replacing the previous landing. */
function landUnpacked() {
  return step('Land the unpacked app at the runtime root', () => {
    const sourceExe = join(UNPACKED, APP_EXE)
    if (!existsSync(sourceExe)) {
      throw new Error(`the packaging step did not produce ${sourceExe}`)
    }
    rmSync(LANDING, { recursive: true, force: true })
    cpSync(UNPACKED, LANDING, { recursive: true })
    const stats = directoryStats(LANDING)
    const exe = join(LANDING, APP_EXE)
    console.log(`${LANDING}: ${stats.files} files, ${formatBytes(stats.bytes)}`)
    return { exe, ...stats, exeBytes: statSync(exe).size }
  })
}

/**
 * Build the console-less launcher shim and place it at the runtime root.
 *
 * The crate is standalone and dependency-free, so this is seconds of cargo.
 * `CARGO_TARGET_DIR` keeps its target directory inside the desktop workspace
 * rather than `src-tauri/desktop-shim/target/`; cargo and its rustup overrides
 * resolve through the same helpers the Tauri entry exe uses.
 * @param {{ skipShim?: boolean }} options - `skipShim` leaves any existing shim untouched.
 * @returns {{ shim: string, shimBytes: number|null }} the landed path and its size,
 *   or a null size when the step was skipped.
 */
function buildShim(options) {
  return step('Build the desktop shortcut shim', () => {
    if (options.skipShim) {
      console.log(`skipped (--skip-shim): ${SHIM_EXE}`)
      return { shim: SHIM_EXE, shimBytes: null }
    }
    if (!existsSync(SHIM_MANIFEST)) {
      throw new Error(`shim manifest not found: ${SHIM_MANIFEST}`)
    }
    const cargoBinary = resolveCargo()
    run(cargoBinary ?? 'cargo', ['build', '--release', '--manifest-path', SHIM_MANIFEST], {
      env: { ...cargoToolchainEnv(cargoBinary), CARGO_TARGET_DIR: SHIM_TARGET },
    })
    const artifact = join(SHIM_TARGET, 'release', 'dsh-gui-desktop.exe')
    if (!existsSync(artifact)) {
      throw new Error(`cargo did not produce ${artifact}`)
    }
    try {
      copyFileSync(artifact, SHIM_EXE)
    } catch (error) {
      throw new Error(`could not copy ${artifact} to ${SHIM_EXE} (is the shim running? close it first): ${error.message}`)
    }
    const shimBytes = statSync(SHIM_EXE).size
    console.log(`${SHIM_EXE} (${formatBytes(shimBytes)})`)
    return { shim: SHIM_EXE, shimBytes }
  })
}

/**
 * Build the Electron desktop app from the pinned harness checkout and land the
 * unpacked result at `<runtime-root>/desktop`, plus the shortcut shim at
 * `<runtime-root>/dsh-gui-desktop.exe`.
 * @param {{ forceSource?: boolean, forceInstall?: boolean, skipShim?: boolean }} [options] -
 *   `forceSource` re-clones the source checkout, `forceInstall` reinstalls its
 *   dependencies, `skipShim` leaves the shim step out.
 * @returns {{ workspace: string, source: string, revision: string, version: string|null,
 *   output: string, exe: string, files: number, bytes: number, exeBytes: number,
 *   shim: string, shimBytes: number|null }}
 */
export function buildDesktop(options = {}) {
  console.log('desktop build: the pinned harness checkout is compiled under the runtime root; "npm run build" never runs this chain.')
  bootstrapPnpm()
  const revision = syncSource(options)
  installSourceDependencies(options)
  writePackageEnvironment()
  ensureElectron()
  buildOfficial()
  packageDesktop()
  const landed = landUnpacked()
  const shim = buildShim(options)
  const result = {
    workspace: DESKTOP_ROOT,
    source: SOURCE,
    revision,
    version: submoduleVersion(ROOT),
    output: LANDING,
    ...landed,
    ...shim,
  }
  console.log('\ndesktop build complete:')
  console.log(`  workspace : ${result.workspace}`)
  console.log(`  source    : ${result.source} @ ${result.revision}${result.version === null ? '' : ` (${result.version})`}`)
  console.log(`  output    : ${result.output} (${result.files} files, ${formatBytes(result.bytes)})`)
  console.log(`  entry     : ${result.exe} (${formatBytes(result.exeBytes)})`)
  console.log(`  shim      : ${result.shim}${result.shimBytes === null ? ' (skipped)' : ` (${formatBytes(result.shimBytes)})`}`)
  console.log('\nrun it with: npm run desktop')
  return result
}

/**
 * Launch the landed desktop app detached, so the invoking terminal returns at
 * once and closing it never kills the app.
 *
 * `DSH_HOME` points at the runtime root's `.dsh`, which is what makes the
 * desktop app use this installation's profile store: the app creates its own
 * `profiles/desktop` beside the existing `profiles/web` instead of starting an
 * unrelated home.
 */
export function runDesktop() {
  const exe = join(LANDING, APP_EXE)
  if (!existsSync(exe)) {
    throw new Error(`desktop app not found at ${exe} — run "npm run build:desktop" first`)
  }
  const child = spawn(exe, [], {
    cwd: LANDING,
    env: { ...process.env, DSH_HOME: WEB_HOME },
    detached: true,
    stdio: 'ignore',
    // Deliberately no `windowsHide`: on Windows Node spawns with
    // STARTF_USESHOWWINDOW + SW_HIDE, which hides every window the child shows,
    // including Electron's main window. `runApp()` keeps the option because the
    // Tauri shell creates its own window instead of inheriting the spawn state.
  })
  child.unref()
  console.log(`launched ${exe}`)
}
