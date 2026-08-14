#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the `remote` plugin into the web
 * profile.
 *
 * This plugin is in-tree: its package lives in the `dsh-remote/` directory
 * beside this script. The shared installer builds it with the pinned toolchain
 * pnpm (esbuild -> lib/index.js + lib/client.js), records it as a `link:`
 * dependency of the web profile, and appends its loader entry
 * (`id: remote, name: dsh-remote`) to the profile's cordis.patch.yml.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh` by
 * the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same repo-local default.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'remote',
  packageDir: join(HERE, 'dsh-remote'),
})
