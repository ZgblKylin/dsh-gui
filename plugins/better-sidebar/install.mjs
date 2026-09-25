#!/usr/bin/env node
/**
 * install.mjs — install the `better-sidebar` plugin group into the web profile.
 *
 * DSH-better-sidebar 从 npm 安装：v0.21.1 的 peerDeps 全部指向 ^0.1.7-rc.1，
 * 与本工程 pinned 的 dsh-v0.1.7-rc.2 harness 匹配（上游把 v0.21.1 标记为
 * 「DSH 0.1.7-rc.1 的稳定适配版」，并补齐 DSH 0.1.7 插件列表使用的图标与
 * locale 元数据）。固定精确版本而非 @latest，是因为 pinned pnpm 11.7 默认的
 * supply-chain minimumReleaseAge 会把过新的版本挡在 @latest 之外、静默回退到
 * 更旧版本；精确 pin 由 pnpm 自动写入 profile 的 minimumReleaseAgeExclude，
 * 安装结果确定。
 * 子模块 remote：`origin` = 官方 `omdsh-dev/DSH-better-sidebar`（子模块
 * checkout 仅作源码参考）。
 *
 * dsh-flowglass / dsh-sidebar-qa 仍从 npm 安装，均 pin 到与其 git submodule
 * tag 一致的精确版本（dsh-flowglass@0.7.2、dsh-sidebar-qa@1.0.2），不用
 * `@latest`：pinned pnpm 11.7 默认 supply-chain minimumReleaseAge 会对
 * `@latest`/范围静默回退到更旧版本，精确 pin 则直接安装并自动豁免，保证结果
 * 确定。安装顺序为 better-sidebar → flowglass → sidebar-qa：flowglass 的 peer
 * 仍要求 `dsh-better-sidebar >=0.19.0`，故 better-sidebar 必须先落地；同一
 * 相对顺序也落在 `dsh.profile.bundles`。dsh-sidebar-qa 自 v1.0.0 起不再声明
 * better-sidebar peer（原生单后端重构），它的顺序只用于保持既有排布。
 *
 * dsh-flowglass 固定在 0.7.2（子模块 tag v0.7.2）：0.6.x 已补上 alpha.2 严格
 * codec 校验需要的 `create` 工厂，0.7.x 进一步适配 DSH 0.1.7 的工具结果与会话
 * 投影；peer 范围为 `^0.1.5-rc.1 || ^0.1.6-alpha.2 || ^0.1.7-alpha.2`，覆盖本次
 * pinned 的 dsh-v0.1.7-rc.2。
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
  // 固定 0.1.7-rc.1+ 适配版 0.21.1（见头部注释；@latest 会被 minimumReleaseAge 挡回更旧版本）。
  packageSpec: 'dsh-better-sidebar@0.21.1',
})

// 然后 dsh-flowglass：live flowgraph（三车道、子代理分支、并行分组、下钻）
// + 可热重载的会话工具箱抽屉，编译产物来自 npm。v0.5.0 起承载面按固定优先级
// 自动选择：DSH 0.1.5+ 原生右侧栏 page type（`dsh-flowglass:flow`，客户端新增
// @deepseek-ai/dsh-api-session-controller 与 @deepseek-ai/dsh-client-ui-sidebar-right
// 两个注入模块）→ better-sidebar 的 tab（原生不可用时）→ 自带固定右栏。
// v0.7.x 起 client peer 为 `^0.1.5-rc.1 || ^0.1.6-alpha.2 || ^0.1.7-alpha.2`，
// 覆盖 pinned 的 dsh-v0.1.7-rc.2（0.6.x 的 `create` 工厂修复与 alpha.2 适配仍在
// 此范围内）；对 dsh-better-sidebar 的 peer 为 >=0.19.0，与本脚本上方固定的
// 0.21.1 匹配。v0.7.0–0.7.2 主要适配 DSH 0.1.7 的工具结果与会话投影、并行调用
// 稳定性与原生侧栏工具集成。
// 版本 pin 到子模块 tag v0.7.2 对应的 npm 发布。
installNpmPlugin({
  id: 'flowglass',
  packageSpec: 'dsh-flowglass@0.7.2',
})

// 然后 dsh-sidebar-qa：独占的「追问」原生面板（选中文本 → 右栏追问 → 独立同
// 工作区会话）。v1.0.0 起收敛为原生单后端，并在 manifest 层移除了
// dsh-better-sidebar peer；由上游针对 DSH 0.1.7 重命名后的图标集按名解析宿主
// 图标。版本 pin 到子模块 tag v1.0.2。
installNpmPlugin({
  id: 'sidebar-qa',
  packageSpec: 'dsh-sidebar-qa@1.0.2',
})
