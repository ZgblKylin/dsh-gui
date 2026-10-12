# 连接标签 webview 的剪贴板能力

本文件分析 dsh-remote 连接标签（本机后端、SSH、Docker 三种后端一致）在 dsh-gui 桌面外壳里的 webview 创建逻辑，以及代码块复制按钮依赖的剪贴板读写如何在 WebView2 中放行。结论以 `src-tauri/src/views.rs`、`src-tauri/src/main.rs`、`src-tauri/ui/view-bridge.js` 与 pinned wry 0.55.1 的源码为准。

## 结论摘要

- 每个连接标签由外壳创建的**子 webview** 承载（`views.rs` 的 `ensure()` → `WebviewBuilder::new` + `Window::add_child`），本机、SSH、Docker 三类连接共用同一条创建路径，只差加载的 loopback URL。
- WebView2 只把**剪贴板读**（`COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ`）当作权限事件；**剪贴板写**不经过权限事件，只要求安全上下文、页面聚焦与点击带来的用户激活。
- 因此「启用剪贴板」在 WebView2 侧指放行读权限，写权限由页面自身语义保证。标签 webview 将读权限显式放行，健全性上再给 `navigator.clipboard.writeText` 注入 `document.execCommand('copy')` 回退，即使异步写因聚焦抖动被拒也能完成复制。

## 一、连接标签 webview 的创建逻辑

外壳页面（`src-tauri/ui/app.js`）收到连接成功后，把后端返回的 loopback URL 交给 `view_create` 命令；Rust 侧在 `views.rs` 的 `ensure()` 中创建或复用该标签的子 webview。

标签 webview 的构建参数（`views.rs` `ensure()`）：

- `WebviewBuilder::new(label, WebviewUrl::External(url))`：标签以其 id 命名（`tab-<id>`），作为顶层文档加载远端 harness 页面；加载 `http://127.0.0.1:<port>/?token=…` 这样的 loopback URL，浏览器侧认证 303 + `Set-Cookie` 握手直接在 webview 内完成。
- `initialization_script(../ui/view-bridge.js)`：文档创建时注入桥接脚本，承载页面主题采样、通知权限征询与 AI-update 回执转发。
- `on_new_window(Allow)`：远端页面的弹窗与 `target=_blank` 走 WebView2 原生弹窗，外壳不接管。
- `enable_clipboard_access()`：启用异步 Clipboard API（见第二节的权限语义）。
- `data_directory(tab_webview_data_dir(...))`：每个标签独立 WebView2 数据目录，cookie 不跨主机串扰。
- `Window::add_child(builder, ...)`：把子 webview 放到窗口内容区指定位置。

`install_webview_permissions` 随后在 Windows 上给每个标签 webview 挂授权处理器（`views.rs`）：

- 剪贴板读权限一律放行（与 `enable_clipboard_access()` 的放行一致）。
- 通知权限取 `GetDeferral()` 挂起，注入 `window.__dshPermissionPrompt({ requestId })` 让标签页面渲染征询浮层，用户选择后经 `view_answer_permission` 回填 allow/deny。

标签切换只做显示/隐藏（`view_set_visible`），页面保持加载。显示标签时外壳把键盘焦点交给 webview（`views.rs` `set_visible` 内的 `set_focus()`，对应 WebView2 的 `MoveFocus(PROGRAMMATIC)`）。

## 二、WebView2 剪贴板权限模型

WebView2 权限事件只有读剪贴板一个枚举值；写路径不触发权限事件。wry 的 `enable_clipboard_access()` 在 WebView2 后端注册的就是一个把 `CLIPBOARD_READ` 置为 ALLOW 的 `PermissionRequested` 处理器（wry `webview2/mod.rs` 的启用剪贴板段落），不涉及写。

`navigator.clipboard.writeText()` 能成功的前提：

- 页面为安全上下文。Loopback 的 `http://127.0.0.1` 属于潜在可信源，`navigator.clipboard` 存在。
- 发起文档处于聚焦状态。
- 点击复制按钮提供用户激活。

三者满足时，WebView2 直接写入系统剪贴板，无需宿主放行。外壳主 webview（`main`）同样调用 `enable_clipboard_access()`（`src-tauri/src/main.rs`）。

## 三、复制按钮的写回退

harness 的复制控件（代码块、消息复制、JSON 树等）经 `ui-primitives` 的 `writeClipboard` 调用 `navigator.clipboard.writeText()`，并把拒绝视为复制失败（该路径没有 `execCommand` 回退）。在嵌入式 WebView2 子 webview 中，异步写可能在真实点击下仍被拒——控制器键盘焦点并非总被转移，而异步 API 要求聚焦文档——此时 `document.execCommand('copy')` 只需要点击的用户激活与一处选区，仍然会成功。

`view-bridge.js` 在顶层框架注入写回退：把 `navigator.clipboard.writeText` 包一层，异步写被拒绝时改用 `execCommand('copy')` 复制同一文本，两者都失败才抛错。读操作保持原样，读权限由第二节的授权处理器放行。

## 四、验证要点

- 本地、SSH、Docker 三类标签分别点击代码块复制按钮，随后在外壳页面或任意编辑器粘贴，应得到代码块内容并显示「复制成功」反馈。
- 切到标签后不点击页面其他位置，直接触发复制按钮，应成功（显示时已交焦点，且回退覆盖聚焦抖动）。
- 通知权限路径不受本次改动影响：`window.__dshPermissionPrompt` 征询仍由 `install_webview_permissions` 提供。

## 五、边界与说明

- 对话框 webview（`dialog-*`）不承载 harness 页面；其复制控件依赖的剪贴板放行属于另一条创建路径（`src-tauri/src/dialogs.rs`），不在本文件范围。
- 改动只覆盖 dsh-gui 外壳；harness 官方 Electron 桌面（`deepseek-harness/apps/desktop`）的租约访客剪贴板策略见 `2026-10-08-desktop-tabs-permission-parity.md`。