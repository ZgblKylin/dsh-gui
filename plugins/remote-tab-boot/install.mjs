#!/usr/bin/env node
/**
 * install.mjs — install the `remote-tab-boot` bootstrap plugin into the current
 * profile.
 *
 * This plugin is in-tree: its package lives in `dsh-remote-tab-boot/` beside
 * this script. It is not part of the app's own composition. A host that opens a
 * remote tab generates one `remote-tab` child profile per saved connection and
 * starts an isolated `dsh` for it; that child profile lists
 * `dsh-remote-tab-boot` in `dsh.profile.bundles` and resolves it through a
 * `node_modules` junction to the hosting profile, so the package must be
 * installed wherever the remote-tab feature is used. Its `apply` is an inert
 * no-op without `DSH_REMOTE_TAB_TARGET`, so installing it in a profile that
 * never opens a remote tab costs one inactive loader entry and nothing else.
 *
 * The package declares `dsh.bundle.patch`, so the managed installer reconciles
 * it into `dsh.profile.bundles` and its own `cordis.patch.yml` insert row
 * (`id: remote-tab-boot, name: dsh-remote-tab-boot`) mounts it as a bundle
 * layer — no manual patch insert is written.
 *
 * Target: the profile the shared pipeline selected (`DSH_PLUGIN_PROFILE`,
 * defaulting to `web`); `DSH_HOME` is passed in by the build and honored by the
 * shared installer.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'remote-tab-boot',
  packageDir: join(HERE, 'dsh-remote-tab-boot'),
})
