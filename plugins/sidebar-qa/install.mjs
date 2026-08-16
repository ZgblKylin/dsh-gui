#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the `sidebar-qa` plugin into the
 * web profile.
 *
 * The plugin source lives in the `dsh-sidebar-qa` git submodule checkout
 * beside this script (upstream: https://github.com/ChenRuoT/dsh-sidebar-qa).
 * It is a thin consumer of dsh-better-sidebar (select conversation text →
 * right-panel follow-up session in the same workspace): the client half
 * declares `inject = ['betterSidebar', ...]`, so it stays inactive until
 * better-sidebar is installed.
 *
 * The shared installer builds it with the pinned toolchain pnpm (tsc + tsdown
 * -> lib/index.js host half + lib/client.js / lib/client-registry.js browser
 * half), records it as a `link:` dependency of the web profile, and —
 * because the package declares `dsh.bundle.patch` — lets `dsh plugin add`
 * reconcile it into `dsh.profile.bundles` (its own cordis.patch.yml inserts
 * entry id 'sidebar-qa'; no manual insert is written, which would
 * double-mount it).
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
  id: 'sidebar-qa',
  packageDir: join(HERE, 'dsh-sidebar-qa'),
  sourceHint: 'git submodule update --init plugins/sidebar-qa/dsh-sidebar-qa',
})
