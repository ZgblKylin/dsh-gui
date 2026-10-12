# desktop 远端标签与 dsh-gui 连接标签的权限能力对照

本文件对照两条远程连接链路：dsh-gui（Tauri 外壳）的连接标签 webview，与 desktop（Electron）经 `dshDesktop.browser` 租约加载的远端标签。结论以 pinned 子模块修订 `5badb150`（dsh 0.2.1-alpha.1）与 `plugins/desktop-tabs/dsh-desktop-tabs` 的源码为准，逐条给出判定位置。

## 结论摘要

- 已报的两个缺陷（远端页面复制按钮无效、dsh-pet 的权限申请与系统通知缺失）同源：desktop 主进程给每个租约访客的 session 装上「全拒绝」权限处理器（`deepseek-harness/apps/desktop/src/browser-guests.ts:141`），而 desktop 承载应用界面的 session 只拒绝媒体权限（`deepseek-harness/apps/desktop/src/microphone-permissions.ts:16`），dsh-gui 的连接标签则放行剪贴板并把通知权限延迟到页内征询（`src-tauri/src/views.rs:504`）。
- 租约 API 自身没有策略参数，`acquire(workspace)` 只收一个存储身份（`deepseek-harness/packages/client/ui-sidebar-browser/src/types.ts:20`），因此这两项差异无法由插件侧消除。
- 其余同类差异中，访客焦点与 `window.open` 两项可由插件侧修复；下载、会话持久化、弹窗抑制属于同一条访客策略，与上面两项一起只能由 desktop 主进程改。
- 本文件只记录对照结论与修法选项，不含 desktop 侧改动。

## 一、已报缺陷的根因

### 1.1 远端页面的复制按钮无效

desktop 的租约访客共享一条会话配置链：`setPermissionRequestHandler` 一律回 `false`、`setPermissionCheckHandler` 一律回 `false`、`setDevicePermissionHandler` 一律回 `false`、`setDisplayMediaRequestHandler` 回空、`will-download` 直接 `preventDefault()`（`deepseek-harness/apps/desktop/src/browser-guests.ts:141`-`154`）。异步剪贴板 API 的写入需要 `clipboard-sanitized-write` 权限，检查处理器返回 false，`navigator.clipboard.writeText()` 因此以 `NotAllowedError` 拒绝。

第二个成因是文档焦点：异步剪贴板 API 要求发起文档处于聚焦状态，而插件挂载访客后从不调用 `webview.focus()`，仅有面板的搜索框与配置面板的输入框会聚焦（`plugins/desktop-tabs/dsh-desktop-tabs/src/client/panel.ts:244`、`plugins/desktop-tabs/dsh-desktop-tabs/src/client/config-panel.ts:210`）。dsh-gui 在显示标签时显式交出焦点（`src-tauri/src/views.rs:234`）。

两条成因叠加：即使权限放行，未聚焦的访客仍可能失败；即使聚焦，权限被拒也必然失败。

### 1.2 dsh-pet 的权限申请与系统通知缺失

dsh-pet 在远端实例里请求通知权限，走 `Notification.requestPermission()`。desktop 访客 session 的请求处理器直接回 `false`，请求不产生任何界面；插件侧也收不到任何事件。desktop 的权限与会话是主进程概念，插件运行在应用文档的渲染进程里，没有可用的改写入点。

dsh-gui 的同一件事是显式实现的：通知类权限取 `GetDeferral()` 挂起，注入 `window.__dshPermissionPrompt({ requestId })` 让标签页面渲染征询浮层，用户选择后经 `view_answer_permission` 回填（`src-tauri/src/views.rs:549`-`596`）；剪贴板读权限则直接放行（`src-tauri/src/views.rs:545`-`548`）。desktop 侧没有等价机制。

## 二、三方能力对照

| 能力 | desktop 应用主文档 | dsh-gui 连接标签 | desktop 远端标签 |
|---|---|---|---|
| 剪贴板读写 | 放行（非媒体权限一律 `true`，`deepseek-harness/apps/desktop/src/microphone-permissions.ts:17`-`22`） | 剪贴板读显式放行，写沿用默认（`src-tauri/src/views.rs:545`） | 拒绝（全拒绝策略） |
| 通知权限 | 放行 | 挂起并页内征询，用户选择后回填（`src-tauri/src/views.rs:549`） | 静默拒绝，无界面 |
| 访客文档焦点 | 主文档天然聚焦 | 显示标签即 `set_focus()`（`src-tauri/src/views.rs:234`） | 不聚焦 |
| 媒体权限 | 仅麦克风，且限定主框架与 `dsh-app://app` | WebView2 默认 | 拒绝 |
| 设备权限（HID/串口/USB） | 主文档默认 | 不适用 | 拒绝 |
| 投屏（display capture） | 主文档默认 | 不适用 | 回空对象 |
| 下载 | 主文档默认 | 默认（WebView2 保存流程） | `will-download` 一律取消 |
| `window.open` / `target=_blank` | 主进程按 URL 分类处理 | 允许 WebView2 独立弹窗（`src-tauri/src/views.rs:186`） | 上游转发 `browserOpenRequested`，但插件未注册监听，链接无响应 |
| 会话持久化 | 应用 profile | 每标签一个 WebView2 数据目录，落盘 | 进程生命期分区（非 `persist:`），重启后重新认证 |

## 三、访客策略的其余约束

