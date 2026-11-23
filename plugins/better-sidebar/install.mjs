#!/usr/bin/env node
/**
 * install.mjs — install the `better-sidebar` plugin group into the web profile.
 *
 * DSH-better-sidebar 从 npm 安装，spec 为 `dsh-better-sidebar@latest`：安装时由
 * 共享流水线查询 registry 的 latest 精确版本并安装该版本，已装同一版本时跳过，
 * 因此上游发布新版本后重跑本脚本即可升级，仓库内不维护版本号。上游自 v0.21.1 起
 * 把右列交由 DSH 原生右侧栏承载、插件把各 tab 类型注册为原生 tab 并只保留底部
 * 工作台与 `ctx.betterSidebar` 服务。
 *
 * 准入：包没有 engines.dsh，闸门逐条比对 14 条 `@deepseek-ai/dsh-*` peer；0.2.2
 * 线的发布把该 peer 定为 `^0.2.2-rc.1`，本工程 pinned 的 harness 0.2.3-alpha.2
 * 落在区间内，不需要 `exempt` 例外。若某次 latest 抬高 peer 下限而被闸门拒绝，构建会
 * 以该包名失败；此时按 plugins/README.md 的说明临时固定版本，或用
 * `DSH_PLUGIN_SKIP=better-sidebar` 屏蔽本 wrapper。
 *
 * 与 harness 的硬依赖：0.26.0 的 host inject 仍含 `webRuntime`，而该服务已在 0.2.1-alpha.1
 * 移除，旧包在 0.2.2 线上会因依赖缺失整层 pending；0.28.x 改用 `connection` 服务与
 * `ctx.connection.requestRejection`，由官方 web-app bundle 的 `ui-connection` 行提供。
 * 因此本 pin 必须与 harness 同批更换。
 *
 * 模型选择适配：0.28.2 在 `src/sidechat-routes.ts` 以两参调用
 * `installModelSelection(agent.ctx, ref)`，而 harness 0.2.2 起该函数只接收 `agentCtx`，
 * 侧聊的模型选择 ref 路径因此失效；0.30.1 已改写为 `agent.model.select(...)`
 * （`sidechat-routes.ts` 的 `model.select(brandedSelection(selection))`，对应 DSH
 * 0.2.2 的 `agent.model` seam），旧限制随之解除。
 *
 * dsh-sidebar-qa 同样从 npm 安装，spec 为 `dsh-sidebar-qa@latest`。安装顺序为
 * better-sidebar → sidebar-qa，同一相对顺序也落在 `dsh.profile.bundles`；
 * dsh-sidebar-qa 自 v1.0.0 起不再声明 better-sidebar peer（原生单后端重构），
 * 它的顺序只用于保持既有排布。host 半用 Config + volatile、按 profile 条目 id
 * 寻址，设置项因此可持久化；信任围栏读 `webStartup`，并按 `webServer.host` 与
 * bind IP 规范化，修复 LAN / `--trusted-host` 访问 `/sidebarqa/api` 恒 403 的
 * 问题。client 半按 `assistantStream` 逐段渲染回答，失败或中断的轮次显示
 * 「本轮回答失败：<原因>」。manifest 的 `engines.dsh >=0.1.7-alpha.1` 覆盖
 * pinned harness 0.2.3-alpha.2。
 *
 * 已知限制（上游 1.2.2 仍未适配）：`src/client/session-wire.ts` 的
 * `ctx.remote.session.follow(...)` 没有传 `activate: true`，而 harness 0.2.2 起
 * 省略该字段不再自动恢复冷普通 Agent，因此跟随一个未激活会话时面板显示历史但
 * 不产生回答。等上游补 `activate` 后移除本记录。
 *
 * 两个包都声明 `dsh.bundle.patch`，所以 `dsh plugin add` 各自 reconcile 进
 * `dsh.profile.bundles` 并由其 bundle 层插入 Loader entry——不写手工 insert
 * （那会 double-mount）。
 *
 * Target: `$DSH_HOME/profiles/web/`。`DSH_HOME` 被桌面壳钉到 `<runtime-root>/.dsh`；
 * 本脚本尊重显式 `DSH_HOME` 覆盖（build 会传一个），否则取同一仓库内默认值。
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

await installNpmPlugin({
  id: 'better-sidebar',
  packageSpec: 'dsh-better-sidebar@latest',
})

// 然后 dsh-sidebar-qa：独占的「追问」原生面板（选中文本 → 右栏追问 → 独立同
// 工作区会话）。它与 better-sidebar 同走 latest 跟踪，安装顺序见头部注释。
await installNpmPlugin({
  id: 'sidebar-qa',
  packageSpec: 'dsh-sidebar-qa@latest',
})
