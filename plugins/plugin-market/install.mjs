#!/usr/bin/env node
/**
 * install.mjs — install the `dshmarket` plugin into the web profile.
 *
 * ⚠️ Installed from npm pinned to an exact version matching the git
 * submodule tag (`v1.70.2`), not `@latest` — exact pins bypass pnpm 11's
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
 * dsh-v0.2.2-alpha.2 admission gate reads a package's declared dsh requirements
 * (`engines.dsh` when present, else its `@deepseek-ai/dsh` /
 * `@deepseek-ai/dsh-*` peers) against the running version, so the
 * `@deepseek-ai/dsh-settings` peer must carry a 0.2-line branch. 1.66.4 is the
 * first release that admits the 0.2 line through `^0.2.0-rc.1`, which covers
 * 0.2.2-alpha.2; below it the install preflight exits 1 and `npm run build`
 * fails. 1.70.x extends that peer with `^0.2.1-alpha.3 || ^0.2.1-rc.1` and runs
 * its own peer check with `includePrerelease`, admitting prerelease host lines
 * instead of reporting them unmet; this wrapper pins 1.70.2.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override
 * (the build passes one) and otherwise pins the same runtime-root default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'plugin-market',
  packageSpec: 'dshmarket@1.70.2',
})
