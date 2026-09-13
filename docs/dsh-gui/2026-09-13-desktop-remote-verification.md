# 远程连接可行性结论独立验证（T12）

本文独立复核 `docs/dsh-gui/2026-09-13-desktop-remote-connection-feasibility.md`（下称 T10）的关键结论。复核不采信作者给出的行号：视图面、跨源承载、控制面与最小改动清单都重新取证据；否定性结论（插件半无法开窗）用独立 grep 全树枚举；全量扫描结论（无 `X-Frame-Options` 等）自己跑检索。

## 验证范围与方法

被验证对象是 T10（159 行）。证据面是 pinned 子模块 `deepseek-harness/`（只读）、本仓库 `src-tauri/` 与 `plugins/remote/dsh-remote/`，以及 Electron 44 的本地类型定义 `apps/desktop/node_modules/electron/electron.d.ts`（装在副本内，不入上游）。

复核动作分四类：一是逐条打开被引用的文件与行号；二是用 ripgrep 独立枚举窗口、webview、协议与安全响应头的出现点（ripgrep 默认跳过被 `.gitignore` 排除的 `node_modules`，正合任务要求）；三是把 T10 标注为「文档声称」的 Electron 语义拿到 Electron 44 自带 typings 与官方结构文档核对；四是独立判断最小改动清单与「不需改 desktop-host 三层分流」这类设计结论。

本次未运行 Electron，未搭建 SSH/隧道，因此运行时行为仍无法判定。

## 一、已复核通过

