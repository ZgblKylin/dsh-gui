#!/usr/bin/env node
/**
 * install.mjs — install three dsh-web-ui artifacts into the repo-local DSH home:
 *
 * 1. the `liangshen` agent preset from
 *    `dsh-web-ui/packages/dsh-liangshen/presets/liangshen`, with dsh-gui's
 *    Windows patch applied to the installed copy only;
 * 2. the `dsh-pet` bundle from `dsh-web-ui/packages/dsh-pet`;
 * 3. the `dsh-web-ui-settings` bundle from
 *    `dsh-web-ui/packages/dsh-web-ui-settings`.
 *
 * dsh-pet registers the `pet` settings namespace; dsh-host-apiproxy's
 * WEB_SETTINGS_NAMESPACES does not expose third-party namespaces, so without
 * dsh-web-ui-settings the pet's configuration card can only render its
 * "namespace not exposed" explanation. The settings bundle is therefore
 * installed and ordered before dsh-pet, matching the upstream
 * `dsh-web-ui-all/aggregate.yml` convention: dsh-pet reads `webUiSettings`
 * once during activation, so the compatibility binder must already be present.
 * Both bundles declare their own dsh.bundle.patch, so the shared plugin
 * installer reconciles them into the profile without writing manual cordis
 * mounts.
 *
 * No other dsh-web-ui package (task-board, skins, community-plugins, ...) is
 * installed here. The dsh-liangshen host plugin is also intentionally NOT
 * installed: the preset alone is enough for the harness roster.
 *
 * UPSTREAM IS NEVER MODIFIED: after the pristine preset copy,
 * `patch-liangshen.mjs` applies dsh-gui's Windows patch to the INSTALLED copy
 * only — it adds `custom-bash.mjs` (vendored from
 * xiaobright/dsh-anchored-standard, MIT) and switches the phase-1 `bash` to it
 * on win32 (DSH's PTY backend is linux/darwin-only), so the cold-start
 * bootstrap does not fall into the degraded fallback. See
 * plugins/dsh-web-ui/README.md.
 *
 * The preset target is replaced and re-copied on every run, so re-installs are
 * idempotent and stale files cannot survive a source change; the patch step
 * re-applies on the fresh copy and is itself a no-op on already-patched
 * output. The bundle packages are built and linked through the shared plugin
 * installer, which is idempotent as well.
 *
 * Targets: `$DSH_HOME/.agent-presets/liangshen` and the `web` profile.
 * `DSH_HOME` is pinned to `<repo>/.dsh` by the desktop shell; this script
 * honors an explicit `DSH_HOME` override (the build passes one) and otherwise
 * pins the same repo-local default.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'
import { bootstrapPnpm, pnpm, STORE } from '../../scripts/toolchain.mjs'
import { applyLiangshenWindowsPatch } from './patch-liangshen.mjs'

/** This wrapper directory: plugins/dsh-web-ui/. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** Repository root: plugins/dsh-web-ui/install.mjs -> <repo>/. */
const ROOT = resolve(HERE, '..', '..')
/** The preset id; also the directory name it installs under. */
const PRESET_ID = 'liangshen'
/** The dsh-web-ui submodule checkout the installed artifacts come from. */
const REPO_DIR = join(HERE, 'dsh-web-ui')
const SOURCE = join(REPO_DIR, 'packages', 'dsh-liangshen', 'presets', PRESET_ID)

/** The dsh-web-ui family bundles installed beside the preset. */
const SETTINGS_PACKAGE_NAME = '@linxin666/dsh-client-ui-web-ui-settings'
const SETTINGS_PACKAGE_DIR = join(REPO_DIR, 'packages', 'dsh-web-ui-settings')
const PET_PACKAGE_NAME = '@linxin666/dsh-pet'
const PET_PACKAGE_DIR = join(REPO_DIR, 'packages', 'dsh-pet')

/** Bundle packages in profile install order: settings bridge before pet. */
const BUNDLE_PACKAGES = [
  { id: 'dsh-web-ui-settings', name: SETTINGS_PACKAGE_NAME, dir: SETTINGS_PACKAGE_DIR },
  { id: 'dsh-pet', name: PET_PACKAGE_NAME, dir: PET_PACKAGE_DIR },
]

/** Files the preset needs to stay mountable after the copy. */
const REQUIRED_FILES = ['agent.cordis.yml', 'tool-bootstrap.mjs']

