#!/usr/bin/env node
/**
 * install.mjs — install the `desktop-tabs` plugin into the selected profile.
 *
 * This plugin is in-tree: its package lives in `dsh-desktop-tabs/` beside this
 * script. Both profiles get it, because the two shells split the plugin
 * differently:
 *
 * - **host half (every profile)** — `src/index.ts` and `src/remote/**` are the
 *   single remote-connection backend. They register `/desktop-tabs/api/*` on the
 *   harness web server (loopback bind only, same-origin fence) and answer it from
 *   `<DSH_HOME>/gui/desktop-tabs.json`; the Tauri shell (`web` profile) drives
 *   those routes through its Rust bridge, so it must never be a desktop-only
 *   install.
 * - **browser half (desktop shell only in practice)** — `src/client/index.ts`
 *   mounts the caption-band tab strip only when the desktop shell publishes
 *   `window.dshDesktop.browser`. In an ordinary `dsh web` page the half returns
 *   immediately, so the `web` profile composition gains the routes and no UI.
 *
 * `scripts/desktop.mjs` re-runs every wrapper with `DSH_PLUGIN_PROFILE=desktop`;
 * the plain `npm run install:plugins` / `npm run build` path uses the default
 * `web`. The package declares `dsh.bundle.patch`, so `dsh plugin add` reconciles
 * it into `dsh.profile.bundles` and its own cordis.patch.yml insert row
 * (`id: desktop-tabs, name: dsh-desktop-tabs`) mounts it as a bundle layer — no
 * manual cordis.patch.yml insert is written, in either profile.
 *
 * Target: `$DSH_HOME/profiles/<profile>`. `DSH_HOME` is pinned to
 * `<runtime-root>/.dsh` by the shells; this script honors an explicit override
 * exactly like the shared pipeline does.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'desktop-tabs',
  packageDir: join(HERE, 'dsh-desktop-tabs'),
})
