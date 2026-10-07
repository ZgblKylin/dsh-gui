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
 *   <runtime-root>/.dsh/profiles/desktop       desktop profile the plugins install into
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
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  HARNESS,
  IS_WINDOWS,
  PLUGINS,
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
/** Archived toolsets whose downloads can be served by a registry mirror, and how each is configured. */
const DOWNLOAD_SOURCES = {
  electron: { environmentVariable: 'ELECTRON_MIRROR', configKey: 'electron_mirror', project: 'electron' },
  builder: {
    environmentVariable: 'ELECTRON_BUILDER_BINARIES_MIRROR',
    configKey: 'electron_builder_binaries_mirror',
    project: 'electron-builder-binaries',
  },
}
/** Standalone crate of the console-less launcher that starts `npm run desktop`. */
const SHIM_MANIFEST = join(ROOT, 'src-shim', 'Cargo.toml')
/** Cargo target directory of the shim, kept inside the desktop workspace. */
const SHIM_TARGET = join(DESKTOP_ROOT, 'shim-target')
/** Where the shim lands: the runtime root, beside the Tauri entry exe. */
const SHIM_EXE = join(RUNTIME_ROOT, 'dsh-gui-desktop.exe')
/** The desktop app's own CLI, the only carrier allowed to manage its profile. */
const DESKTOP_CLI = join(LANDING, 'resources', 'runtime', 'cli', 'bin', IS_WINDOWS ? 'dsh.cmd' : 'dsh')
/** The desktop harness home the app creates when it starts for the first time. */
const DESKTOP_PROFILE = join(WEB_HOME, 'profiles', 'desktop')
/** How long the first app start may take to write the profile, in milliseconds. */
const PROFILE_INIT_TIMEOUT_MS = 120_000

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
  return capture('git', ['-C', dir, ...args], { GIT_TERMINAL_PROMPT: '0' })
}

/**
 * Run a command with its stdout and stderr written to files instead of pipes.
 * The dsh Windows sandbox rejects child processes that capture through pipes, so
 * the file form keeps the captured diagnostics available inside a sandboxed
 * session (the same reason `scripts/staging.mjs` captures this way).
 * @param {string} command - executable to spawn.
 * @param {string[]} args - arguments, verbatim.
 * @param {NodeJS.ProcessEnv} [extraEnv] - environment overrides on top of `process.env`.
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, error: Error|undefined }}
 */
