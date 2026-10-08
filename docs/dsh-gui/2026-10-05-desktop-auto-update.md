# desktop 端的 auto update 迁移方案

本文件记录把 dsh-gui 外壳的「自动更新」迁移到 desktop 端的现状核查、约束与分阶段范围。上游结论见 [2026-10-02-desktop-plugin-injection.md](2026-10-02-desktop-plugin-injection.md)。

## 现状：更新逻辑在外壳里，不在插件里

| 位置 | 规模 | 职责 |
|---|---|---|
| `src-tauri/src/update.rs` | 1813 行 | 模块发现（根仓库 + 子模块）、`.gitmodules` 解析与子模块 URL 漂移修复、npm registry 发布状态、标签/提交比较与「不降级」判定、默认分支解析、GitHub Releases 页面解析、冷启动预览与完整检查、待更新计划落盘、**生成并分离启动更新器脚本**（模板编译进二进制，临时副本执行，Windows 开独立 PowerShell 控制台，脚本内烘入 dsh-gui/harness 的 PID 以等待其退出）、按项目选择 commit/tag 目标、就地更新根仓库（`git submodule update --init --recursive`） |
| `src-tauri/src/changelog.rs` | 1414 行 | 拉取并汇总更新日志 |
| `src-tauri/ui/app.js` | 379 处 `update` 引用 | 更新对话框：模块行、本地/远端版本列、每行「更新 / AI 更新 / 更新日志」、总进度与日志、toast |
| `src-tauri/src/main.rs` | 命令注册 | `local_update_projects` / `cached_update_status` / `check_updates` / `start_update` / `update_root` / `update_changelog` / `ai_update_request` / `ai_update_result` |

`plugins/ai-update`（`dsh-ai-update`）已经是插件：它监听顶层 `window` 的 `dsh-gui:ai-update` 消息（协议 v1，字段 `requestId` / `prompt`），选中「创造模式」预设、把提示词填进 composer，并用 `dsh-gui:ai-update-result` 回执。**该插件已装在 desktop profile 里**（与 `dsh-desktop-tabs`、`dsh-remote` 同批，共 19 个依赖）。

因此「AI 更新新建会话」这一半基本可以直接复用：迁移后的插件只需在顶层派发同样的消息（`window.parent === window`），回执走同一条通道。

## 两个硬约束

1. **无法往官方「应用」菜单里加入口**。该菜单由外壳 preload 创建（[preload-menu.ts](../../deepseek-harness/apps/desktop/src/preload-menu.ts)），只有固定的「应用 / 编辑」两个按钮，弹出的是外壳的原生菜单（`show_window_menu`），插件没有任何注入点——与标签页那条结论一致。入口只能落在插件自己的 UI：标题栏带内、紧挨菜单右侧（标签条的做法），或做成标签条上的一个控件。
2. **「重启并更新」与「更新后要重 build」在 desktop 端不同**。外壳把更新器脚本分离启动、等自己退出后执行 git 更新再重启自己；desktop 应用是运行时根下解包好的产物，仓库更新后还需要 `npm run build`（重装 harness 运行时与插件）才能生效，`apps/desktop` 变更才需要 `npm run build:desktop`。这条流程要在方案里显式设计，不能照搬。

## 可平移 vs 需要重写

| 能力 | 判定 | 说明 |
|---|---|---|
| 更新对话框的交互与信息结构 | **可平移**（重写为客户端插件 UI） | 行模型（模块、当前版本、目标版本、状态、GitHub 链接）与「更新 / AI 更新 / 更新日志」动作都可照搬 |
| 背景检测更新 | **需重写**（改为 host 半 Node） | 语义可平移（fetch + ahead/behind + 标签比较 + 不降级判定），但实现是 Rust 调 git；Node 侧直接调 git 更简单 |
| 子模块 URL 漂移修复、npm 发布状态、默认分支解析 | **需重写**，可按需裁剪 | 属于长期踩坑积累，首版可先不做，遇到再补 |
| 更新日志 | **需重写**（可选） | 1414 行里大量是抓取与摘要细节；首版可只给 GitHub Releases 链接 |
| AI 更新新建会话 | **直接复用** | 派发 `dsh-gui:ai-update` 消息即可，`dsh-ai-update` 已具备 |
| 分离式更新器 + 重启 | **需重新设计** | desktop 端要自己拉起分离进程、等应用退出、执行 git 更新与 `npm run build`，再重启应用 |
| 就地更新根仓库（对话框内） | **可平移** | `git ff` + `git submodule update --init --recursive` 在 Node 里等价 |

