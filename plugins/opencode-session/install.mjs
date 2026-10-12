#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the 'opencode-session' plugin.
 *
 * This plugin is in-tree: its package lives in the 'dsh-opencode-session/'
 * directory beside this script. The shared installer builds it with the pinned
 * toolchain pnpm (tsdown -> lib/index.js) and records it as a 'link:'
 * dependency of the selected profile. The package declares `dsh.bundle.patch`,
 * so `dsh plugin add` reconciles it into `dsh.profile.bundles` and its own
 * cordis.patch.yml insert row ('id: opencode-session', 'name:
 * dsh-opencode-session') mounts it as a bundle layer — no manual
 * cordis.patch.yml insert is written.
 *
 * Profile is selected by DSH_PLUGIN_PROFILE (default 'web'); the desktop build
 * re-runs this script with 'desktop'.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'opencode-session',
  packageDir: join(HERE, 'dsh-opencode-session'),
})