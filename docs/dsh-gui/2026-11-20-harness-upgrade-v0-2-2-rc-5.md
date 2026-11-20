# harness 升级：dsh-v0.2.2-rc.3 → dsh-v0.2.2-rc.5

本文件记录把工程基座 `deepseek-harness` 从 `dsh-v0.2.2-rc.3` 推进到 `dsh-v0.2.2-rc.5` 的适配与阶段一验收结果。按升级门槛，验证在仓库内 worktree `.staging/dsh-gui`（工作分支 `staging/verify`）完成，未改动主工程；阶段二合并主分支待用户审批后执行。

## 目标修订与发布状态

| 项 | 旧修订 | 新修订 | npm |
| --- | --- | --- | --- |
| deepseek-harness | dsh-v0.2.2-rc.3（38a6a5c965） | **dsh-v0.2.2-rc.5**（9c2670d3bc） | `@deepseek-ai/dsh` 的 `latest` 与 `next` 均为 `0.2.2-rc.5` |
| 官方 provider 四件套（browser-use / playwright-mcp / computer-use / cua-driver-native） | 0.2.2-rc.3 | **0.2.2-rc.5** | 四包已发布 `0.2.2-rc.5`（`next`）；`latest` 仍停在 `0.1.6-alpha.1` |

`harness.json` 保持 `{"runtime":"npm","version":null}`，不改清单；构建按子模块 `apps/cli/package.json` 的版本从 registry 安装 `@deepseek-ai/dsh@0.2.2-rc.5`。

## 区间规模

rc.3..rc.5 共 8 个提交，含 `dsh-v0.2.2-rc.4` 与 `dsh-v0.2.2-rc.5` 两次发布提交。版本号之外的源码改动集中在三处，其余为各包版本号同步与测试：

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 网页搜索默认提供方按模型路由选择 | `packages/bundle/base/cordis.patch.yml`、`packages/web/**` | 基础组合不再设置 `web.searchProvider`；`dsh-web` 在没有显式 id 时按模型请求的路由选择：`deepseek-official` / `deepseek-account` 路由用旧版 Messages 搜索（不按次收费、按 token 计费），其它路由与不服务于模型请求的搜索用 DeepSeek Search API。`WebSearchRequest` 新增 `llmProvider`，`dsh-tool-web` 传入会话最新模型请求的路由 |
| DeepSeek 内容审查与拒答 | `packages/llm/llm-deepseek`、`packages/llm/llm` | 新增 `safetyCheck` 开关并始终请求内容审查；`refusal` 停止原因映射为 `CONTENT_REFUSED` 错误并携带提供方说明；拒答前已消耗的 token 先上报用量 |
| liveshare 隧道 worker | `packages/experimental/liveshare` | 在 Host 的 Electron Node 模式下启动隧道 worker |

对应的上游升级指南为 `docs/upgrade-guide/v0.2.2-rc.4/web-search-deepseek-model-default/` 与 `docs/upgrade-guide/v0.2.2-rc.3/deepseek-refusal-code/`。

## 适配改动

| 文件 | 改动 |
| --- | --- |
| `deepseek-harness`（子模块指针） | 38a6a5c965 → **9c2670d3bc（rc.5）** |
| `plugins/harness/browser-use.mjs`、`computer-use.mjs` | 四个官方 provider 的精确 spec 与注释抬到 `0.2.2-rc.5`。四包的 peer 精确指向运行时版本，旧 pin 会被新闸门拒绝，因此必须与 harness 同批换包；rc.3..rc.5 之间官方四件套只有 `package.json` 版本号变化，挂载行与 Config 保持原样 |
| `plugins/harness/README.md` | 安装内容表、准入说明与 Agent Teams 表述同步到 rc.5 |
| `plugins/README.md` | 中英文两段的当前 pinned runtime、准入与安装说明同步到 rc.5 |
| 其余 npm wrapper 的注释与 README | `better-sidebar`、`commandcode-provider`、`deep-whale`、`ds-harness-remote`、`dsh-pause`、`dsh-pet`、`dsh-web-ui`、`dsh-you-should-know`、`plugin-market`、`skill-mcp-center` 中「当前 pinned harness」与准入说明改到 rc.5；这些 wrapper 跟踪 registry latest，安装 pin 本身不变 |
| `docs/dsh-gui/{ssh-remote-workspace,ssh-provider-vs-dsh-remote,dsh-pet-troubleshooting}.md` | 运行时版本示例与当前 pinned harness 说明同步到 rc.5 |