| 编号 | 主张 | 复核方法 | 证据 | 判定 |
|---|---|---|---|---|
| V1 | 视图面三条代码事实：`createWindow` 的 `webPreferences` 未声明 `webviewTag`；`setWindowOpenHandler` 恒返回 `deny`；`will-navigate` 只放行 `dsh-app:` | 逐行打开 `main.ts:82-102` | `main.ts:89-95` 只含 `preload`、`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`；`main.ts:97` 为 `setWindowOpenHandler(() => ({ action: 'deny' }))`；`main.ts:98-100` 在 `new URL(url).protocol !== \`${SCHEME}:\`` 时 `event.preventDefault()` | 通过 |
| V2 | 独立 grep 确认没有任何额外窗口、webview 或 `BrowserView` 的创建路径 | 在 `deepseek-harness/apps` 全树检索 `BrowserWindow|BrowserView|WebContentsView|webviewTag|setWindowOpenHandler|openExternal|will-attach-webview|add_child` | 命中全部落在 `apps/desktop/src/main.ts`：`BrowserWindow` 在 8、82、83、142、143、153、343、371 行，`setWindowOpenHandler` 在 97 行，其余关键词零命中；`apps/desktop-host` 零命中 | 通过 |
| V3 | 「插件半无法自行开窗/导航」成立 | 综合 V1、V2 与宿主侧进程与 IPC 边界 | 宿主半是普通 Node 进程，入口由 `host-process.ts:101-113` 以自带 Node 启动，无法 import Electron；主 renderer 只有协议标记；renderer 发起的窗口创建被 97 行拒绝；主框架导航被 98-100 行拦住；宿主半也无法借 Node IPC 请求开窗，因为 `host-process.ts:137-144` 对非法消息直接 `fail` 并 `child.kill('SIGTERM')`，合法事件只有 `ready` 与 `fatal`（`host-process.ts:32-43`） | 通过 |
| V4 | `webviewTag` 未声明且全仓无命中 | 在 `deepseek-harness` 全树检索 `webviewTag|will-attach-webview` | 零命中（`node_modules` 被 gitignore，ripgrep 自动跳过，符合任务要求的排除范围） | 通过 |
| V5 | Electron 文档三条语义：`will-navigate` 只对主框架触发、观察子框架要用 `will-frame-navigate`、`webviewTag` 默认 `false` 且必须用 `will-attach-webview` 剥离 preload | 读 Electron 44 自带 typings 与官方结构文档 | `electron.d.ts:17647` 起写 "Emitted when a user or the page wants to start navigation on the main frame"；`17624-17630` 写 `will-frame-navigate` 覆盖 "the main frame or any of its subframes"；`17612-17622` 存在 `will-attach-webview` 事件；官方 WebPreferences 页写 `webviewTag` "Defaults to `false`" 并用整段说明 `will-attach-webview` 的剥离要求；`sandbox` "Default is `true` since Electron 20" | 通过（且比 T10 引用的 `main` 分支文档更贴近当前 Electron 44） |
| V6 | `setWindowOpenHandler` 返回 `deny` 时不创建窗口，`overrideBrowserWindowOptions` 是合法字段 | 读 Electron 44 typings 的 `WindowOpenHandlerResponse` | `electron.d.ts:20517-20541`：`action` 为 `'allow' \| 'deny'` 且 "Controls whether new window should be created."，并存在 `overrideBrowserWindowOptions?: BrowserWindowConstructorOptions` 与 `outlivesOpener?` | 通过（T10 方案 A 用到的字段名正确） |
| V7 | 主 renderer 没有可用的窗口或 IPC 面 | 读 preload 与 IPC 校验 | `apps/desktop/src/preload-app.ts:5` 只暴露 `{ protocolVersion: 1 }`；`main.ts:104-111` 要求发送方协议为 `dsh-app:` 且 hostname 在白名单内，`main.ts:234` 的插件变更入口传 `['shell']`；主窗口加载 `dsh-app://app/index.html`（`main.ts:362-363`），不匹配 `shell` | 通过 |
| V8 | 全仓无 `X-Frame-Options` 与 `frame-ancestors` | 在 `deepseek-harness` 全树检索 `X-Frame-Options|x-frame-options|frame-ancestors|frame-src` | 零命中 | 通过 |
| V9 | 全仓 CSP 只有两处 | 检索 `Content-Security-Policy|http-equiv|contentSecurityPolicy` | 实际 CSP 声明只有 `apps/desktop/renderer/plugin-manager.html:6` 的 meta 与 `packages/api/session-controller/src/media-references.ts:19` 的 `'Content-Security-Policy': "sandbox; default-src 'none'"`；其余命中是 SignTool 的 `/csp` 参数与文档里的 `http-equiv: refresh` | 通过 |
| V10 | 主窗口加载的 Web UI 页面无 CSP meta，宿主半渲染 index 时只注入启动数据 | 读 `apps/web/index.html` 与 `desktop-host/src/index.ts:189-193` | `apps/web/index.html` 共 14 行，head 只有 charset、viewport、manifest、icon 与 title；`index.ts:190-193` 的 `rows` 只含一条 `{ kind: 'script', placement: 'head', text: DESKTOP_TRANSPORT_SCRIPT }`，随后 `renderIndexInjections` 渲染，全程不写 CSP | 通过 |
| V11 | 被嵌入侧 index 响应只写 `content-type`，webserver 的路由与 fallback 不追加安全响应头 | 读两处实现 | `frontend-static/src/index.ts:104` 为 `res.writeHead(200, { 'content-type': type })`；`webserver/src/index.ts:221-237` 的处理器只有「命中路由 → handler」「否则 fallback」「无 fallback → 404」三条分支，不写额外响应头 | 通过 |
| V12 | cookie 属性与认证流程的位置和值 | 读 `browser-auth.ts` | 第 122 行串为 `${name}=${value}; Max-Age=...; Path=/; Expires=...; HttpOnly; SameSite=Strict`；`240-266` 行校验 root 查询 token 后 `writeHead(303, { 'set-cookie': sessionCookie(...) })`；`267-275` 行有效 cookie 时 303 到干净 `/`；`276-281` 与 `304-312` 行写 401（`content-type: text/plain; charset=utf-8`）；`289-302` 行 `isAuthenticated` 按请求的 Host 计算 cookie 名并校验签名与有效期 | 通过（cookie 值绑定 authority，跨源 iframe 下的行为仍属运行时，见第三节） |
| V13 | 宿主半可在插件进程内自行监听回环端口 | 读现有插件实现与宿主进程启动参数 | `plugins/remote/dsh-remote/src/index.ts:802` 为 `const server = createServer((socket) => {`，`812` 行用 `client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, ...)` 送出流量；宿主进程只以 `entry`、`projectDir` 与可选 `--allow-linked-profile` 启动（`host-process.ts:102-107`），没有 Node 权限模型或组合层限制阻止 `node:net` 监听 | 通过 |
| V14 | `connection.fetch.register` 不依赖 `webServer`，路径受 `/api` 约束，desktop 已把 `/api/` 前缀接到它 | 读注册表、路径常量与 desktop 挂载点 | `rpc-host.ts:139-156` 只把路由写进本地 `fetchRoutes` 映射；`rpc-host.ts:292-303` 的 `assertFetchRoute` 要求路径通过 `endpointFromPath(API_PATH, ...)`，而 `api-path.ts:6` 定义 `API_PATH = '/api'`；`desktop-host/src/index.ts:305` 取 `connection.createSharedFetchHandler('/api')`，`341-342` 把 `url.pathname.startsWith('/api/')` 交给它 | 通过 |
| V15 | 客户端到达精确路由的两种方式与基址 | 读 client 侧 rpc 实现 | `client/rpc.ts:34` 的方法名为 `call(channel, endpoint, payload, signal)`；`43-51` 用 `new URL(\`${channel}/${endpoint}\`, resolveBase())` POST；`108-111` 的 `resolveBase()` 取 `location.origin`；`61-69` 的 `open` 要求 `channel === '/api'` 且载体提供 `openStream` | 通过 |
| V16 | 共享通道 `/api` 只允许一个拦截器且已被 Typert Gateway 占用，Gateway 只认领自己的类型化 endpoint | 读两处实现 | `rpc-host.ts:190-192` 对非 `API_PATH` 通道抛错，`197-205` 在同一通道已有拦截器时抛错；`gateway/src/index.ts:198-204` 以 `ctx.inject(['connection'], ...)` 调用 `connection.rpc.intercept('/api', ...)`；`gateway/src/index.ts:266-273` 的 `claimsEndpoint` 只认领已注册或已见过的 endpoint | 通过 |
| V17 | desktop 的 `/api` 分派不调用 `requestRejection`，因此精确路由自身不做来源校验 | 读 desktop 分派与来源校验定义 | `desktop-host/src/index.ts:341-342` 直接 `await api.fetch(request)`，全流程不调用 `requestRejection`；`rpc-host.ts:97-100` 的 `requestRejection` 才是 Host/Origin 围栏与 cookie 认证的施加点（未使用） | 通过 |
| V18 | desktop 仍服务 client bundle，且该能力不依赖 `webServer` | 读 Host 与 client modules | `desktop-host/src/index.ts:200` 对 `/plugins/` 前缀调 `ctx.clientModules.fetchBundle(request)`；`packages/client/modules/src/index.ts:576` 在 `ctx.get('webServer') === undefined` 时才 `ctx.inject(['webServer'], ...)` 注册 HTTP 路由，`578-580` 无条件向 `webserver/index-inject` 推送启动注入；`607-614` 的 `fetchBundle` 文档明写 "without a Web server" | 通过 |
| V19 | `credentials` 行在 desktop 组合中保留 | 读 base patch 与 desktop patch | `packages/bundle/base/cordis.patch.yml:96-98` 保留 `credentials` 行并指向 `@deepseek-ai/dsh-credentials-local`；`desktop.cordis.patch.yml:24-27` 把 `connection` 的 `inject` 改为 `credentials` | 通过 |
| V20 | §1 现状表与 §2 依据的行号抽检 | 逐行打开 17 处插件行号与 Tauri 行号 | `plugins/remote/dsh-remote/src/index.ts` 的 48（`import * as ssh2ns from 'ssh2'`）、74、457（`export class SshSession`）、802、812、969、1036、1138、1160、1181、1237、1266、1277、1333（本机后端 `spawn(env.node, [env.bin, 'web', ...])`）、1555（`waitFrontendReady`）、1629、1684 全部命中；`src-tauri/src/views.rs:1-14` 与 `175-193` 命中；`src-tauri/src/main.rs:661-667`、`675-694`、`1387`、`1391`、`1379-1395` 命中；`plugins/remote/dsh-remote/docs/README.md:56`（回环监听端点的取舍）与 `110`（走 Rust 命令而非页面 fetch 的原因）命中；`plugins/remote/dsh-remote/src/client/index.ts:23-25` 的 `apply` 确为 `void ctx` | 通过（两处范围问题见 E2、E3） |
| V21 | T10 对既有文档的更正正确 | 对照 `2026-09-13-desktop-api-and-migration.md` 的相关行与 desktop 组合 | 该文档把「监听端口」列为 desktop 缺失能力并以「desktop 明确不开监听端口」为据（其 §2.2 表与 §4）。实际被禁用/缺失的是 `webserver` 行（`desktop.cordis.patch.yml:6-7`）与宿主侧路由注册面，而插件所在的 host 进程是普通 Node 进程（V13），组合层没有任何限制阻止其自行监听回环。因此把「不能监听端口」当成插件能力上限确实不准确 | 通过（更正成立） |
| V22 | 最小改动清单的文件与函数位置准确，且两个方案都不需要改 desktop-host 三层分流 | 逐条打开并独立判断 | 方案 A 引用的 `main.ts:97`（`setWindowOpenHandler`）与 `main.ts:82-102`（`createWindow`）命中，`window-all-closed` 在 `main.ts:373-375` 命中；方案 B 引用的 `main.ts:89-95` 命中，`will-attach-webview` 全仓零命中（V4）；`desktop-host/src/index.ts:339-343` 的三层分流只处理协议处理器转发的请求，而方案 A 的新窗口与方案 B 的 `<webview>` 都以 `http://127.0.0.1:<port>` 为 src 由 Chromium 直接加载，不经过 `dsh-app://` 处理器，控制通道继续走既有 `/api/` 与 `/.dsh/remote-stream`，所以两个方案都不需要改 Host 分流 | 通过（独立判断一致） |
| V23 | 宿主半的 Node 能力与环境变量过滤 | 读启动参数 | `host-process.ts:109-111` 只剔除 `NODE_OPTIONS`、`DSH_DESKTOP_*` 与 `npm`/`pnpm`/`corepack` 前缀，未剔除 `HOME`/`USERPROFILE` 等，因此 `~/.ssh` 可达；「能力声明不是安全沙箱」与工作区 `AGENTS.md` 的「安全边界」一节一致 | 通过 |
| V24 | 需实测项的标注 | 通读 §5 与全文标注 | §5 列出 10 条需实测项，覆盖跨站 iframe 认证、303 是否在子框架内完成、`window.open` 恒 deny 的用户可见后果、混合内容、iframe 内完整可用性、精确路由端到端、Typert endpoint 集合、方案 A/B 实际行为、`ssh2` 离线安装与 CSP 警告后果；正文对 `window.open` 在子框架内的行为（第 87 行）与 WebView2 旁证的外推限制（第 42、107 行）也明确标注为需实测 | 通过 |

