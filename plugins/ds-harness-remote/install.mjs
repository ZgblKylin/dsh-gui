#!/usr/bin/env node
/**
 * install.mjs — install the `ds-harness-remote` plugin into the selected profile.
 *
 * 从 npm 安装 `ds-harness-remote`（DSH Remote：基于 P2P 端到端加密连接的远程访问
 * 插件，让 PC、移动端与 Web 访问本机 Harness 会话与工作区），固定精确版本 `0.6.0`
 * 而非 `@latest`：pinned pnpm 11.7 默认的 supply-chain `minimumReleaseAge` 会把过新
 * 的版本挡在 `@latest` 之外并静默回退到更旧版本，精确 pin 由 pnpm 自动写入豁免。
 *
 * 上游：https://github.com/liguobao/ds-harness-remote（默认分支 main，远程 Web
 * https://dsh.r2049.cn/app）。包以发布形态提供预构建的 `dist/index.js`（host 半）与
 * `dist/client.js`（browser 半），没有构建步骤，本 wrapper 不引入 submodule。
 *
 * 功能：安装后在设置页出现 Remote 面板，登录 Remote 账号即可从其他设备接入；host 半
 * 另注册 `remote_*` 系列工具（列出在线机器与工作区、读写/创建会话、收发消息、上传下载
 * 文件，需要官方 `tools` service）。不打开公网监听端口、无需路由端口转发。
 *
 * 包声明 `dsh.bundle.patch`（`cordis.patch.yml`）：`dsh plugin add` 会把它 reconcile 进
 * `dsh.profile.bundles`，bundle 层自行插入 `ds-harness-remote`（普通 profile 启用）与
 * `ds-harness-remote-tui`（仅有 dsh-tui 入口时启用）两个 entry，因此本脚本不写手工
 * insert（那会 double-mount）。
 *
 * 准入：manifest 无 `engines.dsh`，app-boot 闸门逐条比对 `@deepseek-ai/dsh*` peer
 * （`@deepseek-ai/dsh-settings`、`dsh-api-gateway`、`dsh-client-*` 等为
 * `>=0.2.2-0 <0.2.3-0`），按 `includePrerelease` 判定时 pinned harness
 * `dsh-v0.2.2-alpha.3` 落在区间内，无需精确版本例外。
 *
 * 依赖：`ws`、`zod`、`qrcode`、`@xterm/headless`、`@xterm/addon-serialize`、
 * `@deepseek-ai/schemastery`；`optionalDependencies` 含原生 WebRTC 模块
 * `@roamhq/wrtc`（下载/编译失败不影响主功能，pnpm 会按 optional 跳过）。
 *
 * 与本仓库内建的 `dsh-remote`（plugins/remote）是两套独立的远程方案：`dsh-remote`
 * 是多后端切换 / SSH 隧道 / docker exec 的自研方案，本插件是社区 P2P 加密远程访问；
 * 两者可同时安装，各用自己的入口与 entry id。
 *
 * Target: `$DSH_HOME/profiles/<profile>`（`DSH_PLUGIN_PROFILE` 选择 profile，默认
 * `web`；desktop 构建时同一脚本装到 desktop profile）。`DSH_HOME` 由桌面壳钉到
 * `<runtime-root>/.dsh`；build 传入的显式覆盖由共享流水线处理。
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'ds-harness-remote',
  packageSpec: 'ds-harness-remote@0.6.0',
})
