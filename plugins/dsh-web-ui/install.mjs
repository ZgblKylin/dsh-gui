#!/usr/bin/env node
/**
 * install.mjs — install the dsh-web-ui plugin bodies into the web profile
 * (per plugins/README.md's 安装方式 section: 安装部分内容, from npm).
 *
 * Four plugin packages of the dsh-web-ui distribution repo are installed,
 * pinned to exact versions matching the upstream git tag (`v0.4.2`), not
 * `@latest` — exact pins bypass pnpm 11's 24h `minimumReleaseAge` gate (the
 * gate silently falls back to an older version for `@latest`/ranges, while a
 * precise version installs and is auto-excluded). Bump these in lockstep with
 * the git submodule tag (upstream renamed itself to dsh-web and the
 * settings-bridge source directory to packages/dsh-web-settings in v0.3.x;
 * the npm package names below are unchanged):
 *
 * 1. the `dsh-web-ui-settings` compatibility bundle
 *    (`@linxin666/dsh-client-ui-web-ui-settings@0.4.2`);
 * 2. the `dsh-skill-explorer` skill center
 *    (`@linxin666/dsh-client-ui-skill-explorer@0.4.2`): browse loaded skills
 *    by source (bundled / project / user / custom / runtime), enable/disable,
 *    create and delete, in a web GUI panel;
 * 3. the `dsh-usage` usage-statistics plugin (`@linxin666/dsh-usage@0.4.2`):
 *    per-provider balance and coding-plan quota probes plus a live token
 *    ledger, rendered as a first-level "Usage statistics" settings section;
 * 4. the `dsh-model-capabilities` plugin
 *    (`@linxin666/dsh-client-ui-model-capabilities@0.4.2`): per-model image
 *    input and reasoning-effort declarations edited on the models settings
 *    cards, writing the official `llm-pi-ai` namespace.
 *
 * `dsh-plugin-manager` is no longer installed here: since the pinned harness
 * dsh-v0.1.7-rc.2 the official `@deepseek-ai/dsh-web-app` bundle ships its
 * own `ui-plugin-manager` loader entry, which collides with the upstream
 * package's bundle patch id (`duplicate loader entry id: ui-plugin-manager`,
 * harness fails to boot). The official plugin manager covers the built-in
 * Plugins page; if the upstream package is wanted again it must be mounted
 * under a distinct loader entry id (see dsh-plugin-uninstall skill).
 *
 * The four remaining packages each declare their own `dsh.bundle.patch`, so
 * `dsh plugin add`
 * reconciles them into `dsh.profile.bundles` and each mounts through its own
 * bundle layer — no manual cordis mount is written (that would double-mount).
 * The settings bridge exposes the `webUiSettings` compatibility binder to
 * dsh-web family plugins that declare it (the `@linxin666/dsh-pet` companion
 * is no longer installed here — the PC2005-cloud `dsh-pet` desktop pet has
 * its own wrapper at `plugins/dsh-pet/`).
 *
 * This wrapper does not install the `dsh-liangshen` host plugin (梁神模式) or
 * its agent preset. Since harness dsh-v0.1.7-rc.2 a preset is a declarative
 * `@deepseek-ai/dsh-agent-preset` row in a profile Cordis patch, and the retired
 * `.dsh/.agent-presets/` directory is no longer discovered — a distribution
 * repo that still syncs a preset there would not reach the roster. That stays
 * outside this wrapper's scope either way.
 *
 * No other dsh-web-ui package (skins, community-plugins, ...) and no agent
 * preset from the distribution repo is installed here.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override
 * (the build passes one) and otherwise pins the same repo-local default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'dsh-web-ui-settings',
  packageSpec: '@linxin666/dsh-client-ui-web-ui-settings@0.4.2',
})

// skill-explorer：DSH 技能中心面板，按来源（bundled/project/user/custom/runtime）
// 浏览已加载技能、启停、创建与删除。engines.dsh >=0.1.5-rc.1 匹配 pinned
// harness；版本对齐子模块 tag v0.3.22。
installNpmPlugin({
  id: 'dsh-skill-explorer',
  packageSpec: '@linxin666/dsh-client-ui-skill-explorer@0.4.2',
})

// dsh-usage：使用统计（多 provider 余额与编程套餐探测 + 实时 token 台账 +
// 设置页一级分区「使用统计」）。宠物公告气泡读取可选的 `pet` 服务，本工程安装的
// PC2005-cloud dsh-pet 不提供该服务，气泡静默，其余功能不受影响。版本对齐
// 子模块 tag v0.4.2。
installNpmPlugin({
  id: 'dsh-usage',
  packageSpec: '@linxin666/dsh-usage@0.4.2',
})

// dsh-model-capabilities：Models 设置页自定义提供方卡片上的「模型能力」扩展区
// （逐模型声明图片输入与推理档位，写官方 llm-pi-ai 命名空间），另提供提供方
// 禁用/启用（先存档再 unset 路由）。经 dsh.bundle.patch 自挂载；版本对齐
// 子模块 tag v0.4.2。
installNpmPlugin({
  id: 'dsh-model-capabilities',
  packageSpec: '@linxin666/dsh-client-ui-model-capabilities@0.4.2',
})
