# desktop 端插件注入与多 host 多 tab 可行性分析

本文件是本次分析的规划与进度文档，Lead 持有。结论汇总在文末「结论（待填）」。

## 问题

desktop 端有没有办法注入插件？官方尚未提供标准插件 API，但能否**在 Electron 层注入插件**（不改官方代码）？目标是：能否用注入插件的方式，在 desktop 端实现当前 dsh-gui 的「多 tab 页封装多个 host」。

## 已知前提（Lead 侦察）

- dsh-gui 的多 tab 由 Tauri **子 webview** 实现（`src-tauri/src/views.rs`，`WebviewBuilder` → `Window::add_child`）：每个连接 tab 一个真实顶层文档，并运行在自己的 WebView2 profile 上（`src-tauri/src/roots.rs` 的 `tab_webview_data_dir`，键为持久的 tab id），因此**每个 tab 持有独立的 cookie jar**；shell 页面通过 `view_*` 命令驱动，切 tab 只隐藏不销毁。
- desktop 是 Electron 应用（`deepseek-harness/apps/desktop`）：`asar: true`、`electronFuses: { runAsNode: true }`、`asarUnpack` 含 `dsh` 生产树；主窗口 `webPreferences` 为 `contextIsolation: true`、`sandbox: true`、`webSecurity: true`，并有 `setWindowOpenHandler` 与 `will-navigate` 守卫。
- desktop 的 Host 是一个 dsh profile（`<DSH_HOME>/profiles/desktop`），由 Electron RunAsNode 子进程启动；主窗口加载的正是 Web 客户端（`dsh-app://app/`），因此 **web 客户端的插件机制对 desktop 同样生效**（上游 README 的 Plugins 页即走共享 plugin manager）。
- 上一轮已实测：`npm run build:desktop` 能把 `plugins/*/install.mjs` 装进 desktop profile（19 个依赖、bundle 与 patch 均生效），应用启动无加载错误。

## 三个子问题

1. **Electron 层注入面**：不改官方代码的前提下，能否把自写代码注入主进程 / preload / shell 渲染页？（`NODE_OPTIONS=--require`、`ELECTRON_RUN_AS_NODE`、fuses、asar 完整性、签名、`additionalArguments`、环境变量与 CLI 参数的实际消费点。）
2. **官方插件通道的能力边界**：通过 desktop profile 的插件（host 半 + client 半）能做到什么？能否嵌入另一个 host 的 Web UI（iframe/CSP/`webSecurity`）、能否在客户端注册页面/侧栏/悬浮层、能否新建窗口。
3. **目标功能规格**：dsh-gui 的「多 tab 封装多个 host」到底要求哪些能力（独立会话/cookie、保活切换、凭据、远程连接 broker），从而判断每条注入路线是否够用。

## 分工

| 任务 | 归属 | 产出 |
|---|---|---|
| Electron 层注入面 | `injection-analyst` | `01-electron-surface.md` |
| 官方插件通道能力边界 | `plugin-channel-analyst` | `02-plugin-channel.md` |
| 目标功能规格（对照 dsh-gui） | `feature-spec-analyst` | `03-feature-spec.md` |
| 独立复核关键论断 | `injection-verifier` | `04-verification.md` |

上表产出文件位于任务期间的任务 scratch `.work/desktop-injection/`（被 `.gitignore` 排除，任务收尾后已清理）。

## Lead 实测（landed 应用 `D:\git\dsh-gui-home\desktop\DeepSeek Harness.exe`）

1. **`NODE_OPTIONS=--require <probe>` 不进入主进程**：探针（`node --check` 通过，且在普通 `node -e "0"` 的对照组里成功写文件）在 desktop 启动后**没有**产生输出文件，说明打包态的 `EnableNodeOptionsEnvironmentVariable` 实际为关闭，主进程无法用该变量 require 自写代码。
2. **`--remote-debugging-port=9222` 被接受**：启动后 9222 处于 LISTEN（Chromium 调试通道可用），即渲染进程级注入（CDP `Page.addScriptToEvaluateOnNewDocument`）在技术上可达，但它是调试通道、需要控制启动参数，且只能触及渲染页，触不到主进程。
3. 早前已验证 `--user-data-dir` 被接受（Electron 原生开关）。

## 进度日志

- 2026-10-02 Lead：完成框架侦察与上述两条实测，落地本规划并派发三个分析任务。

## 结论

### 一、能否「在 Electron 层注入插件」

不能走主进程注入这条路，且不需要去走：

- **打包应用只加载 `app.asar`**：Electron 的应用查找顺序是 `app.asar` → `app` → `default_app.asar`，删除或替换 asar 才能让 `resources/app/` 接管，那属于修改官方产物，不满足「不改官方代码」。
- **`NODE_OPTIONS=--require` 无效**：fuse wire 实测 `EnableNodeOptionsEnvironmentVariable` 为 ENABLE，但 Electron 在打包应用中只接受 `--max-http-header-size` 与 `--http-parser` 这一类白名单项，其余被直接丢弃。实测证实：同一探针在 `node -e 0` 对照组写入了文件，而 desktop 启动后**主进程与 RunAsNode 的 Host 子进程都没有命中**。
- **可用的只剩调试通道**：`EnableNodeCliInspectArguments` 为 ENABLE，`--remote-debugging-port` 被接受（实测 9222 监听）。它们是「控制启动参数才能获得的调试入口」，不是插件机制，也不适合作为产品能力。

