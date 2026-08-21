#!/usr/bin/env node
/**
 * install.mjs — install the `better-sidebar` plugin group into the web profile.
 *
 * ⚠️ Installed from npm as `dsh-better-sidebar@latest` and
 * `dsh-sidebar-qa@latest` (per plugins/README.md's 安装方式 section: the
 * packages are not marked as source installs). The DSH-better-sidebar and
 * dsh-sidebar-qa git submodule checkouts beside this script are kept as
 * source references only — they are not built or linked here.
 *
 * Install order matters: dsh-sidebar-qa is a thin consumer of
 * dsh-better-sidebar (hard peer dependency; stays inactive without it), so
 * dsh-better-sidebar is installed FIRST, then dsh-sidebar-qa — the same
 * relative order lands in `dsh.profile.bundles`, i.e. better-sidebar's bundle
 * layer applies before dsh-sidebar-qa's. Both packages declare
 * `dsh.bundle.patch`, so `dsh plugin add` reconciles each into
 * `dsh.profile.bundles` and their own bundle layers insert the entries; no
 * manual insert is written (that would double-mount them).
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override
 * (the build passes one) and otherwise pins the same repo-local default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

// Install dsh-better-sidebar first: dsh-sidebar-qa declares it as a hard
// peer dependency and its client half injects `betterSidebar` — the module
// tree stays inactive until the dependency lands.
installNpmPlugin({
  id: 'better-sidebar',
  packageSpec: 'dsh-better-sidebar@latest',
})

// Then dsh-sidebar-qa: guarantees the peer dependency is resolvable and that
// dsh.profile.bundles orders better-sidebar's layer before dsh-sidebar-qa's.
installNpmPlugin({
  id: 'sidebar-qa',
  packageSpec: 'dsh-sidebar-qa@latest',
})
