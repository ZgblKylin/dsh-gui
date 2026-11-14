#!/usr/bin/env node
/**
 * install.mjs — install the `commandcode-provider` plugin into the web profile.
 *
 * ⚠️ Installed from npm pinned to an exact version (`0.17.3`), not `@latest` —
 * exact pins bypass pnpm 11's 24h `minimumReleaseAge` gate, which would
 * otherwise silently fall back to the previous release for `@latest` (per
 * plugins/README.md's 安装方式 section: the package is not marked as a source
 * install).
 *
 * The package declares `dsh.bundle.patch`, so `dsh plugin add` reconciles it
 * into `dsh.profile.bundles` and its own `cordis.patch.yml` mounts the entry
 * (id `llm-commandcode`, name `@mars-sea/dsh-commandcode-provider`); no manual
 * insert is written here (that would double-mount it).
 *
 * Admission on the pinned harness `dsh-v0.2.2-rc.3` needs no exact-version
 * exemption since 0.17.3: its `engines.dsh` is now
 * `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0`, so 0.2.2-rc.3 sorts
 * inside the second branch (`0.2.2-alpha.2 <= 0.2.2-rc.3 < 0.2.3-0`). The same
 * disjunction is carried by its `@deepseek-ai/dsh-*` peers, so the admission
 * gate admits the package on its own. Pins through 0.15.5 ended at
 * `<0.2.2-0` and therefore had to grant the exact-version `exempt`; it is
 * dropped here instead of carried forward, because an exemption is keyed to
 * both the package version and the running dsh version.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same runtime-root default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'commandcode-provider',
  packageSpec: '@mars-sea/dsh-commandcode-provider@0.17.3',
})
