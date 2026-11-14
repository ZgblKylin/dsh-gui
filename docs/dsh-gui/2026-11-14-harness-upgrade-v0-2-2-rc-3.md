# harness 升级：dsh-v0.2.2-rc.1 → dsh-v0.2.2-rc.3

本文件记录把工程基座 `deepseek-harness` 从 `dsh-v0.2.2-rc.1` 推进到
`dsh-v0.2.2-rc.3` 的适配与阶段一验收结果。按升级门槛，验证在仓库内 worktree
`.staging/dsh-gui`（工作分支 `staging/verify`）完成，未改动主工程；阶段二合并
主分支待用户审批后执行。

## 目标修订与发布状态

| 项 | 旧修订 | 新修订 | npm |
| --- | --- | --- | --- |
| deepseek-harness | dsh-v0.2.2-rc.1（66491b05e3） | **dsh-v0.2.2-rc.3**（38a6a5c965） | `@deepseek-ai/dsh` 的 `latest` 仍是 `0.2.2-rc.1`，`next` 为 `0.2.2-rc.3` |
| 官方 provider 四件套（browser-use / playwright-mcp / computer-use / cua-driver-native） | 0.2.2-rc.1 | **0.2.2-rc.3** | 四个包均已发布 `0.2.2-rc.3`（`next`） |

`harness.json` 保持 `{"runtime":"npm","version":null}`，不改清单；构建按子模块
`apps/cli/package.json` 的版本从 registry 安装 `@deepseek-ai/dsh@0.2.2-rc.3`。

## 区间规模

rc.1..rc.3 共 1574 个提交（含 `dsh-v0.2.2-rc.2` 发布与 rc.2 之后合入主分支的大量
功能与修复）。rc.1 之后补写的升级指南集中在 `docs/upgrade-guide/v0.2.2-rc.1/`
（19 篇）及更早版本目录，其中与本仓库集成面相关的是 `dsh-doc-skill`、
`cua-native-platform`、`plugin-update-method`、`css-anchored-menus`（alpha.2）、
`office-kit-package` / `office-operation-tools`（alpha.3）等。

## 适配改动

| 文件 | 改动 |
| --- | --- |
| `deepseek-harness`（子模块指针） | 66491b05e3 → **38a6a5c965（rc.3）** |
| `plugins/harness/browser-use.mjs`、`computer-use.mjs` | 四个官方 provider 的精确 spec 与注释抬到 `0.2.2-rc.3`。rc.3 的 CUA provider 契约新增必填 `capabilities`，rc.1 构建的包会直接 TypeError，因此必须与 harness 同批换包 |
| `docs/official/cordis-plugin-development` → `docs/official/dsh-doc` | rc.3 用单个 `dsh-doc` skill 取代四个创造模式 skill；链接改指 `packages/preset/agent-preset/skills/dsh-doc` |
| `AGENTS.md` | `docs/official` 条目同步为 `dsh-doc/` 与其 references/templates |
| `.agents/skills/dsh-gui-preset-dev/SKILL.md`、`dsh-gui-update/SKILL.md` | 旧 skill 名与路径按 rc.3 迁移表改到 `dsh-doc/references/{compositions,composition-reference,plugin-development}.md` |
| `plugins/README.md`、`plugins/harness/README.md`、各 npm wrapper 的 `install.mjs` 注释与 README | 当前 pinned runtime / 官方 family pin / 准入口径同步到 rc.3；修正 Agent Teams 已退役（内置 `ui-agent-team` 行）与 `webRuntime` 移除版本（0.2.1-alpha.1，非 rc.2）的表述；npm pin 本身不变 |
| `docs/dsh-gui/{ssh-provider-vs-dsh-remote,ssh-remote-workspace,dsh-pet-troubleshooting}.md` | 运行时与 SSH 家族安装示例同步到 rc.3 |

`docs/official` 的 9 个目录型符号链接在本机 checkout 后是文件型重解析点
（`PSIsContainer=False`、子项不可读），已用 `New-Item -ItemType SymbolicLink`
重建为目录链接；这只是一次文件系统修复，目标字符串不变，不进入提交内容。

## 兼容性核查

- `dsh.bundle.patch` / `dsh.client` 清单类型、`vendor/loader`、`vendor/cordis`、
  app-boot 的 profile 装载与准入闸门（`plugin-compatibility.ts`）两 tag **无差异**，
  现有 bundle 层与 client 半不会因契约变化加载失败。
- 服务面只移除 `accountController`、`officeToPdf`，新增 `deepseekChatImport`、
  `mcpManager`、`officeKit`；仓库插件使用的 service 与 slot（含
  `conversation.input.right`、`shell.overlay`）全部保留。
- 除官方四件套外，19 个 npm pin 与 7 个 in-tree link 包的声明区间都在
  `includePrerelease` 语义下接纳 `0.2.2-rc.3`，无需精确版本例外。
- `webRuntime` 与本次升级无关：该服务在 `v0.2.1-alpha.1` 已移除并改用
  `webStartup`，rc.1 源码里同样不存在。

## 阶段一验收

全部在 `.staging/dsh-gui` 与 `.staging/` 运行时根内完成，未触碰主工程与运行中的
Desktop 实例（本会话宿主）。验证命令与证据留在 `.work/upgrade-rc3/`。

