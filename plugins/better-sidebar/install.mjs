#!/usr/bin/env node
/**
 * install.mjs — install the `better-sidebar` plugin group into the web profile.
 *
 * DSH-better-sidebar 从 npm 安装（官方已发版 v0.16.1，含 z-index 图层修复
 * #330：宿主层 40→25，防底部面板遮挡 ui-cordis 动态插件面板）。
 * 子模块 remote 命名：`origin` = 官方 `omdsh-dev/DSH-better-sidebar`，
 * `fork` = `ZgblKylin/DSH-better-sidebar`（子模块 checkout 仅作源码参考）。
 *
 * dsh-flowglass / dsh-sidebar-qa 仍从 npm 安装（两者依赖 better-sidebar 的
 * bundle 层，安装顺序不变：better-sidebar 先装，再装两个 companion；同一
 * 相对顺序也落在 `dsh.profile.bundles`，即 better-sidebar 的 bundle 层先于
 * 其 companions 应用）。
 *
 * 三个包都声明 `dsh.bundle.patch`，所以 `dsh plugin add` 各自 reconcile 进
 * `dsh.profile.bundles` 并由其 bundle 层插入 Loader entry——不写手工 insert
 * （那会 double-mount）。
 *
 * Target: `$DSH_HOME/profiles/web/`。`DSH_HOME` 被桌面壳钉到 `<repo>/.dsh`；
 * 本脚本尊重显式 `DSH_HOME` 覆盖（build 会传一个），否则取同一仓库内默认值。
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'better-sidebar',
  packageSpec: 'dsh-better-sidebar@latest',
})

// 然后 dsh-flowglass：live flowgraph（三车道、子代理分支、并行分组、下钻）
// + 可热重载的会话工具箱抽屉，编译产物来自 npm。装好 better-sidebar 时
// 注册为原生会话级 tab。
installNpmPlugin({
  id: 'flowglass',
  packageSpec: 'dsh-flowglass@latest',
})

// 然后 dsh-sidebar-qa：保证硬 peer 依赖可解析且 `dsh.profile.bundles` 把
// better-sidebar 的层排在 companions 之前。
installNpmPlugin({
  id: 'sidebar-qa',
  packageSpec: 'dsh-sidebar-qa@latest',
})