### 二、官方插件通道足够实现多 host 多 tab

结论：**可以，且不需要改官方代码**。路径是把一个 dsh 插件（host 半 + client 半）装进 desktop profile，客户端半用应用自身的租约通道创建 `<webview>`：

- **客户端渲染侧有现成容器位**：`sidebar.panellist` 与 `main`（同 id 的 keyed 派发）可给出插件自有的整窗视图，第一方插件 `ui-plugin-manager`、`ui-schedule` 就是同 id 双注册；右侧栏 `sidebar.right.pane.tab` 是开放的 keyed 注册表，适合做标签条。
- **`<webview>` 通道实测可用**：`webviewTag` 在主窗口为真，`dshDesktop.browser.acquire()` 返回 `{lease, partition}`，按 `about:blank#<lease>` 挂载后 `getWebContentsId()` 可用；随后导航 `http://127.0.0.1:19999/` 成功加载（标题被探针改成 `MARKER-19999`），而导航到本机 Host `127.0.0.1:19387` 被 `ERR_FAILED` 拒绝。无租约时挂载被 `will-attach-webview` 直接拒绝。上游插件 `ui-sidebar-browser` 已在用同一条通道，说明这是树内的受支持用法而非旁路。
- **host 半能解决「另一个 host 从哪来」**：host 插件可注册 `webServer` 路由、可自监听回环端口，因此隧道/转发/换取 token URL 这些控制面可以留在插件里。

### 三、与 dsh-gui 现状的差距（决定是否值得做）

| 能力 | dsh-gui | desktop 插件方案 |
|---|---|---|
| 窗口内多个独立文档视图 | 每个 tab 一个 Tauri 子 webview | 每个 tab 一个 `<webview>`（租约 + 独立 partition） |
| 保活切换（只隐藏不销毁） | 支持 | 支持（同一会话内） |
| 会话在重启后保留 | 支持（每个 tab 一个落盘的 WebView2 profile，按持久化 tab id 复用） | **不支持**：guest partition 名为 `dsh-sidebar-browser-<uuid>`，无 `persist:` 前缀，属内存 cookie jar，重启即丢；分片名由外壳随机生成，插件无法复用 |
| 指向本机 Host 的 tab | 支持（本地为第一个 tab） | **不支持**：guest 被禁止指向本机 Host authority，本机 Host 就是应用主窗口本身 |
| 每个视图独立 cookie jar | 成立（每个 tab 一个 WebView2 profile） | 成立（每 guest 一个 partition，但是内存态） |
| 新开原生窗口 | WebView2 弹窗原生行为 | 不可用（`setWindowOpenHandler` 恒 deny） |
| 同源 iframe 方案 | —— | **不可行**：子框架没有 `nodeIntegrationInSubFrames`，既无 preload 也无 IPC，且 `dsh-app://app/<前缀>/` 取不到本地 `./assets/*` |

因此：**多 host 多 tab 的骨架在 desktop 上可用插件实现，但「重启后免登录」与「本地 Host 也作为一个 tab」这两点是缺口**；前者需要每次通过 token URL 重新认证，后者意味着本机实例只能继续占据主窗口。

### 四、路线建议与风险

- 推荐形态：**一个插件的两半**。host 半负责连接与隧道、产出各 host 的带 token URL 与控制 API；client 半在已声明 slot 里画标签条，并用 `dshDesktop.browser.acquire()` 为每个 host 挂一个 `<webview>`，切 tab 用隐藏而不是销毁。
- 实现模板：直接读上游 `packages/client/ui-sidebar-browser`（`browser-guests.ts`、`main.ts` 的租约 IPC）——它是这条通道目前唯一的使用者。
- 风险：租约通道与 `webviewTag` 都是上游内部实现，没有对外契约；升级可能改变行为。`--inspect`、`--remote-debugging-port` 只能作为调试手段，不应写进产品路径。

### 五、本次分析修正的三处事实

1. `NODE_OPTIONS` 被丢弃**不是**因为 fuse 关闭：fuse 实测为 ENABLE，原因是打包应用的官方白名单；且它对 RunAsNode 的 Host 子进程同样无效（实测零命中）。
2. 同源 iframe 不可行的**理由**不是「boot IPC 要求主框架」，而是子框架没有 nodeIntegrationInSubFrames（另有两处静态阻碍）。
3. dsh-gui 的多 tab 原先让所有 webview 共用外壳的 WebView2 profile，多 host 只靠 cookie 名 = hash(authority) 区分；现已改为每个 tab 一个独立 profile（`src-tauri/src/roots.rs` 的 `tab_webview_data_dir`，路径键为持久化的 tab id），cookie 不再跨 host 可见。
