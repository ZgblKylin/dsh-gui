# harness 升级：dsh-v0.2.1-alpha.2 → dsh-v0.2.1-rc.2

本文件记录把工程基座 `deepseek-harness`、4 个插件模块升级到目标修订，并移除 dsh-model-capabilities 的过程，以及阶段一（副本 `.staging/dsh-gui`）的适配与验收结果。流程与门槛见 skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md)。

## 目标修订与发布状态

| 模块 | 旧修订 | 新修订 | npm |
| --- | --- | --- | --- |
| deepseek-harness | dsh-v0.2.1-alpha.2 | dsh-v0.2.1-rc.2（687f282e86） | `@deepseek-ai/dsh@0.2.1-rc.2` 已发布（`next` tag） |
| dsh-deep-whale | v0.1.7 | v0.1.8（15e9aa0） | 皮肤 0.1.8、manager 0.1.7 均已发布 |
| DSH-better-sidebar | v0.26.0 | v0.28.0（83faf70） | 已发布，`latest` 即目标版本 |
| dsh-sidebar-qa | v1.1.0 | v1.2.0（3c671f3） | 已发布 |
| @mars-sea/dsh-commandcode-provider | v0.13.0 | v0.13.4（2e0bb2d） | 已发布，但声明引擎不含 rc.2 |

dsh-model-capabilities（`@linxin666/dsh-client-ui-model-capabilities`）从安装集移除。它不是独立子模块：源码只存在于 `dsh-web-ui/` 子模块的 `packages/dsh-model-capabilities/`，`.gitmodules`、git config、索引 gitlink 与 `.git/modules` 都没有它的登记，因此移除动作是「删 wrapper 安装块 + 卸载 profile 条目」，没有子模块或 git 缓存需要清理。

## 上游变更

| 变更 | 说明 |
| --- | --- |
| **准入闸门改为 engines.dsh 优先** | `packages/boot/app-boot/src/plugin-compatibility.ts` 在 rc.2 改为：清单声明 `engines.dsh` 时只按该范围判定，未声明时才逐条比对 `@deepseek-ai/dsh*` peer。判定字段由 `peers` 改名为 `requirements`。`^0.2.0-rc.2`、`^0.2.0-rc.1`、`>=0.1.7-rc.1 <0.3.0-0`、`^0.2.1-rc.1` 仍放行，精确 alpha 版本与含 alpha 分值的析取由放行变拒绝 |
| **官方家族包随基座换代** | browser-use、computer-use、browser-use-playwright-mcp、computer-use-cua-driver-native 的 dsh peer 全部为精确 `0.2.1-rc.2`，必须与 harness 同批抬 pin |
| **可选 bundle 新增** | `@deepseek-ai/dsh-experimental-plugin-market-bundle` 进入 `OPTIONAL_BUNDLES`，属 installation-owned bundle，本仓库无需声明或安装 |
| **better-sidebar 的 host inject 变化** | 0.26.0 inject 仍含 `webRuntime`，rc.2 已删除该服务，旧 pin 在 rc.2 上会因依赖缺失整层 pending；0.28.0 改用 `connection` 服务与 `ctx.connection.requestRejection`，13 条 dsh peer 全指 `^0.2.1-rc.1` |
| **web-app preset 声明变化** | standard/ptc 去掉 subagent schedule 相关 deny，minimal 新增 `read_image` 与压缩；仓库 `presets/` 只有 README，无实例需要跟进 |
| **desktop 构建入口** | `apps/desktop` 区间变化较大（windows-signing 等），`npm run build:desktop` 在副本完整复验通过 |

## 适配改动