`docs/official` 的 19 个链接全部指向 rc.5 中仍存在的位置：10 个目录链接可列出子项，9 个文件链接可读取内容；没有悬空链接，无需重建。

## 兼容性核查

- 官方四件套在 rc.3..rc.5 之间只有各自的 `package.json` 版本号变化，名字、peer 结构与 Config schema 不变；四个 `0.2.2-rc.5` 包已在 registry 发布，准入闸门按精确 peer 接纳。
- bundle 与 client 契约无差异：`packages/util/package-manifest` 的 `dsh.bundle` 类型、`packages/boot/app-boot` 的 profile 装载与准入闸门、`vendor/loader`、`vendor/cordis` 两 tag 之间没有改动。
- `web.searchProvider` 在仓库配置与插件中没有引用，profile 继承「按模型路由自动选择」；`commandcode-provider` 的联网搜索开关显式指定提供方，显式 id 仍优先，不受新默认影响。
- `LLM_FAILURE_CODES` 新增 `CONTENT_REFUSED`；仓库插件没有按 LLM 错误码分支的逻辑。
- 19 个插件安装脚本的准入声明在 `includePrerelease` 语义下接纳 `0.2.2-rc.5`，web 与 desktop 两个 profile 的安装都没有出现包被闸门拒绝的情况，也没有使用精确版本例外。
- `plugins/harness/auto-review-model` 依赖的三条内部约定在 rc.5 中仍然成立：审查请求带 `purpose: 'auto-review'`（`LlmRequestPurposeMap` 的声明合并仍在）、`llm/stream` 仍是 waterfall、provider 仍在 waterfall 之后解析。

## 阶段一验收

全部在 `.staging/dsh-gui` 与 `.staging/` 运行时根内完成，未触碰主工程与运行中的实例。

| 项目 | 命令 / 手段 | 结果 |
| --- | --- | --- |
| 运行时与 web profile 构建 | `npm run build -- --skip-exe`（`DSH_HOME=.staging/.dsh`） | 退出码 0；安装 `@deepseek-ai/dsh@0.2.2-rc.5` 到 `.staging/.harness`；19 个插件安装脚本执行完成（`auto-update` 在 web profile 按设计跳过）；组合冒烟检查通过 |
| 入口 exe 构建 | `npm run build` | 退出码 0；cargo release 编译完成，入口 `.staging/dsh-gui.exe`（14,218,240 字节）落位 |
| 组合配置 | `.staging/.harness/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config` | 退出码 0；228 个 loader 条目，无 `duplicate loader entry id`，无 error 输出 |
| **WebUI 加载验收** | 空闲端口 3090 启动 `npm run harness`，Playwright 打开带 token 的 URL | 标题 `DeepSeek Harness`；新建会话成功（侧栏出现「新会话」并选中），composer、访问模式、模型选择、使用统计与插件面板齐全；控制台 0 error / 2 warning；首屏的「预览版说明」与「开始使用（登录 / 添加 API Key）」是首次启动对话框，不是错误覆盖层；验收后关闭实例并释放端口 |
| **tauri 外壳验收** | 空闲端口 3091 执行 `npm start`，computer use 读取窗口 | 出现标题 `DeepSeek Harness` 的窗口（`dsh-gui.exe`）；UI 树列出新建会话、插件、自动化任务、技能中心、工作区、Remote、使用统计与 composer，桌宠渲染正常；通知权限弹窗为首次启动提示，无错误覆盖层；验收后关闭窗口并释放端口 |
| **desktop 构建** | `npm run build:desktop -- --skip-plugins`（`DSH_HOME=.staging/.dsh`） | 退出码 0；源 `9c2670d3bc`（0.2.2-rc.5）；产物 `.staging/desktop` 7878 文件 / 1.05 GB；入口 `DeepSeek Harness.exe` 版本 0.2.2-rc.5（234.9 MB）；shim `dsh-gui-desktop.exe` 重建 |
| desktop profile 插件安装 | `.staging/install-desktop-plugins.mjs`（构建第 9 步的等价流程：准入裁剪、逐个安装脚本、bundles 调和） | 19 个安装脚本执行完成，0 个 bundle 条目需要补登记；官方四件套为 `0.2.2-rc.5` |
| **desktop 应用验收** | 隔离 `--user-data-dir` 启动 `.staging/desktop/DeepSeek Harness.exe`，computer use 读窗口，Playwright 读桌面 host 的带 token URL | 窗口出现（904×1053），标题栏按钮可 invoke；staging home 无凭据，窗口显示欢迎首屏（登录 / 添加 API Key）。桌面 host 在 `127.0.0.1:62974` 起服务，其页面完整渲染：品牌 `DSH 本地构建 0.2.2-rc.5-9c2670d-dirty`、新建会话、插件、自动化任务、技能中心、工作区、Remote、使用统计与 composer，desktop-only 插件（更新、桌宠、皮肤、市场等）的 client bundle 全部加载；控制台 0 error / 1 warning（连接首屏加载竞态）；无错误覆盖层。验收后关闭实例 |
| docs/official 链接 | 逐条读取 19 个链接 | 全部可穿透（目录可列出子项，文件可读取） |

