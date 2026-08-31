# Harness 升级后构建失败排查记录（2026-08-30）

## 背景

`deepseek-harness` 子模块从 `dsh-v0.1.1-rc.2`（b150a55，父仓库记录值）升级到
工作区 `dsh-v0.1.2-alpha.1`（cd5ef81）后，`npm run build`（即
`node scripts/dsh-gui.mjs build`）在 harness 构建阶段失败。

## 症状

- tsdown/rolldown 报 `Build failed with 7 errors`，全部为 `MISSING_EXPORT`，
  import 位置集中在残留产物 `lib/types/api-proxy.js`：
  - `resolveSessionPreset`（来自 `@deepseek-ai/dsh-agent-presets`）
  - `ApiRemoteSessionNotFound`、`ApiRemoteSubagentSessionOwnership`、
    `apiRemoteSubagentOwnershipError`、`createApiRemoteAgentResolver`
    （来自 `@deepseek-ai/dsh-api-remotes`）
  - 这些符号在新版本 `src/index.ts` 中均已不存在。
- 最终 `[ELIFECYCLE] Command failed with exit code 1`，构建中止。
- 完整日志见仓库根 `npm.log`（首次失败日志，仅供追溯）。

## 根因

上游 `dsh-v0.1.2-alpha.1` 删除了 7 个包，旧版本构建产物残留在子模块工作区：

| 残留目录 | 状态 |
| --- | --- |
| `packages/host/apiproxy` | 无 `package.json`、无 `src/`，仅剩 `lib/`、`node_modules/` |
| `packages/client/runtime` | 同上 |
| `packages/client/schema-form` | 同上 |
| `packages/client/web-react` | 同上 |
| `packages/examples/acp-demo` | 同上 |
| `packages/examples/jsonrpc-demo` | 同上 |
| `packages/test-support/acp-snapshot` | 同上 |

这些目录中 `lib/`、`node_modules/` 均被 `.gitignore`（`lib/`、`node_modules`）
忽略，`git checkout` 不清理，且 `git ls-files` 确认上游树中不存在这些路径
（tracked 文件数为 0）。

`deepseek-harness/tsdown.config.ts` 的构建扫描规则为：

```ts
workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
entry: ['lib/types/{index,invariant,startup}.js'],
```

该 glob 会把上述孤儿目录仍当作构建目标（其 `lib/types/index.js` 匹配 entry
且 re-export 了 `api-proxy.js` 等旧模块），打包时按新版本 `src/index.ts`
解析依赖并校验符号，随即报 `MISSING_EXPORT`。

另：子模块内 `package.json` 的 `packageManager` 曾被本地改为 `pnpm@11.24.0`
（与本次失败无关，属环境对齐的本地改动，已在修复时还原为上游
`pnpm@11.7.0`）。

## 诊断步骤（可复现）

```powershell
# 1. 位置确认
$PSVersionTable
git status --short            # 期望： M deepseek-harness（子模块指针漂移）
git submodule status          # 期望： +cd5ef81...（HEAD 与父仓库记录不符）

# 2. 表明确认（父仓库记录 vs 工作区 HEAD）
git ls-tree HEAD deepseek-harness            # 记录值 b150a55... = dsh-v0.1.1-rc.2
git -C deepseek-harness rev-parse HEAD        # 工作区 cd5ef81... = dsh-v0.1.2-alpha.1
git -C deepseek-harness ls-tree --name-only HEAD packages/host/ | Select-String apiproxy  # 无输出 => 包已删除

# 3. 孤儿残留扫描（workspace 中无 package.json 的目录）
Get-ChildItem deepseek-harness\packages\*\* -Directory |
  Where-Object { -not (Test-Path (Join-Path $_.FullName 'package.json')) } | % FullName

# 4. 确认残留无 tracked 文件
git -C deepseek-harness ls-files packages/host/apiproxy   # 空输出
```

## 修复步骤

