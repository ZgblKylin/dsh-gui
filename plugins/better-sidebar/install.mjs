#!/usr/bin/env node
/**
 * install.mjs — install the `better-sidebar` plugin group into the web profile.
 *
 * DSH-better-sidebar 从 npm 安装：v0.24.1 的 peerDeps 全部指向 ^0.2.0-rc.1，
 * 与本工程 pinned 的 dsh-v0.2.0-rc.2 harness 匹配；上游自 v0.21.1 起把右列交由
 * DSH 原生右侧栏承载、插件把各 tab 类型注册为原生 tab 并只保留底部工作台与
 * `ctx.betterSidebar` 服务。固定精确版本而非 @latest，是因为 pinned pnpm 11.7
 * 默认的 supply-chain minimumReleaseAge 会把过新的版本挡在 @latest 之外、静默回退到
 * 更旧版本；精确 pin 由 pnpm 自动写入 profile 的 minimumReleaseAgeExclude，
 * 安装结果确定。v0.21.1 的 14 条 @deepseek-ai/dsh-* peer 全是 ^0.1.7-rc.1，
 * caret 上界不含 0.2.0，会被 0.2.0 的准入闸门整包拒绝（安装期 exit 1、启动期
 * bundle 整层跳过），因此本次必须抬到 0.24.1。
 * 子模块 remote：`origin` = 官方 `omdsh-dev/DSH-better-sidebar`（子模块
 * checkout 仅作源码参考）。
 *
 * dsh-flowglass / dsh-sidebar-qa 仍从 npm 安装，均 pin 到与其 git submodule
 * tag 一致的精确版本（dsh-flowglass@0.7.3、dsh-sidebar-qa@1.1.0），不用
 * `@latest`：pinned pnpm 11.7 默认 supply-chain minimumReleaseAge 会对
 * `@latest`/范围静默回退到更旧版本，精确 pin 则直接安装并自动豁免，保证结果
 * 确定。安装顺序为 better-sidebar → flowglass → sidebar-qa：flowglass 的 peer
 * 仍要求 `dsh-better-sidebar >=0.19.0`，故 better-sidebar 必须先落地；同一
 * 相对顺序也落在 `dsh.profile.bundles`。dsh-sidebar-qa 自 v1.0.0 起不再声明
 * better-sidebar peer（原生单后端重构），它的顺序只用于保持既有排布。
 *
 * dsh-flowglass 固定在 0.7.3（子模块 tag v0.7.3）：v0.7.x 的 client peer 为
 * `^0.1.5-rc.1 || ^0.1.6-alpha.2 || ^0.1.7-alpha.2`，三个 caret 分支的上界都在
 * 0.2.0 之前，0.2.0-rc.2 的准入闸门会拒绝；0.7.2 与 0.7.3 的这两条 peer 原文
 * 逐字相同，因此保持旧 pin 同样会被拒。上游尚无适配 0.2 的发布，本次以精确
 * 版本例外（installNpmPlugin 的 `exempt`）继续挂载；例外按「包@版本 + 运行时
 * 版本」精确记录，harness 再次换代即自动失效。若实测该版本在 0.2.0-rc.2 上
 * 不兼容，应改为 skip 屏蔽并等上游抬 peer。
 *
 * 三个包都声明 `dsh.bundle.patch`，所以 `dsh plugin add` 各自 reconcile 进
 * `dsh.profile.bundles` 并由其 bundle 层插入 Loader entry——不写手工 insert
 * （那会 double-mount）。
 *
 * Target: `$DSH_HOME/profiles/web/`。`DSH_HOME` 被桌面壳钉到 `<runtime-root>/.dsh`；
 * 本脚本尊重显式 `DSH_HOME` 覆盖（build 会传一个），否则取同一仓库内默认值。
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'better-sidebar',
  // 固定 0.2.0-rc.1+ 适配版 0.24.1（见头部注释；@latest 会被 minimumReleaseAge 挡回更旧版本）。
  packageSpec: 'dsh-better-sidebar@0.24.1',
})

// 然后 dsh-flowglass：live flowgraph（三车道、子代理分支、并行分组、下钻）
// + 可热重载的会话工具箱抽屉，编译产物来自 npm。v0.5.0 起承载面按固定优先级
// 自动选择：DSH 0.1.5+ 原生右侧栏 page type（`dsh-flowglass:flow`，客户端新增
// @deepseek-ai/dsh-api-session-controller 与 @deepseek-ai/dsh-client-ui-sidebar-right
// 两个注入模块）→ better-sidebar 的 tab（原生不可用时）→ 自带固定右栏。
// 对 dsh-better-sidebar 的 peer 为 >=0.19.0，与本脚本上方固定的 0.24.1 匹配。
// 版本 pin 到子模块 tag v0.7.3，并带上精确版本例外（理由见头部注释）。
installNpmPlugin({
  id: 'flowglass',
  packageSpec: 'dsh-flowglass@0.7.3',
  exempt: 'dsh-flowglass 0.7.3 的 @deepseek-ai/dsh-typert-protocol 与 @deepseek-ai/dsh-client-ui-primitives peer 为 ^0.1.5-rc.1 || ^0.1.6-alpha.2 || ^0.1.7-alpha.2，不含 0.2.0；上游尚无适配 0.2 的发布（0.7.2 与 0.7.3 的 peer 逐字相同）',
})

// 然后 dsh-sidebar-qa：独占的「追问」原生面板（选中文本 → 右栏追问 → 独立同
// 工作区会话）。v1.0.0 起收敛为原生单后端，并在 manifest 层移除了
// dsh-better-sidebar peer；由上游针对 DSH 0.1.7 重命名后的图标集按名解析宿主
// 图标。v1.1.0 是纯元数据修复版：peer 由 ^0.1.0-rc.8 改为纯下限 >=0.1.0-rc.8
// （caret 上界 <0.2.0-0 过不了 0.2.0 的准入闸门），src/** 零改动。
// 版本 pin 到子模块 tag v1.1.0。
installNpmPlugin({
  id: 'sidebar-qa',
  packageSpec: 'dsh-sidebar-qa@1.1.0',
})