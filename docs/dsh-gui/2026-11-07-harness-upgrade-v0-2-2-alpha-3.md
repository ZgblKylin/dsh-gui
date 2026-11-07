# harness 升级：dsh-v0.2.2-alpha.2 → dsh-v0.2.2-alpha.3

本文件记录把工程基座 `deepseek-harness` 升级到目标修订的取舍与验收结果。本次按
skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md) 的两阶段流程执行：
先在验证 worktree `.staging/dsh-gui` 完成更新、适配、构建与验收，报告并经用户审批后才
同步回本工程。流程与门槛见 [upgrade-staging-workspace.md](upgrade-staging-workspace.md)。

## 目标修订与发布状态

| 模块 | 旧修订 | 新修订 | npm |
| --- | --- | --- | --- |
| deepseek-harness | dsh-v0.2.2-alpha.2（f3803c9697） | **dsh-v0.2.2-alpha.3**（05b1cae8db） | `@deepseek-ai/dsh@0.2.2-alpha.3` 已发布（`alpha` tag） |

官方家族四包（browser-use / playwright-mcp / computer-use / cua-driver-native）的 peer
精确指向 `0.2.2-alpha.3`，必须与 harness 同批抬 pin；`@deepseek-ai/dsh-ssh` 家族、
`dsh-base`、`dsh-web-app` 等官方包在 registry 上同样有 `0.2.2-alpha.3` 发布。
`harness.json` 保持 `{"runtime":"npm","version":null}`：构建按子模块
`apps/cli/package.json` 的版本精确安装 CLI，子模块检出即版本的唯一来源，无需改清单。

更新时远端默认分支已出现更新的 tag `dsh-v0.2.2-rc.1`（本次对话框目标仍是 alpha.3，未越级）。

## 区间规模

| 指标 | 值 |
| --- | --- |
| 提交数 | 462（`release(dsh): 0.2.2-alpha.3` 收尾） |
| 变更文件 | 2315（+87654 / -27240） |
| 上游升级指南 | 无新增（`docs/upgrade-guide/` 最后一份仍是 `v0.2.2-alpha.2`），属修复线小版本 |

区间内容以缺陷修复与 vendored 依赖换代为主：`schedule` 任务时间控制初始化、`session-projection`
保留已释放单元的检查点、`forge` 评审与 worktree 插件入口统一、空会话侧栏修复，以及
cordis 4.0.6-alpha.2 与 loading 家族（loader / hmr / group / include / timer / logger-console /
schemastery）的 alpha.2 vendored 版本。没有任何本仓库需要跟进的组合、bundle 或插件 API 破坏性变更。

## 适配改动

本次功能改动只有两处，其余是把「当前 pinned harness」的版本引用同步到 alpha.3：

| 文件 | 改动 |
| --- | --- |
| `deepseek-harness`（子模块指针） | f3803c9697 → 05b1cae8db（`dsh-v0.2.2-alpha.3`） |
| `plugins/harness/browser-use.mjs`、`plugins/harness/computer-use.mjs` | 四个官方家族包 spec `@deepseek-ai/*@0.2.2-alpha.2` → `@0.2.2-alpha.3`；注释与 README 同步 pinned tag |
| `plugins/harness/README.md` | 两张安装表与闸门描述的版本同步 |
| `plugins/README.md` | 安装方式清单、Current plugins 段、例外机制段与官方家族 pin 同步到 alpha.3 |
| `plugins/{better-sidebar,deep-whale,ds-harness-remote,dsh-pause,dsh-pet,commandcode-provider,plugin-market,skill-mcp-center,dsh-web-ui}/install.mjs` 及对应 README | 注释/文档里的 pinned harness 版本与准入表述同步；npm pin 不变（新区间仍全部放行） |
| `docs/dsh-gui/{ssh-provider-vs-dsh-remote,ssh-remote-workspace,dsh-pet-troubleshooting}.md` | 运行时版本引用同步到 alpha.3 |

`plugins/commandcode-provider` 的精确版本例外不需要改代码：`installNpmPlugin` 的 `exempt`
在安装时按实际运行时版本重新授予，本次安装日志确认 `allowed @mars-sea/dsh-commandcode-provider@0.15.5
for DSH 0.2.2-alpha.3`；`install.mjs` 的说明文字已同步 alpha.3。

