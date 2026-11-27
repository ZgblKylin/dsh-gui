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
 *
 * `ds-harness-remote` imports `@deepseek-ai/dsh-client-connection` dynamically.
 * No profile-local copy is linked for it: profile boot computes a runtime
 * resolution whose installation scope answers that name from the dsh
 * installation itself (`createRuntimeResolution` in `@deepseek-ai/dsh-app-boot`,
 * 0.2.3-alpha.2), so the import resolves without the profile installing the
 * package. A hand-made junction would instead point into
 * `<runtime-root>/.harness/node_modules`, which every harness reinstall deletes.
 *
 * Profiles installed by an earlier revision still carry that junction. It is
 * removed here before the package operation, so a harness reinstall cannot leave
 * a dangling entry that the required `connection` plugin fails to import.
 */

import { lstatSync, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'
import { removeLink } from '../../scripts/remove-tree.mjs'
import { WEB_HOME } from '../../scripts/toolchain.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

dropObsoletePeerLink(
  process.env.DSH_HOME ?? WEB_HOME,
  (process.env.DSH_PLUGIN_PROFILE ?? 'web').trim() || 'web',
)

installPlugin({
  id: 'desktop-tabs',
  packageDir: join(HERE, 'dsh-desktop-tabs'),
})

/**
 * Remove the peer junction an earlier revision of this wrapper created.
 *
 * Only a link whose target sits inside the runtime root's `.harness` or
 * `.desktop/source` tree is removed: a real installation at that path, or a
 * link to any other location, is left alone. The link is dropped without
 * visiting its target, so a stale or live `.harness` copy is never modified.
 * @param {string} dshHome - harness home holding the profiles.
 * @param {string} profile - profile name inside `dshHome/profiles`.
 */
function dropObsoletePeerLink(dshHome, profile) {
  const profileDir = join(dshHome, 'profiles', profile)
  const link = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-client-connection')
  const stats = lstatSync(link, { throwIfNoEntry: false })
  if (stats === undefined) return
  if (!stats.isSymbolicLink()) return
  let raw
  try {
    raw = readlinkSync(link)
  } catch (error) {
    console.warn(`  could not read the obsolete peer link at ${link}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const target = raw.startsWith('\\\\?\\') ? raw.slice(4) : raw
  const resolved = isAbsolute(target) ? target : resolve(dirname(link), target)
  const runtimeRoot = dirname(dshHome)
  const owned = [join(runtimeRoot, '.harness'), join(runtimeRoot, '.desktop', 'source')]
    .some((root) => resolved.toLowerCase().startsWith(root.toLowerCase() + sep))
  if (!owned) return
  try {
    removeLink(link)
    console.log(`  removed the obsolete @deepseek-ai/dsh-client-connection link from ${profileDir}`)
  } catch (error) {
    console.warn(`  could not remove the obsolete peer link at ${link}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
