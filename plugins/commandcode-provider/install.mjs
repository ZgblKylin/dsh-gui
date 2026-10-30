#!/usr/bin/env node
/**
 * install.mjs — install the `commandcode-provider` plugin into the web profile.
 *
 * ⚠️ Installed from npm pinned to an exact version matching the git submodule
 * tag (`v0.15.5`), not `@latest` — exact pins bypass pnpm 11's 24h
 * `minimumReleaseAge` gate, which would otherwise silently fall back to the
 * previous release for `@latest` (per plugins/README.md's 安装方式 section: the
 * package is not marked as a source install). The
 * `dsh-commandcode-provider` git submodule beside this script is kept as a
 * source reference only — it is not built or linked here.
 *
 * The package declares `dsh.bundle.patch`, so `dsh plugin add` reconciles it
 * into `dsh.profile.bundles` and its own `cordis.patch.yml` mounts the entry
 * (id `llm-commandcode`, name `@mars-sea/dsh-commandcode-provider`); no manual
 * insert is written here (that would double-mount it).
 *
 * Declared range still excludes the 0.2.2 line, so the exemption stays explicit:
 * 0.15.5 declares `engines.dsh` as `>=0.2.1-rc.2 <0.2.2-0`, the same range
 * carried by its `dsh.compatibility.dsh` and its `@deepseek-ai/dsh-*` peers, and
 * it records 0.2.1-rc.2 / 0.2.1-rc.3 / 0.2.1-rc.4 as verified in
 * `dsh.compatibility.dshReleases`. The upper bound `<0.2.2-0` excludes the whole
 * 0.2.2 prerelease line, and the pinned harness `dsh-v0.2.2-alpha.2` sorts
 * above it, so the admission gate refuses the package on its own. 0.15.5 is the
 * newest release and carries the identical range, so this wrapper grants the
 * exact-version exemption the admission gate offers instead of dropping the
 * plugin. The exemption is keyed to
 * `@mars-sea/dsh-commandcode-provider@0.15.5` AND to the running dsh version,
 * so a later harness upgrade invalidates it rather than carrying the accepted
 * risk forward. Remove the `exempt` option once upstream publishes a release
 * whose declared range admits the pinned harness.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same runtime-root default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'commandcode-provider',
  packageSpec: '@mars-sea/dsh-commandcode-provider@0.15.5',
  exempt:
    'upstream 0.15.5 declares engines.dsh ">=0.2.1-rc.2 <0.2.2-0", which '
    + 'excludes the 0.2.2 prerelease line; the plugin is kept mounted on '
    + 'dsh-v0.2.2-alpha.2 pending an upstream release that admits it',
})