```powershell
# 1. 还原子模块本地改动（packageManager → pnpm@11.7.0）
git -C deepseek-harness checkout -- package.json

# 2. 删除 7 个孤儿残留目录（均无 tracked 文件，仅 gitignore 产物）
Remove-Item deepseek-harness\packages\host\apiproxy -Recurse -Force
# 同理：client/runtime、client/schema-form、client/web-react、
#       examples/acp-demo、examples/jsonrpc-demo、test-support/acp-snapshot
# 等价方式：git -C deepseek-harness clean -fdX packages/host/apiproxy

# 3. 验证构建（跳过 cargo，聚焦 harness + 插件 + presets）
node scripts/dsh-gui.mjs build --skip-exe
```

## 验证结果

- 完整构建通过：tsc（host 面）+ tsdown（host/client 面）+ vite web dist +
  218 个 client artifacts 全部产出，耗时正常。
- 插件安装脚本（ai-update、better-sidebar、flowglass、sidebar-qa、deep-whale、
  dsh-web-ui、plugin-market、remote、review、routing-suite 等）与 agent preset
  安装全部成功，无报错。
- 子模块工作区干净，外层仓库仅剩 `git add deepseek-harness` 记录升级指针。

## 预防措施

- 升级 harness 子模块后、构建前，先执行上文"诊断步骤"第 3 步的 孤儿目录
  扫描；存在无 `package.json` 的 `packages/*/*` 目录即说明上游删包残留。
- 升级后建议顺手校验 `git ls-files`，确认残留目录无 tracked 文件后再删除，
  避免误删上游真实文件。
- 不要在子模块内保存本地改动（如 packageManager），升级时一并还原/提交。
- 记录知识：`tsdown.config.ts` 的 `workspace`/`entry` 扫描逻辑不校验
  `package.json` 存在性，任何"被忽略产物目录"都可能混入构建目标。

---

# 附：升级后运行期问题排查记录（同日复验）

构建通过后运行期还有两个问题，均已处置并验证。

## 问题 2：dsh-gui 无窗口 + 90s 超时（浏览器认证未适配）

### 症状

`gui.log` 显示 `timed out after 90s waiting for the harness on 127.0.0.1:3080`，
窗口不出现；`harness.log` 里 harness 正常启动并打印：

```
dsh web: http://127.0.0.1:3080/?token=...
```

### 根因

`dsh-v0.1.2-alpha.1` 的 Web profile 引入浏览器认证
（`packages/client/connection/src/browser-auth.ts`，经 web-app bundle 挂载）：

- 启动时签发一次性 launch token，并打印带 `?token=` 的 URL；
- 无 token 且无有效 cookie 时，`GET /` 与所有 `/api*` 路由统一返回 **401**；
- 首次带 token 的 `GET /?token=...` 返回 `303` + 签名 `Set-Cookie`（cookie
  名形如 `dsh-auth-<hash>`，值与 Host authority 绑定），此后凭 cookie 访问。

而 dsh-gui（升级前版本）的启动协议只认"HTTP 200"：

- `spawn_harness` 把 stdout 直接重定向到 `harness.log`，拿不到 token；
- `main.rs` 的 `http_get_ok` 仅接受 `200` → 401 永远不满足；
- webview 加载裸 `http://127.0.0.1:<port>/` → 无 cookie → 401；
- 主进程无 cookie 的 `remote_call` / changelog 请求同样会被 401 拦截。

### 修复（`src-tauri/src/main.rs`，2026-08-30）

1. `spawn_harness`：stdout/stderr 改为管道，工作线程按行 append 到
   `harness.log`（append 模式句柄，两个流互不覆盖），stdout 行同时回放
   channel 供解析。
2. 新增 `HarnessProcess`（child + 行接收器）与 `HarnessAuth`
   （web_url + cookie）；`wait_ready` 在轮询 HTTP 的同时解析
   `?token=`（`parse_launch_token`），把 **401（gate 就绪）与 200（旧版无认证）
   都视为"已在服务"**，并等待 token 行到达。
3. 新增 `fetch_session_cookie`：token 换取 `Set-Cookie` 首对 `name=value`。
4. `harness_url` 返回带 token 的 URL（wrapper iframe 用它完成 303+cookie）；
   `http_post_json_raw` / `http_post_json` / changelog `web_summary` 增加
   cookie 参数并随请求头发送。
5. 旧版（无 token）harness 自动兼容：无 token 行时用裸 URL、cookie 为 None。

