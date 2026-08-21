#!/usr/bin/env node
/**
 * install.mjs — install the `dshmarket` plugin into the web profile.
 *
 * ⚠️ Installed from npm as `dshmarket@latest` (per plugins/README.md's
 * 安装方式 section: the package is not marked as a source install). The
 * dsh-market git submodule checkout beside this script is kept as a source
 * reference only — it is not built or linked here. The package declares
 * `dsh.bundle.patch`, so `dsh plugin add` reconciles it into
 * `dsh.profile.bundles` and its own bundle layer mounts the entry; no manual
 * insert is written (that would double-mount it).
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override
 * (the build passes one) and otherwise pins the same repo-local default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'plugin-market',
  packageSpec: 'dshmarket@latest',
})
