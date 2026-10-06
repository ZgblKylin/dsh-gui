#!/usr/bin/env node
/**
 * install.mjs — install the `auto-update` plugin into the *desktop* profile only.
 *
 * This plugin is in-tree: its package lives in `dsh-auto-update/` beside this
 * script. The whole feature is desktop-shell-only (the browser half attaches an
 * update button to the Windows caption area and drives it through
 * `window.dshDesktop`), so this wrapper deliberately does nothing for any other
 * profile: the ordinary `web` profile must keep exactly the composition it had
 * before this wrapper existed. `scripts/desktop.mjs` re-runs every wrapper with
 * `DSH_PLUGIN_PROFILE=desktop`; the plain `npm run install:plugins` /
 * `npm run build` path uses the default `web`.
 *
 * The package declares `dsh.bundle.patch`, so `dsh plugin add` reconciles it
 * into `dsh.profile.bundles` and its own cordis.patch.yml insert row
 * (`id: auto-update, name: dsh-auto-update`) mounts it as a bundle layer — no
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
  console.log(`\n==> skip plugin 'auto-update': desktop-only, profile '${profile}' is left untouched`)
} else {
  installPlugin({
    id: 'auto-update',
    packageDir: join(HERE, 'dsh-auto-update'),
  })
}
