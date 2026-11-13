#!/usr/bin/env node
/**
 * install.mjs — install the `remote-tab-boot` bootstrap plugin into the
 * *desktop* profile only.
 *
 * This plugin is in-tree: its package lives in `dsh-remote-tab-boot/` beside
 * this script. It is not part of the app's own composition. The desktop app
 * generates one `remote-tab` child profile per saved remote connection and
 * starts an isolated `dsh web` for it; that child profile lists
 * `dsh-remote-tab-boot` in `dsh.profile.bundles` and resolves it through a
 * `node_modules` junction to the desktop profile's `node_modules`. The package
 * is therefore installed into the desktop profile only — in any other profile
 * its `apply` is an inert no-op (no `DSH_REMOTE_TAB_TARGET`), so installing it
 * there would only add a permanently inactive entry.
 *
 * `scripts/desktop.mjs` re-runs every wrapper with `DSH_PLUGIN_PROFILE=desktop`;
 * the plain `npm run install:plugins` / `npm run build` path uses the default
 * `web`. The package declares `dsh.bundle.patch`, so `dsh plugin add`
 * reconciles it into `dsh.profile.bundles` and its own cordis.patch.yml insert
 * row (`id: remote-tab-boot, name: dsh-remote-tab-boot`) mounts it as a bundle
 * layer — no manual cordis.patch.yml insert is written.
 *
 * Target: `$DSH_HOME/profiles/desktop`. `DSH_HOME` is passed in by the desktop
 * build; this script honors an explicit override exactly like the shared
 * pipeline does.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Profile the shared pipeline resolved; mirrors its own default. */
const profile = (process.env.DSH_PLUGIN_PROFILE ?? 'web').trim() || 'web'

if (profile !== 'desktop') {
  console.log(`\n==> skip plugin 'remote-tab-boot': desktop-only (the remote-tab child profile lists it), profile '${profile}' is left untouched`)
} else {
  installPlugin({
    id: 'remote-tab-boot',
    packageDir: join(HERE, 'dsh-remote-tab-boot'),
  })
}
