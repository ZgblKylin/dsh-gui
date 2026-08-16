#!/usr/bin/env node
/**
 * install.mjs — install and mount the `file-explorer` plugin into the web
 * profile.
 *
 * ⛔ TEMPORARILY MASKED: the dsh-better-sidebar plugin supersedes this file
 * tree/preview panel (per-session explorer + viewer registry). The guard
 * below skips the whole install pipeline — no profile dependency, no bundle
 * mount — until it is removed. See also
 * .dsh/profiles/web/package.json (the dependency and bundle entry were
 * removed there).
 *
 * The plugin source lives in the `dsh-file-explorer` git submodule checkout
 * beside this script. It ships prebuilt (`lib/`) and declares
 * `dsh.bundle.patch`, so the shared installer skips its build and skips the
 * manual cordis.patch.yml insert: `dsh plugin add` reconciles it into the
 * profile's `dsh.profile.bundles`, and its own bundle patch layer mounts the
 * entry.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh` by
 * the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same repo-local default.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the submodule checkout. */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Temporarily masked by dsh-better-sidebar. Set to false to re-enable this
 * plugin (then re-run `node plugins/file-explorer/install.mjs` and restart).
 */
const MASKED = true
if (MASKED) {
  console.log('[file-explorer] install skipped — temporarily masked by dsh-better-sidebar')
} else {
  installPlugin({
    id: 'file-explorer',
    packageDir: join(HERE, 'dsh-file-explorer'),
    sourceHint: 'git submodule update --init plugins/file-explorer/dsh-file-explorer',
  })
}
