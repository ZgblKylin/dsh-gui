#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the 'ai-update' plugin into the
 * web profile.
 *
 * This plugin is in-tree: its package lives in the 'dsh-ai-update/' directory
 * beside this script. The shared installer builds it with the pinned toolchain
 * pnpm (esbuild -> lib/index.js + lib/client.js) and records it as a 'link:'
 * dependency of the web profile. The package declares `dsh.bundle.patch`, so
 * `dsh plugin add` reconciles it into `dsh.profile.bundles` and its own
 * cordis.patch.yml insert row ('id: ai-update', 'name: dsh-ai-update') mounts
 * it as a bundle layer — no manual cordis.patch.yml insert is written.
 *
 * Target: $DSH_HOME/profiles/web/. DSH_HOME is pinned to <repo>/.dsh by
 * the desktop shell; this script honors an explicit DSH_HOME override (the
 * build passes one) and otherwise pins the same repo-local default.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'ai-update',
  packageDir: join(HERE, 'dsh-ai-update'),
})