### 验证（实测通过）

```
GET /?token=...        → HTTP 303 + set-cookie
GET / + cookie         → HTTP 200（页面正常）
GET / 无 cookie        → HTTP 401（gate 仍收紧）
gui.log:
[dsh-gui] harness ready at http://127.0.0.1:3080/?token=...
```

`cargo check` / `cargo test`（21 用例全过，含新增
`launch_token_is_extracted_from_the_url_line`）。

## 问题 3：页面 Failed to load plugins（第三方插件旧版 bundle）

### 症状

浏览器打开带 token 的 URL 后页面报：

```
Failed to load plugins
dsh-flowglass
failed to import loader entry ... (@linxin666/dsh-client-ui-web-ui-settings):
client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table ...
```

### 根因（确认为第三方插件生态漂移）

- `@linxin666/dsh-client-ui-web-ui-settings@0.3.6` 的 `lib/client.js` 有
  `require("@deepseek-ai/dsh-client-runtime/client")`（源码注释明示按 rc.6/rc.7
  时代设计），`dsh-flowglass@0.4.1` 的 peerDependencies 也声明
  `@deepseek-ai/dsh-client-ui-primitives=^0.1.1-rc.2`。
- alpha.1 已移除/改名 client 运行时（仅剩 `@deepseek-ai/dsh-client-test-runtime`），
  `PLATFORM_MODULES`（packages/client/web/src/platform.ts）中无
  `@deepseek-ai/dsh-client-runtime` → module table 无 seed → 装载失败。
- 上游 alpha 预发布立场允许自由重命名/重组包、不承诺兼容；npm latest
  （0.3.6/0.4.1）已是最新，无修复版可装。

运行时确实 require 旧包的：`@linxin666/dsh-client-ui-web-ui-settings`、
`@linxin666/dsh-pet`；声明引用旧 peer 的还有 dsh-flowglass、dsh-better-sidebar、
dsh-sidebar-qa、dshmarket。报错画面中 flowglass 只是最先露头的 loader entry。

### 处置（默认跳过，等待 upstream 适配）

- `scripts/plugin-install.mjs`：`skipInstall(id)` 改为**默认名单**机制——
  `DEFAULT_SKIPPED_PLUGINS`（flowglass / dsh-web-ui-settings / dsh-pet）默认
  跳过，`installNpmPlugin` 内部统一判断并打印原因；`DSH_PLUGIN_SKIP` 环境
  变量仍可追加，`DSH_PLUGIN_FORCE_INSTALL=1` 可强制安装（upstream 适配后
  无需改代码即可恢复）。
- `plugins/better-sidebar` / `plugins/dsh-web-ui` 的 `install.mjs` 保持直接
  调用（判断已下沉共享脚本，注释说明恢复方法）。
- 已从 profile 移除三个包（`dsh plugin --profile web remove`，bundles 全部
  清除）。`npm run build` 验证：显示 `skipping '...' — version-incompatible ...`，
  deps/bundles 均不再出现三者。

### 恢复条件

`@linxin666/*`（dsh-web 全家桶）与 dsh-flowglass 发布基于 0.1.2 系列
（不再 require `@deepseek-ai/dsh-client-runtime`）的新版本后：
从 `scripts/plugin-install.mjs` 的 `DEFAULT_SKIPPED_PLUGINS` 中移除对应 id
（无需改 wrapper），或临时以 `DSH_PLUGIN_FORCE_INSTALL=1 npm run build`
强制安装，然后重新 `dsh plugin --profile web add <spec>` 确认。

### 遗留核对

dsh-better-sidebar / dsh-sidebar-qa / dshmarket / @linxin666/dsh-liangshen 仍
保留在 profile（仅声明引用旧包名的 peer，不含运行时 require）。下次启动后
核实这些插件无加载错误；若出现同类 module-table 报错，同样加入 `DSH_PLUGIN_SKIP`。

---

# Webview 改造记录（iframe → 独立 WebView2 子 webview）

## 动机