## 分阶段范围

- **S1 检测 + 入口 + 对话框（只读）**：host 半新增 `GET /desktop-tabs/api/update/status`（或独立插件路由），做根仓库与子模块的 fetch / ahead-behind / 标签比较；client 半在标题栏带菜单右侧加「更新」入口与对话框，展示行与状态，提供「检测」「更新日志（外链）」「AI 更新」。不写仓库。
- **S2 执行更新**：对话框内「更新」执行根仓库 ff + 子模块递归同步，逐行回显日志；完成后提示需要 `npm run build`（desktop 端还要重启应用）。是否遵循 [dsh-gui-update](../official/../../.agents/skills/dsh-gui-update/SKILL.md) 的「先在 `.staging/dsh-gui` 验证」策略由用户决定（外壳现在的流程是直接更新）。
- **S3 分离式更新 + 重启 + AI 更新回执**：生成分离更新器（等应用退出 → git 更新 → `npm run build` → 重启应用），并把 `dsh-gui:ai-update` 的派发与回执接上（复用 `dsh-ai-update`）。

## 范围冻结（2026-10-05 用户确认）

- **只做 S1 + S2**：检测更新 + 对话框 + 就地执行更新。不做 S3 的分离式更新器与自动重启；更新完成后由用户手动执行 `npm run build:desktop`，与 dsh-gui 原有模式一致（外壳提示的是 `npm run build`，desktop 端换成 `build:desktop`）。
- **入口位置**：标题栏**最右侧、窗口按键之前**（照搬 dsh-gui 的位置），不是菜单右侧。注意右侧宽度要避开原生窗口按键区（`titleBarOverlay` 占位，Windows 约 138px）。
- **更新日志一并迁移**：每行可查看本次更新带来的内容——有 tag 且 origin 是 GitHub 时取该 release 的说明；否则回退到提交列表（`git log`）。首版不做 AI 摘要。
- S2 更新策略：**直接 git 更新**（根仓库 ff + 子模块递归同步，按项目选择 commit/tag 目标），不强制走 `.staging` 验证。

## 待确认（已由用户回答，保留备查）

1. 按 S1 → S2 → S3 推进 → **改为只做 S1 + S2**。
2. S2 策略 → **直接 git 更新**。
3. 更新日志 → **要**。
4. 入口位置 → **标题栏最右侧、窗口按键之前**。

## 实现方案（2026-10-05 第二轮）

新增插件 `plugins/auto-update/`（wrapper `install.mjs` + 包 `dsh-auto-update`），
**仅安装到 desktop profile**（与 `plugins/desktop-tabs/install.mjs` 同构，其他 profile
只打印 skip）。host 半提供检测/更新/更新日志三条路由；client 半在标题栏最右侧画入口
按钮与对话框。接口契约、文件归属与验收判据冻结在会话临时目录的
`.work/auto-update/00-contract.md`（该目录属 `.gitignore` 排除的 scratch，任务收尾时已随
其他测试残留一并清理；当前态行为以 [desktop-auto-update.md](desktop-auto-update.md) 为准），
两端实现者只以该契约文件为准。

要点：

- **入口位置**：`position: fixed; top: 0; right: var(--dsh-auto-update-controls-width,
  138px)`，落在 40px 标题栏带内、窗口按键之前；`-webkit-app-region: no-drag`。
- **AI 更新不重写**：client 半在顶层派发 `dsh-gui:ai-update`（v1）并等
  `dsh-gui:ai-update-result` 回执，会话创建、工作区选择与「创造模式」预设由已装在
  desktop profile 的 `dsh-ai-update` 承担。
- **更新日志**：host 半收集 `git log` 提交列表；`mode=tag` 且 origin 为 GitHub 时优先取
  该 release 的说明。首版不做 AI 摘要（`dsh-ai-update` 已有 `/dsh-gui-api/changelog`
  路由，后续可作为可选增强接上）。
- **不做**：分离式更新器、自动重启、npm 发布状态核对、待更新计划文件；更新完成后由
  用户在已有 Desktop 实例关闭时手动执行 `npm run build:desktop`。
- **仓库根解析**：`DSH_GUI_ROOT` → `dirname(DSH_HOME)/dsh-gui` → `dirname(DSH_HOME)`；
  `scripts/desktop.mjs` 的 `runDesktop()` 增补注入 `DSH_GUI_ROOT`（对齐外壳
  `runApp()` 的既有做法）。

## 分工（2026-10-05 第二轮）

