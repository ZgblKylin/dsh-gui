#!/usr/bin/env node
/**
 * install.mjs — install the `desktop-tabs` plugin into the *desktop* profile only.
 *
 * This plugin is in-tree: its package lives in `dsh-desktop-tabs/` beside this
 * script. The prototype is desktop-shell-only (the browser half anchors a tab
 * strip to the Windows caption menu and mounts one leased `<webview>` per remote
 * tab through `window.dshDesktop.browser`), so this wrapper deliberately does
 * nothing for any other profile: the ordinary `web` profile must keep exactly
 * the composition it had before this wrapper existed. `scripts/desktop.mjs`
 * re-runs every wrapper with `DSH_PLUGIN_PROFILE=desktop`; the plain
 * `npm run install:plugins` / `npm run build` path uses the default `web`.
 *
 * The package declares `dsh.bundle.patch`, so `dsh plugin add` reconciles it
 * into `dsh.profile.bundles` and its own cordis.patch.yml insert row
 * (`id: desktop-tabs, name: dsh-desktop-tabs`) mounts it as a bundle layer — no
 * manual cordis.patch.yml insert is written.
 *
 * Target: `$DSH_HOME/profiles/desktop`. `DSH_HOME` is pinned to
 * `<runtime-root>/.dsh` by the desktop build; this script honors an explicit
 * override exactly like the shared pipeline does.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Profile the shared pipeline resolved; mirrors its own default. */
const profile = (process.env.DSH_PLUGIN_PROFILE ?? 'web').trim() || 'web'

if (profile !== 'desktop') {
  console.log(`\n==> skip plugin 'desktop-tabs': desktop-only, profile '${profile}' is left untouched`)
} else {
  installPlugin({
    id: 'desktop-tabs',
    packageDir: join(HERE, 'dsh-desktop-tabs'),
  })
}