`docs/official` 的 19 条符号链接（10 条目录、9 条文件）在目标修订上逐条核实仍可穿透
（links=19 bad=0），无需改指。

## 验收（阶段一）

全部在 worktree `.staging/dsh-gui` 内完成；运行实例使用 worktree 自己的 DSH_HOME
（`.staging/.dsh`）与独立 user-data 目录，未触碰正在运行的 Desktop 实例与主仓库。

| 项目 | 命令 / 手段 | 结果 |
| --- | --- | --- |
| desktop 构建 | `npm run build:desktop -- --skip-plugins` | 退出码 0（2026-11-07T15:00:17）；产物落 `.staging/desktop`，入口 `.staging/desktop/DeepSeek Harness.exe`，shim `.staging/dsh-gui-desktop.exe`；源为 05b1cae8db |
| desktop profile 插件安装 | `.work/update-alpha3/install-desktop-plugins.mjs`（等价于构建被跳过的安装步骤） | 退出码 0；24 个依赖、22 个 bundle，`missing bundle entries: (none)` |
| `docs/official` 链接 | 逐条解析并列举/读取 | links=19 bad=0 |
| 打包产物 smoke（手动补跑） | `node --experimental-transform-types apps/desktop/scripts/smoke-packaged-runtime.ts --unsigned` | Host 从 `resources/app.asar/dsh` 启动并服务前端、CLI 离线安装/卸载插件、DOCX/XLSX/PPTX→PDF 与 skill CLI 全部通过；随后 teardown 挂起（与构建期 smoke 同一现象），故不纳入构建 |
| **WebUI 加载验收** | 启动 `.staging/desktop/DeepSeek Harness.exe`（`DSH_HOME=.staging/.dsh`、独立 `--user-data-dir`、空闲端口），用 CDP 读取 `dsh-app://app/` 渲染结果 | 会话界面正常渲染：`新会话`、`插件`、`自动化任务`、`技能中心`、`Remote`、模型选择器与 composer 齐全；22 个 bundle 的组合脚本加载成功；`hasOverlay=false`，无异常、无加载失败提示；截图见 `.work/update-alpha3/webui-full-profile.png` |
| **GUI 启动运行验收（computer use）** | `cua_driver_native` 读取桌面窗口 | 窗口正常出现（staging home 无凭据，显示欢迎/登录首屏），GUI 可启动运行；截图见 `.work/update-alpha3/` 的窗口快照 |

验证期间观察到一次首启失败（启动时 `desktop web: failed to load plugins/??@deepseek-ai/dsh-client-modules/client.js`，
主进程转发到 Host 时 `read ECONNRESET`），随后用干净 profile、完整 profile 与复用同一 user-data
目录共 3 次启动均正常加载，未能复现；判断为插件安装后首次组合期间的一次性文件竞态，记录为风险。

## 偏差与风险

- **Desktop profile 由等价脚本安装**：构建自带的插件安装步骤会改写正在运行的 Desktop 实例的 profile，
  验证时以 `--skip-plugins` 跳过构建内安装，改用 `.work/update-alpha3/install-desktop-plugins.mjs`
  执行同一流程（profile 初始化、兼容性裁剪、逐个 `install.mjs`、bundles 调和）。
- **构建期 smoke 被临时跳过**：`runtime:smoke` 与打包产物 smoke 在本机启动后会挂住（检查完成后不退出，
  曾静默两小时），验证时通过 `scripts/desktop.mjs` 的 `SOURCE_PATCHES` 临时跳过；该临时改动已在提交前撤销，
  不进入工作分支。打包产物 smoke 的关键检查已手动补跑通过。
- **dsh-pet 的 desktop 屏蔽未生效**：其 wrapper 以 `profiles/web` 判断「是否已安装」，desktop profile
  下打印 `dsh-pet not present in profile (install failed)` 并跳过 `display:"web"` 配置注入，于是 Desktop 里
  pet 以 Electron 桌面模式运行并首次下载 electron v43.3.0。不影响 WebUI 加载，属已知偏差，可在后续单独修
  wrapper 的 profile 判定。
- **首启一次性竞态**（见上一节）：主工程重建后若首次启动出现同样的 client bundle 加载失败，重启一次即可，
  并请反馈以便进一步定位。
- 本次不涉及阶段二：主分支未改动，合并由用户审批后执行。
