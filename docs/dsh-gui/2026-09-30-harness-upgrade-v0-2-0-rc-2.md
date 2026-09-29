# harness 升级：dsh-v0.1.7-rc.2 → dsh-v0.2.0-rc.2

本文件记录把工程基座 `deepseek-harness` 与 6 个插件模块升级到目标修订的过程，以及阶段一（副本 `.staging/dsh-gui`）的适配、验证结果与遗留。流程与门槛见 skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md)。

## 目标修订与发布状态

| 模块 | 旧修订 | 新修订 | npm |
| --- | --- | --- | --- |
| deepseek-harness | dsh-v0.1.7-rc.2 | dsh-v0.2.0-rc.2 | `@deepseek-ai/dsh@0.2.0-rc.2` 已发布（`latest`） |
| DSH-better-sidebar | v0.21.1 | v0.24.1 | 已发布，`latest` 即目标版本 |
| dsh-flowglass | v0.7.2 | v0.7.3 | 已发布 |
| dsh-sidebar-qa | v1.0.2 | v1.1.0 | 已发布 |
| dshmarket | v1.65.3 | v1.66.5 | 已发布 |
| dsh-web-ui 四个包 | v0.4.2 | v0.4.4 | 四包均已发布 |
| dsh-deep-whale | v0.1.5 | v0.1.6 | 仅两块皮肤有 0.1.6，管理包仍为 0.1.5 |

`dsh-pet`（v0.2.12）与 `src-tauri/whale-icon` 不在本次目标内。

## 上游变更

发布说明（[v0.2.0-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)）。与本仓库组合相关的主要变更：

| 变更 | 说明 |
| --- | --- |
| **插件版本准入闸门收紧** | `packages/boot/app-boot/src/plugin-compatibility.ts` 把包的 `peerDependencies` 中 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 项与**运行版本**比对；该文件在 dsh-v0.1.7-rc.2 与 dsh-v0.2.0-rc.2 之间逐字节相同，拒绝完全来自运行版本从 `0.1.7-rc.2` 跳到 `0.2.0-rc.2`：所有声明 `^0.1.x` 或 `<0.1.8-0` 的包由放行变为拒绝。`peerDependenciesMeta.optional` 不参与豁免，`engines` 不被读取 |
| **随包 preset 声明未变** | `packages/bundle/web-app/presets/{standard,ptc,minimal,cordis}.patch.yml` 在两个修订间逐字节相同，`plugins/harness/agent-team.mjs` 的四个委派行锚点仍然各命中一次 |
| **新增可选 bundle** | `@deepseek-ai/dsh-experimental-schedule-bundle` 进入 `OPTIONAL_BUNDLES`，属 installation-owned 依赖，本仓库无需声明或安装 |
| **官方家族包随基座换代** | agent-team-profile、auto-review、browser-use、browser-use-playwright-mcp、computer-use、computer-use-cua-driver-native 均发布 `0.2.0-rc.2`，peer 改为精确 `0.2.0-rc.2` |
| **官方 web-app 新增 client 座位** | 新增 `ui-layout`（声明 `main` 与 `sidebar.panellist` 座位）与若干设置页座位；dsh-web-ui 的 skill-explorer 自 0.4.4 起注入 `@deepseek-ai/dsh-client-ui-layout` |

## 兼容性准入闸门与版本例外

闸门在安装与启动两条路径上生效：`dsh plugin add` 在 pnpm 之前预检，命中即 exit 1（`npm run build` 随之失败）；启动时 `packages/boot/app-boot/src/profile.ts` 把不兼容的 bundle 层整层跳过并打印 `dsh: skipping profile bundle "…"`，组合残缺但不报错退出。

按运行版本 `0.2.0-rc.2` 实跑 `evaluatePluginCompatibility` 的判定结果：