问题 2 的解法（wrapper 页面 + iframe 同站点嵌入）虽然验证通过，但不够优雅：
iframe 依赖 "wrapper 端口上与 harness 同站点" 这一巧合同源关系，浏览器认证
的 cookie、主题桥、AI 更新消息全部走 `window.postMessage` 通道，任何一处
上游调整都可能再次断裂。本次将 harness 页面改为**独立子 webview** 加载，
iframe 时代的所有 workaround 一并移除；随后进一步删除 wrapper 服务器，
shell 页面迁到应用源。

## 设计

- **窗口**：不变——无边框窗口（`decorations: false`），shell 页面
  （`ui/index.html`）绘制标题栏（窗口控制、标签页、菜单、弹窗），
  由 **tauri 应用源**提供（`frontendDist: ui`，`WebviewUrl::App`），
  不再有 wrapper 服务器与额外 loopback 端口。
  代价：shell 的 localStorage 与旧 loopback 源（http://127.0.0.1:3081）
  不同源，首次升级后标签页/已保存连接列表会重置一次（凭据仍在
  Windows 凭据管理器中）。
- **标签页**：每个已建立连接对应一个**子 webview**
  （`tauri::webview::WebviewBuilder` → `Window::add_child`，需开启 tauri
  `unstable` feature），位置/尺寸由 shell 页面报告 `#harness-frame` 的
  CSS 逻辑像素边界，Rust 侧 `view_set_bounds` 按窗口缩放换算后重排。
  - 加载 `http://127.0.0.1:<port>/?token=...` 即可，webview 自己的 cookie
    jar 承接 303 + Set-Cookie——顶层文档，无 iframe SameSite 约束。
  - 切换标签 = show/hide，页面永不重载（与 iframe 时代语义一致）。
  - **弹窗**：`on_new_window` 返回 `NewWindowResponse::Allow`
    （`SetHandled(false)`），窗口/链接新窗口走 WebView2 自身的新窗口流程
    （默认打开 popup 窗口，见 WebView2 文档 Handled=false 情形）；
    不做额外路由处理。
  - **禁止 auto_resize**：tauri 的 auto_resize 是**比例式**重排
    （top 36px 会随窗口高度缩放），标题栏固定高的布景需要
    shell 驱动的绝对重排，故由 `resize`/`ResizeObserver` 触发
    `layoutViews()` → `view_set_bounds`。
- **标题栏主题**：`ui/theme-bridge.js` 被 `ui/view-bridge.js` 取代。
  桥随子 webview `initialization_script` 注入 harness 页面，采样全局
  文本/背景色后经 Tauri IPC（`page_theme`）上报；Rust 转发
  `page-theme` 事件（携带 tabId），shell 存到 `tabs[].theme` 并应用。
- **AI 更新**：dsh-ai-update 浏览器插件契约不变（window message +
  `window.parent.postMessage`）。顶层 webview 下 `window.parent === window`，
  因此：shell 用 `view_eval` 注入合成 `MessageEvent`（`source: window`），
  插件照常回复 `window.parent.postMessage(...)`；`view-bridge.js` 捕获该
  消息经 `ai_update_result` IPC 转回 shell（`ai-update-result` 事件）。
- **弹窗遮挡**：子 webview 是原生子窗口，覆盖在 shell 页面上方，因此
  DOM 弹层（连接管理/更新/关于/变更日志/配置菜单）打开时隐藏
  harness webview（`markModal` 计数），关闭时恢复显示；toast 移到标题栏带内。
- **安全**：所有子 webview（含远端标签页 URL）都会获得
  `window.__TAURI_INTERNALS__`，因此每个命令按调用方 webview label 校验：
  shell 命令仅接受 `main`，桥命令仅接受 `tab-*`。
- **wrapper 删除**：`wrapper.rs`（loopback 静态服务器）整体移除，shell
  页面改由 tauri 应用源托管；**不需要任何 harness 转发**——harness 页面
  由子 webview 同源直连。shell 自身的跨源 RPC（`remote_call` +
  带 cookie 的 ad-hoc HTTP）保留，与 wrapper 无关。

## 涉及文件

- `src-tauri/Cargo.toml`：tauri 增加 `unstable` feature。
- `src-tauri/src/views.rs`（新增）：ViewRegistry、`view_create` /
  `view_set_bounds` / `view_set_visible` / `view_close` / `view_eval` /
  `page_theme` / `ai_update_result` 命令与 label 防线。
