#!/usr/bin/env node
// plugins/dsh-pet/install.mjs — PC2005-cloud/dsh-pet（npm 包名 dsh-pet）wrapper。
//
// 来源：git submodule（plugins/dsh-pet/dsh-pet，pin 最新版本 tag v0.2.9，
//   仅作源码参考，不参与构建）；安装走 npm（installNpmPlugin，精确版本
//   dsh-pet@0.2.9），与 dsh-web-ui 等 npm 型 wrapper 同一通道。
//
// 兼容性：v0.2.9 的 host 半 inject `webServer / agentDefaultModel / credentials /
//   llm / commands` 与 0.2.6 起相同，其中 `agentDefaultModel` 服务由本仓库 pin 的
//   base bundle（@deepseek-ai/dsh-agent-default-model）提供，host 半可正常激活；
//   浏览器半自 0.2.8 起把 `commandUi`（官方 dsh-client-ui-commands 的「/」命令
//   服务）加进本地 inject，该服务随 web-app bundle 挂载，因此 /pet 选择框注册
//   有保障。声明层的 `@deepseek-ai/dsh-client-runtime` 是模块图排序信息
//   （client-modules 只解析 `dsh.client.external` 边，缺失不影响加载）；系统通知
//   自 0.2.9 起改走 host 转发通道（host 半监听 `session/event` / `agent/error`
//   并落在 `/dsh-pet-7340/notify`，浏览器半轮询该路由），不再使用 DSH 0.1.5 已
//   移除的 `ctx.connection.api.events.mux/host`；浏览器通知权限仍由 dsh-gui 壳层
//   的 WebView2 授权弹窗支持（见 src-tauri）。故本 wrapper 不默认跳过。
//
// 桌面屏蔽：插件真正装入 profile 后，向 $DSH_HOME/dsh-pet/main-config.json
//   注入 display:"web" 的默认宠物（见 inject-config.mjs），使任何宠物都不
//   落在 desktop/both → 不拉起独立 Electron 进程、不下载 Electron。
//   0.2.9 新增的配图开关（whisperImageEnabled / chatImageEnabled）与 `memes`
//   段不注入：上游按内置默认值合并、保存时原样透传，屏蔽语义只需 display。
//
// Target: `$DSH_HOME/profiles/web/`。`DSH_HOME` 缺省仓库内 `<repo>/.dsh`，
//   显式传入的 `DSH_HOME` 优先（与共享流水线一致）。

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installNpmPlugin } from '../../scripts/plugin-install.mjs'
import { WEB_HOME } from '../../scripts/toolchain.mjs'
import { injectPetConfig, petConfigPath } from './inject-config.mjs'

const ID = 'dsh-pet'
// 精确稳定 SemVer（Market 约束：不用 latest / 版本范围 / prerelease 作安装目标）。
const PACKAGE_SPEC = 'dsh-pet@0.2.9'

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