| 包 | 判定 | 处置 |
| --- | --- | --- |
| `dsh-better-sidebar@0.24.1` | 放行 | 抬 pin（14 条 peer 全为 `^0.2.0-rc.1`） |
| `dsh-sidebar-qa@1.1.0` | 放行 | 抬 pin（peer 改为纯下限 `>=0.1.0-rc.8`） |
| `dshmarket@1.66.5` | 放行 | 抬 pin（1.66.4 起纳入 0.2 线，属硬下限） |
| dsh-web-ui 四包 `0.4.4` | 放行 | 抬 pin（peer 为 `@deepseek-ai/dsh >=0.2.0-rc.1`） |
| `@smalltailqwq/…-manager@0.1.5` | 放行 | 无需例外（peer 为 `>=0.1.7-rc.1`） |
| 官方家族六包 `0.2.0-rc.2` | 放行 | 抬 pin |
| plugins/remote、plugins/ai-update | 放行 | 无 `@deepseek-ai/dsh*` peer |
| `dsh-flowglass@0.7.3` | 拒绝 | 精确版本例外（peer 为 `^0.1.5-rc.1 \|\| ^0.1.6-alpha.2 \|\| ^0.1.7-alpha.2`；0.7.2 与 0.7.3 原文相同，旧 pin 同样被拒） |
| 两块皮肤 `maid-atelier@0.1.6`、`orca-link@0.1.6` | 拒绝 | 精确版本例外（peer 为 `>=0.1.7-rc.1 <0.1.8-0`） |
| `dsh-pet@0.2.12` | 拒绝 | 精确版本例外（9 条 peer 均为 `^0.1.1-rc.2`，npm 无更新版本） |

例外由 profile 的 `compatibility.json` 承载，键是精确的「包@版本」，值是允许的精确 DSH 版本；`scripts/plugin-install.mjs` 的 `installNpmPlugin` 新增 `exempt` 参数，install 脚本在安装前调用 `dsh plugin --profile web allow-version <包@版本> --dsh-version <运行时版本> --accept-risk` 写入，因此 harness 再次换代时旧例外自动失效、闸门重新拦截。

## 需要的适配

### 官方家族钉（plugins/harness/）

| 文件 | 改动 |
| --- | --- |
| `agent-team.mjs` | `TEAM_VERSION` → `0.2.0-rc.2` |
| `auto-review.mjs` | `@deepseek-ai/dsh-experimental-auto-review@0.2.0-rc.2` |
| `browser-use.mjs` | 两个包 → `0.2.0-rc.2` |
| `computer-use.mjs` | 两个包 → `0.2.0-rc.2` |

四个 install 脚本的注释同步为「peer 指向 0.2.0-rc.2，匹配 pinned `dsh-v0.2.0-rc.2`」。`agent-team.mjs` 的锚点与派生逻辑无需改动，实测派生出 `standard-team` 与 `ptc-team`，`minimal` 无委派行、`cordis` 挂进程级工具集，两者按既有规则跳过。

### 三方插件钉

| 文件 | 改动 |
| --- | --- |
| `plugins/better-sidebar/install.mjs` | `dsh-better-sidebar@0.24.1`、`dsh-flowglass@0.7.3`（带 `exempt`）、`dsh-sidebar-qa@1.1.0` |
| `plugins/dsh-web-ui/install.mjs` | 四个包 → `@0.4.4`；plugin-manager 段的过时理由改写为「同名 entry id 覆盖会抹掉官方 Plugins 页座位」 |
| `plugins/plugin-market/install.mjs` | `dshmarket@1.66.5`，并说明该版本是硬下限 |
| `plugins/deep-whale/install.mjs` | pin 由单一常量改为分包映射（manager `0.1.5`、两块皮肤 `0.1.6`）；两块皮肤带 `exempt` |
| `plugins/dsh-pet/install.mjs` | 保持 `dsh-pet@0.2.12`，新增 `exempt` 与对应的兼容性说明 |

### 共享流水线

`scripts/plugin-install.mjs` 新增 `grantVersionExemption()` 与 `installNpmPlugin` 的 `exempt` 选项：在 up-to-date 快速路径之前授予例外，使例外随每次构建刷新，而不是只在首次安装时写入。

### 文档同步

`plugins/README.md`、`plugins/harness/README.md`、`plugins/dsh-web-ui/README.md` 的版本引用与说明已按上述事实更新，并新增 `exempt` 机制的说明；`docs/dsh-gui/update-check.md` 无需改动。

## 验收

在副本 `E:\Git\dsh-gui-home\.staging\dsh-gui` 内执行，`DSH_HOME` 显式指向副本 `.dsh`：