- `src-tauri/src/main.rs`：注册 `ViewRegistry`，所有 shell 命令增加
  `webview` 参数并校验；主窗口改为 `WebviewUrl::App("index.html")`；
  `generate_handler` 注册新命令；移除 wrapper 启动代码。
- `src-tauri/ui/view-bridge.js`（新增，替代 theme-bridge.js）：主题采样走
  IPC；AI 更新结果转发。
- `src-tauri/ui/app.js`：标签页从 iframe 改为 webview 管理
  （`ensureTabView`/`syncViews`/`layoutViews`/`markModal`）；主题与
  AI 更新改为 Tauri 事件；toast 移入标题栏。
- `src-tauri/ui/index.html` / `titlebar.css`：注释与样式同步
  （移除 `.tab-frame`，`.harness-frame` 仅作布局锚点）。
- `src-tauri/src/wrapper.rs`：**已删除**（shell 迁至应用源，无 loopback
  托管/转发职责）。
- `src-tauri/build.rs` / `capabilities/default.json`：新命令的 ACL
  权限与 remote URL 通配（`http://127.0.0.1:*`，供 tab webview 的
  主题/AI 更新桥使用）。

## 验证

在克隆工程（`DSH_GUI_PORT=3202`）实测通过：

- **独立 webview 成功加载 dsh**：窗口正常出现，自定义标题栏（窗口图标/标题/
  连接标签页/＋/菜单/最小化/最大化/关闭）全部渲染；内容区由子 webview
  加载 `http://127.0.0.1:3202/?token=...`，浏览器认证 303 → cookie →
  harness 页面正常显示（实测渲染出海豚主题首页与历史会话列表）。
- **移动/缩放**：标题栏 36px 固定，`#harness-frame` 的 CSS rect 上报给
  `view_set_bounds`（逻辑像素，Rust 按窗口 DPI 换算）；用 Win32
  `MoveWindow` 把窗口从 1280x800 改到 1520x950，harness 立即跟随重排；
  Win32 子窗口枚举确认 harness webview 恒位于标题栏下方 36px。
- **弹窗/新窗口**：`on_new_window` 返回 `Allow`（`SetHandled(false)`），
  走 WebView2 默认新窗口流程，未做额外路由（后续遇到问题再补）。
- **对话框遮挡**：打开配置菜单时 harness webview 隐藏、菜单可见；关闭后
  恢复显示（markModal 计数路径实测通过）。
- **主题桥**：view-bridge.js 采样页面全局色经 `page_theme` IPC 上报，
  Rust 转发 `page-theme` 事件，标题栏按 harness 主题着色（实测标签页高亮
  由深色默认变为蓝色主题色）。
- **传输层细节**：子 webview 同样注入 `window.__TAURI_INTERNALS__`，
  因此所有 shell 命令按调用方 webview label 校验（`main` 才可调
  `view_*`/`remote_call` 等，`tab-*` 才可回报主题/AI 更新结果）；
  权限清单（`capabilities/default.json` + `build.rs` 的
  `AppManifest::commands`）同步加入了新命令；shell 页面在应用源
  （tauri://，Local 上下文），tab webview 的桥命令走 remote url 通配
  `http://127.0.0.1:*`。
- **wrapper 删除后实测（补充）**：**无 3203/wrapper 端口监听**，仅 harness
  3202 一个端口；shell 页面从应用源加载并正常进入主界面（`harness_url`
  等 invoke 通过——boot 日志显示的 harnessUrl 即 3202 端口）；标题栏/
  主题自适应/子 webview 加载 harness/`MoveWindow` 缩放跟随全部正常。

### 遗留说明

- 主题/新窗口/AI 更新链路中，主题已实测；弹窗与 AI 更新请求的 UI 触发
  路径未做全自动交互验证（配置已在代码与文档中说明）。
- shell 页面从 loopback 源迁到应用源后，localStorage 与旧源不同：
  升级后标签页/已保存连接列表重建一次（凭据仍在 Windows 凭据管理器）。
