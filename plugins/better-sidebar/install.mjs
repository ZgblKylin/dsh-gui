#!/usr/bin/env node
/**
 * install.mjs — install the `better-sidebar` plugin group into the web profile.
 *
 * ⚠️ TEMP (fork-source): DSH-better-sidebar 暂时改为【源码安装】——z-index 图层
 * 修复（宿主层 40→25，防底部面板遮挡 ui-cordis 动态插件面板）尚未发版到 npm。
 * 子模块 remote 命名：`origin` = 官方 `omdsh-dev/DSH-better-sidebar`，
 * `fork` = `ZgblKylin/DSH-better-sidebar`（本地 fix 分支推 fork，合入官方后发版）。
 * 上游发版后还原：把下方第一个 installPlugin 块整体换回
 *   installNpmPlugin({ id: 'better-sidebar', packageSpec: 'dsh-better-sidebar@latest' })
 * 并删除本 TEMP 注释块（含下方 `TEMP(fork-source)` 标记）。
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

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installNpmPlugin, installPlugin } from '../../scripts/plugin-install.mjs'

/** 本 wrapper 目录——持有各插件包（submodule checkout 或 in-tree 包）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

// TEMP(fork-source) — DSH-better-sidebar 源码安装（fork，link 模式）；
// 上游发版后删除本块并恢复下方 installNpmPlugin 调用。
installPlugin({
  id: 'better-sidebar',
  packageDir: join(HERE, 'DSH-better-sidebar'),
  sourceHint: 'git submodule update --init plugins/better-sidebar/DSH-better-sidebar',
})
// TEMP(fork-source) end

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
