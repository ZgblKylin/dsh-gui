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

import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'
import { ROOT, WEB_HOME } from '../../scripts/toolchain.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'desktop-tabs',
  packageDir: join(HERE, 'dsh-desktop-tabs'),
})

// ds-harness-remote's dist imports @deepseek-ai/dsh-client-connection, but the
// profile installer does not hoist that optional peer. Link the runtime copy so
// the parent plugin (and every generated remote-tab child profile) can load it
// before the child-profile generator runs.
ensureDsHarnessRemotePeer(
  process.env.DSH_HOME ?? WEB_HOME,
  (process.env.DSH_PLUGIN_PROFILE ?? 'web').trim() || 'web',
)

/**
 * Link the runtime's @deepseek-ai/dsh-client-connection into one profile.
 * @param {string} dshHome - harness home holding the profiles.
 * @param {string} profile - profile name inside `dshHome/profiles`.
 */
function ensureDsHarnessRemotePeer(dshHome, profile) {
  const profileDir = join(dshHome, 'profiles', profile)
  const target = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-client-connection')
  if (existsSync(target)) return
  const runtimeRoot = dirname(dshHome)
  const source = [
    join(runtimeRoot, '.harness', 'node_modules', '@deepseek-ai', 'dsh-client-connection'),
    join(runtimeRoot, '.desktop', 'source', 'node_modules', '@deepseek-ai', 'dsh-client-connection'),
    join(ROOT, 'deepseek-harness', 'node_modules', '@deepseek-ai', 'dsh-client-connection'),
  ].find((candidate) => existsSync(candidate))
  if (source === undefined) {
    console.warn('  @deepseek-ai/dsh-client-connection is unavailable in the runtime and source trees; ds-harness-remote may fail to load until it is linked manually')
    return
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    console.log(`  linked @deepseek-ai/dsh-client-connection into ${profileDir}`)
  } catch (error) {
    console.warn(`  could not link @deepseek-ai/dsh-client-connection into ${profileDir}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