## 二、有误或需修正

### E1（低危，证据等级标注）第 109 行把 `corsEnabled: false` 的后果写成静态事实

主张：`2026-09-13-desktop-remote-connection-feasibility.md:109` 称「`corsEnabled: false`（`main.ts:36`）使 `dsh-app://` 不是 CORS 源，被嵌入的远端页面无法反向请求本机 `dsh-app://app/api/...`」，该句与第 121 行表格同列为有利的静态事实。

复核方法：读 `main.ts` 的权限声明，核对 Electron 的 `CustomScheme` 文档对 `corsEnabled` 的定义，并与 T10 自己在第 65 行的结论对照。

证据：`main.ts:36` 确为 `corsEnabled: false`；Electron 官方 `CustomScheme` 结构页把 `corsEnabled` 定义为「Default false」，即该行等于不开启 CORS。但 CORS 只约束脚本发起的 `fetch`/`XHR` 能否读取跨源响应，并不阻止简单请求（图片、表单提交、导航）到达目标，也不阻止其产生副作用。T10 第 65 行同时指出 desktop 的 `/api` 分发不做任何来源校验（V17），因此「无法反向请求」比代码支持的强度更高。

判定：需修正（标注等级与措辞）。结论方向（跨源 `fetch` 读不到 `dsh-app://` 响应）成立，但「无法反向请求」应降级为需实测或收窄。

