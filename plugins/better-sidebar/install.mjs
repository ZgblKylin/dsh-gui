#!/usr/bin/env node
/**
 * install.mjs — install the `better-sidebar` plugin group into the web profile.
 *
 * DSH-better-sidebar 从 npm 安装（DSH 0.1.2-rc.1 需 v0.18.0：其 peerDeps 全部
 * 指向 ^0.1.2-rc.1。注意 v0.17.1 是针对 dsh-v0.1.2-alpha.1 的适配，import
 * 了 rc.1 已移除的 settingsNamespace，不能在 rc.1 上加载）。固定精确版本而非
 * @latest，是因为 pinned pnpm 11.7 默认 supply-chain minimumReleaseAge 会把
 * 过新的 0.18.0 挡在 @latest 之外、回退到旧版 0.17.1。
 * 子模块 remote 命名：`origin` = 官方 `omdsh-dev/DSH-better-sidebar`，
 * `fork` = `ZgblKylin/DSH-better-sidebar`（子模块 checkout 仅作源码参考）。
 *
 * dsh-flowglass / dsh-sidebar-qa 仍从 npm 安装（两者依赖 better-sidebar 的
 * bundle 层，安装顺序不变：better-sidebar 先装，再装两个 companion；同一
 * 相对顺序也落在 `dsh.profile.bundles`，即 better-sidebar 的 bundle 层先于
 * 其 companions 应用）。两个 companion 均 pin 到与其 git submodule tag 一致
 * 的精确版本（dsh-flowglass@0.3.0、dsh-sidebar-qa@0.4.0），不用 `@latest`：
 * pinned pnpm 11.7 默认 supply-chain minimumReleaseAge 会对 `@latest`/范围
 * 静默回退到更旧版本，精确 pin 则直接安装并自动豁免，保证结果确定。
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
  // 固定 rc.1 适配版 0.18.0（见头部注释；@latest 会被 minimumReleaseAge 挡回 0.17.1）。
  packageSpec: 'dsh-better-sidebar@0.18.0',
})

// 然后 dsh-flowglass：live flowgraph（三车道、子代理分支、并行分组、下钻）
// + 可热重载的会话工具箱抽屉，编译产物来自 npm。装好 better-sidebar 时
// 注册为原生会话级 tab。默认跳过：0.4.x 对 dsh-v0.1.2-alpha.1 的 client
// 运行时不兼容（见 docs/dsh-gui/harness-upgrade-build-failure.md；upstream
// 适配后移除默认清单即可，或临时 DSH_PLUGIN_FORCE_INSTALL=1）。版本 pin 到
// 子模块 tag v0.3.0 对应的 npm 发布。
installNpmPlugin({
  id: 'flowglass',
  packageSpec: 'dsh-flowglass@0.3.0',
})

// 然后 dsh-sidebar-qa：保证硬 peer 依赖可解析且 `dsh.profile.bundles` 把
// better-sidebar 的层排在 companions 之前。版本 pin 到子模块 tag v0.4.0。
installNpmPlugin({
  id: 'sidebar-qa',
  packageSpec: 'dsh-sidebar-qa@0.4.0',
})
