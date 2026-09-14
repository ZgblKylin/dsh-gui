#!/usr/bin/env node
/**
 * install.mjs — install the `better-sidebar` plugin group into the web profile.
 *
 * DSH-better-sidebar 从 npm 安装：v0.19.1 的 peerDeps 全部指向 ^0.1.5-rc.1，
 * 与本工程 pinned 的 dsh-v0.1.5-rc.2 harness 匹配，上游已在该版本上完成真机
 * 挂载验证。固定精确版本而非 @latest，是因为 pinned pnpm 11.7 默认的
 * supply-chain minimumReleaseAge 会把过新的版本挡在 @latest 之外、静默回退到
 * 更旧版本；精确 pin 由 pnpm 自动写入 profile 的 minimumReleaseAgeExclude，
 * 安装结果确定。
 * 子模块 remote：`origin` = 官方 `omdsh-dev/DSH-better-sidebar`（子模块
 * checkout 仅作源码参考）。
 *
 * dsh-flowglass / dsh-sidebar-qa 仍从 npm 安装（两者依赖 better-sidebar 的
 * bundle 层，安装顺序不变：better-sidebar 先装，再装两个 companion；同一
 * 相对顺序也落在 `dsh.profile.bundles`，即 better-sidebar 的 bundle 层先于
 * 其 companions 应用）。两个 companion 均 pin 到与其 git submodule tag 一致
 * 的精确版本（dsh-flowglass@0.5.0、dsh-sidebar-qa@0.5.0），不用 `@latest`：
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
  // 固定 0.1.5-rc.1+ 适配版 0.19.1（见头部注释；@latest 会被 minimumReleaseAge 挡回更旧版本）。
  packageSpec: 'dsh-better-sidebar@0.19.1',
})

// 然后 dsh-flowglass：live flowgraph（三车道、子代理分支、并行分组、下钻）
// + 可热重载的会话工具箱抽屉，编译产物来自 npm。v0.5.0 起承载面按固定优先级
// 自动选择：DSH 0.1.5+ 原生右侧栏 page type（`dsh-flowglass:flow`，客户端新增
// @deepseek-ai/dsh-api-session-controller 与 @deepseek-ai/dsh-client-ui-sidebar-right
// 两个注入模块）→ better-sidebar 的 tab（原生不可用时）→ 自带固定右栏。
// client peer 抬到 ^0.1.5-rc.1，与本工程 pinned 的 dsh-v0.1.5-rc.2 harness 一致；
// 对 dsh-better-sidebar 的 peer 抬到 >=0.19.0，恰与本脚本上方固定的 0.19.1 匹配。
// 版本 pin 到子模块 tag v0.5.0 对应的 npm 发布。
installNpmPlugin({
  id: 'flowglass',
  packageSpec: 'dsh-flowglass@0.5.0',
})

// 然后 dsh-sidebar-qa：保证硬 peer 依赖可解析且 `dsh.profile.bundles` 把
// better-sidebar 的层排在 companions 之前。版本 pin 到子模块 tag v0.5.0。
installNpmPlugin({
  id: 'sidebar-qa',
  packageSpec: 'dsh-sidebar-qa@0.5.0',
})