| 任务 | 归属 | 写范围 | 产出 |
|---|---|---|---|
| 脚手架 + host 半 | `host-dev` | `plugins/auto-update/**`（除 `src/client/**`） | 路由、检测、就地更新、更新日志 |
| client 半 | `client-dev` | `plugins/auto-update/dsh-auto-update/src/client/**` | 入口按钮、对话框、更新日志弹窗、AI 更新派发 |
| 独立验证 | `verifier` | `.work/auto-update/**`（scratch，已清理） | V1–V10 验证报告（fixture 仓库 + 隔离 desktop 实例） |
| 脚本与文档 | `docs-scripts` | `scripts/desktop.mjs`、`docs/dsh-gui/**`、插件 README 复核 | `DSH_GUI_ROOT` 注入、文档同步 |

## 进度日志

- 2026-10-05 Lead（第一轮）：完成现状核查（update.rs 1813 行 / changelog.rs 1414 行 / app.js 379 处引用）、确认 `dsh-ai-update` 已装在 desktop profile、确认「应用菜单不可注入」与「重启+重 build 流程不同」两条约束，落地本方案待用户确认范围。
- 2026-10-05 Lead（第二轮）：确认用户指令（agent team 实施、构建指令改 `build:desktop`、验证后由用户手动 build）；冻结接口契约与文件归属，派发 host/client/验证/文档四条任务。
- 2026-10-05 verifier（第三轮）：首轮 V1–V10 全通过（278 检查 0 失败）；修复子模块日志文案后复验（V3–V6 191 检查 + V7–V10 62 检查）；补 reset --hard 代价警示后第三轮复验（V7–V10 77 + 惰性 10，0 失败）。
- 2026-10-05 Lead（收尾）：误在仓库根执行了一次 `npm run build`（本意是构建插件包），已按原状恢复插件产物（与验证过的产物逐字节一致），未改动仓库跟踪文件；该次构建把运行时根的入口 exe 与 web profile 插件重装了一遍，属同一源码的重建，无行为变化。

## 结论

**完成。** 现状文档见 [desktop-auto-update.md](desktop-auto-update.md)；接口契约与验证报告
写在任务期间的 scratch（`.work/auto-update/00-contract.md`、`.work/auto-update/04-verification.md`），
该目录已随测试残留清理，结论已并入本文与现状文档。

| 项 | 结果 |
|---|---|
| 交付 | 新插件 `plugins/auto-update/`（wrapper + 包 `dsh-auto-update`）：三条 host 路由、标题栏入口、更新对话框、更新日志弹窗、AI 更新派发；`scripts/desktop.mjs` 注入 `DSH_GUI_ROOT`；新增 `docs/dsh-gui/desktop-auto-update.md` |
| 构建 | pinned pnpm（`.toolchain`）`install` + `build` 通过；`lib/index.js` 42294 B、`lib/client.js` 83457 B；删产物重建后逐字节一致 |
| 功能验证 | V3–V6：23 个 fixture 场景、191 检查、0 失败（含 NDJSON 行序、tag/commit 两种目标、子模块递归同步、changelog 的 Release/提交回退与截断） |
| UI 验证 | 隔离 desktop 实例（独立 `DSH_HOME` + `--user-data-dir` + 端口覆盖）+ CDP：V7–V10 77 检查 0 失败；入口 `rect{top:0,right:1142,bottom:40}`、`env(titlebar-area-width)=1143` → 不覆盖窗口按键；AI 更新回执 `ok:true`、草稿含本次运行唯一 tag、预设「创造模式」 |
| 惰性 | 无 `window.dshDesktop` 的页面 0 DOM / 0 样式 / 0 请求（正负向对照 10/10） |
| 安装面 | 非 desktop profile 只 skip、退出 0、不写 profile（快照前后一致）；纯新隔离 profile 走官方安装后插件挂载正常 |
| 仓库既有测试 | `npm run test:scripts` 12/12 |

收尾流程与用户约定一致：更新只完成 git 层，对话框底部提示**关闭 Desktop 实例后手动执行
`npm run build:desktop`**（该命令第 9 步会把本插件装进 desktop profile），随后重启应用。

遗留与未覆盖：

- 未做分离式更新器、自动重启、待更新计划文件（npm 发布状态与更新日志 AI 摘要已在
  v2 增补中补齐，见下节）。
- 未在 macOS/Linux 外壳、真实 `npm run build:desktop`（需关闭正在运行的实例）、
  AI 更新 60s 无回执超时路径上验证。
