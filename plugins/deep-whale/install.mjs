#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the `deep-whale` skin series into
 * the web profile.
 *
 * The upstream distribution repo lives in the `dsh-deep-whale` git submodule
 * checkout beside this script; the actual plugin package is the `maid-atelier`
 * skin directory inside it. The package is a distribution build (prebuilt
 * `lib/`; upstream builds it in the dsh-web-ui scaffolding repo), so this
 * wrapper opts out of the shared build pipeline even though the manifest
 * declares a `build` script. It also declares `dsh.bundle.patch`, so the
 * shared installer reconciles it into the profile's `dsh.profile.bundles` and
 * its own bundle patch layer mounts the entry (`id: ui-skin-maid-atelier`) —
 * no manual cordis.patch.yml insert is added (that would double-mount it).
 *
 * UPSTREAM IS NEVER MODIFIED: the wrapper first copies the pristine package
 * checkout to `$DSH_HOME/plugins/deep-whale/maid-atelier`, then
 * `patch-sidebar-qa.mjs` applies dsh-gui's sidebar-qa layout patch to that
 * copy's prebuilt `lib/client.js` (palace backdrop + characters + trims stay
 * inside the conversation area when better-sidebar's right/bottom panels are
 * open). The patched copy is what gets linked into the web profile. Re-installs
 * replace the copy, so the patch is idempotent and stale files cannot survive.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh` by
 * the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same repo-local default.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'
import { WEB_HOME } from '../../scripts/toolchain.mjs'
import { applyMaidAtelierSidebarQaPatch } from './patch-sidebar-qa.mjs'

/** This plugin's directory — the wrapper that owns the submodule checkout. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** The pristine submodule package. */
const SOURCE = join(HERE, 'dsh-deep-whale', 'maid-atelier')
/** Required before the copy+patch step can run. */
const REQUIRED_FILES = ['package.json', 'cordis.patch.yml', join('lib', 'client.js')]

if (REQUIRED_FILES.some((file) => !existsSync(join(SOURCE, file)))) {
  throw new Error(
    `deep-whale: plugin package not found at ${SOURCE} — initialize it with: `
    + 'git submodule update --init plugins/deep-whale/dsh-deep-whale',
  )
}

/** The patched install artifact, under the same DSH_HOME the installer uses. */
const dshHome = process.env.DSH_HOME ?? WEB_HOME
const TARGET = join(dshHome, 'plugins', 'deep-whale', 'maid-atelier')

rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })
cpSync(SOURCE, TARGET, {
  recursive: true,
  filter: (src) => !src.includes(`${process.platform === 'win32' ? '\\' : '/'}node_modules`),
})

const patched = applyMaidAtelierSidebarQaPatch(TARGET)
console.log(`  sidebar-qa patch applied: ${patched.join(', ')}`)

installPlugin({
  id: 'deep-whale',
  packageDir: TARGET,
  build: false,
})