修改建议：改为「`corsEnabled: false` 使 `dsh-app://` 不是 CORS 源，被嵌入的远端页面无法用 `fetch` 读取 `dsh-app://app/api/...` 的响应；简单请求与导航是否仍能到达该处理器属运行时行为，列入需实测」，或直接移入 §5。

### E2（低危，引用范围）第 30 行的 `package.json:36-37` 不覆盖 `ssh-config`

主张：`2026-09-13-desktop-remote-connection-feasibility.md:30` 用 `plugins/remote/dsh-remote/package.json:36-37` 支撑「纯 JS `ssh2` 与 `ssh-config`」。

复核方法：打开该 manifest 的依赖段。

证据：第 34 行为 `"dependencies": {`，第 35 行为 `"ssh-config": "^5.2.1",`，第 36 行为 `"ssh2": "^1.16.0"`，第 37 行为 `},`。所引范围只覆盖 `ssh2` 与右括号，`ssh-config` 在第 35 行。

判定：需修正（引用范围偏一行）。

修改建议：改为 `package.json:34-37` 或 `package.json:35-36`。

### E3（低危，引用位置）第 25 与 37 行用 `views.rs:1-14` 支撑「连接界面由 Rust 壳页面承载」

主张：`2026-09-13-desktop-remote-connection-feasibility.md:25` 称「连接界面整体由 Rust 壳页面承载（`src-tauri/src/views.rs:1-14`）」，第 37 行表格同引该范围。

