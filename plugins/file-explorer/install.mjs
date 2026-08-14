#!/usr/bin/env node
/**
 * install.mjs — install and mount the `file-explorer` plugin into the web
 * profile.
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

installPlugin({
  id: 'file-explorer',
  packageDir: join(HERE, 'dsh-file-explorer'),
  sourceHint: 'git submodule update --init plugins/file-explorer/dsh-file-explorer',
})
