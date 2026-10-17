#!/usr/bin/env node
/**
 * install.mjs — install the `commandcode-provider` plugin into the web profile.
 *
 * ⚠️ Installed from npm pinned to an exact version matching the git submodule
 * tag (`v0.13.4`), not `@latest` — exact pins bypass pnpm 11's 24h
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
 * Exact-version exemption: 0.13.4 declares its engines as exactly two verified
 * releases — `0.2.0-rc.2 || 0.2.1-alpha.4` — carried verbatim by its
 * `engines.dsh`, its `dsh.compatibility.dsh` / `dshReleases` records and its
 * `@deepseek-ai/dsh-*` peers. The rc.2 admission gate reads `engines.dsh` first
 * and compares it alone, so 0.2.1-rc.2 falls outside that disjunction and
 * `dsh plugin add` would exit 1 before pnpm runs (the bundle layer would then be
 * skipped at boot). The disjunction admits no adjacent prerelease, release
 * candidate or stable patch version, and no published release declares rc.2, so
 * keeping the previous pin does not help either: 0.12.x/0.13.0 target other
 * engines. This wrapper therefore grants the profile an exact-version
 * exemption (`installNpmPlugin`'s `exempt`) for
 * `@mars-sea/dsh-commandcode-provider@0.13.4` on the pinned harness version.
 * The exemption is keyed to that exact runtime version, so the next harness
 * change invalidates it and the gate decides again. Upstream verifies the
 * plugin against 0.2.1-alpha.4; the intervening alpha.4 → rc.2 host changes are
 * exercised only by the staging build and the WebUI acceptance run.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same runtime-root default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'commandcode-provider',
  packageSpec: '@mars-sea/dsh-commandcode-provider@0.13.4',
  exempt:
    '@mars-sea/dsh-commandcode-provider@0.13.4 declares engines.dsh '
    + '"0.2.0-rc.2 || 0.2.1-alpha.4" and the rc.2 gate reads only that range; '
    + 'the plugin is verified upstream against 0.2.1-alpha.4 and no release '
    + 'declares rc.2 yet, so the exact version is accepted for this runtime.',
})