### 环境偏差（不影响主工程，记录以便复现）

- **desktop 构建跳过第 9 步**：`scripts/desktop.mjs` 的插件安装步骤用全局 `tasklist` 检测 `DeepSeek Harness.exe`，而本会话宿主正是该进程，构建无法执行该步；改为按同一脚本逻辑手动复刻（`.staging/install-desktop-plugins.mjs`）。这是上轮验证的既有做法。
- **desktop 打包链的两个 smoke 临时跳过**：本机 `runtime:smoke` 与 packaged runtime smoke 在断言全部通过后不退出，`prepare-dsh` 静默挂起；验证时在 `.desktop/source` 的对应脚本加环境变量守卫（`DSH_SKIP_RUNTIME_SMOKE` / `DSH_SKIP_PACKAGED_SMOKE`），交付前已撤销，不进入提交。desktop 应用改为落位后手动启动验收。
- **desktop 构建跳过上游 clean**：上游 `pnpm run clean` 会删除前一步预取的 primary-runtime 下载缓存，随后的 `prepare:runtime` 必须重新从 `nodejs.org` 拉取，网络超时会中断打包；验证时以 `DSH_SKIP_DESKTOP_CLEAN` 复用本修订已完成的构建输出，交付前同样撤销。
- **中断构建的 pnpm store 残留**：被打断的 `prepare:runtime` 会在 `.desktop/source/apps/desktop/.desktop-build/pnpm-store/v11/projects` 留下悬空 symlink，`pnpm run clean` 报 `ENOTEMPTY`；删除该 store 目录后重跑即可，它属于构建工作区产物。
- **staging 产物带低完整性标签**：`.staging` 位于会话工作区，其中的入口 exe 与 desktop 应用无法使用 Chromium 沙箱；desktop 应用启动时以 `--no-sandbox --disable-gpu --user-data-dir=<.staging/user-data-rc5>` 启动，并去掉继承的 `ELECTRON_RUN_AS_NODE`。

## 已知回归与未决风险

- **网页搜索默认行为变化（上游设计）**：使用 DeepSeek 模型的会话现在走旧版 Messages 搜索，会话日志会追加 `web/deepseek-search-llm-request` 事件，按 token 计费；DeepSeek provider 指向网关的部署会把 `DEEPSEEK_API_KEY` 发往官方搜索端点，需要按 rc.4 指南第 2、3 步配置 `web-search-deepseek.baseURL` 或显式 `searchProvider`。本仓库不设置该字段，继承新默认。
- **desktop 窗口未进入会话界面**：staging home 没有账号凭据，desktop 窗口停在欢迎首屏；会话界面与插件组合通过桌面 host 的带 token URL 渲染结果确认，登录后的交互面未实测。主工程的 desktop profile 带凭据，实装后按常规使用验证。
- **第三方 npm 插件按 registry latest 安装**：本轮为 better-sidebar 0.32.1、commandcode-provider 0.18.2、ds-harness-remote 0.6.6、dsh-pause 0.1.8、dsh-pet 0.4.9、dshmarket 1.73.23、skill-mcp-center 0.8.1、dsh-web-ui 三包 0.4.19 / 0.4.20 等，web 与 desktop 两个 profile 加载均无报错；右键菜单、远端面板等交互细节未逐一实操。
- 阶段二尚未执行：工作分支合并回主分支需用户明确审批；合并后由用户停止运行中的实例并执行重建。