- `.dsh/profiles/web/node_modules` 在克隆工程中以 junction 复用，
  两个 harness 实例（3080/3202）共享 node_modules 只读，无冲突。

---

# 附 2：AI 更新按钮失效（dsh-ai-update 客户端 API 漂移，2026-09-05 修复）

## 症状

webview 改造后的自动更新对话框里，AI 更新按钮点击后提示
「AI 更新会话未启动，可检查内嵌页面或重试。」，按钮失效。

## 定位

端到端复现（Playwright headless Chromium 加载 `http://127.0.0.1:3080/?token=<t>`
后注入与 shell `view_eval` 完全相同的合成消息，捕获插件回复）：

```
dispatch dsh-gui:ai-update → reply { ok: false, error: "workspaces.connectWorkspace is not a function" }
```

即插件浏览器半确实挂载、消息链路（合成 MessageEvent `source: window` → 顶层
`window.parent === window`）无恙，断点在 `dsh-ai-update` 客户端调用的服务 API：

- alpha.1 把"按工作区打开/新建空白会话"从 `workspaces` 服务移到
  `uiWorkspace` 服务（`packages/client/ui-workspace/src/client/navigation.ts`，
  `UiWorkspace.connectWorkspace`）；`IWorkspaces` 只剩 create/rename/delete/
  archiveSession/insertSessionBefore/list。
- `WorkspaceSnapshot` 同时删除了 `recentWorkspaceId`、`baselinesReady`
  字段（`packages/api/workspace-controller/src/client/model.ts`）。
- 插件 `sessions` / `conversation.input.for(actx).setDraft` 契约不变，无需改动。

## 修复

`plugins/ai-update/dsh-ai-update/src/client/index.ts`：

1. `inject` 增加 `'uiWorkspace'`；`run()` 改用
   `uiWorkspace.connectWorkspace(targetWorkspaceId)`。
2. 工作区快照按新形状对齐：去掉 `recentWorkspaceId`/`baselinesReady`，
   兜底用 `items[0]`（注册了 dsh-gui 仓库工作区时本就走首选分支）。
3. README/docs 同步（服务清单、工作区兜底顺序）。

重新构建（`node plugins/ai-update/install.mjs`，即共享流水线
pnpm + tsdown）。**无需重启 harness**：`dsh-client-hmr` 轮询到
`lib/client.js` 变化后重新哈希 bundle（boot rev
`07f9319592144ae5-51` → `936f3081d4d4`），SSE 推送 rebuilt，
活的页面 fiber 原地换新。

## 复验

同一探针脚本再次注入：

```
reply { ok: true }；composer 编辑器内容包含预填充的提示词
```

（`window.addEventListener('message')` 捕获回复 + 检查
`[contenteditable]` 文本）。shell 侧回复转发链路（view-bridge.js →
`ai_update_result` IPC → shell 事件）未改动。

## 预防

插件浏览器半升级 harness 后先核对客户端服务目录
（`packages/extensions/cordis-client-runner/src/client/api-catalog.ts`
列出 AI 插件可用的 `ctx.*` 服务与方法签名），再跑一次上述探针脚本
（`.work/ai-update-probe-pw.mjs`）确认 `ok: true`。

探针副作用：探针流程会执行 `sessions.clear()`，页面回到 home 后应用的标准
导航策略自动补位连接最近工作区，可能留下一个空白会话（后续探针/真实点击会
复用它，无害）；在意的话在主页会话行右键「归档」隐藏即可，不要手工删除
`.dsh/sessions/...` 目录（宿主存储另有序/缓存索引）。

## 涉及文件

- `plugins/ai-update/dsh-ai-update/src/client/index.ts`
- `plugins/ai-update/dsh-ai-update/README.md`、`docs/README.md`
- `lib/client.js` 重建产物（gitignored，随安装流水线生成）

---

# 附 3：远端 SSH 连接在浏览器认证后失效（dsh-remote 未适配，2026-08-31 修复）

## 症状

「新建连接 → 远程 · SSH」报 `remote ssh 无法连接`，对话框日志在
`ssh 端口转发 ✓` 之后不再前进；远端日志尾部出现 `Killed`，`dsh-gui` tmux
会话与服务全部消失。

