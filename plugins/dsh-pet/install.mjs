#!/usr/bin/env node
// plugins/dsh-pet/install.mjs — PC2005-cloud/dsh-pet（npm 包名 dsh-pet）wrapper。
//
// 来源：git submodule（plugins/dsh-pet/dsh-pet，pin 版本 tag v0.3.6，仅作源码参考，
//   不参与构建）；安装走 npm（installNpmPlugin，精确版本 dsh-pet@0.3.6），与其它
//   npm 型 wrapper 同一通道。
//
// 兼容性：v0.3.6 的 9 条 `@deepseek-ai/dsh*` peer 均为 `^0.2.0-rc.1`（相对 v0.3.1 新增
//   `@deepseek-ai/dsh-client-ui-primitives`），经准入闸门的
//   `semver.satisfies(..., { includePrerelease: true })` 判定覆盖本仓库 pin 的 harness
//   `0.2.1-alpha.1`，安装期准入预检与启动期 bundle 层挂载都通过，因此不需要
//   installNpmPlugin 的 `exempt` 例外。host 半 inject 为
//   `webServer / agentDefaultModel / credentials / llm / commands`：其中
//   `agentDefaultModel` 由本仓库 pin 的 base bundle
//   （@deepseek-ai/dsh-agent-default-model）提供，其余服务随 base 与 web-app bundle
//   挂载，host 半可正常激活。浏览器半在 `src/client/app.ts` 声明本地 inject
//   `slots / locale / connection / remote / remote.commands / commandUi`：`commandUi`
//   是官方 dsh-client-ui-commands 的「/」命令服务，随 web-app bundle 挂载，`/pet`
//   选择框注册有保障；声明层 `dsh.client.inject` 只列
//   `@deepseek-ai/dsh-client-connection`（随 web-app bundle 挂载）。系统通知走 host
//   转发通道：host 半监听 `session/event` 与 `agent/error`，把帧落在
//   `/dsh-pet-7340/notify`，浏览器半轮询该路由。故本 wrapper 不默认跳过。
//
// 桌面屏蔽：插件真正装入 profile 后，向用户层配置注入 display:"web" 的默认宠物
//   （见 inject-config.mjs），使任何宠物都不落在 desktop/both → 不拉起独立 Electron
//   进程、不下载 Electron。
//
// Target: `$DSH_HOME/profiles/web/`。`DSH_HOME` 缺省仓库内 `<runtime-root>/.dsh`，
//   显式传入的 DSH_HOME 优先（与共享流水线一致）。

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installNpmPlugin } from '../../scripts/plugin-install.mjs'
import { WEB_HOME } from '../../scripts/toolchain.mjs'
import { injectPetConfig, petConfigPath } from './inject-config.mjs'

const ID = 'dsh-pet'
// 精确稳定 SemVer（Market 约束：不用 latest / 版本范围 / prerelease 作安装目标）。
const PACKAGE_SPEC = 'dsh-pet@0.3.6'

installNpmPlugin({ id: ID, packageSpec: PACKAGE_SPEC })

// 注入只在该插件实际位于 profile 时执行（默认跳过时没有包可注入，也不该留孤儿配置）。
// profile 用 hoisted linker（pinProfileStore 写入），包落在 node_modules/dsh-pet。
const dshHome = process.env.DSH_HOME ?? WEB_HOME
const installed = existsSync(
  join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-pet', 'package.json'),
)
if (!installed) {
  console.log(
    `  dsh-pet not present in profile (install failed) — ` +
      `desktop-block config injection skipped.`,
  )
} else {
  const target = petConfigPath(dshHome)
  mkdirSync(dirname(target), { recursive: true })
  const result = injectPetConfig(target)
  const label =
    result === 'created'
      ? 'created'
      : result === 'patched'
        ? 'patched (display -> web)'
        : 'left untouched (display already configured)'
  console.log(`  dsh-pet user config ${label}: ${target}`)
}
