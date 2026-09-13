# 用户设想「SSH 远端 headless + 桌面端独立 webview 加载远端 WebUI」在官方 Electron desktop 的可行性核实

本文核实的目标方案：桌面端通过 SSH 登录远端机器，在远端启动 headless 的 dsh（远端自跑 `dsh web`，只绑回环），桌面端用独立的窗口或 webview 加载远端自带的 Web UI。

上游源码引用相对仓库根，即 `deepseek-harness/...`（pinned 子模块 `dsh-v0.1.5-rc.2`，只读）。本仓库源码引用同样相对仓库根。全部结论区分三类证据：

- 「代码可证」：源码或组合配置文件里有直接对应的行，改动或行为可由静态阅读确定。
- 「文档声称」：结论来自上游仓库文档、Electron 官方文档等文本，而非本次可执行的代码路径。
- 「需实测」：依赖 Electron/Chromium 运行时行为、真实远端环境或真实安装流程，静态阅读不能判定。

## 结论摘要

用户方案拆成两层后判定不同。**控制面（SSH、远端启动、端口转发、凭据、连接状态与控制通道）成立**，且官方 desktop 提供了标准插件 API，不需要魔改；**视图面（用独立窗口或 `<webview>` 加载远端 WebUI）不成立**，纯插件唯一可用的承载方式是同一页面内的跨源 iframe，其运行时可行性需实测。整句方案因此判定为**有条件成立**。

用户的难点预判「主要难点是 desktop 版还没有标准的插件化 API，只能魔改注入」**不准确**，方向偏了一层：

- 数据面与能力面有标准插件面：profile bundle 插入 Loader 行、`ctx.connection.fetch.register` 挂精确路由、`ctx.slots.register` 渲染界面、`ctx.credentials` 存取凭据、Typert Remote 提供类型化方法，且受信同进程插件可以直接使用 `ssh2` 与 `node:child_process`；证据见 §2。
- 真正的硬约束在窗口与视图面：dsh 插件运行在 Electron 之外的 Node 子进程里，拿不到 `BrowserWindow`；主 renderer 的 `window.open` 被无条件拒绝，`<webview>` 标签未开启。因此「独立 webview/窗口」这一载体必须改上游 `apps/desktop` 私有源码。
- 次要约束在跨源承载：远端 WebUI 的认证依赖 `SameSite=Strict` 的 HttpOnly cookie，跨站 iframe 下的 cookie 存取属运行时行为。

另有一处容易被误判的既有实现障碍：现有 `plugins/remote/dsh-remote` 的宿主半声明 `inject = ['webServer']` 并按任意前缀注册 `/remote-api`（`plugins/remote/dsh-remote/src/index.ts:74`、`plugins/remote/dsh-remote/src/index.ts:1181`），而 desktop 组合在层里禁用了 `webserver` 行（`deepseek-harness/apps/desktop-host/config/desktop.cordis.patch.yml:6-7`），该插件在 desktop 中会永久 pending。这是「按原样迁移」不成立的原因，不是「方案本身不可能」的原因。

## 1. dsh-gui 现状要素与所属层

dsh-gui 的远程连接能力分布在 Rust 壳（Tauri）、插件宿主半与插件浏览器半三处。浏览器半当前不注册任何内容，其 `apply` 为空（`plugins/remote/dsh-remote/src/client/index.ts:23-25`），连接标签页与新建连接对话框由 Rust 壳页面驱动（`src-tauri/ui/app.js:455` 调 `remote_call`，`src-tauri/ui/app.js:318` 调 `view_create`），每个标签页的承载是壳创建的子 webview（`src-tauri/src/views.rs:1-14`）。

