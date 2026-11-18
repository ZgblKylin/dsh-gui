# 快捷助手设计说明

## 为什么需要独立的原生助手进程

全局快捷键与「失焦自动隐藏、可置顶」的浮层窗口只能由原生代码提供。两个桌面产品的外壳不同：Tauri 外壳（`dsh-gui.exe`）是本仓库自有的 Rust 程序，Electron 桌面（`DeepSeek Harness.exe`）来自上游 harness，后者没有可复用的窗口/快捷键扩展点。让插件自己拉起一个原生助手进程，使两种外壳共用同一实现，也避免给上游 Electron 主进程打补丁。

助手是 `src-tauri` crate 的第二个 bin（`dsh-quick-assistant`），与外壳共用依赖；构建产物落在运行时根，Host 半按 `<dirname(DSH_HOME)>/dsh-quick-assistant[.exe]` 查找，可用 `DSH_QUICK_ASSISTANT_EXE` 覆盖。

## 进程与通信

```
DSH Host（Node）                    原生助手（Rust/Tauri）              覆盖页（WebView2）
  ├─ 启动助手 --url --api --shortcut --data-dir
  ├─ GET /quick-assistant/api/native ← 每 3 秒轮询 ───────────────────────┤
  ├─ POST /quick-assistant/api/chat ← SSE ────────────────────────────────┤ fetch
  └─ 一次性 token ─────────────────────── argv ──────────────────────────→ window.__QA_TOKEN__
```

- 助手的三条职责：注册全局快捷键（Win32 `RegisterHotKey`，消息窗口 WndProc 收 `WM_HOTKEY`）、显示/隐藏窗口（`SetForegroundWindow` + 线程输入附加，失焦隐藏，置顶时跳过隐藏）、把内容高度回报给窗口（页面调用 `qa_set_height`）。
- 页面通过 Tauri IPC 命令控制窗口：`qa_set_pinned`、`qa_hide`、`qa_set_height`、`qa_set_shortcut`、`qa_log`；原生侧通过事件 `qa-shown` / `qa-hidden` 通知页面聚焦输入框或中止流。
- 助手轮询 `<base>/quick-assistant/api/native`：快捷键变化时重新注册，`showRequest` 变化时显示窗口（设置页的「测试唤起」走这里）。连续 4 次轮询失败即认为 Host 已退出并自行结束。
- Host 半在插件 dispose 时结束助手进程（3 秒后强杀）；助手意外退出时按指数退避重启，最多 5 次。

## 安装范围与 shell overlay

插件不能出现在普通浏览器页面里，但 Tauri 外壳与浏览器页面共用 `web` profile。安装脚本按 profile 分流：

- `desktop` profile：`installPlugin` 正常写入 profile 的 `cordis.patch.yml`。
- 其他 profile：`installPlugin({ mountFile })` 只安装依赖，挂载行写到 `<DSH_HOME>/gui/shell-overlays/quick-assistant.patch.yml`。

Tauri 外壳启动 `dsh web` 时扫描 `<DSH_HOME>/gui/shell-overlays/*.patch.yml`，有文件时以 `dsh --profile web --patch <file>… --port … --no-open` 启动（启动器选项必须位于被启动应用的参数之前）。没有 overlay 文件时仍以 `dsh web --port … --no-open` 启动。浏览器直接运行 `dsh web` 不经过外壳，因此不加载该插件。

## HTTP 接口（前缀 `/quick-assistant`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | token | 覆盖页 HTML，注入 `window.__QA_TOKEN__` |
| GET | `/assets/:file` | token | 覆盖页静态资源，仅允许明文文件名 |
| GET | `/api/bootstrap` | token | 设置、语言表、模型目录、助手状态 |
| POST | `/api/chat` | token | SSE：`meta` → `delta`… → `done`/`error` |
| GET | `/api/native` | token | 助手轮询：`{ shortcut, showRequest }` |
| GET/PUT | `/api/settings` | 同源 | 设置读取/保存 |
| GET | `/api/catalog` | 同源 | provider → model → 思考等级目录 |
| POST | `/api/show` | 同源 | 测试唤起（`showRequest` 自增） |
| GET | `/api/health` | 无 | 助手是否在运行 |

`/api/chat` 请求体：`{ mode, text, messages?, sourceLanguage?, targetLanguage? }`。`mode` 为 `ask` 时 `messages` 是此前的问答文字对；其余模式忽略 `messages`，由提示词模板与 `text` 生成单条用户消息。模型解析顺序：模式覆盖 → 主模型 → 模型目录中第一个可用条目。

## 与 DSH 的接缝

- `ctx.webServer.register({ kind: 'prefix', path: '/quick-assistant', handler })`：路由自行实现 token 与同源校验（`/api` 前缀的浏览器信任围栏不覆盖插件路由）。
- `ctx.llm.stream({ provider, model, reasoningEffort?, system?, messages, purpose: 'quick-assistant', signal })`：不创建 Session；`purpose` 由本包的模块声明扩充 `LlmRequestPurposeMap`。客户端断开时通过 `res.on('close')` 中止请求。
- `ctx.agentDefaultModel.currentSelection()`：可选服务，缺失时回落到模型目录。

## 升级检查清单

升级 harness 后复核：

1. `GenerateOptions` 的 `messages` / `purpose` / `reasoningEffort` 字段仍兼容；
2. `LlmRequestPurposeMap` 仍通过 `@deepseek-ai/dsh-llm/types` 扩充；
3. `WebServer.register` 的 `prefix` 路由与 `ServerResponse` 生命周期语义不变；
4. 客户端 `settings.section` / `settings.section.icon` slot 与 `PropsRuntime` / `PropsLocale` 契约不变；
5. Tauri crate 的第二个 bin 仍可编译（`cargo build --release --bin dsh-quick-assistant`）。