```
✗ tmux 会话 dsh-gui — state=MISSING
✗ 启动远端 dsh — ... npm run harness ... > $HOME/.dsh-gui-remote.log 2>&1
✓ tmux 启动 dsh —
✓ 服务端口 3080 — 会话内后端监听 127.0.0.1:3080
✓ ssh 端口转发 — 127.0.0.1:64519 -> 64:3080
（此后原地等待 "前端就绪"，150s 超时 → teardown → tmux kill-session → 远端 Killed）
```

## 根因（问题 2 的 remote 侧漏适配）

问题 2 修复只覆盖了本地壳层（`src-tauri/main.rs` 的 `spawn_harness`）：
`dsh-v0.1.2-alpha.1` 起的浏览器认证使 **无 token 时 `GET /` 与 `/api*` 一律 401**。
而 `plugins/remote/dsh-remote`（Host 端 `connectRemote`）仍是升级前协议：

1. 「前端就绪」探测只认 **HTTP 2xx**（`probe().loadable`）——裸 URL 永远 401，永不就绪；
2. 返回给标签页的 URL 是裸 `http://127.0.0.1:<本地端口>/`——即使放行也 401 白屏；
3. 最致命：`teardown()` 会把**本次尝试创建的** tmux 会话 `kill-session` 掉——
   于是每次失败都顺带杀掉刚启动的远端 dsh，日志尾部留一行 `Killed`。

（注：本地 `GET /?token=...` → **303 + Set-Cookie**，携带 cookie 再访 `/` → 200；
裸 URL → 401；错误 token → 401。这些与问题 2 里 `main.rs` 记录完全一致。）

## 修复（`plugins/remote/dsh-remote/src/index.ts`，Hot Reload 生效，免重启）

对齐 `main.rs` 的既有 token 适配约定：

- 新增 `remoteLaunchToken()`：从远端 `$HOME/.dsh-gui-remote.log` 里
  `dsh web: ...?token=<token>` 一行提取一次性 launch token；
- 隧道建立后，就绪判定改为：
  - 裸 URL 2xx（旧版无 token profile）→ 就绪，返回裸 URL；
  - 或带 token 的 URL 返回 **303（token 被接受）/ 2xx** → 就绪，返回带 token 的 URL；
  - 401 会在循环内反复重取 token（应对 token 行晚于端口开放落盘的情况）；
- 返回 `res.url = http://127.0.0.1:<本地端口>/?token=...`，标签页 webview 自己完成
  303 + cookie（与本地标签完全同一条链路）。

## 验证（实测通过）

```
ssh.connect → ok:true
前端就绪 http://127.0.0.1:64309/?token=ng6aj... — HTTP 303
GET /?token=... → 303 + set-cookie；GET / + cookie → 200
插件隧道 64309 监听存活；远端 tmux 会话 ALIVE（不再被 teardown 杀掉）
```

## 涉及文件

- `plugins/remote/dsh-remote/src/index.ts`（修复）
- `plugins/remote/dsh-remote/docs/README.md`、`README.md`（文档同步）
- `lib/index.js` 重建产物（gitignored）
- 本记录文件（§附 3）

---

# 附 4：弹层打开时 harness 内容黑屏（原生子窗口遮挡，修复记录）

## 症状

webview 改造（iframe → 独立子 webview）后，点开标题栏汉堡菜单、连接管理、
检查更新/关于等弹层时，窗口内 dsh 内容区域全部变黑；基于 UI Automation 的
截图工具仍能选中 dsh 会话里的控件，说明页面只是"不显示"而未被卸载。

## 根因

- 改造后每个连接标签页由 `views.rs` 的**原生子 webview**
  （`Window::add_child`）承载，它是一个独立的原生子窗口，绘制层级在
  shell 主 webview **之上**。
- 因此 shell 页面里的 DOM 弹层（`.overlay`、`.config-menu`）永远被 harness
  子窗口盖住；旧实现用 `ui/app.js` 的 `markModal(true)` 在弹层打开时
  `view_set_visible(false)` 隐藏 harness webview 来"露出"弹层。
- 隐藏后内容区只剩 shell 的 `--bg: #0d1117`（近黑背景）——即截图里的黑屏。
  页面未卸载，所以 UI Automation 仍可见控件。

