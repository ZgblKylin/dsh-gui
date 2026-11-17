#!/usr/bin/env node
/**
 * install.mjs — install the `dsh-you-should-know` plugin into the selected
 * profile.
 *
 * 来源：npm 发布包 `dsh-you-should-know`（上游 `lolipop-1x1/dsh-you-should-know`），
 * spec 为 `dsh-you-should-know@latest`：安装时由共享流水线查询 registry 的 latest
 * 精确版本并安装该版本，已装同一版本时跳过，因此上游发布新版本后重跑本脚本即可升级，
 * 仓库内不维护版本号。本 wrapper 不引入 git submodule、不构建：发布包已含预构建的
 * `dist/host/index.js`（host 半）与 `dist/client.js`（browser 半）。
 *
 * 功能：「You Should Know」任务提醒。host 半在主会话模型请求扩展点捕获完整请求快照
 * （系统提示、用户消息、助手回答、工具调用/结果与工具声明），按配置步长后台用独立
 * 观察者模型（默认跟随主会话模型）判断值得理解的重要事实、方案取舍与背景知识；browser
 * 半在输入框上方以可收起的浮层展示提醒，支持按需解释、标记已了解、带回主会话继续讨论
 * 与独立设置。观察只读取既有上下文，不运行工具，观察请求/响应不写入主会话记录。
 *
 * 挂载：包声明 `dsh.bundle.patch`（`cordis.patch.yml` 插入 entry id
 * `dsh-you-should-know`、name `dsh-you-should-know`），因此 `dsh plugin add` 会把
 * 它 reconcile 进 `dsh.profile.bundles`，由 bundle 层自己挂载——本脚本不写手工
 * `cordis.patch.yml` insert（那会 double-mount）。
 *
 * 准入：manifest 没有 `engines.dsh`，app-boot 闸门逐条比对 `@deepseek-ai/dsh*` peer：
 * `@deepseek-ai/dsh-agent`、`dsh-client-connection`、`dsh-llm`、`dsh-session`、
 * `dsh-storage-domain` 五条都是 `>=0.2.0-rc.2 <0.3.0-0`，本仓库 pin 的 harness
 * `dsh-v0.2.2-rc.3` 按 includePrerelease 落在区间内，安装期预检与启动期 bundle 层
 * 挂载都通过，因此不需要 `installNpmPlugin` 的 `exempt` 例外。
 *
 * 其余声明与 0.2.2-rc.3 的差异，均不影响加载：
 * - `@deepseek-ai/cordis` peer 为 `^4.0.4 || ^4.0.5-alpha.1`（derivs Config schema
 *   依赖）：这是非 dsh 相关 peer，不进准入闸门；运行时 cordis 为 4.x 线，`4.1.0`
 *   满足 `^4.0.4`。
 * - `engines.node` 声明 `>=22.19.0`，低于 harness 自己的 Node 下限，无阻。
 * - `dsh.client.inject`（`@deepseek-ai/dsh-client-locale`、
 *   `dsh-client-ui-conversation`、`dsh-client-ui-settings`、`dsh-api-gateway`）是
 *   informational 的包名边缘（preflight 展示与 HMR 对比），缺席的行会被跳过；插件
 *   真正的依赖是 Cordis 服务 inject（host 半 llm / agent / session，browser 半
 *   会话输入区插槽），随 base 与 web-app bundle 就绪。
 *
 * npm 包名会由共享流水线登记到 `<DSH_HOME>/gui/npm-installs.json`，桌面壳的更新
 * 检查据此区分 npm 安装与源码安装（见 `scripts/plugin-install.mjs` 的
 * `recordNpmInstall`）。
 *
 * Target：`$DSH_HOME/profiles/<profile>`（`DSH_PLUGIN_PROFILE` 选择 profile，默认
 * `web`）。`DSH_HOME` 由桌面壳钉到 `<runtime-root>/.dsh`；显式覆盖由共享流水线处理。
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

await installNpmPlugin({
  id: 'dsh-you-should-know',
  packageSpec: 'dsh-you-should-know@latest',
})