/**
 * In-tree wrapper for the Quick Assistant plugin (`dsh-quick-assistant`).
 *
 * Source: this repository, built in place (tsdown) and installed as a `link:`
 * dependency, so edits under `dsh-quick-assistant/` reach the next boot without
 * reinstalling.
 *
 * Mount target by profile — the feature is desktop-only, so a plain browser page
 * must never compose it:
 * - `desktop` (the Electron desktop app owns this profile): mounted in the
 *   profile patch like every other plugin;
 * - any other profile (the `web` profile the Tauri shell and a browser page
 *   share): the dependency is installed but the loader row goes to
 *   `<DSH_HOME>/gui/shell-overlays/quick-assistant.patch.yml`. The desktop
 *   shell applies that file as an extra `--patch` layer when it spawns
 *   `dsh web`, so the plugin exists only inside the shell and a plain
 *   `dsh web` page stays clean.
 *
 * The native overlay host (`dsh-quick-assistant.exe`, built from `src-tauri`)
 * is produced by `npm run build` / `npm run build:desktop`, not by this script.
 * `DSH_HOME` stays pinned to the runtime root's `.dsh`.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin, shellOverlayPatchPath } from '../../scripts/plugin-install.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const profile = (process.env.DSH_PLUGIN_PROFILE ?? 'web').trim() || 'web'

const options = {
  id: 'quick-assistant',
  packageDir: join(here, 'dsh-quick-assistant'),
}

if (profile === 'desktop') {
  installPlugin(options)
} else {
  installPlugin({ ...options, mountFile: shellOverlayPatchPath('quick-assistant') })
}