| 要素 | 当前落点 | 证据（相对路径:行号） |
|---|---|---|
| 本机额外后端启动 | 宿主半插件 | `plugins/remote/dsh-remote/src/index.ts:1333` |
| SSH 连接与认证（密码、密钥、口令、ssh config 解析、known_hosts accept-new） | 宿主半插件，纯 JS `ssh2` 与 `ssh-config` | `plugins/remote/dsh-remote/src/index.ts:47`、`plugins/remote/dsh-remote/src/index.ts:48`、`plugins/remote/dsh-remote/src/index.ts:457`、`plugins/remote/dsh-remote/package.json:35-36` |
| SSH 本地端口转发 | 宿主半插件 | 回环监听见 `plugins/remote/dsh-remote/src/index.ts:802-824`，流量经 `ssh2` 的 `forwardOut` 送出见 `plugins/remote/dsh-remote/src/index.ts:812` |
| 远端 dsh 启动与 tmux 会话保活 | 宿主半插件 | `plugins/remote/dsh-remote/src/index.ts:1629`、`plugins/remote/dsh-remote/src/index.ts:1684`、`plugins/remote/dsh-remote/src/index.ts:1138` |
| 远端就绪探测与 launch token 提取 | 宿主半插件 | `plugins/remote/dsh-remote/src/index.ts:1160`、`plugins/remote/dsh-remote/src/index.ts:1555` |
| Docker `exec` stdio 隧道 | 宿主半插件 | `plugins/remote/dsh-remote/src/index.ts:969`、`plugins/remote/dsh-remote/src/index.ts:1036` |
| 凭据与 keyfile（Windows DPAPI / Linux gpg、`<DSH_HOME>/gui/keys/`） | 宿主半插件，自实现文件加解密 | `plugins/remote/dsh-remote/src/index.ts:1266`、`plugins/remote/dsh-remote/src/index.ts:1277`、`plugins/remote/dsh-remote/src/index.ts:1237` |
| `/remote-api` 白名单 op 面 | 宿主半插件注册 `webServer` 前缀路由，Rust 命令做 op 白名单与回环 POST 代理 | `plugins/remote/dsh-remote/src/index.ts:74`、`plugins/remote/dsh-remote/src/index.ts:1181`、`src-tauri/src/main.rs:1387`、`src-tauri/src/main.rs:1379-1395` |
| 连接标签页与新建连接对话框 | Rust 壳页面，不使用插件浏览器半 | `src-tauri/ui/app.js:455`、`src-tauri/ui/app.js:318`、`plugins/remote/dsh-remote/src/client/index.ts:1-25` |
| 远端 WebUI 的承载 | Rust 壳创建子 webview（`WebviewBuilder` 与 `window.add_child`） | `src-tauri/src/views.rs:175-193` |

Rust 壳走裸 TCP 而不是页面 `fetch` 的原因写在插件文档里：壳页面位于应用源（app origin），与 `http://127.0.0.1:<port>` 跨源，页面不能直接访问 `/remote-api`（`plugins/remote/dsh-remote/docs/README.md:110`；`src-tauri/src/main.rs:1172-1176` 把该源记作 "the app origin"，插件文档把它记作 `tauri://`，`src-tauri/` 内没有该 scheme 字面量）。同一文档也记录了本地转发必须有一个回环监听端点的取舍（`plugins/remote/dsh-remote/docs/README.md:56`）。

子 webview 相对 iframe 的收益写在 Rust 侧的模块注释里：子 webview 是真实的顶层文档，认证流程在它自己的 cookie jar 中完成，不需要代理或 iframe 的 SameSite 变通（`src-tauri/src/views.rs:5-10`）；同时窗口级的 cookie 也由壳单独获取并注入自己的 HTTP 调用（`src-tauri/src/main.rs:661-667`、`src-tauri/src/main.rs:675-694`、`src-tauri/src/main.rs:1391`）。这段注释是判断 iframe 承载风险的第一手旁证，但它描述的是 WebView2 环境，不能直接外推到 Electron。

## 2. 要素到官方 desktop 的映射

### 2.1 纯插件可行部分

desktop 的 dsh 后端是一个独立的 Node 子进程，不是 Electron 进程：外壳用自带的 upstream Node.js 可执行文件启动 `node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`（`deepseek-harness/apps/desktop/src/host-process.ts:101-113`），可执行文件路径来自 `runtimeResources`（`deepseek-harness/apps/desktop/src/main.ts:55-63`），README 也把「dsh 运行在自带 upstream Node.js 下」写进关键技术决策（`deepseek-harness/apps/desktop/README.md:12`）。因此宿主半插件拥有完整 Node 能力，但没有任何 Electron API。

