/**
 * auto-review-model installer: installs the in-tree `dsh-auto-review-model`
 * package into the selected profile.
 *
 * Source — in-tree package (`auto-review-model/` beside this script), no build
 * step: the package is plain ESM with zero runtime dependencies, so the shared
 * pipeline uses it as shipped. The package declares `dsh.bundle.patch`, so
 * `dsh plugin add` reconciles it into `dsh.profile.bundles` and its own bundle
 * layer inserts the `auto-review-model` entry — this wrapper writes no manual
 * `cordis.patch.yml` insert.
 *
 * `DSH_PLUGIN_PROFILE` selects the profile (default `web`); the desktop build
 * (`scripts/desktop.mjs`) re-runs every wrapper with `DSH_PLUGIN_PROFILE=desktop`.
 * `DSH_HOME` is pinned to `<runtime-root>/.dsh` by the desktop build, and an
 * explicit override is honored exactly like the shared pipeline does.
 *
 * The plugin depends on harness internals (the `auto-review` request purpose,
 * the `llm/stream` waterfall short-circuit, provider resolution after that
 * waterfall). A harness upgrade must re-check them against the checklist in the
 * package README (`auto-review-model/README.md`, section "Harness 升级检查清单").
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The desktop profile is reserved for the Electron application's own CLI. The
 * shared pipeline only uses that CLI when a carrier is supplied (as
 * `build:desktop` does); without one it would write this repository's pnpm
 * `storeDir` into the profile and then fail, so refuse before it starts.
 */
const profile = (process.env.DSH_PLUGIN_PROFILE ?? 'web').trim() || 'web'
const carrier = (process.env.DSH_PLUGIN_DSH_CLI ?? '').trim() || null
if (profile === 'desktop' && carrier === null) {
  throw new Error(
    'auto-review-model: the desktop profile is owned by the Electron app. '
    + 'Fully quit DeepSeek Harness, then install with its own CLI: '
    + '"<app>/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop '
    + `add link:${join(HERE, 'auto-review-model')}. `
    + '"npm run build:desktop" uses that same channel.',
  )
}

installPlugin({
  id: 'auto-review-model',
  packageDir: join(HERE, 'auto-review-model'),
})