- 更新是 `reset --hard` 语义且**不加二次确认**（与外壳一致），靠对话框常驻警示与两个
  按钮 tooltip 交代「未提交改动会被丢弃、未跟踪文件保留」。

经验教训：

1. **破坏性操作必须自带代价提示**：首版完整复刻了外壳的交互，但外壳的 `reset --hard`
   没有二次确认、也没有警示；复核时才补上常驻警示。迁移 UI 时不能只对齐控件，要对齐
   「用户点下去之前知道什么」。
2. **契约要写验证者能构造的判据**：V6 原先写「伪造 GitHub origin 且无网络」，离线环境
   无法构造（git 层先失败），实际改用 `DSH_AUTO_UPDATE_GITHUB_API_BASE` 桩覆盖。
3. **共享包目录的构建命令必须显式指定 cwd**：Lead 漏了工作目录，在仓库根跑了
   `npm run build`（全量 dsh-gui 构建）。跨包执行 pnpm 时始终传 `workdir`。

## v2 增补（2026-10-07，用户实机反馈）

用户实机试用后的三点要求：① 补 AI 摘要与 npm 状态核对；② 检查更新改单次递归 fetch；
③ 打开对话框时工程列表与检查状态每次都空白重检，需要缓存。**功能一律对标外壳已有实现**，
契约增补见任务期间 scratch 的契约 `.work/auto-update/00-contract.md` §7（已随测试残留清理）。

| 项 | 实现 | 关键证据 |
|---|---|---|
| 单次递归 fetch | `mode=check` 在顶层执行一次 `git fetch --prune --recurse-submodules origin`，逐行只做本地比较；递归 fetch 非零退出不算整体失败，仅「本地仍缺 `origin/<默认分支>` ref」的行退化为该行单独 fetch；远端默认分支仍先 `ls-remote --symref`（拿每行一次轻量往返换正确性） | verifier 用 `GIT_TRACE` 计数：正常路径 **1 次递归 fetch、0 次逐行 fetch**，子模块 `origin/main` 由该次 fetch 前进；不可达子模块场景 1 次递归 + 1 次该行退化 fetch（负向对照），其余行照常 |
| npm 发布状态 | 新增 `src/npm.ts`：`<DSH_HOME>/gui/npm-installs.json` ∩ 工程清单名（根 + `apps/**` + `packages/**`），对 `registry.npmjs.org` 并发查询，字段 `{packages, latest, missing, complete, error?}` 与 Rust `NpmUpdateInfo` 一致；失败只写 `npm.error` | 桩覆盖命中/缺版本/HTTP/网络/不可解析五形态 + 门控矩阵；对话框两条文案与外壳逐字一致 |
| 更新日志 AI 摘要 | commit 目标（或 tag 取不到 release）时按 `changelog.rs` 的 `build_prompt` 构造提示词，`POST /dsh-gui-api/changelog` 复用已装的 `dsh-ai-update`；副标题 `由 dsh AI 汇总 · N 条提交 · from → to`（`N` 用 host 新字段 `count`）；`release` 优先且不发 AI；失败回退提交列表 | 隔离实例内真实路由被调用 1 次、提示词含提交列表与 diffstat；404/502 降级、release 存在时 0 次 AI 请求 |
| 结果缓存 | host 模块级缓存最近一次 `check`（部分失败也存），新增 `mode=cached`（200/204）；client 打开顺序对齐外壳 `openUpdateDialogWithBestState` | 首次开对话框恰好 1 次 `mode=cached`，**第二次开 0 请求**；「检查更新」仍发 `mode=check`；打桩 204 时回退骨架 → check |

验证：Lead 亲自复跑 host 自测 **251/251**、client CDP 驱动 13 组断言全通过（几何 `right=1120=controlsLeft`、重开零请求、`pageErrors=[]`）、`npm run test:scripts` 12/12；verifier 独立复算 v2 判据 V11–V14 与 V3–V10 回归，合计 **411 项检查 0 失败**，期间发现并修复 1 个缺陷（registry 返回 2xx 但 body 不可解析时 `npm.error` 落成原始 JS 解析错误，现为「无法解析 npm registry 响应」）。产物：`lib/index.js` 53514 B、`lib/client.js` 95850 B（删产物重建逐字节一致）。

遗留（v2 后）：

