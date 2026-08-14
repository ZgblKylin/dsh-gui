#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the `terminal` plugin into the web
 * profile.
 *
 * The plugin source lives in the `dsh-terminal` git submodule checkout beside
 * this script. The shared installer builds it with the pinned toolchain pnpm
 * (esbuild -> lib/index.js + lib/client.js), records it as a `link:`
 * dependency of the web profile, and appends its loader entry
 * (`id: terminal, name: dsh-terminal`) to the profile's cordis.patch.yml.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh` by
 * the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same repo-local default.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the submodule checkout. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'terminal',
  packageDir: join(HERE, 'dsh-terminal'),
  sourceHint: 'git submodule update --init plugins/terminal/dsh-terminal',
})