复核方法：读 `views.rs:1-14` 并确认连接标签与新建连接对话框的实际驱动位置。

证据：`views.rs:1-14` 描述的是每个连接标签页由独立子 webview 承载，以及子 webview 的 cookie jar 与弹窗语义；标签栏与新建连接对话框的驱动在 `src-tauri/ui/app.js`（`app.js:455` 调 `remote_call`，`app.js:318` 调 `view_create`）。T10 全文未引用 `src-tauri/ui/`。

判定：需修正（引用位置不精确，方向不误）。

修改建议：承载说明保留 `views.rs:1-14`，界面驱动的引用补 `src-tauri/ui/app.js`（如 `app.js:314-322` 与 `452-456`）。

### E4（低危，沿用文档措辞）第 40 行的 `tauri://` 来自插件文档而非本仓库证据

主张：`2026-09-13-desktop-remote-connection-feasibility.md:40` 称 Rust 壳走裸 TCP 的原因写在插件文档里，即「壳页面源是 `tauri://`」。

复核方法：在 `src-tauri/` 内检索该 scheme 字面量，并读 Tauri 侧的跨源说明。

证据：`plugins/remote/dsh-remote/docs/README.md:110` 确实写「壳页面源是 `tauri://`」，T10 的引用本身准确；但 `src-tauri/` 内检索 `tauri://` 零命中，`src-tauri/src/main.rs:1172-1176` 只说 "the shell page lives on the app origin"。跨源结论（壳页面与 `http://127.0.0.1:<port>` 跨源）不依赖具体 scheme。

判定：需修正（措辞来源）。作为对插件文档的转述正确，作为事实陈述缺乏本仓库证据。

修改建议：改为「壳页面位于应用源（app origin），与 `http://127.0.0.1:<port>` 跨源；插件文档把该源记作 `tauri://`」。

### E5（低危，推断标注）第 109 行的 `nodeIntegrationInSubFrames` 默认值

主张：`2026-09-13-desktop-remote-connection-feasibility.md:109` 称「`nodeIntegrationInSubFrames` 默认关闭且未声明」。