| 要素 | 纯插件可行 | 依据 |
|---|---|---|
| SSH 与端口转发（`ssh2` + `node:net`） | 可行 | 宿主半在普通 Node 进程内（`host-process.ts:101-113`），`child_process` 与 `node:net` 均为原生能力；环境变量只过滤 `NODE_OPTIONS`、`DSH_DESKTOP_*`、`npm`/`pnpm`/`corepack` 前缀（`host-process.ts:109-111`），`HOME`/`USERPROFILE` 保留，`~/.ssh` 可读 |
| 回环本地监听端点 | 可行 | 插件是同进程受信代码，端口监听不受组合限制；「能力声明不是安全沙箱」是本仓库既定约定（`AGENTS.md` 的「安全边界」一节） |
| 远端启动命令与 tmux 保活 | 可行 | 同上，通过 `ssh2` 会话执行远端命令 |
| 凭据存取 | 可行，且可改用官方服务 | desktop 组合保留 `credentials` 行（`deepseek-harness/packages/bundle/base/cordis.patch.yml:97-98`），`connection` 行显式 `inject: [credentials]`（`desktop.cordis.patch.yml:24-27`）；服务方法见 `deepseek-harness/packages/credentials/credentials/src/index.ts:183-256` |
| 客户端连接 UI 与承载视图 | 可行 | desktop 会把客户端 bundle 服务给页面：宿主半对 `/plugins/` 前缀调用 `ctx.clientModules.fetchBundle`（`deepseek-harness/apps/desktop-host/src/index.ts:200`），启动图由 `clientModules` 通过 `webserver/index-inject` 事件注入（`deepseek-harness/packages/client/modules/src/index.ts:578-580`），且该服务在缺 `webServer` 时仍可用（`deepseek-harness/packages/client/modules/src/index.ts:576`、`deepseek-harness/packages/client/modules/src/index.ts:601-614`）；客户端插件按 `ctx.slots.register` 组合 UI |
| client 到 host 的控制通道 | 可行，两条 | 见下 |

控制通道的第一条是精确 Fetch 路由。`ctx.connection.fetch.register` 把路由写进本地 `fetchRoutes` 映射，全程不访问 `webServer`（`deepseek-harness/packages/client/connection/src/rpc-host.ts:139-156`），路径必须落在 `/api` 之下（`rpc-host.ts:292-303`、`deepseek-harness/packages/client/connection/src/api-path.ts:6`），desktop 宿主半已经取了这个 handler 并把 `/api/` 前缀的请求交给它（`deepseek-harness/apps/desktop-host/src/index.ts:305`、`deepseek-harness/apps/desktop-host/src/index.ts:341-342`）。客户端半在同源页面里用 `globalThis.fetch('/api/<segment>')` 或 `ctx.connection.rpc.call('/api', '<endpoint>', payload)` 到达它；后者把 `location.origin` 作为基址（`deepseek-harness/packages/client/connection/src/client/rpc.ts:44`、`client/rpc.ts:108-111`），在 desktop 中即 `dsh-app://app`。

需要注意精确路由不是自由分发。`createSharedFetchHandler` 的分派顺序是：精确路由命中则执行，否则交给共享通道的拦截器，拦截器不认领则返回 404（`deepseek-harness/packages/client/connection/src/rpc-host.ts:121-135`）。共享通道 `/api` 上只允许一个拦截器，且已由 Typert Gateway 占用（`rpc-host.ts:190-205`、`deepseek-harness/packages/api/gateway/src/index.ts:198-204`），它只认领自己的类型化 endpoint（`gateway/src/index.ts:266-273`）。因此自定义操作应注册精确 Fetch 路由，类型化方法与流式调用应走 Typert Remote。

控制通道的第二条是 Typert Remote 的流。客户端半的 `open` 只接受 `/api` 通道并要求载体提供 `openStream`（`client/rpc.ts:61-69`），desktop 注入的传输脚本正好提供了它，把流映射为对 `/.dsh/remote-stream` 的 POST 并逐行解析 NDJSON（`deepseek-harness/apps/desktop-host/src/index.ts:99-120`、`deepseek-harness/apps/desktop-host/src/index.ts:190-192`），宿主半把该路径交给 `remoteStreamHandler`，后者调用 `typertGateway.wireStream.open`（`apps/desktop-host/src/index.ts:223-265`、`apps/desktop-host/src/index.ts:339-340`、`gateway/src/index.ts:177-180`）。这条通道同样不依赖 `webServer`。