| 项目 | 命令 / 手段 | 结果 |
| --- | --- | --- |
| desktop 构建 | `npm run build:desktop -- --skip-plugins`（`DSH_HOME=.staging/.dsh`） | 退出码 0；源 `38a6a5c965`（0.2.2-rc.3）；产物 `.staging/desktop` 7878 文件 / 1.05 GB；shim `dsh-gui-desktop.exe` 重建 |
| desktop profile 插件安装 | 构建第 9 步的等价流程（初始化 profile、准入裁剪、逐个 `plugins/*/install.mjs`、bundles 调和） | 24 个依赖 / 24 个 bundle 全部就位；官方四件套为 `0.2.2-rc.3` |
| **WebUI 加载验收** | 启动 `.staging/desktop/DeepSeek Harness.exe`（`DSH_HOME=.staging/.dsh`、隔离 user-data、空闲端口），用 CDP 读取 `dsh-app://app/` 的渲染结果 | `DSH 本地构建 0.2.2-rc.3-38a6a5c-dirty`；会话界面完整渲染（新会话、插件、自动化任务、技能中心、工作区、composer、模型选择、暂停/远程/皮肤等插件 UI）；`consoleErrors=[]`、无错误覆盖层；打开「插件」页列出全部已安装插件 |
| **GUI 启动运行验收（computer use）** | `cua_driver_native` 读取窗口 | 窗口出现（904×1053「DeepSeek Harness」）；staging home 无凭据，显示欢迎/登录首屏（登录、添加 API Key）；标题栏按钮可 invoke；宿主就绪（`dsh web: http://127.0.0.1:...`） |
| 组合配置 | desktop 自带 CLI 的 `--profile desktop --dump-config` | 按设计拒绝（desktop profile 由 Electron 独占管理），组合验收以应用实际加载为准 |
| docs/official 链接 | 逐条读取 19 个链接 | 全部可穿透（目录可列出子项，文件可读取） |

### 环境偏差（不影响主工程，记录以便复现）

- **构建用 `--skip-plugins`**：`scripts/desktop.mjs` 的插件步骤会用全局 `tasklist`
  检测 `DeepSeek Harness.exe`，而本会话宿主正处于运行状态，构建无法执行该步；
  改为按同一脚本逻辑手动复刻。这是上轮 alpha.3 验证的既有做法。
- **构建期两个 smoke 临时跳过**：本机 `runtime:smoke` 与 packaged runtime smoke
  在全部检查通过后不退出（与 alpha.3 记录相同）。验证时在 `scripts/desktop.mjs`
  的 `SOURCE_PATCHES` 中临时加入 `DSH_SKIP_RUNTIME_SMOKE` / `DSH_SKIP_PACKAGED_SMOKE`
  守卫并设置对应环境变量，交付前已撤销，不进入提交。副作用是打包版本串带
  `-dirty` 后缀（同一提交干净构建会去掉）。
- **staging 内构建的两个环境问题**：`vite` 的 esbuild 临时文件删除曾被拒（把
  `TMP`/`TEMP` 钉到 `.staging/.tmp-build` 后通过）；electron-builder 的 icon-tool
  缓存在仓库内 staging 下会继承仓库根 `package.json` 的 `"type":"module"` 而被
  当 ESM 执行（在 `.staging/.cache/electron-builder/package.json` 写入
  `{"type":"commonjs"}` 解决）。后者是仓库内 worktree 布局的新问题，建议后续让
  `scripts/desktop.mjs` 创建缓存目录时写入该标记。
- **应用启动参数**：worktree 位于会话工作区内，产物带低完整性标签，Chromium
  沙箱无法启动；且会话宿主 Desktop 正在运行，Electron 单实例锁会拒绝第二个默认
  userData 的实例。验证时以 `--no-sandbox --disable-gpu --user-data-dir=<.staging>`
  启动，并去掉会话继承的 `ELECTRON_RUN_AS_NODE`。
- **验收时 Windows 会话处于锁屏**：computer use 通过窗口级快照确认窗口与欢迎页；
  页面内交互（打开插件页）通过 CDP 完成。若需真实前台操作，应在解锁的桌面上复验。

## 已知回归与未决风险

- `dsh-better-sidebar@0.30.1` 使用 rc.3 已删除的 `Menu.getAnchorRect` /
  `useAnchoredPosition`（改为 CSS Anchor Positioning）→ 右键/文件/历史/tab 菜单
  不再按鼠标位置弹出（不阻断加载）。上游 `0.32.1` 的 peer 已指向 `^0.2.2-rc.2`，
  疑似适配版；本次只更新 harness，未抬插件 pin。
- `ds-harness-remote@0.6.3` 读取已改名的 `BundleInfo.updatable`（rc.3 为
  `update?: 'registry' | 'git'`）→ 远程插件更新检查 fail-closed；其 RPC 允许列表
  仍含 `officeToPdf/*`（rc.3 服务改名 `officeKit`）→ 远程 office 预览失效。
  上游 `0.6.4` 已发布，本次未抬 pin。
- `dsh-sidebar-qa@1.2.2` 在控制台输出「this DSH has no right sidebar」警告
  （warning 级，选择弹层仍可用）；属该插件对右侧栏的探测口径，记录不阻断。
- 阶段二尚未执行：工作分支合并回主分支需用户明确审批；合并后由用户停止运行中
  的 Desktop 实例并执行 `npm run build:desktop` 重建。
