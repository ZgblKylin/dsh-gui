#!/usr/bin/env node
/**
 * install.mjs — install the `skill-mcp-center` plugin into the selected profile.
 *
 * 从 npm 安装 `@max-null/dsh-skill-mcp-center`，固定精确版本 0.7.0 而非 `@latest`：
 * pinned pnpm 11.7 默认的 supply-chain `minimumReleaseAge` 会把过新的版本挡在
 * `@latest` 之外并静默回退到更旧版本，精确 pin 由 pnpm 自动写入豁免，安装结果确定。
 *
 * 本 wrapper 不引入 git submodule：包以发布形态提供预构建的 `dist/`（host 半）与
 * `client.js`（browser 半），没有构建步骤，仓库侧的 `install.mjs` 是唯一来源。
 *
 * 功能：设置页新增「Skill & MCP」分区，用于浏览、启停与删除 skills，以及增删、
 * 启停 `mcp-client` 服务器（经 `ctx.loader` 热应用）；安装 `dsh-better-sidebar`
 * 时另在右侧栏提供 MCP 实时状态面板（可选 peer，本工程已安装）。
 *
 * host 半的 `inject` 为 `loader`、`tools`，并从 `ctx.skills` 读取技能目录。包声明
 * `dsh.bundle.patch`，其 `cordis.patch.yml` 插入 entry（id `skill-mcp-center`，
 * name `@max-null/dsh-skill-mcp-center`），因此 `dsh plugin add` 会把它 reconcile
 * 进 `dsh.profile.bundles` 并由 bundle 层自挂载——本脚本不写手工 insert（那会
 * double-mount）。
 *
 * 准入：manifest 没有 `engines.dsh`，app-boot 闸门逐条比对 `@deepseek-ai/dsh*`
 * peer（`dsh-skill`、`dsh-tools`、`dsh-host-apiproxy`、`dsh-client-connection` 均为
 * `>=0.1.1-rc.1 <0.3.0`，按 `includePrerelease` 判定）；pinned harness
 * `dsh-v0.2.2-alpha.2` 落在区间内，无需精确版本例外。
 *
 * npm 包名会由共享流水线登记到 `<DSH_HOME>/gui/npm-installs.json`，桌面壳的更新
 * 检查据此区分 npm 安装与源码安装（见 `scripts/plugin-install.mjs` 的
 * `recordNpmInstall`）。
 *
 * Target: `$DSH_HOME/profiles/<profile>`（`DSH_PLUGIN_PROFILE` 选择 profile，默认
 * `web`）。`DSH_HOME` 由桌面壳钉到 `<runtime-root>/.dsh`；build 传入的显式覆盖由
 * 共享流水线处理。
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'skill-mcp-center',
  packageSpec: '@max-null/dsh-skill-mcp-center@0.7.0',
})
