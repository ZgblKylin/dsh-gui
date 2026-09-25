#!/usr/bin/env node
/**
 * dsh-gui — cross-platform build/install/run commands for the desktop shell.
 *
 * One Node CLI so the same commands work on Windows, macOS, and Linux (WSL).
 * Every path resolves from the repository root regardless of the invoking cwd.
 *
 * Commands:
 *   setup    one-shot bootstrap: pinned pnpm -> dsh runtime (see below) ->
 *            entry exe (release unless --debug) -> plugins (each
 *            plugins/<id>/install.mjs) -> install agent presets -> install the
 *            global agent template (global_template.agents/ -> .dsh/.agents/)
 *   build    dsh runtime (unless --skip-harness) -> entry exe -> plugins (each
 *            plugins/<id>/install.mjs) -> install agent presets -> install the
 *            global agent template
 *   install  run every plugins/<id>/install.mjs (alias: plugins)
 *   run      launch the entry exe detached; the invoking terminal returns at
 *            once and closing it never kills dsh-gui (or its dsh child)
 *   shortcut create a Windows desktop shortcut to the entry exe (Windows only)
 *
 * The dsh runtime is selected by `harness.json` (environment overrides win;
 * see scripts/harness-runtime.mjs for the full contract):
 *   npm     install `@deepseek-ai/dsh@<version>` into `<repo>/.harness/` from
 *           the registry and launch that CLI. Nothing under
 *           `deepseek-harness/` is compiled; the pinned submodule supplies the
 *           release tag the version is derived from.
 *   source  `pnpm install` + `pnpm run clean` + `pnpm run build` inside the
 *           `deepseek-harness` submodule and launch its built CLI. A build whose
 *           submodule revision already matches `.dsh/gui/harness-build.json` is
 *           skipped, so an unchanged pinned revision costs no rebuild.
 *
 * Flags (after the command):
 *   --debug          cargo debug build instead of release (release is default)
 *   --skip-harness   build: skip the dsh runtime install/build
 *   --skip-exe       skip the cargo build + exe copy (runtime/plugins only —
 *                    useful on Linux without Tauri system deps)
 *   --force-harness  clean-reinstall the dsh runtime even when it is current
 *                    (removes .harness/node_modules + lockfile, re-resolves
 *                    from the registry)
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  HARNESS_BUILD_STATE_FILE,
  HARNESS_NPM_PACKAGE,
  ensureHarnessProject,
  requireHarnessRuntime,
  resolveHarnessRuntime,
  submoduleRevision,
  submoduleVersion,
} from './harness-runtime.mjs'
import {
  BIN_NAME,
  GLOBAL_AGENTS_TEMPLATE,
  HARNESS,
  IS_WINDOWS,
  PLUGINS,
  ROOT,
  STORE,
  WEB_HOME,
  bootstrapPnpm,
  fillTreeFromTemplate,
  pnpm,
  run,
} from './toolchain.mjs'
import { recordNpmInstall } from './plugin-install.mjs'

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

/** Where a completed source build records the submodule revision it built. */
function harnessBuildStatePath() {
  const dshHome = process.env.DSH_HOME ?? WEB_HOME
  return join(dshHome, 'gui', HARNESS_BUILD_STATE_FILE)
}

/** @returns {{ runtime?: string, revision?: string, version?: string|null, builtAt?: string } | null} */
function readHarnessBuildState() {
  try {
    const state = JSON.parse(readFileSync(harnessBuildStatePath(), 'utf8'))
    return state !== null && typeof state === 'object' ? state : null
  } catch {
    return null
  }
}

/**
 * Whether the source runtime already matches the pinned submodule revision.
 *
 * The submodule revision is the only input that changes its build outputs, so
 * an unchanged revision reuses the existing `lib/` instead of paying the full
 * clean + tsc + tsdown rebuild. The CLI artifact check keeps a deleted or
 * partial build from being treated as current.
 * @returns {boolean}
 */
function harnessSourceCurrent() {
  const state = readHarnessBuildState()
  const revision = submoduleRevision(ROOT)
  if (state?.runtime !== 'source' || revision === null || state.revision !== revision) return false
  return existsSync(join(HARNESS, 'apps', 'cli', 'lib', 'bin.js'))
}