一处必须由插件自己承担的安全事实：desktop 的 `/api` 分派直接调用 `api.fetch`，不调用 `requestRejection`（`apps/desktop-host/src/index.ts:305`、`apps/desktop-host/src/index.ts:341-342`），而 Host/Origin 与 cookie 认证原本由 `requestRejection` 与 `authorizeIndex` 施加（`rpc-host.ts:97-100`）。因此在 desktop 中注册的精确路由自身不做任何来源校验，插件若需要来源限制必须自己实现。

### 2.2 必须改上游的部分

desktop 没有把窗口创建或协议注册开放给插件：`dsh-app://` 的 `protocol.handle` 只有一处，按宿主名硬分流 `shell` 与 `app`（`deepseek-harness/apps/desktop/src/main.ts:224-231`）；第二个窗口的唯一创建路径是插件管理窗口（`main.ts:315-326`）。宿主半拿不到 Electron API，主 renderer 拿到的是 `{ protocolVersion: 1 }` 标记（`main.ts:148`、`deepseek-harness/apps/desktop/src/preload-app.ts:5`），IPC 处理函数又统一要求发送方宿主名为 `shell`（`main.ts:104-111`、`main.ts:234`），而主窗口加载 `dsh-app://app/index.html`（`main.ts:362-363`），因此主 renderer 无法调用任何 Electron IPC。

同样的边界也切断了插件通过 Node IPC 与 Electron 主进程通信的路径：外壳对子进程消息只接受 `ready` 与 `fatal`，其余一律判定为非法并杀掉子进程（`host-process.ts:137-144`、`host-process.ts:32-43`）。

### 2.3 与既有迁移结论的关系

仓库内 `docs/dsh-gui/2026-09-13-desktop-api-and-migration.md` 判定 dsh-gui 的远程连接「不可迁移」，其依据是既有实现落在 `/remote-api` 任意前缀路由与 Tauri 壳的多 webview 上。本任务的判断对象是按连接点改写后的目标方案，两者的差别只有一处需要点明：那份结论中「不能监听端口」说的是 `/api/` 注册点的能力上限，不是插件进程的上限；回环监听由插件进程自己用 `node:net` 建立，desktop 组合并不阻止这一点。视图面的约束则与那份结论一致：插件不能创建窗口。

## 3. 承载远端 WebUI 的三种方式专项验证

对照实现是现有 dsh-gui 的子 webview（`src-tauri/src/views.rs:175-193`）。Electron 侧的选择只有三种：新开 `BrowserWindow`、`<webview>` 标签、同页 iframe。

### 3.1 新开 BrowserWindow

纯插件不可能，三条独立理由各自成立。

