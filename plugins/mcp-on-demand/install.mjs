#!/usr/bin/env node
/**
 * install.mjs — install the `dsh-mcp-on-demand` plugin into the selected profile.
 *
 * In-tree package (`dsh-mcp-on-demand/` beside this script), no build step: the
 * package is plain ESM with zero runtime dependencies. The wrapper only hands
 * it to the shared install pipeline (`scripts/plugin-install.mjs`), which runs
 * `dsh plugin --profile <profile> add link:<package dir>` and lets the
 * package's own `dsh.bundle.patch` reconcile it into `dsh.profile.bundles` —
 * its bundle layer inserts the `mcp-on-demand` entry itself, so no manual
 * `cordis.patch.yml` insert is written here.
 *
 * `DSH_PLUGIN_PROFILE` selects the profile (default `web`); the desktop build
 * (`scripts/desktop.mjs`) re-runs every wrapper with `DSH_PLUGIN_PROFILE=desktop`.
 * `DSH_HOME` is pinned to `<runtime-root>/.dsh` by the desktop build and an
 * explicit override is honored exactly like the shared pipeline does.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'mcp-on-demand',
  packageDir: join(HERE, 'dsh-mcp-on-demand'),
})
