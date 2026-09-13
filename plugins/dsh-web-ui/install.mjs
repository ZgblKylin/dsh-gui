#!/usr/bin/env node
/**
 * install.mjs — install the dsh-web-ui plugin bodies into the web profile
 * (per plugins/README.md's 安装方式 section: 安装部分内容, from npm).
 *
 * Four plugin packages of the dsh-web-ui distribution repo are installed,
 * pinned to exact versions matching the upstream git tag (`v0.3.22`), not
 * `@latest` — exact pins bypass pnpm 11's 24h `minimumReleaseAge` gate (the
 * gate silently falls back to an older version for `@latest`/ranges, while a
 * precise version installs and is auto-excluded). Bump these in lockstep with
 * the git submodule tag (upstream renamed itself to dsh-web and the
 * settings-bridge source directory to packages/dsh-web-settings in v0.3.x;
 * the npm package names below are unchanged):
 *
 * 1. the `dsh-web-ui-settings` compatibility bundle
 *    (`@linxin666/dsh-client-ui-web-ui-settings@0.3.22`);
 * 2. the `dsh-plugin-manager` plugin-manager tab
 *    (`@linxin666/dsh-client-ui-plugin-manager@0.3.22`): registers a
 *    `settings.plugins.tab` tab in the official Plugins settings section
 *    (install from npm/git, enable/disable, update/remove, conflict
 *    reconciliation, repair conversations);
 * 3. the `dsh-skill-explorer` skill center
 *    (`@linxin666/dsh-client-ui-skill-explorer@0.3.22`): browse loaded skills
 *    by source (bundled / project / user / custom / runtime), enable/disable,
 *    create and delete, in a web GUI panel;
 * 4. the `dsh-task-board` host-authoritative task board
 *    (`@linxin666/dsh-client-ui-task-board@0.3.22`): real session execution,
 *    Host cron scheduling, and optional cross-platform idle-sleep protection,
 *    mounted without DSH source changes.
 *
 * All four declare their own `dsh.bundle.patch`, so `dsh plugin add`
 * reconciles them into `dsh.profile.bundles` and each mounts through its own
 * bundle layer — no manual cordis mount is written (that would double-mount).
 * The settings bridge exposes the `webUiSettings` compatibility binder to
 * dsh-web family plugins that declare it (the `@linxin666/dsh-pet` companion
 * is no longer installed here — the PC2005-cloud `dsh-pet` desktop pet has
 * its own wrapper at `plugins/dsh-pet/`).
 *
 * This wrapper does not install the `dsh-liangshen` host plugin (梁神模式) or
 * its agent preset: the plugin syncs that preset into
 * `.dsh/.agent-presets/liangshen` from its own host startup, which stays
 * outside this wrapper's scope.
 *
 * No other dsh-web-ui package (skins, community-plugins, ...) and no agent
 * preset from the distribution repo is installed here (agent presets belong to
 * the `presets/` flow, not this wrapper).
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override
 * (the build passes one) and otherwise pins the same repo-local default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'dsh-web-ui-settings',
  packageSpec: '@linxin666/dsh-client-ui-web-ui-settings@0.3.22',
})

// plugin-manager：官方「插件」设置分区内的插件管理器 Tab（启停/安装/更新/卸载
// + 冲突对账 + 修复会话），双通道（官方 /plugin-installer RPC 或 loopback 网关 +
// dsh plugin CLI）。engines.dsh >=0.1.5-rc.1 匹配 pinned harness；版本对齐
// 子模块 tag v0.3.22。
installNpmPlugin({
  id: 'dsh-plugin-manager',
  packageSpec: '@linxin666/dsh-client-ui-plugin-manager@0.3.22',
})

// skill-explorer：DSH 技能中心面板，按来源（bundled/project/user/custom/runtime）
// 浏览已加载技能、启停、创建与删除。engines.dsh >=0.1.5-rc.1 匹配 pinned
// harness；版本对齐子模块 tag v0.3.22。
installNpmPlugin({
  id: 'dsh-skill-explorer',
  packageSpec: '@linxin666/dsh-client-ui-skill-explorer@0.3.22',
})

// task-board：host 权威任务板（真实会话执行 + Host cron 调度 + 可选跨平台
// 闲置防睡眠），host 半区挂系统提示词公告 section、浏览器半区渲染任务板 UI。
// 双半区都经 dsh.bundle.patch 自挂载；版本对齐子模块 tag v0.3.22。
installNpmPlugin({
  id: 'dsh-task-board',
  packageSpec: '@linxin666/dsh-client-ui-task-board@0.3.22',
})
