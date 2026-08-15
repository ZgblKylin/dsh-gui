#!/usr/bin/env node
/**
 * install.mjs — install and mount the `review` plugin into the web profile.
 *
 * The plugin source lives in the `dsh-review` package beside this script. It
 * ships prebuilt (`lib/index.js`, plain ESM with no build step), so the shared
 * installer skips pnpm install + build for it and links the package directory
 * as-is into `.dsh/profiles/web/`.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh` by
 * the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same repo-local default.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's wrapper directory — owns the in-tree plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'review',
  packageDir: join(HERE, 'dsh-review'),
})
