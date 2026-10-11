#!/usr/bin/env node
/**
 * install.mjs — install the `commandcode-provider` plugin into the web profile.
 *
 * ⚠️ Installed from npm pinned to an exact version matching the git submodule
 * tag (`v0.12.10`), not `@latest` — exact pins bypass pnpm 11's 24h
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
 * Engine pairing: 0.12.10 declares exactly three verified engines —
 * `0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2` — carried verbatim by its 15
 * `@deepseek-ai/dsh-*` peers, `engines.dsh`, `dsh.compatibility.dsh` and
 * `dsh.compatibility.dshReleases`, so the admission gate admits it against this
 * repository's pinned dsh-v0.2.1-alpha.2 and no version exemption is needed.
 * The disjunction of bare versions is deliberate: unlike a caret or `>=` range
 * it admits no adjacent prerelease, release candidate or stable patch version
 * (`0.2.1-alpha.3`, `0.2.1-rc.1`, `0.2.1`, `0.3.0-alpha.1` all stay rejected).
 * The 0.12.0 line targeted 0.2.0-rc.1 with `^` ranges and was the last release
 * for that runtime; older plugin releases do not pair with this runtime
 * (0.11.17 was the last for dsh 0.1.7, 0.11.11 the last for 0.1.2–0.1.6, and
 * 0.9.1 the last for the 0.5.0 line).
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same runtime-root default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'commandcode-provider',
  packageSpec: '@mars-sea/dsh-commandcode-provider@0.12.10',
})
