#!/usr/bin/env node
/**
 * install.mjs — install the dsh-web-ui plugin bodies into the web profile
 * (per plugins/README.md's 安装方式 section: 安装部分内容, from npm).
 *
 * Two plugin packages of the dsh-web-ui distribution repo are installed,
 * pinned to exact versions matching the upstream git tag (`v0.3.14`), not
 * `@latest` — exact pins bypass pnpm 11's 24h `minimumReleaseAge` gate (the
 * gate silently falls back to an older version for `@latest`/ranges, while a
 * precise version installs and is auto-excluded). Bump these in lockstep with
 * the git submodule tag (upstream renamed itself to dsh-web and the
 * settings-bridge source directory to packages/dsh-web-settings in v0.3.x;
 * the npm package names below are unchanged):
 *
 * 1. the `dsh-liangshen` host plugin (`@linxin666/dsh-liangshen@0.3.14`);
 * 2. the `dsh-web-ui-settings` compatibility bundle
 *    (`@linxin666/dsh-client-ui-web-ui-settings@0.3.14`).
 *
 * Both declare their own `dsh.bundle.patch`, so `dsh plugin add`
 * reconciles them into `dsh.profile.bundles` and each mounts through its own
 * bundle layer — no manual cordis mount is written (that would double-mount).
 * The settings bridge exposes the `webUiSettings` compatibility binder to
 * dsh-web family plugins that declare it (the `@linxin666/dsh-pet` companion
 * is no longer installed here — the PC2005-cloud `dsh-pet` desktop pet has
 * its own wrapper at `plugins/dsh-pet/`).
 *
 * No other dsh-web-ui package (task-board, skins, community-plugins, ...) and
 * no agent preset from the distribution repo is installed here (agent presets
 * belong to the `presets/` flow, not this wrapper).
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override
 * (the build passes one) and otherwise pins the same repo-local default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'dsh-liangshen',
  packageSpec: '@linxin666/dsh-liangshen@0.3.14',
})
// 下面的 web-ui-settings 包依赖旧版 `@deepseek-ai/dsh-client-runtime`
// （dsh-v0.1.2-alpha.1 中已不存在），安装器默认跳过；upstream 适配后从默认
// 清单移除即可，或临时 DSH_PLUGIN_FORCE_INSTALL=1（见
// docs/dsh-gui/harness-upgrade-build-failure.md）。版本仍与 git tag 同步 pin。
installNpmPlugin({
  id: 'dsh-web-ui-settings',
  packageSpec: '@linxin666/dsh-client-ui-web-ui-settings@0.3.14',
})
