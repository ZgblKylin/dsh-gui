# npm 插件批量升级：11 个精确 pin 抬到 registry 最新发布

本文件记录把 `plugins/` 下 11 个 npm 型插件的精确 pin 一次抬到各自 registry
最新版本的取舍与验收结果。本轮不涉及 `deepseek-harness` 与 `src-tauri/whale-icon`
子模块，运行时保持 `dsh-v0.2.2-rc.1`。流程按 skill
[dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md)：先在副本
`.staging/dsh-gui` 换 pin、构建、验收，通过后把工作分支 `staging/verify` 合并回本工程。

## 目标版本

| 插件 | 安装脚本 | 旧 pin | 新 pin |
| --- | --- | --- | --- |
| dsh-better-sidebar | `plugins/better-sidebar/install.mjs` | `0.28.2` | **0.30.1** |
| @mars-sea/dsh-commandcode-provider | `plugins/commandcode-provider/install.mjs` | `0.15.5` | **0.17.3** |
| @smalltailqwq/dsh-client-ui-skin-deep-whale-manager | `plugins/deep-whale/install.mjs` | `0.1.8` | **0.1.9** |
| @smalltailqwq/dsh-client-ui-skin-orca-link | `plugins/deep-whale/install.mjs` | `0.1.9` | **0.1.10** |
| ds-harness-remote | `plugins/ds-harness-remote/install.mjs` | `0.6.0` | **0.6.3** |
| dsh-pause | `plugins/dsh-pause/install.mjs` | `0.1.6` | **0.1.8** |
| dsh-pet | `plugins/dsh-pet/install.mjs` | `0.3.8` | **0.4.6** |
| @linxin666/dsh-client-ui-skill-explorer | `plugins/dsh-web-ui/install.mjs` | `0.4.12` | **0.4.16** |
| @linxin666/dsh-client-ui-web-ui-settings | `plugins/dsh-web-ui/install.mjs` | `0.4.12` | **0.4.16** |
| @linxin666/dsh-usage | `plugins/dsh-web-ui/install.mjs` | `0.4.12` | **0.4.16** |
| dshmarket | `plugins/plugin-market/install.mjs` | `1.73.3` | **1.73.15** |

未改动：`@smalltailqwq/dsh-client-ui-skin-maid-atelier`（保持 `0.1.9`）、
`dsh-sidebar-qa@1.2.2`、`@max-null/dsh-skill-mcp-center@0.7.0`。

所有目标版本均等于各自 `dist-tags.latest`，无 prerelease 或版本范围安装目标。

## 上游变更与准入

准入闸门读取包 manifest 的 `engines.dsh`（存在时），否则逐条比对 `@deepseek-ai/dsh*`
peer。运行中的 harness 是 `0.2.2-rc.1`：

| 插件 | 要点 |
| --- | --- |
| better-sidebar 0.30.1 | 14 条 dsh peer 全部抬到 `^0.2.2-rc.1`（新增 `dsh-client-ui-input-trigger`，由 web-app bundle 的 `ui-input-trigger` 行提供），放行；host inject 仍 `webServer/sessions/connection/tools`；entry id `better-sidebar` 不变；**0.30.x 起上游安装器会检查 profile 的 host-tree 是否混入多份 dsh 副本**（本仓库走 `dsh plugin add`，不跑该检查）；`installModelSelection` 两参调用已改为 `agent.model.select(...)`，旧「模型选择契约未适配」限制解除 |
| commandcode-provider 0.17.3 | `engines.dsh` 改为 `>=0.2.1-rc.2 <0.2.2-0 \|\| >=0.2.2-alpha.2 <0.2.3-0`，`0.2.2-rc.1` 落在第二段 → **撤销 0.15.5 时代的精确版本例外**；`engines.node` 抬到 `>=24.9`；entry id `llm-commandcode` 不变 |
| deep-whale manager 0.1.9 / orca-link 0.1.10 | manager peer `>=0.1.7-rc.1` 不变；orca-link peer 由 `>=0.2.0-rc.2 <0.3.0-0` 收窄为 `>=0.2.2-0 <0.2.3-0`，`includePrerelease` 下覆盖 `0.2.2-rc.1`；三包 entry id 不变 |
| ds-harness-remote 0.6.3 | peer 区间不变（多段析取），放行；**bundle patch 删除了 `ds-harness-remote-tui` 条件行**，只插 `ds-harness-remote` |
| dsh-pause 0.1.8 | 六条 dsh peer 仍 `^0.2.0-rc.2`；新增非 dsh peer `@deepseek-ai/schemastery >=3.18.0`；新功能 Pause 键与空闲「强制继续」（`agent.followup`） |
| dsh-pet 0.4.6 | 9 条 dsh peer 仍 `^0.2.0-rc.1`；host inject 实为 6 项（`connection` 自 0.3.8 起就在，旧文档漏写）；新增 `@andresaya/edge-tts` 依赖与语音/睡觉台词/托盘/点击音效等默认配置键；entry id `dsh-pet` 不变 |
| linxin666 三包 0.4.16 | peer 下界由 `>=0.2.1-rc.3` 抬到 `>=0.2.2-rc.1`，放行；新增 `locale/` 双语文件；entry id `ui-web-ui-settings` / `ui-skill-explorer` / `usage` 不变 |
| dshmarket 1.73.15 | `@deepseek-ai/dsh-settings` peer 六段析取不变，放行；含 #411 空闲期安全延迟插件变更、#1122 Windows GBK 控制台解码、GitHub archive 更新识别；entry id `dsh-market` 不变 |

