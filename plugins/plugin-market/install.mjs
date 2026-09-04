#!/usr/bin/env node
/**
 * install.mjs — install the `dshmarket` plugin into the web profile.
 *
 * ⚠️ Installed from npm pinned to an exact version matching the git
 * submodule tag (`v1.38.0`), not `@latest` — exact pins bypass pnpm 11's
 * 24h `minimumReleaseAge` gate (which silently falls back to an older
 * version for `@latest`/ranges), and keep the installed body in sync with
 * the checkout beside this script (per plugins/README.md's 安装方式
 * section: the package is not marked as a source install). The dsh-market
 * git submodule checkout beside this script is kept as a source
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
  packageSpec: 'dshmarket@1.38.0',
})