## 修复（混合方案）

两种界面不再与 harness 子窗口争层级：

1. **汉堡菜单 → Tauri 原生弹出菜单**（`main.rs` 的 `show_config_menu`）：
   与左上角窗口菜单同机制（`window.popup_menu_at`），原生菜单浮在一切
   子 webview 之上，不再需要隐藏 harness。
2. **连接管理 / 检查更新 / 关于 → 系统原生弹窗**（`src/dialogs.rs`）：
   `setup` 阶段预创建三个**隐藏**的 `dialog-conn/update/about` WebviewWindow
   （加载同一 `index.html` 并注入 `window.__DSH_DIALOG_VIEW__`，`app.js` 进入
   `dialog-mode`）；`open_dialog` 发出带 `kind` 的 `dialog-open` 事件（Tauri
   JS 监听器是 Any 目标，会广播，所以各页只响应与自己 kind 匹配的请求），
   匹配的页面渲染内容后经 `show_dialog` 显示自身；作为主窗口的 **owned
   window** 永远压在主窗口之上。窗口用**常规尺寸**（长内容在面板内滚动），
   打开时不做 resize——WebView2 初始化期间同步 `set_size` 会让整个进程冻结；
   内容变化后的微调由 `fit_dialog` 在显示 1.5s 后才允许执行。
   harness 全程保持可见——弹窗浮于其上，而非黑屏。
   - 连接弹窗成功后经 `connection_added` 命令 → `connection-added` 事件
     通知主 shell 追加标签页；
   - 更新弹窗的「AI 更新」经 `ai_update_request` → 主 shell 在活动标签页
     执行 `view_eval` → `dialog_event` 把结果送回更新弹窗；
   - 更新日志仍在更新弹窗内以 overlay 展示（该弹窗内没有 harness 子窗口，
     无遮挡问题）。

   > 注：**不能在 IPC 命令中运行时创建** `WebviewWindow`——本项目为子
   > webview 开启了 tauri `unstable` feature，该 feature 下存在已知问题：
   > 额外 WebviewWindow 白屏且整个应用卡死
   > （[tauri-apps/tauri#10011](https://github.com/tauri-apps/tauri/issues/10011)）。
   > 所以改为在 setup（尚未创建任何子 webview）时预创建隐藏窗口，之后只
   > 显示/隐藏复用，绕开该 bug。

## 涉及文件

- `src-tauri/src/dialogs.rs`（新增）：`open_dialog` / `close_dialog` /
  `fit_dialog` / `show_dialog` / `connection_added` / `ai_update_request` /
  `dialog_event`。
- `src-tauri/src/main.rs`：`show_config_menu` 原生菜单；数据命令的
  `ensure_shell_or_dialog` 放宽到 `dialog-*` 页面；菜单事件转发。
- `src-tauri/src/views.rs`：`DIALOG_LABEL_PREFIX` 与
  `ensure_shell_or_dialog` / `ensure_dialog`。
- `src-tauri/ui/app.js`：`DIALOG_VIEW` 分支（`bootDialog`/`dialog-open` kind
  过滤）、原生菜单调用、显示后延迟自适应（`scheduleFit`/`fitDialogToContent`）、
  主 shell 的事件监听（`config-menu-action` / `connection-added` /
  `ai-update-request` / `dialog-closed`）。
- `src-tauri/ui/titlebar.css`：`dialog-mode` 样式。
- `src-tauri/build.rs` / `capabilities/default.json`：新命令 ACL 与
  `dialog-*` 标签权限。

## 验证

- `cargo check` 通过；`cargo test` 通过（沙箱内 2 个 git 用例受
  "couldn't create signal pipe" 环境限制失败，无沙箱复跑全部通过）。
- 窗口级实测（截图见 `.work/dsh-gui-smoke/`）：原生汉堡菜单打开时
  harness 内容保持可见；「检查更新」与「新建连接」弹窗卡片正常渲染、
  可关闭；关闭后主界面与 harness 内容均正常，无黑屏/卡死。
- 细节见 `docs/dsh-gui/gui-window-frame.md` 的行条目更新。