| 文件 | 改动 |
| --- | --- |
| `plugins/harness/browser-use.mjs`、`computer-use.mjs` | 官方家族四包 pin → `0.2.1-rc.2`，注释同步精确 peer 与连带升级要求 |
| `plugins/better-sidebar/install.mjs` | `dsh-better-sidebar@0.28.0`、`dsh-sidebar-qa@1.2.0`；注释写明 rc.2 的 engines-first 闸门与 `webRuntime` 移除导致的硬依赖 |
| `plugins/deep-whale/install.mjs` | 分包 pin：manager `0.1.7`、maid-atelier 与 orca-link 各 `0.1.8`；注释说明三包 peer 放行、无需例外 |
| `plugins/commandcode-provider/install.mjs` | `@mars-sea/dsh-commandcode-provider@0.13.4` + `exempt` 精确版本例外（理由随安装日志输出） |
| `plugins/commandcode-provider/README.md` | 版本、引擎声明、例外状态与验证方式同步 |
| `plugins/dsh-web-ui/install.mjs` | 删除 dsh-model-capabilities 安装块；安装集改为三个包；注释同步 rc.2 与移除原因 |
| `plugins/dsh-web-ui/README.md` | 三包口径；「已移除插件」新增 dsh-model-capabilities 一节（能力承接与卸载动作） |
| `plugins/dsh-pet/install.mjs`、`plugins/plugin-market/install.mjs` | 注释里的运行版本与闸门口径同步到 rc.2 |
| `scripts/plugin-install.mjs` | `grantVersionExemption` 与 `exempt` 的 JSDoc 改为 engines.dsh 优先的判定口径（代码无改动） |
| `plugins/README.md` | 闸门说明、安装方式清单、dsh-web-ui 三包口径、deep-whale/better-sidebar/sidebar-qa 版本；补上此前缺失的 commandcode-provider 条目 |
| `README.md` | 插件树注释与 dsh-web-ui 安装集说明同步 |
| `docs/dsh-gui/ssh-remote-workspace.md`、`ssh-provider-vs-dsh-remote.md`、`dsh-pet-troubleshooting.md` | 运行版本与准入闸门引用更新为 `0.2.1-rc.2` |

`docs/official` 的 19 条符号链接（10 条目录、9 条文件）在 rc.2 上逐条核对仍可穿透，无需改指。

## 阶段一验收

验收在副本 `E:\Git\dsh-gui-home\.staging\dsh-gui` 内执行，`DSH_HOME` 为副本的 `E:\Git\dsh-gui-home\.staging\.dsh`。

1. 子模块检出：harness `dsh-v0.2.1-rc.2`、deep-whale `v0.1.8`、better-sidebar `v0.28.0`、sidebar-qa `v1.2.0`、commandcode `v0.13.4`；副本工作区相对本工程的改动为 17 个受版本管理文件加 5 个子模块指针。
2. 构建：`npm run build:desktop -- --skip-plugins` 全绿。出仓检出于 687f282e86（0.2.1-rc.2），落位 `desktop/`（7809 个文件、1.02 GB），入口 `DeepSeek Harness.exe` 234.9 MB，shim `dsh-gui-desktop.exe` 234496 字节。
3. desktop profile：构建第 9 步因运行中的 Desktop 实例（本会话宿主）拒绝执行，因此构建加 `--skip-plugins`，构建后以等价脚本重放第 9 步：初始化副本 desktop profile → 逐个运行 12 个 `plugins/*/install.mjs` → bundle reconcile。结果为 20 个依赖、18 个 bundle 层、reconcile 0（全部已登记）；`compatibility.json` 写入 `@mars-sea/dsh-commandcode-provider@0.13.4` 对 `0.2.1-rc.2` 的精确版本例外。
4. WebUI 加载验收：以副本 DSH_HOME 启动副本 desktop 应用的 web 后端（`dsh web` 于 `http://127.0.0.1:65307/`），用真实浏览器渲染会话首页：新建会话、全局面板（插件 / 自动化任务 / 技能中心）、工作区会话树、使用统计卡、输入框与模型选择均正常，控制台 11 条消息、0 error、0 warning；加载的 client 插件包含 commandcode、better-sidebar、sidebar-qa、皮肤、桌宠、dsh-web-ui 三包，且不含 dsh-model-capabilities。确认后关闭该实例。
5. GUI 启动运行验收：启动副本 desktop 应用，窗口出现并完成欢迎页 → API Key 引导页 →「稍后配置」→ 主会话界面（主机标签「本机」、版本 0.2.1-rc.2）；依次打开 更多 → 设置（12 个分区：通用设置、模型、Command Code、内置插件、Agent 预设、追问、桌宠配置、插件市场、侧边卡片、Web 插件、皮肤管理、使用统计）、Models 页（DeepSeek 与 Command Code 两张提供方卡片，无 model-capabilities 扩展区）、底部工作台（文件 / Git / 任务管理 / 侧边对话 / 终端）。皮肤（maid-atelier）与桌宠（蓝毛小女仆）均正常渲染。验收后关闭该实例，确认端口释放且本工程运行中的实例未受影响。
6. `--dump-config`：desktop profile 的 boot 与 dump 由 CLI 按设计拒绝（`profile "desktop" is managed exclusively by the Electron application`），因此组合检查改由本次真实启动与 UI 渲染承担；host stdout/stderr 无 `skipping profile bundle`、无 duplicate loader 报错、无插件加载失败提示。