- 真实 AI 摘要成功路径未在验证床跑通（床内无模型凭据），隔离实例内真实路由返回的是模型错误；成功渲染用页面级打桩覆盖，降级路径已在实例内验证。
- 两个测试钩子（`DSH_AUTO_UPDATE_GITHUB_API_BASE` / `DSH_AUTO_UPDATE_NPM_REGISTRY_BASE`）不会随 desktop 启动链路到达 Host（`DSH_HOME`/`DSH_GUI_ROOT` 正常到达），因此钩子驱动的端到端只在路由级验证；生产路径用官方默认地址，不受影响。
- 仍是「点更新即执行」的 `reset --hard`（沿例外壳），代价由常驻警示与 tooltip 交代。
- 一个子模块 origin 不可达时该行报错、其余行正常、`allChecked=false`，不做自动重试。

## v3 增补（2026-10-08，用户实机反馈：检查一次太慢）

用户截图显示一次检查 **192.4 s**，并问「会和 dsh-gui 一样，程序启动后就在后台开始检查吗」。
实机归因（真实检出、只读）：顶层递归 fetch 77.3 s（`-j 8` 后 45.1 s）、每行
`ls-remote --symref` 2–12 s 且**串行**（抽样 7 行 46 s）、npm 逐行串行（registry 不可达时
10 s/行 ≈ 70 s）；另测一轮网络更差时为 fetch 140.6 s、`mode=local` 27.3 s、`mode=check`
319.5 s。契约增补见任务期间 scratch 的契约 `.work/auto-update/00-contract.md` §8（已清理）。

| 项 | 实现 | 关键证据 |
|---|---|---|
| 单飞 | 模块级 in-flight Promise：并发 `mode=check` 共享同一次运行与同一份结果；`cached`/`local` 不参与、不阻塞 | 并发两次 check 只发 **1 次**递归 fetch、**1 次** npm 探测，两份响应逐字段相同；check 在飞时 `mode=local` 748 ms 返回 |
| 并行调度 | 顶层 `fetch --prune --recurse-submodules -j 8 origin`（不认 `-j` 时去掉重试一次）；每行 `ls-remote` 与 fetch 同时发起（≤8）；逐行本地比较与 `localCheck` 都按行 ≤8 并发；行序仍按 `.gitmodules` | 与独立实现的串行参考逐字段+顺序一致；npm 池 maxInFlight=5 |
| npm 熔断与预算 | 跨行 ≤8 并发、首个探测先行（registry 不可达只耗 1 次尝试）、传输层失败熔断、10 s 阶段预算（文案 `npm 版本核对超时（10 秒预算）`）；非 2xx 与不可解析 body 不熔断 | destroy 桩探测恰 1 次；hang 桩 npm 阶段 11.9 s；503 桩 5 包 5 次探测；git 行与 `allChecked` 不变 |
| 首屏后台检查 | 挂载即后台检查（与外壳一致）：先 `?mode=cached`（命中零网络），未命中才 `?mode=check`；打开对话框立即用缓存渲染；`hasUpdates=true` 打开零请求，`hasUpdates=false` 发一次不阻塞、不出骨架的静默重查（外壳 `openUpdateDialogWithBestState` 同款） | 挂载在缓存命中时请求恰 `["?mode=cached"]`、`mode=check` 0 次；「检查更新」仍是唯一用户主动刷新入口 |

**实机耗时（同机同口径，npm 快失败隔离）**：`mode=check` 40.9 s / 51.1 s（v2：192.4 s 截图、
319.5 s 实测），其中顶层 fetch 22.9–38.6 s，**插件可控部分 8.7 s / 24.0 s**（v2：≈115–179 s）——
即检查已从「fetch + 一串串行等待」变成「基本只剩 fetch 本身」，而 fetch 受网络限制、不在插件
可控范围内。应用启动后检查在后台进行，打开对话框/重新加载都立即出内容，不再等网络。

验证：Lead 复跑 host 自测 **289/289**、client CDP 驱动 16 组断言全通过；verifier 独立复算
V15–V18 与 V3–V6/V11–V14/V7–V10 回归，合计 **469 项检查**，唯一 FAIL 经复核为契约措辞冲突
（`hasUpdates=false` 的静默重查与外壳一致），已按外壳语义修订 §8.4/§8.5，无代码改动。

遗留（v3 后）：

- 顶层递归 fetch 仍包含嵌套子模块（例如 `dsh-web-ui/satellites/*`），这些不在检测行里；
  网络差时 fetch 仍是主要耗时。若将来要再快，可考虑只并发 fetch 检测行所需的顶层子模块。
- 真实 npm 联网耗时未测（本机 registry 不可达，10 s 连接超时由环境决定）。
- 其余不可控环境：本机每次 `git` 进程启动开销较大（`mode=local` 并行前 27.3 s，并行后 ~1.6 s 量级）。