`browser-guests.ts` 在 `will-attach-webview` 里固定访客的 `webPreferences`：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: false`、`disableDialogs: true`、`devTools` 仅在未打包时开启（`deepseek-harness/apps/desktop/src/browser-guests.ts:85`-`91`）。这让访客无法弹原生对话框、无法嵌套 webview、无法在发行版里开 DevTools；销毁访客时以 `waitForBeforeUnload: false` 关闭（`deepseek-harness/apps/desktop/src/browser-guests.ts:60`），页面无法阻止卸载。

导航侧同时限制：主框架只能导航到 http/https 且不能指向应用自身的 Host authority（`deepseek-harness/apps/desktop/src/browser-guests.ts:156`-`169`），请求侧取消带用户名口令的 URL 与本机应用 Host（`deepseek-harness/apps/desktop/src/browser-guests.ts:147`-`153`）。这些是隔离设计，与剪贴板、通知同属一层，改动都需要在 desktop 主进程内进行。

## 四、租约 API 的可扩展性

插件通过 `window.dshDesktop.browser` 使用该通道，判据是 `protocolVersion === 1`，只调用 `acquire(workspace)` 与 `release(lease)`（`plugins/desktop-tabs/dsh-desktop-tabs/src/client/bridge.ts:41`-`46`）。上游同一接口另有 `onOpenRequested(lease, listener)`（`deepseek-harness/packages/client/ui-sidebar-browser/src/types.ts:26`），上游 sidebar-browser 用它消费被拒绝的原生窗口请求（`deepseek-harness/packages/client/ui-sidebar-browser/src/client/electron/ElectronWebViewImpl.ts:155`）；本插件没有注册，因此远端页面里的 `window.open` 与 `target=_blank` 点击后无任何结果。

## 五、修法选项

### 5.1 选项 A：仓库携带 desktop 补丁

新增仓库级补丁目录（例如 `desktop/patches/`），由 `npm run build:desktop` 在同步检出后幂等应用。补丁把访客租约扩成带显式策略的请求，取 `isolated` 时保持现状，取 `harness` 时放行剪贴板读写与下载、并把通知权限转发给应用文档征询。

代价是构建链新增一个环节，且每次升级 `deepseek-harness` 都要重新适配补丁：`.desktop/source` 的脏树检查会中止构建（`scripts/desktop.mjs:228`），所以补丁必须在同步后应用、并在构建前 reset；`docs/dsh-gui/desktop-app.md` 需要同步补一节。

### 5.2 选项 B：仅插件侧兜底

不改 desktop：插件在挂载访客后 `focus()`；对剪贴板注入降级实现（覆写远端页面的 `navigator.clipboard.writeText` 走 `document.execCommand('copy')`）；把远端 `Notification` 桥接到应用文档显示。

这能消除症状，但等于对远端页面做运行时改写，通知的「权限申请」语义与 dsh-gui 的征询流程不一致，且随远端页面结构变化而失效。

本仓库的 `plugins/desktop-tabs/dsh-desktop-tabs` 已按此路线实现**通知**这一块（`src/client/notify-relay.ts` 与 `view.ts`）：guest 每次 `dom-ready` 注入 shim，把 `Notification.permission`/`requestPermission()`/`navigator.permissions.query({name:'notifications'})` 报成 `granted`，`new Notification(...)` 改成入队；视图层在 guest 存活期间按 1 s `executeJavaScript` 取回队列，应用文档用自身 `Notification` 重放为真实系统通知。剪贴板的选项 B 兜底与 `focus()` 尚未据此实现。机制与验证、已知限制见该插件 `README.md` 的「远端通知转接」与「已知限制」两节。

### 5.3 选项 C：只保留审计

不改 desktop，也不改插件的访客加载路径，把对照结论与补丁设计留作后续决策的输入。插件侧的焦点与 `onOpenRequested` 两项独立于 desktop 策略，不依赖选项 A 即可实施。

## 六、若走选项 A 的补丁设计

- 协议：`browserAcquire` 请求增加 `policy`，取值 `isolated`（缺省，维持现有隔离）与 `harness`（连接标签）；`protocolVersion` 升到 2，插件接受 1 或 2，读到 1 时按 `isolated` 处理。
- 落点：`deepseek-harness/apps/desktop/src/browser-guests.ts` 的 `configureSession` 按策略分派；`deepseek-harness/apps/desktop/src/ipc.ts` 与 `preload-app.ts` 透传策略；`deepseek-harness/packages/client/ui-sidebar-browser/src/types.ts` 扩展请求类型。
- `harness` 策略内容：剪贴板读写放行；下载放行；通知权限按第八节选定的语义处理。
- 插件侧：`plugins/desktop-tabs/dsh-desktop-tabs/src/client/bridge.ts` 与 `view.ts` 传策略，并在挂载后聚焦访客。

## 七、验证要点

- 剪贴板：在远端标签里点击代码块复制按钮，随后在应用文档执行 `navigator.clipboard.readText()`，应取到该代码块内容。
- 通知：在远端实例触发 `Notification.requestPermission()`，按选定语义应出现征询界面或直接进入已授权状态并出现系统通知。
- 焦点：切到远端标签后不做任何点击，直接触发复制按钮，应成功。
- 构建约束：`npm run build:desktop` 的插件安装步骤要求 desktop 处于关闭状态（`docs/dsh-gui/desktop-app.md:53`），构建与验收都需要先退出应用。

## 八、未决问题

- 通知语义：若走选项 A 的 `harness` 策略，需再定「与 dsh-gui 一致的页内征询」还是「与 desktop 主文档一致的直接放行」；本次选项 B 落地的转接采用的是**在应用文档直接放行并重放**，绕过征询。
- 下载是否随通知一并纳入 `harness` 策略。
- 远端标签的会话持久化：是否改用 `persist:` 分区，让重启后免去一次 token 导航。
