# dsh-gui 启动即闪退（setup panic：the underlying handle is not available）排查与修复记录（2026-09-26）

## 症状

双击 `dsh-gui.exe` 后窗口不出现、进程立即退出（闪退）。仓库根目录
`dsh-gui-crash.log` 反复出现同一条 panic：

```
panic: panicked at ...\tauri-2.11.5\src\app.rs:1425:11:
Failed to setup app: error encountered during setup hook: the underlying handle is not available
```

## 定位

### panic 触发点

`src-tauri/src/main.rs`（Windows 分支，`setup` 内）：

```rust
native_window::install(window.hwnd()?.0);
```

`window.hwnd()` 返回 `raw_window_handle::HandleError::Unavailable`，其 `Display`
即 **"the underlying handle is not available"**（`raw-window-handle-0.6.2/src/lib.rs:366,385`）。
该 `?` 冒泡出 setup，被 `tauri/src/app.rs:1425` 用
`panic!("Failed to setup app: {e}")` 打出——与日志完全吻合。

### 为什么 `hwnd()` 会 Unavailable

Tauri runtime-wry **吞掉了底层建窗失败**：

- `tauri-runtime-wry-2.11.4/src/lib.rs`：`Message::CreateWindow(window_id, handler)`
  分支为 `Err(e) => log::error!("{e}")`——失败只记日志、不返还；
- 同文件 `Context::create_window`：无论 handler 成功与否都返回
  `Ok(DetachedWindow)`。

于是 `WebviewWindowBuilder::build()?` 表面成功，实际窗口没有插入 runtime 的窗口表；
紧接着的 `window.hwnd()` 查不到窗口 → `Unavailable` → setup panic。

### 真正的底层错误（加日志后捕获）

`wry/tao` 只把真实错误发到 `log` crate，而 dsh-gui 原本没有 logger，所以只留下
不透明的 `HandleError::Unavailable`。加上文件 logger（见下）后，实测得到：

```
[ERROR] tauri_runtime_wry: failed to create webview: WebView2 error:
        WindowsError(Error { code: HRESULT(0x800700AA), message: "资源正在使用中。" })
```

- `0x800700AA` = `HRESULT_FROM_WIN32(ERROR_BUSY)`；
- 把 `%LOCALAPPDATA%\com.dsh.gui\EBWebView` 换成全新目录后，错误变为
  `0x8000FFFF`（`E_UNEXPECTED`）；
- 把 WebView2 的 user-data 目录指向**仓库内**新目录
  （`E:\Git\dsh-gui\.dsh\gui\webview2`）后，**启动完全成功**（harness ready、
  WebView2 子进程正常拉起、无 panic）。

即根因是 **WebView2 默认用户数据目录 `%LOCALAPPDATA%\<identifier>\EBWebView`
在当前环境下不可用**（environment 创建失败，浏览器进程都拉不起来）。
`%LOCALAPPDATA%\com.dsh.gui` 目录本身可写、ACL 正常，排除单纯权限问题；
与它相关的是 WebView2 对该 profile 的创建/初始化失败。

## 修复

### Phase 1：让真实错误可见

- `src-tauri/Cargo.toml`：新增 `log = "0.4"`（树中已存在 0.4.33）。
- `src-tauri/src/logging.rs`（新增）：进程级文件 logger，写入
  `<root>/.dsh/gui/gui.log`（按行 append，与 `log_status` 共用文件）；
  `logging::install(&root)` 在 `main()` 里、Tauri builder 运行前调用。
- `src-tauri/src/main.rs`：setup 内加入 `dsh-gui starting` / `setup: building the
  main window` 进度行。

### Phase 2：不再不透明闪退

- `src-tauri/src/main.rs`：`native_window::install(window.hwnd()?.0)` 改为先取句柄、
  失败时 `fatal(Some(&setup_root), "主窗口创建失败…见 .dsh\\gui\\gui.log")`——
  弹 MessageBox + 干净退出，而不是 panic。
- `src-tauri/src/main.rs`：`dialogs::create_all(...)?` 改为 best-effort：失败仅
  `log::error!` + `dsh_log`，不中断启动（`open_dialog` 会按需创建缺失的弹窗）。

### Phase 3：真正修复（WebView2 user-data 目录改到仓库内）

- `src-tauri/src/main.rs`：新增 `webview_data_dir(root)` =
  `<root>/.dsh/gui/webview2`，并把它设为：
  - 主窗口 `WebviewWindowBuilder::data_directory(...)`；
  - `src-tauri/src/dialogs.rs` 每个弹窗 `WebviewWindowBuilder::data_directory(...)`；
  - `src-tauri/src/views.rs` 每个标签页子 `WebviewBuilder::data_directory(...)`。
- 这样所有 WebView2 environment 共享一个仓库内 profile，彻底不依赖
  `%LOCALAPPDATA%\com.dsh.gui\EBWebView`；出问题时可删除 `.dsh/gui/webview2` 重置。
  与自托管约定一致（`DSH_HOME`、日志都在 `.dsh` 下）。

## 验证（实测通过）

在改后的构建上、**不设任何 `WEBVIEW2_*` 环境变量**、`DSH_GUI_PORT=3099` 启动：

```
[dsh-gui] harness ready at http://127.0.0.1:3099/?token=...
[dsh-gui] [ui] boot gate: harness ready after 8022ms
[dsh-gui] perm: install_webview_permissions on 'tab-current'
运行中：yes（无 panic；dsh-gui-crash.log 未增长）
```

- 仓库内 profile 已生成：`.dsh/gui/webview2/EBWebView` 存在。
- 标签页子 webview（`tab-current`）权限流程正常运行，说明 `views.rs` 的
  `data_directory` 生效。
- `cargo build --release` 通过。

### 一次性影响

WebView2 profile 从 `%LOCALAPPDATA%\com.dsh.gui\EBWebView` 迁到
`.dsh/gui/webview2`，因此 shell 页面（应用源）的 localStorage 会重建一次
（标签页/已保存连接列表；凭据仍在 Windows 凭据管理器）。旧的
`%LOCALAPPDATA%\com.dsh.gui\EBWebView`（约 459 MB）已不再被使用，可自行删除。

## 涉及文件

- `src-tauri/Cargo.toml`（`log` 依赖）
- `src-tauri/src/logging.rs`（新增）
- `src-tauri/src/main.rs`（安装 logger、setup 加固、`webview_data_dir` + 主窗口 data_directory）
- `src-tauri/src/dialogs.rs`（弹窗 data_directory）
- `src-tauri/src/views.rs`（标签页子 webview data_directory）

## 备注：附带的 Tauri 上游缺陷

`tauri-runtime-wry` 在 `Message::CreateWindow` 上吞掉建窗错误，使
`WebviewWindowBuilder::build()` 在原生窗口创建失败时仍返回 `Ok`，调用方只能在下一次
句柄查询时看到误导性的 `HandleError::Unavailable`。本记录即为该缺陷在本工程的
定位与规避：不依赖 `build()?` 判定成功，而是显式校验句柄并把真实错误落盘。
