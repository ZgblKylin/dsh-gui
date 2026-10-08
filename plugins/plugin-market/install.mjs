#!/usr/bin/env node
/**
 * install.mjs — install the `dshmarket` plugin into the web profile.
 *
 * ⚠️ Installed from npm pinned to an exact version matching the git
 * submodule tag (`v1.66.9`), not `@latest` — exact pins bypass pnpm 11's
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
 * The dshmarket version is a hard floor, not a preference: the harness
 * dsh-v0.2.1-alpha.1 admission gate checks every `@deepseek-ai/dsh` /
 * `@deepseek-ai/dsh-*` peer against the running version, and 1.65.3's
 * `@deepseek-ai/dsh-settings: ^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2`
 * is rejected — the install preflight exits 1 and `npm run
 * build` fails. 1.66.4 admitted the 0.2 line; this wrapper pins 1.66.9.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override
 * (the build passes one) and otherwise pins the same runtime-root default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'plugin-market',
  packageSpec: 'dshmarket@1.66.9',
})
