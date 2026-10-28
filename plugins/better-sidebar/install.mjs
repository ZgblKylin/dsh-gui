#!/usr/bin/env node
/**
 * install.mjs — install the `better-sidebar` plugin group into the web profile.
 *
 * DSH-better-sidebar 从 npm 安装：v0.28.0 的 13 条 @deepseek-ai/dsh-* peerDeps
 * 全部指向 ^0.2.1-rc.1，与本工程 pinned 的 dsh-v0.2.1-rc.3 harness 匹配——准入
 * 闸门对没有 engines.dsh 的包逐条比对 dsh peer 区间，0.2.1-rc.3 落在
 * ^0.2.1-rc.1（>=0.2.1-rc.1 <0.3.0-0）内。上游自 v0.21.1 起把右列交由 DSH 原生
 * 右侧栏承载、插件把各 tab 类型注册为原生 tab 并只保留底部工作台与
 * `ctx.betterSidebar` 服务。固定精确版本而非 @latest，是因为 pinned pnpm 11.7
 * 默认的 supply-chain minimumReleaseAge 会把过新的版本挡在 @latest 之外、静默回退
 * 到更旧版本；精确 pin 由 pnpm 自动写入 profile 的 minimumReleaseAgeExclude，安装
 * 结果确定。
 * 子模块 remote：`origin` = 官方 `omdsh-dev/DSH-better-sidebar`（子模块
 * checkout 仅作源码参考）。
 *
 * 与 harness 的硬依赖：0.26.0 的 host inject 仍含 `webRuntime`，而 rc.2 已移除该
 * 服务，旧包在 rc.2 上会因依赖缺失整层 pending；0.28.0 改用 `connection` 服务与
 * `ctx.connection.requestRejection`，由官方 web-app bundle 的 `ui-connection` 行提供。
 * 因此本 pin 必须与 harness 同批更换。
 *
 * dsh-sidebar-qa 同样从 npm 安装，pin 到与其 git submodule tag 一致的精确版本
 * dsh-sidebar-qa@1.2.1，不用 `@latest`：pinned pnpm 11.7 默认
 * supply-chain minimumReleaseAge 会对 `@latest`/范围静默回退到更旧版本，精确
 * pin 则直接安装并自动豁免，保证结果确定。安装顺序为 better-sidebar →
 * sidebar-qa，同一相对顺序也落在 `dsh.profile.bundles`；dsh-sidebar-qa 自
 * v1.0.0 起不再声明 better-sidebar peer（原生单后端重构），它的顺序只用于
 * 保持既有排布。host 半用 Config + volatile、按 profile 条目 id 寻址，设置项
 * 因此可持久化；1.2.1 起信任围栏读 `webStartup`，并按 `webServer.host` 与 bind IP
 * 规范化，修复 LAN / `--trusted-host` 访问 `/sidebarqa/api` 恒 403 的问题。
 * client 半按 `assistantStream` 逐段渲染回答，失败或中断的轮次显示
 * 「本轮回答失败：<原因>」。manifest 的 `engines.dsh >=0.1.7-alpha.1` 覆盖
 * pinned harness 0.2.1-rc.3，peer 与 `dsh.client.inject` 均无变化。
 *
 * 两个包都声明 `dsh.bundle.patch`，所以 `dsh plugin add` 各自 reconcile 进
 * `dsh.profile.bundles` 并由其 bundle 层插入 Loader entry——不写手工 insert
 * （那会 double-mount）。
 *
 * Target: `$DSH_HOME/profiles/web/`。`DSH_HOME` 被桌面壳钉到 `<runtime-root>/.dsh`；
 * 本脚本尊重显式 `DSH_HOME` 覆盖（build 会传一个），否则取同一仓库内默认值。
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'better-sidebar',
  // 固定 0.2.1 线适配版 0.28.0（见头部注释；@latest 会被 minimumReleaseAge 挡回更旧版本）。
  packageSpec: 'dsh-better-sidebar@0.28.0',
})

// 然后 dsh-sidebar-qa：独占的「追问」原生面板（选中文本 → 右栏追问 → 独立同
// 工作区会话）。v1.0.0 起收敛为原生单后端，并在 manifest 层移除了
// dsh-better-sidebar peer；由上游针对 DSH 0.1.7 重命名后的图标集按名解析宿主
// 图标。host 半用 Config + volatile、按 profile 条目 id 寻址，设置项可持久化；
// 1.2.1 起信任围栏读 `webStartup`（按 `webServer.host` 与 bind IP 规范化），修复
// LAN / `--trusted-host` 访问 `/sidebarqa/api` 恒 403 的问题；client 半按
// `assistantStream` 逐段渲染回答，失败或中断的轮次显示原因。manifest 的
// `engines.dsh >=0.1.7-alpha.1` 覆盖 pinned harness 0.2.1-rc.3，准入闸门按
// engines.dsh 判定放行。
// 版本 pin 到子模块 tag v1.2.1。
installNpmPlugin({
  id: 'sidebar-qa',
  packageSpec: 'dsh-sidebar-qa@1.2.1',
})