for (const file of REQUIRED_FILES) {
  if (!existsSync(join(SOURCE, file))) {
    throw new Error(
      `${PRESET_ID}: preset source not found at ${join(SOURCE, file)} — `
      + 'initialize it with: git submodule update --init plugins/dsh-web-ui/dsh-web-ui',
    )
  }
}

const dshHome = process.env.DSH_HOME ?? join(ROOT, '.dsh')
const target = join(dshHome, '.agent-presets', PRESET_ID)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(SOURCE, target, { recursive: true })

const patched = applyLiangshenWindowsPatch(target)
console.log(`installed agent preset '${PRESET_ID}' (${SOURCE}) -> ${target}`)
console.log(`  patched: ${patched.join(', ')}`)

/**
 * Build the family bundles in the upstream workspace, filtering the install to
 * these packages so the wrapper does not pull the whole dsh-web-ui monorepo.
 * Each package's own `prepare` runs during install. The install uses
 * --frozen-lockfile so the upstream pnpm-lock.yaml is never rewritten; the
 * explicit build below guarantees lib/ for packages where `prepare` did not
 * already produce it, and disables pnpm's verify-deps-before-run full-workspace
 * reinstall because the filtered install above already provisioned the deps.
 */
function buildBundlePackages() {
  for (const pkg of BUNDLE_PACKAGES) {
    if (!existsSync(join(pkg.dir, 'package.json'))) {
      throw new Error(
        `${pkg.name}: package not found at ${pkg.dir} — `
        + 'initialize it with: git submodule update --init plugins/dsh-web-ui/dsh-web-ui',
      )
    }
  }
  bootstrapPnpm()
  console.log(`\n==> build dsh-web-ui bundles (${REPO_DIR})`)
  const filters = BUNDLE_PACKAGES.flatMap(pkg => ['--filter', `${pkg.name}...`])
  pnpm(['install', ...filters, '--store-dir', STORE, '--frozen-lockfile'], {
    cwd: REPO_DIR,
    env: { CI: 'true' },
  })
  for (const pkg of BUNDLE_PACKAGES) {
    console.log(`  build ${pkg.name}`)
    pnpm(['--filter', pkg.name, 'run', 'build'], {
      cwd: REPO_DIR,
      env: { CI: 'true', pnpm_config_verify_deps_before_run: 'false' },
    })
  }
}

/**
 * Keep the settings bridge bundle before dsh-pet in the profile manifest when
 * both are installed. dsh-pet reads `webUiSettings` once during activation, so
 * appending the bridge behind an existing pet row can leave the pet bound to
 * the official (unexposed) settings scope until the next reorder.
 * @param {string} profileDir - absolute path of the web profile directory.
 */
function ensureBridgeBeforePet(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  let changed = false

  const dependencies = manifest.dependencies
  const depNames = dependencies === undefined ? [] : Object.keys(dependencies)
  const bridgeDepIndex = depNames.indexOf(SETTINGS_PACKAGE_NAME)
  const petDepIndex = depNames.indexOf(PET_PACKAGE_NAME)
  if (bridgeDepIndex >= 0 && petDepIndex >= 0 && bridgeDepIndex > petDepIndex) {
    const bridgeSpec = dependencies[SETTINGS_PACKAGE_NAME]
    delete dependencies[SETTINGS_PACKAGE_NAME]
    const ordered = {}
    for (const [name, spec] of Object.entries(dependencies)) {
      if (name === PET_PACKAGE_NAME) ordered[SETTINGS_PACKAGE_NAME] = bridgeSpec
      ordered[name] = spec
    }
    manifest.dependencies = ordered
    changed = true
  }

  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    const bridgeIndex = bundles.indexOf(SETTINGS_PACKAGE_NAME)
    const petIndex = bundles.indexOf(PET_PACKAGE_NAME)
    if (bridgeIndex >= 0 && petIndex >= 0 && bridgeIndex > petIndex) {
      bundles.splice(bridgeIndex, 1)
      bundles.splice(bundles.indexOf(PET_PACKAGE_NAME), 0, SETTINGS_PACKAGE_NAME)
      changed = true
    }
  }

  if (changed) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    console.log(`  ordered ${SETTINGS_PACKAGE_NAME} before ${PET_PACKAGE_NAME}`)
  }
}

buildBundlePackages()
for (const pkg of BUNDLE_PACKAGES) {
  installPlugin({
    id: pkg.id,
    packageDir: pkg.dir,
    sourceHint: 'git submodule update --init plugins/dsh-web-ui/dsh-web-ui',
    build: false,
  })
}
ensureBridgeBeforePet(join(dshHome, 'profiles', 'web'))