### 验收偏差

构建的第 9 步与 GUI 启动都受「正在运行的 Desktop 实例」限制，本会话的宿主正是该实例，因此采用两项等价处置，均只影响验证装置、不影响产物：

- 构建加 `--skip-plugins`，随后用 `install-desktop-plugins.mjs` 原样重放第 9 步（同样的 profile 初始化、同样的 12 个安装脚本、同样的 bundle reconcile），目标仍是副本自己的 `.staging/.dsh/profiles/desktop`。
- GUI 验收在副本产物的等值副本上执行：复制 `desktop/` 后，仅把 `app.asar` 内 `package.json` 的 `name` 字段做同长度二进制替换（24 字节），使 Electron userData 与单实例锁落到独立目录；harness、插件与 UI 产物的其余字节完全相同。原因是 Electron 单实例锁按 app 名与 userData 判定，`--user-data-dir` 不改变 `app.getPath('userData')`，无法让两个实例共存。

## 屏蔽与例外

- 本次没有屏蔽任何插件。
- 唯一例外：`@mars-sea/dsh-commandcode-provider@0.13.4` 的 `engines.dsh` 为 `0.2.0-rc.2 || 0.2.1-alpha.4`，不含 rc.2，且上游没有任何声明 rc.2 的发布；wrapper 以 `exempt` 授予精确版本例外，例外键为「包@版本 + 精确 dsh 版本」，下次 harness 换代即失效。

## 未决风险

- commandcode-provider 0.13.4 上游只在 0.2.1-alpha.4 上验证；alpha.4 → rc.2 的宿主变化由本次副本构建与 UI 验收覆盖，命令执行路径未逐一实测。
- better-sidebar 0.28.0 发布不足 24 小时，依赖精确 pin 进入 profile 的 `minimumReleaseAgeExclude`；npm 撤回该版本时安装会失败。
- dsh-sidebar-qa 1.2.0 的信任栅栏仍读取已删除的 `webRuntime`，在 rc.2 上退化为 loopback-only：本工程走 127.0.0.1 不受影响，`--trusted-host`/LAN 访问会 403，属上游跟进项。
- 阶段二之前，本工程两个 profile（web 与 desktop）仍装有 dsh-model-capabilities，需要在重建时按「阶段二实装」一节的命令卸载。

## 阶段二实装

阶段一验收通过并经用户明确审批后执行，只同步受版本管理的文件，不执行构建或安装：

1. 5 个子模块检出到本文档表格中的新修订；逐文件同步副本验证过的 17 个文件与本报告。
2. 卸载本工程两个 profile 里残留的 dsh-model-capabilities（需在停止实例后由用户执行）：
   - web profile：`node .harness\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile web remove @linxin666/dsh-client-ui-model-capabilities`
   - desktop profile：`desktop\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop remove @linxin666/dsh-client-ui-model-capabilities`
   - 清理 `.dsh\gui\npm-installs.json` 中该包名与 `.dsh\profiles\web\pnpm-workspace.yaml` 中它的 `minimumReleaseAgeExclude` 行（残留不影响启动）。
3. 用户停止运行中的 Desktop 实例后执行 `npm run build:desktop`，再启动应用确认新版本生效。
