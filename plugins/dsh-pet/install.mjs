#!/usr/bin/env node
// plugins/dsh-pet/install.mjs — PC2005-cloud/dsh-pet（npm 包名 dsh-pet）wrapper。
//
// 来源：git submodule（plugins/dsh-pet/dsh-pet，pin 最新版本 tag v0.2.6，
//   仅作源码参考，不参与构建）；安装走 npm（installNpmPlugin，精确版本
//   dsh-pet@0.2.6），与 dsh-web-ui 等 npm 型 wrapper 同一通道。
//
// 兼容性（client 半不兼容，默认跳过）：
//   - v0.2.6 的 host 半 inject `webServer / agentDefaultModel / credentials /
//     llm / commands`，其中 `agentDefaultModel` 服务在本仓库 pin 的
//     dsh-v0.1.2-rc.1 已由 base bundle（@deepseek-ai/dsh-agent-default-model）
//     提供，host 半可正常激活（v0.2.4 时的“无此服务”阻断已解除）；
//   - 但 client 半 `dsh.client.inject` 仍依赖已被移除的旧运行时
//     `@deepseek-ai/dsh-client-runtime`（dsh-v0.1.2-rc.1 改用
//     dsh-client-connection / dsh-client-store / dsh-client-modules），
//     浏览器侧加载会 miss module table，桌宠 UI 无法渲染。
//   因此本 wrapper 向 installNpmPlugin 传入 `skip` 声明默认跳过（屏蔽入口在
//   插件脚本，共享流水线不再硬编码）；待上游改用新 client 运行时后把 `skip`
//   改为 `null` 即可恢复，或临时强制安装：DSH_PLUGIN_FORCE_INSTALL=1（见
//   docs/dsh-gui/dsh-pet-troubleshooting.md）。
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
// 屏蔽入口：默认跳过（原因见头部注释）。upstream 改用新 client 运行时后改为 null 恢复。
const SKIP_REASON = 'client-half still requires the removed @deepseek-ai/dsh-client-runtime'

installNpmPlugin({ id: ID, packageSpec: PACKAGE_SPEC, skip: SKIP_REASON })

// 注入只在该插件实际位于 profile 时执行（默认跳过时没有包可注入，也不该留孤儿配置）。
// profile 用 hoisted linker（pinProfileStore 写入），包落在 node_modules/dsh-pet。
const dshHome = process.env.DSH_HOME ?? WEB_HOME
const installed = existsSync(
  join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-pet', 'package.json'),
)
if (!installed) {
  console.log(
    `  dsh-pet not present in profile (skipped by default or install failed) — ` +
      `desktop-block config injection skipped. Set DSH_PLUGIN_FORCE_INSTALL=1 to install.`,
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