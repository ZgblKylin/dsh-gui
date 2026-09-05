#!/usr/bin/env node
// plugins/dsh-pet/install.mjs — PC2005-cloud/dsh-pet（npm 包名 dsh-pet）wrapper。
//
// 来源：git submodule（plugins/dsh-pet/dsh-pet，pin 最新版本 tag v0.2.6，
//   仅作源码参考，不参与构建）；安装走 npm（installNpmPlugin，精确版本
//   dsh-pet@0.2.6），与 dsh-web-ui 等 npm 型 wrapper 同一通道。
//
// 兼容性：v0.2.6 的 host 半 inject `webServer / agentDefaultModel / credentials /
//   llm / commands`，其中 `agentDefaultModel` 服务在本仓库 pin 的
//   dsh-v0.1.2-rc.1 已由 base bundle（@deepseek-ai/dsh-agent-default-model）
//   提供，host 半可正常激活；浏览器半原依赖的 `@deepseek-ai/dsh-client-runtime`
//   在本 harness 中已被 dsh-client-connection / dsh-client-store /
//   dsh-client-modules 取代，但经实测 dsh-pet 的浏览器半可正常加载运行（系统
//   通知权限由 dsh-gui 壳层的 WebView2 授权弹窗支持，见 src-tauri）。故本
//   wrapper 不再默认跳过。
//
// 桌面屏蔽：插件真正装入 profile 后，向 $DSH_HOME/dsh-pet/main-config.json
//   注入 display:"web" 的默认宠物（见 inject-config.mjs），使任何宠物都不
//   落在 desktop/both → 不拉起独立 Electron 进程、不下载 Electron。
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
const PACKAGE_SPEC = 'dsh-pet@0.2.6'

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