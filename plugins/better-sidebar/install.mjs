#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the `better-sidebar` plugin into
 * the web profile.
 *
 * The plugin source lives in the `DSH-better-sidebar` git submodule checkout
 * beside this script (upstream: https://github.com/omdsh-dev/DSH-better-sidebar).
 * The shared installer builds it with the pinned toolchain pnpm (tsc + tsdown
 * -> lib/index.js host half + lib/client.js / lib/client-terminal.js /
 * lib/client-editor.js lazy chunks), records it as a `link:` dependency of
 * the web profile, and — because the package declares `dsh.bundle.patch` —
 * lets `dsh plugin add` reconcile it into `dsh.profile.bundles` (its own
 * cordis.patch.yml bundle layer inserts the entry; no manual insert is
 * written, which would double-mount it).
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override
 * (the build passes one) and otherwise pins the same repo-local default.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the submodule checkout. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'better-sidebar',
  packageDir: join(HERE, 'DSH-better-sidebar'),
  sourceHint: 'git submodule update --init plugins/better-sidebar/DSH-better-sidebar',
})