`prepare` 生命周期脚本：commandcode-provider / dsh-pause / dshmarket **旧版本即已声明**，
非本轮新增；registry tarball 安装不执行 `prepare`。

## 适配改动

| 文件 | 改动 |
| --- | --- |
| 八个 `plugins/<id>/install.mjs` | 11 处 `packageSpec` 精确版本抬到上表值；头部兼容性注释同步 |
| `plugins/commandcode-provider/install.mjs` | 删除 `exempt`（0.17.3 自行接纳 `0.2.2-rc.1`），注释改写为双段析取说明 |
| `plugins/better-sidebar/install.mjs` | peer 说明 `^0.2.1-rc.1` → `^0.2.2-rc.1`、13 → 14 条；模型选择限制改写为「0.30.1 已适配」 |
| `plugins/deep-whale/install.mjs` | 每包独立版本与 peer 区间描述（manager 0.1.9、maid-atelier 0.1.9、orca-link 0.1.10） |
| `plugins/ds-harness-remote/install.mjs` | bundle 说明改为 0.6.3 只插一个 entry（tui entry 已删） |
| `plugins/dsh-pet/install.mjs` | 发布状态、host inject 6 项、peer 版本同步 |
| `plugins/README.md`、`plugins/{commandcode-provider,dsh-pause,dsh-pet,dsh-web-ui}/README.md` | pin 数字、例外段（现无 wrapper 需要例外）、各包准入与功能描述 |
| `README.md`、`docs/dsh-gui/dsh-pet-troubleshooting.md` | 根文档与排错文档里的旧 pin |

## 验收（阶段一，副本内）

1. **构建**：`npm run build -- --skip-exe`（`DSH_HOME=<仓库根>/.staging/.dsh`）exit 0；
   dsh 运行时 `@deepseek-ai/dsh@0.2.2-rc.1` 复用，17 个安装脚本全部走完。
2. **组合冒烟**：build 内置的 `--profile web --dump-config` 复合检查 **passed**，
   无 `duplicate loader entry id`、无 patch 缺失；11 个插件的 bundle 层全部进入组合
   （`better-sidebar` / `llm-commandcode` / `ui-skin-*` / `ds-harness-remote` / `dsh-pause` /
   `dsh-pet` / `ui-web-ui-settings` / `ui-skill-explorer` / `usage` / `dsh-market`）。
3. **装出的版本**：副本 profile 的 13 个目标包声明版本与实际 `node_modules` 版本逐项一致
   （`verify-versions.mjs` 全 ok），`dsh.profile.bundles` 19 项包含全部 11 个新插件。
4. **WebUI 加载验收**：副本以自身 DSH_HOME 在端口 3090 启动，界面完整渲染（侧边栏 /
   会话树 / 输入框 / 全局面板 / 用量卡 / 皮肤 / 宠物），控制台可见各插件 client 半加载：
   `dsh-better-sidebar` 打印 `quote chips ready`（0.30.1 新功能）、`dsh-sidebar-qa` 注册 2 个
   右侧栏 tab、`dsh-pet` 渲染宠物与对话气泡、deep-whale 女仆皮肤渲染、技能中心面板列出
   技能来源分组。无插件加载失败提示，无 `DesktopHostFatalError`。
5. **插件屏蔽**：本轮无屏蔽项。

### 已知非插件问题

- 首次构建在 `mcp-on-demand` 之后挂起（无 I/O、无网络、25 分钟无进展），进程持有
  `profiles/web/package.json.lock`。终止构建、删除陈旧锁与
  `.plugin-manager/run.json` 后重跑即完成，产物一致。
- WebUI 控制台的 `dsh-market.com/api/telemetry` CORS 报错来自外部遥测端点；
  `ds-harness-remote` 的 `ACCOUNT_AUTH_REQUIRED` 是未登录 Remote 账号的正常状态；
  全新 home 的「开始使用」登录弹窗与 `playwright-mcp` 会话恢复警告同为环境状态，
  均与本轮 pin 无关。

## 风险

- **better-sidebar 0.30.x 的混合 host-tree 检查**：若 profile 中混入多份 `@deepseek-ai/dsh-*`
  副本，宿主会报 `DesktopHostFatalError`（不点名包）。本轮副本构建与启动均未触发；
  主工程就地升级时按上游
  `node <profile>/node_modules/dsh-better-sidebar/scripts/check-profile-host-tree.mjs <profile>`
  排查。
- 主工程 profile 需在停止运行中的实例后重跑 `npm run build` 才会换成新版本；只改脚本
  不重建仍是旧版本。
