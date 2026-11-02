#!/usr/bin/env node
/**
 * install.mjs — install the `dsh-pause` plugin into the selected profile.
 *
 * 来源：npm 发布包 `dsh-pause`（上游 `better-er/dsh-pause`），经
 * `installNpmPlugin` 安装**精确版本 0.1.6** 而非 `@latest`：pinned pnpm 11.7 默认的
 * supply-chain `minimumReleaseAge`（1440 分钟）会把发布不足 24h 的版本挡在 `@latest`
 * 之外并静默回退到上一版，精确 pin 让安装内容与所选上游发布一致（0.1.6 发布于
 * 2026-10-29）。本 wrapper 不引入 git submodule、不构建：发布包已含预构建的
 * `lib/index.js`（host 半）与 `lib/client.js`（browser 半），仓库侧的 `install.mjs`
 * 就是当前 profile 与全新部署共同的权威安装目标。
 *
 * 功能：「DSH·暂停」。host 半监听 `agent/pre-step` waterfall，在模型完成一轮工具交互、
 * 正要发出下一次请求之前卡住（每个 turn 的首次请求 step 为 1，永不暂停），暂停期间
 * composer 保持可用，模型侧不感知；主输入框裸 Enter 或暂停控件都放行，草稿非空时作为
 * steer 插话随本次请求一并发出。browser 半经 `conversation.input.right` slot 在
 * composer 工具行渲染开关与暂停控件。会话开关默认关闭（Config `defaultEnabled`），
 * 可在 composer 逐会话开启；宿主 RPC 走插件向 webServer 自注册的 `/dsh-pause` 前缀
 * 路由（复用 connection 的信任判定与浏览器鉴权），不碰 DSH 源码。
 *
 * 挂载：包声明 `dsh.bundle.patch`（`cordis.patch.yml` 插入 entry id `dsh-pause`、
 * name `dsh-pause`），因此 `dsh plugin add` 会把它 reconcile 进
 * `dsh.profile.bundles`，由 bundle 层自己挂载——本脚本不写手工 `cordis.patch.yml`
 * insert（那会 double-mount）。
 *
 * 准入：manifest 没有 `engines.dsh`，app-boot 闸门逐条比对 `@deepseek-ai/dsh*` peer：
 * `@deepseek-ai/dsh`、`dsh-llm`、`dsh-client-connection`、`dsh-client-ui-conversation`、
 * `dsh-client-ui-renderer`、`dsh-client-ui-slots` 六条都是 `^0.2.0-rc.2`（等价
 * `>=0.2.0-rc.2 <0.3.0-0`，按 includePrerelease 判定），本仓库 pin 的 harness
 * `dsh-v0.2.2-alpha.2` 落在区间内，安装期预检与启动期 bundle 层挂载都通过，因此
 * 不需要 `installNpmPlugin` 的 `exempt` 例外。
 *
 * 两处声明与 0.2.2-alpha.2 的差异，均不影响加载：
 * - `engines.node` 声明 `>=26.3.1`，高于 harness 自己的 `>=24.9.0`。profile 的 pnpm
 *   未开 `engine-strict`，安装只告警不拒绝；发布产物不依赖 Node 26 专有 API。
 * - `dsh.client.inject` 列出 `@deepseek-ai/dsh-client-runtime`，该包在 0.2.2-alpha.2
 *   中已不存在。`dsh.client.inject` 是 informational 的包名边缘（preflight 展示与
 *   HMR 对比），不参与 entry 激活排序，组合与客户端加载都会跳过缺席的行；插件真正
 *   的依赖是 Cordis 服务 inject——host 半 `connection` / `agents`，浏览器半
 *   `slots` / `connection` / `conversation`，这些服务随 base 与 web-app bundle 就绪。
 *
 * npm 包名会由共享流水线登记到 `<DSH_HOME>/gui/npm-installs.json`，桌面壳的更新
 * 检查据此区分 npm 安装与源码安装（见 `scripts/plugin-install.mjs` 的
 * `recordNpmInstall`）。
 *
 * Target：`$DSH_HOME/profiles/<profile>`（`DSH_PLUGIN_PROFILE` 选择 profile，默认
 * `web`）。`DSH_HOME` 由桌面壳钉到 `<runtime-root>/.dsh`；显式覆盖由共享流水线处理。
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'dsh-pause',
  packageSpec: 'dsh-pause@0.1.6',
})
