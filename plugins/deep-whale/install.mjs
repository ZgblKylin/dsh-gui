#!/usr/bin/env node
/**
 * install.mjs — install and mount the `deep-whale` skin series into
 * the web profile (免编译源码安装, per plugins/README.md's 安装方式 section).
 *
 * The upstream distribution repo lives in the `dsh-deep-whale` git submodule
 * checkout beside this script; the actual plugin package is the `maid-atelier`
 * skin directory inside it. The checkout ships prebuilt `lib/` committed in
 * the repo (the manifest also declares a `build` script for upstream
 * development), so this wrapper NEVER compiles: it opts out of the shared
 * build pipeline (`build: false`) and has the shared installer link the
 * prebuilt package as shipped. It declares `dsh.bundle.patch`, so
 * `dsh plugin add` reconciles it into the profile's `dsh.profile.bundles` and
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
