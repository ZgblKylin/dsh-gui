#!/usr/bin/env node
/**
 * install.mjs — install the dsh-web-ui plugin bodies into the web profile
 * (per plugins/README.md's 安装方式 section: 安装部分内容, from npm).
 *
 * Three plugin packages of the dsh-web-ui distribution repo are installed,
 * all from npm as `@latest` (upstream renamed itself to dsh-web and the
 * settings-bridge source directory to packages/dsh-web-settings in v0.3.x;
 * the npm package names below are unchanged):
 *
 * 1. the `dsh-liangshen` host plugin (`@linxin666/dsh-liangshen@latest`);
 * 2. the `dsh-web-ui-settings` compatibility bundle
 *    (`@linxin666/dsh-client-ui-web-ui-settings@latest`);
 * 3. the `dsh-pet` companion plugin (`@linxin666/dsh-pet@latest`).
 *
 * All three declare their own `dsh.bundle.patch`, so `dsh plugin add`
 * reconciles them into `dsh.profile.bundles` and each mounts through its own
 * bundle layer — no manual cordis mount is written (that would double-mount).
 * The settings bridge is installed before dsh-pet, matching the upstream
 * `dsh-web-ui-all/aggregate.yml` convention (dsh-pet reads `webUiSettings`
 * once during activation; without the bridge its settings card shows the
 * "namespace not exposed" explanation).
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
  packageSpec: '@linxin666/dsh-liangshen@latest',
})
// 下面两个包依赖旧版 `@deepseek-ai/dsh-client-runtime`（dsh-v0.1.2-alpha.1
// 中已不存在），安装器默认跳过；upstream 适配后从默认清单移除即可，或临时
// DSH_PLUGIN_FORCE_INSTALL=1（见
// docs/dsh-gui/harness-upgrade-build-failure.md）。
installNpmPlugin({
  id: 'dsh-web-ui-settings',
  packageSpec: '@linxin666/dsh-client-ui-web-ui-settings@latest',
})
installNpmPlugin({
  id: 'dsh-pet',
  packageSpec: '@linxin666/dsh-pet@latest',
})