- 宿主半插件不在 Electron 进程内，无法 import Electron。全仓 `BrowserWindow` 的使用只出现在 `apps/desktop/src/main.ts`（`main.ts:8`、`main.ts:82-83`、`main.ts:142-143`）。
- 主 renderer 没有可用的窗口或 IPC 面：preload 只暴露协议标记（`preload-app.ts:5`），IPC 只接受 `shell` 宿主名（`main.ts:104-111`、`main.ts:234`）。
- renderer 发起的窗口创建被无条件拒绝：`setWindowOpenHandler` 恒返回 `{ action: 'deny' }`（`main.ts:97`）。Electron 文档写明由该 handler 取消时不会创建窗口，该事件在 renderer 发起窗口请求时触发（[webContents 文档](https://raw.githubusercontent.com/electron/electron/main/docs/api/web-contents.md)，文档声称）；子框架内的 `window.open` 是否同样进入该 handler 列入需实测。

主框架导航也被拦住：`will-navigate` 在协议不是 `dsh-app:` 时 `preventDefault`（`main.ts:98-100`），因此 renderer 不能把主窗口导航到 `http://127.0.0.1:<端口>/`。Electron 文档说明 `will-navigate` 只在主框架导航时触发，观察 iframe 导航要用 `will-frame-navigate`（[webContents 文档](https://raw.githubusercontent.com/electron/electron/main/docs/api/web-contents.md)，文档声称）。这条语义同时给出了两个推论：`main.ts:98` 不构成对同页 iframe 的约束；新开窗口作为独立 `webContents` 也不受主窗口这条监听约束。

### 3.2 `<webview>` 标签

纯插件不可能，需要改上游两处。

`webPreferences` 只声明了 `preload`、`nodeIntegration`、`contextIsolation`、`sandbox`、`webSecurity`（`main.ts:89-95`），未声明 `webviewTag`；全仓检索 `webviewTag` 无命中。Electron 文档写明 `webPreferences.webviewTag` 默认 `false`，开启后 `<webview>` 的 preload 会带 node integration，必须用 `will-attach-webview` 剥离 preload 并校验初始设置（[WebPreferences 文档](https://www.electronjs.org/docs/latest/api/structures/web-preferences)，文档声称）。因此需要改的是 `createWindow` 的 `webPreferences` 与新增 `will-attach-webview` 监听（`main.ts:82-102`）。

语义上 `<webview>` 与现有 Rust 子 webview 最接近：独立顶层文档与独立 cookie jar（对照 `src-tauri/src/views.rs:5-10`）。

### 3.3 同页 iframe

这是纯插件唯一可行的承载方式，静态阅读能排除两类阻断，剩下的都是运行时问题。

嵌入侧不设限制。全仓 CSP 只有两处：桌面插件管理页面（`deepseek-harness/apps/desktop/renderer/plugin-manager.html:6`）与媒体响应的 sandbox 头（`deepseek-harness/packages/api/session-controller/src/media-references.ts:19`）。主窗口加载的 Web UI 页面既没有 CSP meta（`deepseek-harness/apps/web/index.html:1-14`），宿主半渲染 index 时也只注入启动数据、不注入 CSP（`apps/desktop-host/src/index.ts:189-193`），静态资源响应只设 `content-type`（`apps/desktop-host/src/index.ts:213-215`）。所以嵌入侧页面没有 `frame-src` 约束，也没有 `frame-ancestors` 约束；Electron 在缺 CSP 时打印的安全警告属于信息性输出，其运行时后果列入需实测。

被嵌入侧同样不设限制。全仓检索 `X-Frame-Options` 与 `frame-ancestors` 无命中；`dsh web` 的 index 响应只写 `content-type`（`deepseek-harness/packages/host/frontend-static/src/index.ts:104`），webserver 的路由与 fallback 分发不追加安全响应头（`deepseek-harness/packages/host/webserver/src/index.ts:221-237`）。因此用户预判中的「`frame-ancestors` 直接禁止被嵌入」**不成立**（代码可证）。

真正的风险在认证。远端 `dsh web` 的 index 走浏览器认证：带 root 查询 token 的首访回 303 并下 `Set-Cookie`，无 token 且无有效 cookie 的请求回 401（`deepseek-harness/packages/client/connection/src/browser-auth.ts:240-282`、`browser-auth.ts:304-312`），每个 Host 请求都必须带 cookie（`browser-auth.ts:289-302`），而该 cookie 是 `HttpOnly; SameSite=Strict`、`Path=/`（`browser-auth.ts:122`）。在同页 iframe 中，顶层文档源是 `dsh-app://app`，被嵌入文档源是 `http://127.0.0.1:<本地转发端口>`，属于跨站语境，`SameSite=Strict` cookie 能否被接受并随后续同 iframe 请求发送取决于 Chromium 的第三方 cookie 策略与站点计算，静态阅读不能判定，列为需实测。这正是 `src-tauri/src/views.rs:5-10` 用子 webview 规避的那一类问题；该旁证来自 WebView2 环境，不能直接外推到 Electron。

两条次要的静态事实需要收窄到它们真正支持的强度。`corsEnabled: false`（`deepseek-harness/apps/desktop/src/main.ts:36`）使 `dsh-app://` 不开启 CORS，被嵌入的远端页面无法用 `fetch` 读取本机 `dsh-app://app/api/...` 的响应；CORS 只约束脚本能否读取跨源响应，不阻止简单请求与导航到达目标，而该路由自身不做来源校验（§2.1），因此远端页面能否以其他方式触达它列入需实测。`nodeIntegrationInSubFrames` 在 `main.ts:89-95` 未声明，Electron 文档把该选项列为实验性且未写出默认值，「默认关闭」是推断而非文档原文，远端页面是否拿到 preload 暴露的 `window.dshDesktop` 同样列入需实测（[WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)）。

还有一条设计层面的推论：把远端 WebUI 反代到本机同源不可行。远端 SPA 的资源与 API 请求都以自己的源为基址，客户端 RPC 也用 `location.origin`（`deepseek-harness/packages/client/connection/src/client/rpc.ts:108-111`）；若经本机 `dsh-app://app` 代理，资源路径会落到静态资源处理器，而 API 路径会与本机后端的 `/api` 冲突，且插件只能注册 `/api/` 之下的精确路径（`deepseek-harness/packages/client/connection/src/rpc-host.ts:292-303`）。因此 iframe 的 src 必须直接指向隧道端口。

### 3.4 三种承载方式与 renderer 配置

主窗口的 renderer 配置为 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`（`main.ts:89-95`；Electron 文档写明 `sandbox` 自 Electron 20 起默认 `true`，[WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)）。

| 承载方式 | 纯插件 | renderer 配置的含义 |
|---|---|---|
| 新开 `BrowserWindow` | 不可行 | 需要改 `main.ts:97`；新窗口是独立 `webContents`，必须显式钉死继承的 webPreferences 与 preload，`sandbox`/`nodeIntegration` 的隔离才不会随 `window.open` 的参数漂移 |
| `<webview>` | 不可行 | 需要改 `main.ts:89-95` 开启 `webviewTag`；Electron 文档要求配 `will-attach-webview` 剥离 preload，否则该 guest 的 preload 带 node integration |
| 同页 iframe | 可行，需实测 | 远端内容运行在同 renderer 的 sandbox 子框架中，无 Node、无 Electron API；`webSecurity: true` 维持同源策略，`corsEnabled: false` 关闭跨源 `fetch` 读取 `dsh-app://` 响应的能力，preload 是否加载与简单请求是否可达均列入需实测 |

## 4. 结论、最小改动清单与能力上限

### 4.1 改动上游时的最小清单

若必须保住「独立 webview」的语义，改动集中在 `apps/desktop/src/main.ts` 的 `createWindow`（`main.ts:82-102`）：

- 方案 A（独立窗口，改动最小）：把 `main.ts:97` 的 `setWindowOpenHandler` 从恒 deny 改为仅对回环 http 目标放行，并在返回的 `overrideBrowserWindowOptions` 中钉死 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true` 且不带 preload。插件客户端半随后可用 `window.open('http://127.0.0.1:<隧道端口>/')` 打开独立窗口。需要一并核对窗口生命周期与 `window-all-closed` 的退出判定（`main.ts:373-375`），以及新窗口自身的导航策略（`main.ts:98-100` 不覆盖它）。
- 方案 B（`<webview>` 标签，源语义最接近现状）：在 `main.ts:89-95` 的 `webPreferences` 增加 `webviewTag: true`，并新增 `will-attach-webview` 监听剥离 preload、限定 src 为回环目标。插件客户端半用 `<webview>` 渲染远端 UI。
- 两个方案都不需要改 `apps/desktop-host/src/index.ts` 的三层路径分流（`apps/desktop-host/src/index.ts:339-343`），控制通道继续走 `/api/` 精确路由与 `/.dsh/remote-stream`。

不做上游改动时，插件侧的改写是必须的，与承载方式无关：宿主半把注册点从 `ctx.webServer.register({ kind: 'prefix' })` 换成 `ctx.connection.fetch.register`，并移除对 `webServer` 的顶层注入（对照 `plugins/remote/dsh-remote/src/index.ts:74` 与 `plugins/remote/dsh-remote/src/index.ts:1181`）；浏览器半从 inert 改为用 `ctx.slots.register` 渲染连接界面与承载视图（对照 `plugins/remote/dsh-remote/src/client/index.ts:23-25`）；凭据可保留自实现文件加解密，也可改用 `ctx.credentials`。

### 4.2 不改上游源码的能力上限

纯插件可以做到：SSH 认证（密码、密钥、口令、`~/.ssh/config`、known_hosts accept-new）、远端启动命令与 tmux 保活、回环本地端口转发、远端 launch token 提取与就绪探测、实时状态回传、凭据存取、在主窗口内渲染连接界面、用同页 iframe 加载远端 WebUI，以及控制面走 `/api/` 精确路由或 Typert Remote。

纯插件做不到：创建 `BrowserWindow`、使用 `<webview>`、为远端 UI 取得独立 cookie jar、新增 `dsh-app://` 宿主名、注册 `/api/` 之外的路径前缀、把远端 SPA 反代到本机同源、以及注入或读取 Electron session 的 cookie。

### 4.3 与官方设计的冲突与维护成本

- 与「不开监听端口」冲突（部分）。官方把「应用不开监听 Web 端口」写成已决决策（`deepseek-harness/apps/desktop/README.md:16`），而端口转发必须在本机回环上监听一个随机端口，仅存在于隧道存活期。同一取舍在 dsh-gui 文档中已明确记录（`plugins/remote/dsh-remote/docs/README.md:56`）。
- 与「只有两个受控窗口、`dsh-app://` 单源」冲突（取决于承载方式）。新窗口或 `<webview>` 增加窗口与源（`main.ts:315-326`、`main.ts:343-349`）；iframe 保持窗口数量不变，但把远端源引入主页面，且被嵌入内容与主页面共享同一个 renderer 进程与网络栈。
- 安装面约束。desktop 插件必须是能从 Desktop registry 离线解析的普通 npm 依赖（`README.md:13`），带依赖 lifecycle script 的包受 `allowBuilds` 策略约束（`README.md:179`）；`ssh2` 的可选原生依赖是否能在桌面 profile 中安装需实测。
- 维护成本。`main.ts` 的窗口与导航策略属 `apps/desktop` 内部实现，未声明为跨包契约，改动需要随 upstream tag 重新合并；插件侧使用的 `connection.fetch.register`、`slots.register`、`credentials` 是包级公开面，升级面较小。不改上游则无法获得独立窗口或独立 cookie jar。

## 5. 需实测项

1. 跨站 iframe 中的认证：在主窗口页面内嵌 `http://127.0.0.1:<端口>/?token=...`，观察 303 响应的 `Set-Cookie` 是否落盘、后续同 iframe 的 `/api` 请求是否带 cookie。判定依据见 `deepseek-harness/packages/client/connection/src/browser-auth.ts:122`、`browser-auth.ts:240-282`、`browser-auth.ts:289-302`。
2. iframe 内的重定向与导航是否被拦截：确认 303 跳转在子框架内完成，且 `will-navigate`（`main.ts:98`）确实不介入子框架。
3. `window.open` 恒 deny 在内嵌远端 UI 上的用户可见后果：远端 UI 中的外部链接、`target=_blank` 与下载是否静默失效（`main.ts:97`）。
4. 混合内容与 CORS 的实际判定：`dsh-app://` 作为 `secure` 特权源（`main.ts:30-40`）内嵌 `http://127.0.0.1` 子框架是否被拦截，`webSecurity: true` 与未开启的 `allowRunningInsecureContent`（`main.ts:94`）的实际作用，以及 `corsEnabled: false`（`main.ts:36`）下被嵌入页面能否用简单请求或导航触达 `dsh-app://app/api/...`。
5. 远端 WebUI 在 iframe 中的完整可用性：Service Worker/manifest、剪贴板与通知权限、文件上传下载、`window.top` 假设、会话续传与流式输出。
6. `ctx.connection.fetch.register` 在 desktop 中的端到端可用性：注册一个精确路由后，确认 `dsh-app://app/api/<segment>` 能到达插件，并确认 desktop 未做来源校验这一事实（`apps/desktop-host/src/index.ts:305`、`apps/desktop-host/src/index.ts:341-342`）。
7. Typert Remote 在 desktop 中的可用 endpoint 集合：`/.dsh/remote-stream` 能转发哪些 endpoint 由类型图生成结果决定（`apps/desktop-host/src/index.ts:228-246`），需按实际生成的 endpoint 确认。
8. 方案 A 与方案 B 的实际行为：放宽 `setWindowOpenHandler` 或开启 `webviewTag` 后，新窗口/guest 继承的 webPreferences、preload 是否注入远端内容、窗口关闭与退出流程（`main.ts:373-375`）。
9. 桌面 profile 内的插件安装：`ssh2`（含可选原生依赖）能否在离线 store 与 `allowBuilds` 策略下安装成功（`README.md:13`、`README.md:179`）。
10. Electron 启动日志的 insecure-CSP 警告不改变 iframe 行为的确认：页面无 CSP 是代码可证的事实（`apps/web/index.html:1-14`、`apps/desktop-host/src/index.ts:189-193`），但警告与其运行时后果需实测。