1. `npm run build`（含入口 exe）全绿，内含 `--profile web --dump-config` 组合冒烟检查，输出以 `Composition smoke check passed.` 结束；构建日志中无 `skipping profile bundle`、无 `duplicate loader entry id`、无安装错误；`profiles/web/compatibility.json` 写入 4 条例外，`dsh.profile.bundles` 含 17 个 bundle 层。
2. `docs/official` 的 19 条符号链接全部可穿透（10 条目录链接在副本中因符号链接以文件型重解析点检出而重建，见下节）。
3. **WebUI 加载验收**：以副本 DSH_HOME 在空闲端口 3090 启动副本的 `npm run harness`，用真实浏览器渲染 `http://127.0.0.1:3090/?token=…`，标题 `DeepSeek Harness`，会话首页正常渲染（新会话、流镜、插件、技能中心、工作区会话树、今日消费、设置、皮肤与桌宠），控制台仅一条 `[dsh-pet] 余额查询失败 reason=credential-missing`（副本无 API Key，属环境性提示），无错误覆盖层。
4. **GUI 启动运行验收**：以 `DSH_GUI_PORT=3091` 启动副本入口 exe（`npm start` → `launched …\.staging\dsh-gui.exe`，后端在 127.0.0.1:3091 监听），用 computer use 观察真实窗口：外壳渲染出标题栏与「本机」连接标签，内嵌页面从加载页过渡到主会话界面，harness 就绪且交互有效——依次关闭「通知权限」提示、在 API Key 引导页选择「稍后配置」、打开「设置」，设置面板列出各插件贡献的分区（通用设置、模型、内置插件、Agent 预设、桌宠配置、追问、侧边卡片、Web 插件、皮肤管理、使用统计）。验收后关闭该实例并确认端口 3091 释放；正在运行的 dsh-gui 全程未受影响。

## 发现与遗留

- **deep-whale 的管理包没有 0.1.6**：`v0.1.6` tag 内只有 maid-atelier 与 orca-link 升到 `0.1.6`，`skin-manager/package.json` 仍是 `0.1.5`，npm 上也不存在 0.1.6。因此 pin 必须分包，整体 pin 0.1.6 会在管理包上 404。
- **四条精确版本例外需要人工接受风险**：flowglass 0.7.3、两块皮肤 0.1.6、dsh-pet 0.2.12 的声明 peer 不含 0.2，闸门按设计拒绝；例外是本次继续挂载它们的唯一途径，DSH 自身也把授予该例外表述为「可能崩溃或损坏数据」。已核对它们在 0.2.0-rc.2 上点名的 service、slot、page type 与事件均存在，但运行期行为未经上游验证；例外在下次 harness 换代后自动失效。
- **`dsh plugin add dshmarket@1.66.5` 再次挂死**：pnpm 打印 `Done in 11.9s` 并把 profile 写好后不退出，`dsh plugin` 进程零 CPU、无 socket 地阻塞 15 分钟以上，并持续持有 `profiles/web/package.json.lock`；`plugin-manager` 的 10 分钟静默看门狗（`idleTimeoutMs` 默认 600000）没有触发终止。处置与 [2026-09-25 记录](2026-09-25-harness-upgrade-v0-1-7-rc-2.md) 相同：终止该子树、删除陈旧的锁文件、重跑构建（重跑时该包已满足快速路径，不再发起 pnpm）。两次发生都在 dshmarket 的 `add` 上，且都在 registry 出现多次 `ECONNRESET` 重试之后，疑似 pnpm 在供应链接校验后的退出路径上等待未释放的网络句柄。本工程重新构建时若再次卡在该包，按同样方式处理即可。
- **`docs/official` 目录链接在副本中以文件型重解析点检出**：副本由 `git clone` 与 `git submodule update` 创建，10 条指向目录的链接落成文件型（`PSIsContainer` 为 `False`），`ls` 与子路径读取都失败；本工程既有检出正常（`PSIsContainer` 为 `True`）。副本内已用 `New-Item -ItemType SymbolicLink` 按原目标重建，重建只改文件系统、目标字符串不变，`git status` 对 `docs/official` 保持干净。
- **plugin-manager 仍不安装**：`@linxin666/dsh-client-ui-plugin-manager` 的 bundle patch 与官方 web-app bundle 的同名 `ui-plugin-manager` 行冲突，在 0.4.4 上该包改为向官方 Plugins 页贡献 `plugins.detail.section`，同 id 覆盖会连带抹掉它依赖的座位，因此维持不安装，理由已写入 install 脚本与 README。

## 阶段二状态

**尚未执行。** 阶段二（同步到本工程）按 skill 第 4 节要求，须在用户明确审批后进行。

用户执行时需要的动作：

```powershell
# 1) 停止正在运行的 dsh-gui
# 2) 重新构建（入口 exe 被占用时可加 --skip-exe，仅重建运行时与插件）
npm run build
```
