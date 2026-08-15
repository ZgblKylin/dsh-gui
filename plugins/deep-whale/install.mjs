#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the `deep-whale` skin series into
 * the web profile.
 *
 * The upstream distribution repo lives in the `dsh-deep-whale` git submodule
 * checkout beside this script; the actual plugin package is the `maid-atelier`
 * skin directory inside it. The package is a distribution build (prebuilt
 * `lib/`; upstream builds it in the dsh-web-ui scaffolding repo), so this
 * wrapper opts out of the shared build pipeline even though the manifest
 * declares a `build` script. It also declares `dsh.bundle.patch`, so the
 * shared installer reconciles it into the profile's `dsh.profile.bundles` and
 * its own bundle patch layer mounts the entry (`id: ui-skin-maid-atelier`) —
 * no manual cordis.patch.yml insert is added (that would double-mount it).
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
  id: 'deep-whale',
  packageDir: join(HERE, 'dsh-deep-whale', 'maid-atelier'),
  sourceHint: 'git submodule update --init plugins/deep-whale/dsh-deep-whale',
  build: false,
})