复核方法：读 Electron 官方 WebPreferences 结构页对应条目。

证据：该页把 `nodeIntegrationInSubFrames` 描述为 "Experimental option for enabling Node.js support in sub-frames such as iframes and child windows. All your preloads will load for every iframe"，未写默认值；默认关闭是合理推断，同页也没有「Default is false」字样。

判定：需修正（标注）。结论正确，但「默认关闭」是推断而非文档原文。

修改建议：改为「`nodeIntegrationInSubFrames` 未声明；该选项按实验性开关对待（Electron 文档未列默认值），需实测确认子框架不加载 preload」，或改引 Electron 源码默认值的出处。

## 三、无法验证

1. 跨站 iframe 中的认证链路：`SameSite=Strict` 的 HttpOnly cookie 在顶层为 `dsh-app://`、子框架为 `http://127.0.0.1:<port>` 的语境下能否写入并随后续同 iframe 请求发送，取决于 Chromium 的第三方 cookie 策略与站点计算。T10 已列为需实测第 1 项，本次同样只能静态核对属性（V12）。
2. iframe 内的 303 重定向是否在子框架内完成，以及 `will-navigate` 是否确实不介入子框架：Electron 44 typings 明确了事件语义（V5），但实际重定向与拦截结果需运行确认。
3. 混合内容：`secure` 的 `dsh-app://` 顶层页面内嵌 `http://127.0.0.1` 子框架是否被拦截，以及 `webSecurity: true` 与未开启的 `allowRunningInsecureContent` 的实际作用。官方文档只定义 `allowRunningInsecureContent` 针对 https 页面，自定义安全源的情形需实测。
4. 方案 A 与方案 B 的实际行为：放宽 `setWindowOpenHandler` 或开启 `webviewTag` 后，新窗口或 guest 继承的 webPreferences、preload 是否注入远端内容、窗口关闭与退出流程。本次未运行 Electron。
5. 远端 WebUI 在 iframe 中的完整可用性（Service Worker、权限、上传下载、`window.top` 假设、流式输出）与真实远端环境下的端到端验证。
6. 桌面 profile 内 `ssh2` 及其可选原生依赖在离线 store 与 `allowBuilds` 策略下的安装结果。
7. `corsEnabled: false` 与混合内容在 Electron 44 具体版本上的实际判定：本次依据的是 Electron 44 自带 typings 与官方结构文档，不是运行结果（见 E1）。

## 四、总体判定

T10 的核心结论经独立复核成立。视图面的否定性结论（纯插件无法创建窗口、无法使用 `<webview>`、无法把主窗口导航到远端）由全树 grep 与逐行代码共同支撑，且宿主半与主 renderer 两条可能的绕行路径都被 IPC 校验与 preload 暴露面切断。全量扫描结论（无 `X-Frame-Options`、无 `frame-ancestors`、CSP 仅两处）我用独立检索复现，结论一致。控制面结论（`connection.fetch.register` 不依赖 `webServer`、受 `/api` 约束、desktop 已挂载该前缀；Typert 流走 `/.dsh/remote-stream`）逐条命中，并附带确认了 T10 自己指出的安全事实：desktop 的 `/api` 分发不做来源校验。T10 对既有迁移文档「不能监听端口」的更正正确。最小改动清单的文件与函数位置准确，两方案都不需要改 Host 三层分流的判断我也独立得出相同结论。T10 把运行时行为统一放进 §5 需实测项，没有把运行时结果写成结论。

需要修正的是 5 处低危问题：第 109 行 `corsEnabled: false` 的后果标注过强（E1）、一处依赖行号范围偏一行（E2）、连接界面承载的引用未含 `src-tauri/ui/app.js`（E3）、`tauri://` 措辞来源（E4）与 `nodeIntegrationInSubFrames` 默认值的推断标注（E5）。未发现实质性错误。

是否建议放行：建议在修正 E1（影响结论强度标注）与 E3（引用完整性）后放行；E2、E4、E5 一并改述更好。核心判断与改动清单不需要改动。