/** Build the pinned submodule, or reuse the build its revision already has. */
function harnessSourceRuntime(frozen, force) {
  if (!force && harnessSourceCurrent()) {
    const state = readHarnessBuildState()
    step('Reuse the existing harness build', () => {
      console.log(
        `submodule revision ${String(state?.revision).slice(0, 12)} unchanged since ${state?.builtAt ?? 'the last build'}`
        + ' — skipping install/clean/build (--force-harness or DSH_HARNESS_REBUILD=1 rebuilds anyway)',
      )
    })
    return
  }
  harnessInstall(frozen)
  harnessBuild()
  const revision = submoduleRevision(ROOT)
  mkdirSync(dirname(harnessBuildStatePath()), { recursive: true })
  writeFileSync(
    harnessBuildStatePath(),
    `${JSON.stringify({
      runtime: 'source',
      revision,
      version: submoduleVersion(ROOT),
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`,
  )
}

/** Version of the npm-installed CLI in `installDir`, or null. */
function installedHarnessVersion(installDir) {
  const manifestPath = join(installDir, 'node_modules', ...HARNESS_NPM_PACKAGE.split('/'), 'package.json')
  try {
    const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/**
 * Whether every installed `@deepseek-ai/dsh-*` package sits at `version`.
 *
 * The dsh family publishes as one release: the pinned runtime version appears in
 * `@deepseek-ai/dsh` and in every sibling package at the same version. An install
 * that mixed a new CLI with old family members (e.g. `pnpm add` reconciled an
 * existing lockfile against a bumped top-level package and left `dsh-sandbox` /
 * `dsh-attachment` on the previous release) fails at boot with import errors such
 * as `does not provide an export named ...`. `installedHarnessVersion` alone
 * cannot catch that — it only reads the top-level package — so the current check
 * treats a mixed tree as stale and reinstalls from a clean state.
 *
 * A missing install (no `node_modules`) is "consistent" by this predicate; the
 * caller combines it with `installedHarnessVersion` (null -> not current).
 * @param {string} installDir - absolute npm-mode install directory.
 * @param {string} version - the pinned runtime version.
 * @returns {boolean}
 */
function harnessFamilyConsistent(installDir, version) {
  const scope = join(installDir, 'node_modules', '@deepseek-ai')
  let entries
  try {
    entries = readdirSync(scope, { withFileTypes: true })
  } catch {
    return true
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-')) continue
    const manifestPath = join(scope, entry.name, 'package.json')
    try {
      const installed = JSON.parse(readFileSync(manifestPath, 'utf8')).version
      if (installed !== version) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Delete the npm runtime's `node_modules` and lockfile so the next `pnpm add`
 * resolves the whole tree from the registry instead of reconciling the previous
 * install. A version change can otherwise leave a mixed dsh family tree: `pnpm
 * add` reconciles an existing lockfile, and even a deleted lockfile is rebuilt
 * from the present `node_modules` state. The repo-local pnpm store
 * (`<repo>/.pnpm-store`) is shared, so a clean reinstall re-links most packages
 * and costs little.
 * @param {string} installDir - absolute npm-mode install directory.
 */
function cleanHarnessInstall(installDir) {
  for (const name of ['node_modules', 'pnpm-lock.yaml']) {
    rmSync(join(installDir, name), { recursive: true, force: true })
  }
}

/**
 * Remove profile-local fallback links that resolve into the source tree.
 *
 * `<profile>/.dsh-module-fallback/node_modules` holds one link per package the
 * launcher projected while the source runtime was active. The launcher re-heals
 * the directory at every boot, but a link into `deepseek-harness/` would
 * outlive a switch to the npm runtime and resolve to an unbuilt source package,
 * so those links are removed when the npm runtime is installed. Only links
 * whose target sits inside the submodule are touched, and the shared
 * `<DSH_HOME>/profiles/node_modules` fallback is left to the launcher.
 * @param {string} dshHome - the harness home whose web profile is pruned.
 * @returns {number} removed link count.
 */
function pruneSourceFallbackLinks(dshHome) {
  const root = join(dshHome, 'profiles', 'web', '.dsh-module-fallback', 'node_modules')
  if (!existsSync(root)) return 0
  const sourcePrefix = HARNESS + sep
  let removed = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidates = entry.name.startsWith('@')
      ? (() => {
          const scope = join(root, entry.name)
          try {
            return readdirSync(scope).map((name) => join(scope, name))
          } catch {
            return []
          }
        })()
      : [join(root, entry.name)]
    for (const candidate of candidates) {
      try {
        if (!lstatSync(candidate).isSymbolicLink()) continue
        const absolute = resolve(dirname(candidate), readlinkSync(candidate))
        if (!absolute.startsWith(sourcePrefix)) continue
        rmSync(candidate, { recursive: true, force: true })
        removed += 1
      } catch {
        // A link that cannot be read is left for the launcher to heal.
      }
    }
  }
  return removed
}

/** Install the pinned dsh CLI from the registry and prune source-era links. */
function harnessNpmRuntime(runtime, force) {
  const installed = installedHarnessVersion(runtime.installDir)
  // A top-level version match is not enough: the dsh family must all sit on the
  // pinned version, or the CLI boots into import errors from stale siblings.
  const current = installed === runtime.version && harnessFamilyConsistent(runtime.installDir, runtime.version)
  step(`Install ${HARNESS_NPM_PACKAGE}@${runtime.version} (npm runtime, repo-local store)`, () => {
    ensureHarnessProject(runtime.installDir, STORE)
    if (!force && current) {
      console.log(`already installed: ${HARNESS_NPM_PACKAGE}@${installed}`)
      return
    }
    // Reinstalling is always a clean reinstall: reconcile-only `pnpm add` can
    // keep a mixed dsh family tree across a version bump (top-level package
    // upgraded, siblings left on the previous release). Deleting node_modules +
    // lockfile forces pnpm to resolve the whole tree from the registry.
    cleanHarnessInstall(runtime.installDir)
    pnpm(['add', `${HARNESS_NPM_PACKAGE}@${runtime.version}`], {
      cwd: runtime.installDir,
      env: { CI: 'true' },
    })
  })
  const cli = requireHarnessRuntime(ROOT)
  const after = installedHarnessVersion(runtime.installDir)
  if (after !== runtime.version) {
    throw new Error(`expected ${HARNESS_NPM_PACKAGE}@${runtime.version} in ${runtime.installDir}, found ${after ?? 'nothing'}`)
  }
  // A still-mixed family after a fresh resolve means the registry/mirror served
  // an inconsistent tree (e.g. stale metadata for the new release) — fail the
  // build now with a clear message instead of a boot-time import error.
  if (!harnessFamilyConsistent(runtime.installDir, runtime.version)) {
    throw new Error(
      `${HARNESS_NPM_PACKAGE}@${runtime.version} installed, but some @deepseek-ai/dsh-* packages resolved to a different version in ${runtime.installDir}`
      + ' — the registry/mirror may be serving stale metadata for this release; retry later or check npm publish state',
    )
  }
  if (!force && current) return
  step('Prune source-runtime module fallback links', () => {
    const removed = pruneSourceFallbackLinks(process.env.DSH_HOME ?? WEB_HOME)
    console.log(removed === 0 ? 'no source-tree fallback links to remove' : `removed ${removed} source-tree fallback link(s)`)
  })
  // The desktop-shell update checker reads this registry to tell npm installs
  // apart from source ones, and to verify a new tag has an npm publish before
  // announcing it.
  recordNpmInstall(process.env.DSH_HOME ?? WEB_HOME, HARNESS_NPM_PACKAGE)
  console.log(`dsh runtime installed: ${cli.bin} (cwd ${cli.cwd})`)
}

/**
 * Bring the configured dsh runtime up to date.
 *
 * `harness.json` selects the runtime; both paths end with an installed CLI at
 * `resolveHarnessRuntime(ROOT).bin`, which the shell, the plugin installer, and
 * `scripts/harness.mjs` all resolve the same way.
 */
function harnessRuntime(options) {
  const runtime = resolveHarnessRuntime(ROOT)
  const force = options.forceHarness || process.env.DSH_HARNESS_REBUILD === '1'
  if (runtime.runtime === 'npm') harnessNpmRuntime(runtime, force)
  else harnessSourceRuntime(options.frozenHarness === true, force)
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
 * also write profile state beside their npm install. The CLI delegates the
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
 * (`install.mjs` plus the source it owns); the build delegates installation to
 * the preset's script, so a preset owns how it lands. Since harness
 * dsh-v0.1.7-rc.2 a preset is an `@deepseek-ai/dsh-agent-preset` declaration
 * row in the profile patch, not a `.dsh/.agent-presets/<id>/` directory (see
 * `presets/README.md`), and adding one never touches this CLI. Scripts run in
 * directory-name order for a deterministic install sequence.
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

/**
 * Install the global agent-config template into the harness home.
 *
 * `global_template.agents/` is the versioned source of the agent configuration
 * shared by every profile of this installation (the always-loaded docs and the
 * user-level skills). It lands in `<DSH_HOME>/.agents/`, which the harness
 * scans as its agents home once the desktop shell points `DSH_AGENTS_HOME`
 * there, so user-level skills reach every session and every workspace.
 *
 * The install only fills in files that are missing: an installed file that
 * already exists is never rewritten, so a user's edit to a global doc or skill
 * survives every later build. Update `global_template.agents/` for content
 * that should change.
 */
function installGlobalTemplate() {
  if (!existsSync(GLOBAL_AGENTS_TEMPLATE)) {
    console.log('No global_template.agents/ — skipping the global agent template.')
    return
  }
  const target = join(WEB_HOME, '.agents')
  let written = 0
  step('Install the global agent template into the harness home', () => {
    written = fillTreeFromTemplate(GLOBAL_AGENTS_TEMPLATE, target)
  })
  console.log(`Installed global_template.agents/ -> ${target} (${written} new file(s); existing files left untouched)`)
}

/**
 * Render the web profile's composition as a build-time smoke check.
 *
 * `--profile web --dump-config` loads every loader entry and the profile's
 * bundles, so it surfaces exactly the failures the shell would hit at boot —
 * missing plugins, duplicate loader entry ids, and import errors from a mixed
 * dsh family tree — while the build is still on the machine that can fix it.
 * The staging upgrade workspace runs the same command as its acceptance gate;
 * the working repo now fails the build on it instead of handing a broken
 * harness to the next launch.
 */
function smokeComposition() {
  if (!existsSync(join(WEB_HOME, 'profiles', 'web'))) {
    console.log('No web profile installed yet — skipping composition smoke check.')
    return
  }
  const cli = requireHarnessRuntime(ROOT)
  step(`Smoke-check the web profile composition (${cli.bin})`, () => {
    run('node', [cli.bin, '--profile', 'web', '--dump-config'], { env: { DSH_HOME: WEB_HOME } })
  })
  console.log('Composition smoke check passed.')
}

function setup(options) {
  bootstrapPnpm()
  harnessRuntime({ ...options, frozenHarness: true })
  if (!options.skipExe) buildExe(options.debug)
  plugins()
  installPresets()
  installGlobalTemplate()
  smokeComposition()
  console.log('\nDone. Entry exe at the repository root; dsh runtime, plugins, agent presets, and the global agent template installed.')
}

function build(options) {
  bootstrapPnpm()
  if (!options.skipHarness) harnessRuntime(options)
  if (!options.skipExe) buildExe(options.debug)
  plugins()
  installPresets()
  installGlobalTemplate()
  smokeComposition()
  console.log('\nDone. Entry exe at the repository root; dsh runtime, plugins, agent presets, and the global agent template installed.')
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
  setup       one-shot bootstrap: pinned pnpm -> dsh runtime (harness.json) ->
              entry exe (release unless --debug) -> plugins (each
              plugins/<id>/install.mjs) -> agent presets (each
              presets/<id>/install.mjs) -> global agent template
              (global_template.agents/ -> .dsh/.agents/)
  build       dsh runtime (unless --skip-harness) -> entry exe -> plugins
              (each plugins/<id>/install.mjs) -> agent presets ->
              global agent template
  install     run every plugins/*/install.mjs (alias: plugins)
  run         launch the entry exe detached; the terminal returns immediately
  shortcut    create a Windows desktop shortcut (Windows only)
  help        show this help

Runtime:
  harness.json selects the dsh runtime. "npm" installs @deepseek-ai/dsh@<version>
  into .harness/ from the registry and launches that CLI; "source" builds the
  deepseek-harness submodule and launches its built CLI. Environment overrides:
  DSH_HARNESS_RUNTIME, DSH_HARNESS_VERSION, DSH_HARNESS_INSTALL_DIR,
  DSH_HARNESS_BIN, DSH_HARNESS_REBUILD=1.

Flags:
  --debug          cargo debug build instead of release (release is default)
  --skip-harness   build: skip the dsh runtime install/build
  --skip-exe       skip the cargo build + exe copy (runtime/plugins only)
  --force-harness  clean-reinstall the dsh runtime even when it is current
                   (removes .harness/node_modules + lockfile, re-resolves
                   from the registry)

Build also smoke-checks the web profile composition (--profile web
--dump-config) after plugins install, so loader/bundle failures surface at
build time instead of at the next launch.

Examples:
  npm run setup
  npm run build -- --debug
  npm run build -- --skip-harness
  npm run build -- --skip-exe
  npm run build -- --force-harness
  npm run build:exe        (alias for build --skip-harness)
  npm run build:webui      (alias for build --skip-exe; runtime/plugins only, no desktop exe)
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
    forceHarness: flags.has('--force-harness'),
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