function capture(command, args, extraEnv = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-gui-desktop-'))
  const outPath = join(scratch, 'stdout')
  const errPath = join(scratch, 'stderr')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync(command, args, {
      cwd: ROOT,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, ...extraEnv },
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

/**
 * Block the current thread for `ms`. The desktop profile is polled
 * synchronously, and `Atomics.wait` is the only wait Node allows on the main
 * thread without turning the whole build chain into promises.
 * @param {number} ms - milliseconds to wait.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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
 * Read one npm config value from an `.npmrc`.
 *
 * Only `key=value` lines are honored, with the whitespace, surrounding quotes and
 * inline comments npm tolerates stripped; keys match case-insensitively. A
 * missing or unreadable file yields undefined.
 * @param {string} file - `.npmrc` path.
 * @param {string} key - config key to look up.
 * @returns {string | undefined} Trimmed value, or undefined when unset.
 */
function readNpmrcValue(file, key) {
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  for (const line of content.split(/\r?\n/u)) {
    const match = /^\s*([^#;\s][^=]*?)\s*=\s*(.*?)\s*(?:[#;].*)?$/u.exec(line)
    if (match === null || match[1].toLowerCase() !== key) continue
    return match[2].replace(/^"(.*)"$/u, '$1').replace(/^'(.*)'$/u, '$1').trim()
  }
  return undefined
}

/**
 * Resolve the npm registry the caller configured.
 *
 * `npm run` exports the resolved npm config to the script as `npm_config_registry`,
 * covering `.npmrc`, environment and `--registry`; the config files are read too
 * so a direct `node scripts/dsh-gui.mjs build-desktop` behaves the same.
 * @returns {string | undefined} Registry URL, or undefined when none is configured.
 */
function npmRegistry() {
  const fromEnvironment = process.env.npm_config_registry?.trim()
  if (fromEnvironment) return fromEnvironment
  for (const file of [join(ROOT, '.npmrc'), join(homedir(), '.npmrc')]) {
    const value = readNpmrcValue(file, 'registry')?.trim()
    if (value) return value
  }
  return undefined
}

/**
 * Derive a project's binary mirror from a registry that also mirrors release assets.
 *
 * npmmirror and its legacy taobao host publish the GitHub release assets these
 * tools download under `/-/binary/<project>/`; the host comes from the caller's
 * registry, so no mirror host is hardcoded here. An unrecognized registry yields
 * undefined, which leaves the tool on its official host.
 * @param {string | undefined} registry - Configured npm registry.
 * @param {string} project - Mirror directory name, for example `electron`.
 * @returns {string | undefined} Mirror base URL, or undefined for an unrecognized registry.
 */
function registryBinaryMirror(registry, project) {
  if (registry === undefined) return undefined
  let url
  try {
    url = new URL(registry)
  } catch {
    return undefined
  }
  if (!/(?:^|\.)(?:npmmirror\.com|npm\.taobao\.org)$/u.test(url.hostname)) return undefined
  return new URL(`-/binary/${project}/`, `${url.origin}/`).toString()
}

/**
 * Resolve the download mirror for one archived toolset.
 *
 * Precedence: the tool's own environment variable, the same key through npm
 * config (`electron_mirror` / `electron_builder_binaries_mirror`), then a mirror
 * derived from the configured registry. A caller value always wins, including an
 * empty one, which restores the official host.
 * @param {{ environmentVariable: string, configKey: string, project: string }} source - Toolset identity.
 * @returns {string | undefined} Mirror base URL, or undefined for the official host.
 */
function downloadMirror(source) {
  const configured = process.env[source.environmentVariable] ?? process.env[`npm_config_${source.configKey}`]
  if (configured !== undefined) return configured
  return registryBinaryMirror(npmRegistry(), source.project)
}

/**
 * Merge one toolset's resolved mirror into a child environment.
 * @param {{ environmentVariable: string, configKey: string, project: string }} source - Toolset identity.
 * @returns {Record<string, string>} Mirror override, or an empty object for the official host.
 */
function downloadMirrorEnv(source) {
  const mirror = downloadMirror(source)
  return mirror === undefined ? {} : { [source.environmentVariable]: mirror }
}

/**
 * Name the download source a step is about to use, for the build log.
 * @param {{ environmentVariable: string, configKey: string, project: string }} source - Toolset identity.
 * @returns {string} Mirror URL, or the official-host placeholder.
 */
function downloadSourceLabel(source) {
  return downloadMirror(source) || 'official GitHub releases'
}

/**
 * Download the Electron binary when the install did not.
 *
 * The workspace's `allowBuilds` does not list `electron`, so its postinstall
 * never runs and the archive is fetched explicitly. `electron_config_cache`
 * keeps the download under the runtime root; the mirror is resolved from the
 * caller's environment, npm config and registry (see `downloadMirror`).
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
    console.log(`electron source: ${downloadSourceLabel(DOWNLOAD_SOURCES.electron)}`)
    run('node', ['install.js'], {
      cwd: electronDir,
      env: { electron_config_cache: ELECTRON_CACHE, ...downloadMirrorEnv(DOWNLOAD_SOURCES.electron) },
    })
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
 * keeps electron-builder's toolset under the runtime root, `DSH_HOME` is
 * unset explicitly: the step needs no harness home, and `run` merges
 * `process.env`, so the inherited value has to be overridden with `undefined`
 * rather than deleted. Electron and electron-builder both download inside the
 * packaging chain, so their resolved mirrors are merged into that child
 * environment as well.
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
      ...downloadMirrorEnv(DOWNLOAD_SOURCES.electron),
      ...downloadMirrorEnv(DOWNLOAD_SOURCES.builder),
    }
    console.log(`electron source: ${downloadSourceLabel(DOWNLOAD_SOURCES.electron)}`)
    console.log(`electron-builder toolset source: ${downloadSourceLabel(DOWNLOAD_SOURCES.builder)}`)
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
 * rather than `src-shim/target/`; cargo and its rustup overrides
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
 * Whether a `DeepSeek Harness.exe` process is currently running. `tasklist`
 * exits 0 with an informational line when nothing matches, so the name in the
 * output is the answer.
 * @returns {boolean}
 */
function desktopAppRunning() {
  const result = capture('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'])
  return result.ok && /DeepSeek Harness\.exe/i.test(result.stdout)
}

/**
 * Initialize the desktop profile when the desktop app has never run.
 *
 * The desktop profile is reserved: only the desktop app's own CLI may manage it,
 * and that CLI refuses an uninitialized profile ("Open DeepSeek Harness Desktop
 * once to initialize its profile, then fully quit it before running dsh plugin
 * --profile desktop"). `windowsHide` keeps the initialization start from
 * flashing a window on the user's desktop; the instance is killed with its whole
 * process tree afterwards, because the upstream README requires Desktop to be
 * closed for package operations. The caller checks that no instance is running
 * before this starts one.
 */
function ensureDesktopProfile() {
  if (existsSync(join(DESKTOP_PROFILE, 'package.json'))) {
    console.log(`desktop profile already initialized: ${DESKTOP_PROFILE}`)
    return
  }
  const exe = join(LANDING, APP_EXE)
  if (!existsSync(exe)) {
    throw new Error(`desktop app not found at ${exe} — run "npm run build:desktop" first`)
  }
  console.log(`initializing the desktop profile: starting ${exe} once`)
  const child = spawn(exe, [], {
    cwd: LANDING,
    env: { ...process.env, DSH_HOME: WEB_HOME },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  if (child.pid === undefined) throw new Error(`could not start ${exe}`)
  child.unref()
  const deadline = Date.now() + PROFILE_INIT_TIMEOUT_MS
  const initialized = () =>
    existsSync(join(DESKTOP_PROFILE, 'package.json')) && existsSync(join(DESKTOP_PROFILE, 'cordis.patch.yml'))
  while (!initialized() && Date.now() < deadline) sleepSync(1000)
  // Give the app a moment to finish writing both files before the profile is
  // handed to the CLI.
  sleepSync(3000)
  const killed = capture('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  // taskkill returns before the process tree has released the profile directory.
  sleepSync(2000)
  if (!initialized()) {
    const detail = [killed.stdout.trim(), killed.stderr.trim()].filter(Boolean).join('\n')
    throw new Error(
      `the desktop app did not initialize ${DESKTOP_PROFILE} within ${PROFILE_INIT_TIMEOUT_MS / 1000}s${detail === '' ? '' : `:\n${detail}`}`,
    )
  }
  console.log(`desktop profile initialized: ${DESKTOP_PROFILE}`)
}

/** Discover the per-plugin install scripts in the same order `npm run install` runs them. */
function pluginInstallScripts() {
  if (!existsSync(PLUGINS)) return []
  return readdirSync(PLUGINS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PLUGINS, entry.name, 'install.mjs'))
    .filter((path) => existsSync(path))
    .sort()
}

/** Read and parse a JSON file; null when it is missing or unparsable. */
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The installed manifest of a profile dependency, or null. */
function installedManifest(name) {
  return readJsonFile(join(DESKTOP_PROFILE, 'node_modules', ...name.split('/'), 'package.json'))
}

/**
 * Dependencies that declare `dsh.bundle.patch` but are missing from
 * `dsh.profile.bundles`, with the spec that re-adds them.
 * @returns {{ name: string, spec: string }[]}
 */
function missingBundleEntries() {
  const profile = readJsonFile(join(DESKTOP_PROFILE, 'package.json'))
  const bundles = Array.isArray(profile?.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : []
  const missing = []
  for (const [name, spec] of Object.entries(profile?.dependencies ?? {})) {
    if (bundles.includes(name)) continue
    if (installedManifest(name)?.dsh?.bundle?.patch === undefined) continue
    missing.push({ name, spec: /^(?:link|file):/.test(spec) ? spec : `${name}@${spec}` })
  }
  return missing
}

/**
 * Re-register dependencies that declare `dsh.bundle.patch` but never reached
 * `dsh.profile.bundles`.
 *
 * The desktop CLI reconciles the bundle list only while `dsh plugin add` changes
 * the dependency tree. An add that fails after pnpm already wrote the dependency
 * leaves the package in `dependencies` without its bundle entry, and every later
 * add of that same spec is a no-op — so the plugin never mounts. `remove` then
 * `add` forces the reconciliation.
 * @returns {number} how many bundle entries were re-registered.
 */
function reconcileDesktopBundles() {
  return step('Reconcile the desktop profile bundles', () => {
    const missing = missingBundleEntries()
    if (missing.length === 0) {
      console.log('every dsh.bundle.patch dependency is registered in dsh.profile.bundles')
      return 0
    }
    for (const entry of missing) {
      console.log(
        `re-registering ${entry.name} (${entry.spec}) — it declares dsh.bundle.patch but is missing from dsh.profile.bundles`,
      )
      try {
        run(DESKTOP_CLI, ['plugin', '--profile', 'desktop', 'remove', entry.name], { env: { DSH_HOME: WEB_HOME } })
        run(DESKTOP_CLI, ['plugin', '--profile', 'desktop', 'add', entry.spec], { env: { DSH_HOME: WEB_HOME } })
      } catch (error) {
        throw new Error(`could not re-register ${entry.name} (${entry.spec}): ${error.message}`)
      }
    }
    const still = missingBundleEntries()
    if (still.length > 0) {
      throw new Error(`dsh.profile.bundles still misses: ${still.map((entry) => entry.name).join(', ')}`)
    }
    console.log(`bundles reconciled: ${missing.length}`)
    return missing.length
  })
}

/**
 * Run every plugin install script again, against the desktop profile.
 *
 * The wrappers are profile-agnostic: `DSH_PLUGIN_PROFILE` selects the profile
 * directory and `DSH_PLUGIN_DSH_CLI` makes them drive the desktop app's own CLI,
 * which is the only carrier allowed to write that profile. The desktop profile
 * starts empty, so every plugin is installed from scratch on the first run and
 * takes the wrappers' fast path afterwards.
 * @param {{ skipPlugins?: boolean }} options - `skipPlugins` leaves the profile alone.
 * @returns {{ scripts: number, reconciled: number }} how many install scripts ran
 *   and how many bundle entries the closing reconcile re-registered.
 */
function installDesktopPlugins(options) {
  return step('Install the plugin set into the desktop profile', () => {
    if (!existsSync(LANDING)) {
      throw new Error(`desktop app not found at ${LANDING} — run "npm run build:desktop" first`)
    }
    if (options.skipPlugins) {
      console.log(`skipped (--skip-plugins): ${DESKTOP_PROFILE}`)
      return { scripts: 0, reconciled: 0 }
    }
    if (!existsSync(DESKTOP_CLI)) {
      throw new Error(`desktop CLI not found: ${DESKTOP_CLI} — run "npm run build:desktop" first`)
    }
    // The upstream README requires Desktop to be fully quit for package
    // operations, whatever the profile state is.
    if (desktopAppRunning()) {
      throw new Error(`a DeepSeek Harness instance is running — quit it before installing into ${DESKTOP_PROFILE}`)
    }
    ensureDesktopProfile()
    const scripts = pluginInstallScripts()
    if (scripts.length === 0) {
      console.log('no plugin install scripts under plugins/ — nothing to install')
      return { scripts: 0, reconciled: 0 }
    }
    for (const script of scripts) {
      console.log(`--- ${script}`)
      run('node', [script], {
        env: {
          DSH_HOME: WEB_HOME,
          DSH_PLUGIN_PROFILE: 'desktop',
          DSH_PLUGIN_DSH_CLI: DESKTOP_CLI,
        },
      })
    }
    const reconciled = reconcileDesktopBundles()
    console.log(`installed ${scripts.length} plugin script(s) into ${DESKTOP_PROFILE}`)
    return { scripts: scripts.length, reconciled }
  })
}

/**
 * Build the Electron desktop app from the pinned harness checkout and land the
 * unpacked result at `<runtime-root>/desktop`, plus the shortcut shim at
 * `<runtime-root>/dsh-gui-desktop.exe`, then install the plugin set into the
 * desktop profile under `<runtime-root>/.dsh/profiles/desktop`.
 * @param {{ forceSource?: boolean, forceInstall?: boolean, skipShim?: boolean,
 *   skipPlugins?: boolean, pluginsOnly?: boolean }} [options] -
 *   `forceSource` re-clones the source checkout, `forceInstall` reinstalls its
 *   dependencies, `skipShim` leaves the shim step out, `skipPlugins` leaves the
 *   desktop profile alone, `pluginsOnly` runs the plugin step against the
 *   already landed app and nothing else.
 * @returns {{ workspace: string, source: string, revision: string, version: string|null,
 *   output: string, exe: string, files: number, bytes: number, exeBytes: number,
 *   shim: string, shimBytes: number|null, profile: string, pluginScripts: number,
 *   bundlesReconciled: number }}
 */
export function buildDesktop(options = {}) {
  if (options.pluginsOnly && options.skipPlugins) {
    throw new Error('--plugins-only conflicts with --skip-plugins')
  }
  if (options.pluginsOnly) {
    console.log('desktop plugins: reinstall the plugin set into the desktop profile (--plugins-only)')
    const plugins = installDesktopPlugins(options)
    const pluginsOnly = {
      workspace: DESKTOP_ROOT,
      source: SOURCE,
      revision: submoduleRevision(ROOT),
      version: submoduleVersion(ROOT),
      output: LANDING,
      exe: join(LANDING, APP_EXE),
      shim: SHIM_EXE,
      shimBytes: null,
      profile: DESKTOP_PROFILE,
      pluginScripts: plugins.scripts,
      bundlesReconciled: plugins.reconciled,
    }
    console.log('\ndesktop plugins complete:')
    console.log(`  output    : ${pluginsOnly.exe}`)
    console.log(`  plugins   : ${pluginsOnly.pluginScripts} script(s) -> ${pluginsOnly.profile}`)
    console.log(`  bundles   : ${pluginsOnly.bundlesReconciled} re-registered`)
    return pluginsOnly
  }
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
  const plugins = installDesktopPlugins(options)
  const result = {
    workspace: DESKTOP_ROOT,
    source: SOURCE,
    revision,
    version: submoduleVersion(ROOT),
    output: LANDING,
    profile: DESKTOP_PROFILE,
    pluginScripts: plugins.scripts,
    bundlesReconciled: plugins.reconciled,
    ...landed,
    ...shim,
  }
  console.log('\ndesktop build complete:')
  console.log(`  workspace : ${result.workspace}`)
  console.log(`  source    : ${result.source} @ ${result.revision}${result.version === null ? '' : ` (${result.version})`}`)
  console.log(`  output    : ${result.output} (${result.files} files, ${formatBytes(result.bytes)})`)
  console.log(`  entry     : ${result.exe} (${formatBytes(result.exeBytes)})`)
  console.log(`  shim      : ${result.shim}${result.shimBytes === null ? ' (skipped)' : ` (${formatBytes(result.shimBytes)})`}`)
  console.log(`  plugins   : ${result.pluginScripts} script(s) -> ${result.profile}${result.pluginScripts === 0 ? ' (skipped)' : ''}`)
  console.log(`  bundles   : ${result.bundlesReconciled} re-registered`)
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
 *
 * `DSH_GUI_ROOT` points at the repository, the same pin `scripts/harness.mjs`
 * exports for the shell's backend: plugins that need the checkout (the desktop
 * auto-update plugin resolves the repository to run `git` against it) read this
 * instead of walking up from `cwd`, which for a landed app under the runtime
 * root would never reach the repository.
 */
export function runDesktop() {
  const exe = join(LANDING, APP_EXE)
  if (!existsSync(exe)) {
    throw new Error(`desktop app not found at ${exe} — run "npm run build:desktop" first`)
  }
  const child = spawn(exe, [], {
    cwd: LANDING,
    env: { ...process.env, DSH_HOME: WEB_HOME, DSH_GUI_ROOT: ROOT },
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
