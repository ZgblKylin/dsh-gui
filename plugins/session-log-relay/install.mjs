#!/usr/bin/env node
/**
 * install.mjs —— 把 `dsh-session-log-relay` 安装到选定的 profile。
 *
 * 内嵌包（`dsh-session-log-relay/` 与本脚本同目录），无 build 步骤：包是零运行时
 * 依赖的普通 ESM，共享流水线按发布形态直接使用。包不声明 `dsh.bundle.patch`，因此
 * 本 wrapper 传入显式 `mount`，由流水线向 profile 的 `cordis.patch.yml` 写入
 * `id: session-log-relay`、`name: dsh-session-log-relay` 的 insert 行；没有 bundle
 * 层的包只能靠这一行成为 Loader 条目。
 *
 * 安装目标只有 `$DSH_HOME/profiles/<profile>`（`$DSH_HOME` 默认
 * `<runtime-root>/.dsh`），不写系统全局位置。`DSH_PLUGIN_PROFILE` 选择 profile
 * （默认 `web`）；desktop 构建以 `DSH_PLUGIN_PROFILE=desktop` 重跑本脚本，因此插件
 * 同时装进两个 profile。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** 本插件目录：持有插件包的 wrapper。 */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'session-log-relay',
  packageDir: join(HERE, 'dsh-session-log-relay'),
  mount: { id: 'session-log-relay', name: 'dsh-session-log-relay' },
})
