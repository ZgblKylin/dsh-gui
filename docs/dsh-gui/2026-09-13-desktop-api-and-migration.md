# DSH Desktop 专属 API 清单与 dsh-gui 功能迁移映射

本文回答两个问题：上游 `deepseek-harness` 的 Electron 桌面应用（下称 desktop）究竟暴露了哪些只属于它的 API；dsh-gui 的「远程连接」与「插件升级」能否迁移到 desktop，代价如何。

上游源码引用一律相对 `deepseek-harness/`（pinned 子模块 `dsh-v0.1.5-rc.2`，只读）。本仓库源码引用相对仓库根。

## 结论摘要

- desktop 的专属 API 只有四组：主窗口 preload 注入的 `window.dshDesktop` 协议标记、插件窗口 preload 注入的结构化插件/更新操作、`dsh-app://` 自定义协议、以及 Electron 壳与 `@deepseek-ai/dsh-desktop-host` 子进程之间的分帧字节管道（含只承载生命周期控制的 Node IPC）。四组都由 `apps/desktop` 内部模块定义，没有任何一项被 README、`docs/architecture.md` 或包 manifest 声明为跨包契约。
- 没有任何 desktop 专属 API 允许第三方 renderer 侧代码注册路由、创建窗口、访问文件系统或执行包操作。`dsh-app://app` 主 renderer 拿到的只有 `{ protocolVersion: 1 }`。
- 「远程连接」**不可迁移**：dsh-gui 的远程能力全部落在 `/remote-api/*` HTTP 路由上，而 desktop 在组合层 `disabled: true` 掉了 `webserver` 行，宿主半只保留一个受 `/api/` 前缀约束的精确 Fetch 路由注册点（`ctx.connection.fetch.register`），它不能注册任意前缀，也不能 spawn 额外后端。「不能监听端口」只是该注册点的上限，不是插件进程的上限：插件所在的 host 进程是普通 Node 进程，仍可自行用 `node:net` 监听回环。
- 「插件升级」**部分可迁移**：desktop 内建的插件事务（staging + 健康检查 + 回滚）能力上强于 dsh-gui 现有流程，可直接复用；但本仓库 7 个插件的宿主半以注入声明依赖 `webServer`（`remote`、`deep-whale`、`better-sidebar`、`dsh-pet`、`dsh-web-ui`、`plugin-market`、`ai-update`），在 desktop 组合中被阻塞，因此在 desktop 中不可用。要让它们工作，必须改上游源码。

## 一、desktop 专属 API 清单

### 1.1 稳定性判据

下表每一行给出「稳定性判定」时，使用以下三条判据，三条同时成立才记为文档化契约：

1. **文本声明**：`apps/desktop/README.md`、`docs/architecture.md`、`.agents/notes/**` 或包的 `package.json` 把该名称、该通道类型或该行为写成对外的承诺，而不只是描述内部实现。
2. **跨包 import**：存在 `apps/desktop` 之外的包或应用 `import` 该模块、该类型或该常量。仅在同目录内部 import 的，视为私有实现。
3. **版本约束**：manifest 中声明了版本号、语义化版本范围，或协议版本常量（如 `DESKTOP_HOST_PROTOCOL_VERSION`）。判据 3 单独成立只表示「有版本标记」，不表示「对第三方开放」。

按这三条判据，desktop 侧的判定结果如下。

- `DESKTOP_IPC`、`DshDesktopApi`、`DesktopUpdateState`：`apps/desktop/README.md:26` 与 `apps/desktop/README.md:28` 用自然语言描述了 renderer 的可见面，但没有把这些标识符本身写成契约；`ipc.ts:1` 的自述是 "Typed preload operations exposed only by the Electron shell"，`ipc.ts:6` 的注释是 "IPC channel names kept private to the desktop application bundle"。无跨包 import。判定：**私有实现**（有 README 行为描述，无标识符契约）。
- `dsh-app` 协议：`apps/desktop/README.md:5` 与 `README.md:16` 把它写进关键技术决策表，`docs/architecture.md:53` 复述同一条，`main.ts:23` 定义 scheme、`main.ts:30` 注册权限。判定：**文档化行为契约**（协议名与能力有文档，privileges 细节仍是代码事实）。
- `DESKTOP_HOST_PROTOCOL_VERSION` 与管道帧格式：`host-protocol.ts:4` 定义版本常量，`release.ts:11` 把它写进 `DesktopRelease` 并参与 `parseDesktopRelease` 校验（`release.ts:23`）；`desktop-host/src/wire.ts:4` 是同一个常量的第二份定义。无跨包 import，靠协议版本常量对齐。判定：**私有实现 + 版本化线协议**。
- preload 暴露面本身：`apps/desktop/README.md:26` 明确写成安装所有权的一节。判定：**文档化权限边界**。

`apps/desktop/README.md:24` 与 `apps/desktop/README.md:161` 另外把 `@deepseek-ai/dsh-desktop-host` 写成 private app package，`desktop-host/package.json:5` 是 `"private": true`。因此 `dsh-desktop-host` 的导出（`runDesktopHost`、`loadProfileDirectory` 的调用方式、`desktop.cordis.patch.yml`）整体属于私有一侧，第三方不应依赖。

### 1.2 preload 向 renderer 暴露的对象与 IPC channel

两个窗口用两个 preload 文件，`main.ts:148` 与 `main.ts:149` 分别解析 `preload-app.cjs` 与 `preload.cjs`，`createWindow` 在 `main.ts:82` 统一设置 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`（`main.ts:91`–`main.ts:94`），`main.ts:97` 拒绝一切 `setWindowOpenHandler` 新窗口，`main.ts:98` 拒绝对非 `dsh-app:` 协议的导航。窗口与 preload 的对应关系写在 `main.ts:320`（插件窗口用 `managementPreload`）与 `main.ts:344`（主窗口用 `appPreload`）。

| 名称/类型 | 位置（相对路径:行号） | 方向/权限边界 | 稳定性判定及判据 |
|---|---|---|---|
| `window.dshDesktop = { protocolVersion: 1 }`（主窗口） | `apps/desktop/src/preload-app.ts:5` | 主 renderer 只得到协议标记；无方法、无 Electron IPC、无文件系统 | 私有实现；`README.md:26` 声明「只拿到协议标记」这一边界，但该对象本身无契约文本、无跨包 import |
| `contextBridge.exposeInMainWorld('dshDesktop', api)`（插件窗口） | `apps/desktop/src/preload.ts:26` | 插件 renderer 得到下表的全部方法 | 私有实现；`ipc.ts:1` 自述 only by the Electron shell |
| `DshDesktopApi.protocolVersion: 1` | `apps/desktop/src/ipc.ts:27` | 类型级版本标记；renderer 可读不可改 | 私有实现；无文档契约，无跨包 import |
| `DshDesktopApi.locale(): Promise<DesktopLocale>` | `apps/desktop/src/ipc.ts:28`；实现 `preload.ts:8` | 插件窗口只读；返回 Electron 应用 locale 派生的文案表 | 私有实现；`README.md:28` 描述「同一 locale payload」，未命名该成员 |
| `DshDesktopApi.plugins.list(): Promise<readonly DesktopPluginRecord[]>` | `apps/desktop/src/ipc.ts:30`；实现 `preload.ts:10` | 插件窗口只读；记录仅含 name 与 version | 私有实现；返回值类型 `DesktopPluginRecord` 定义在 `project-manager.ts:48` |
| `DshDesktopApi.plugins.add(spec: string): Promise<void>` | `apps/desktop/src/ipc.ts:31`；实现 `preload.ts:11` | 插件窗口写；spec 必须是 npm registry 名称（可带精确版本或 tag），不得是 `-`、含空白、含反斜杠、含 `://` 或 `file:` | 私有实现；`README.md:26` 声明「收到结构化 install 操作」，但调用者不能传任意 pnpm 参数 |
| `DshDesktopApi.plugins.remove(name: string): Promise<void>` | `apps/desktop/src/ipc.ts:32`；实现 `preload.ts:12` | 插件窗口写；name 须匹配 npm 包名模式 | 私有实现 |
| `DshDesktopApi.plugins.update(name: string, version: string): Promise<void>` | `apps/desktop/src/ipc.ts:33`；实现 `preload.ts:13` | 插件窗口写；version 经 `VERSION_PATTERN`（`project-manager.ts:108`）校验后拼成 `name@version` 并以 `--save-exact` 落盘（`project-manager.ts:489`–`project-manager.ts:494`）：`latest`、`beta`、`next`、`1.x` 都通过，含空白、`^`、`~`、`*`、`||` 的写法被拒绝，最终解析版本由 registry 决定 | 私有实现 |
| `DshDesktopApi.updates.check(): Promise<DesktopUpdateState>` | `apps/desktop/src/ipc.ts:36`；实现 `preload.ts:16` | 插件窗口只读；返回 `idle`/`checking`/`available`/`installing`/`ready`/`error` 六态 | 私有实现 |
| `DshDesktopApi.updates.install(): Promise<void>` | `apps/desktop/src/ipc.ts:37`；实现 `preload.ts:17` | 插件窗口写；触发 Electron 释放包下载与 `quitAndInstall` | 私有实现 |
| `DshDesktopApi.updates.subscribe(listener): () => void` | `apps/desktop/src/ipc.ts:38`；实现 `preload.ts:18`–`preload.ts:22` | 主→渲染推送；订阅 `updatesState` 通道，返回退订函数 | 私有实现 |
| `DesktopUpdateState.phase` 六态判别式 | `apps/desktop/src/ipc.ts:20` | 状态机形状；`publishUpdate` 把每次状态变化广播给**所有**窗口（`main.ts:151`–`main.ts:157`，发送点 `main.ts:154`） | 私有实现 |
| channel `dsh-desktop:locale-get` | `apps/desktop/src/ipc.ts:8`；注册 `main.ts:241` | invoke/handle，方向 renderer→main，回执为 `DesktopLocale` | 私有实现；`ipc.ts:6` 自述 kept private to the desktop application bundle |
| channel `dsh-desktop:plugins-list` | `apps/desktop/src/ipc.ts:9`；注册 `main.ts:245` | invoke/handle | 私有实现 |
| channel `dsh-desktop:plugins-add` | `apps/desktop/src/ipc.ts:10`；注册 `main.ts:250` | invoke/handle；`main.ts:251` 先做类型校验，再走 `mutate` | 私有实现 |
| channel `dsh-desktop:plugins-remove` | `apps/desktop/src/ipc.ts:11`；注册 `main.ts:254` | invoke/handle；`main.ts:255` 先做类型校验 | 私有实现 |
| channel `dsh-desktop:plugins-update` | `apps/desktop/src/ipc.ts:12`；注册 `main.ts:258` | invoke/handle；`main.ts:259` 要求两个参数都是 string | 私有实现 |
| channel `dsh-desktop:updates-check` | `apps/desktop/src/ipc.ts:13`；注册 `main.ts:264` | invoke/handle | 私有实现 |
| channel `dsh-desktop:updates-install` | `apps/desktop/src/ipc.ts:14`；注册 `main.ts:268` | invoke/handle | 私有实现 |
| channel `dsh-desktop:updates-state` | `apps/desktop/src/ipc.ts:15`；发送 `main.ts:154` | main→renderer 推送，无 invoke 注册 | 私有实现 |

权限边界由一个统一的 sender 校验保证：`assertDesktopSender`（`main.ts:104`）要求 `event.senderFrame` 非空、URL 协议为 `dsh-app:`、hostname 落在调用方给出的白名单内，否则抛 `rejected IPC from an unowned renderer`。所有插件与更新类 channel 都传 `['shell']`（`main.ts:234`、`main.ts:242`、`main.ts:246`、`main.ts:265`、`main.ts:269`），因此只有加载 `dsh-app://shell/...` 的插件窗口能通过；主窗口加载 `dsh-app://app/index.html`（`main.ts:363`），不匹配 `shell`，无法调用这些 channel。

还有两条与权限相关的代码事实，必须与上面的清单一起读：

- 开发模式下插件变更被整体拒绝：`main.ts:235`–`main.ts:237` 在 `development !== undefined` 时抛 `plugin package changes require a packaged application`；`main.ts:247` 让 `pluginsList` 在开发模式返回空数组。菜单项 `pluginsMenuPackagedOnly` 在开发模式 `enabled: false`（`main.ts:334`）。
- 包变更成功后会强制重载主窗口：`main.ts:239` 调 `mainWindow.webContents.reload()`。

上面清单的消费端只有一处：`apps/desktop/renderer/plugin-manager.js:1` 的 `const api = window.dshDesktop`，该脚本再调用 `api.locale()`（`plugin-manager.js:4`）、`api.plugins.list()`（`plugin-manager.js:30`）、`api.plugins.remove`（`plugin-manager.js:42`）、`api.plugins.update`（`plugin-manager.js:51`）与 `api.plugins.add`（`plugin-manager.js:92`）。更新类方法在插件窗口加载的脚本里没有调用点。

`VERSION_PATTERN`（`project-manager.ts:108` 的 `/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u`）对 `plugins.add` 与 `plugins.update` 是同一套校验，因此这两行的「可带 tag」与「版本写法」并不矛盾：两者都不接受空白、`^`、`~`、`*`、`||`，都接受 tag 名与 `1.x` 这类写法。`project-manager.ts:489`–`project-manager.ts:494` 只做校验与拼接，真正的版本由 pnpm 从 registry 解析。

### 1.3 desktop-host 的 wire 协议

Electron 壳与子进程之间有三条通道，`host-process.ts:112` 的 `stdio` 数组把它们固定下来：三项忽略、fd 3 为请求字节管道、fd 4 为响应字节管道、fd 5 为 Node IPC。常量定义在 `host-protocol.ts:7`、`host-protocol.ts:10`、`host-protocol.ts:13`，子进程侧有独立的一份同值定义（`desktop-host/src/wire.ts:7`、`wire.ts:10`）。

帧格式是固定的 13 字节头加载荷：魔数 `0x44534833`（ASCII `DSH3`）、1 字节类型、4 字节大端 streamId、4 字节大端载荷长度（`host-protocol.ts:18`–`host-protocol.ts:19`，编码见 `host-protocol.ts:98`–`host-protocol.ts:104`）。streamId 必须是 1 到 `0xffff_ffff` 的整数（`host-protocol.ts:86`–`host-protocol.ts:90`）。单帧载荷上限为：数据帧 `DESKTOP_PIPE_CHUNK_BYTES = 64 * 1024`，控制帧 1 MiB（`host-protocol.ts:16`、`host-protocol.ts:20`，限额选择逻辑 `host-protocol.ts:94`）。

请求方向帧类型（`host-protocol.ts:22`–`host-protocol.ts:27`）：

| 名称/类型 | 位置（相对路径:行号） | 方向/权限边界 | 稳定性判定及判据 |
|---|---|---|---|
| `REQUEST_FRAME_START = 1`，载荷为 `DesktopHostRequestStart` JSON | 常量 `host-protocol.ts:22`；接口 `host-protocol.ts:35`；编码 `host-protocol.ts:112` | 壳→子进程；载荷含 `url`、`method`、`headers`、`hasBody` | 私有线协议；版本常量 `host-protocol.ts:4` 是唯一版本约束，无跨包 import |
| `REQUEST_FRAME_DATA = 2`，单帧至多 64 KiB 原始体字节 | 常量 `host-protocol.ts:23`；编码 `host-protocol.ts:117` | 壳→子进程 | 私有线协议 |
| `REQUEST_FRAME_END = 3`，载荷必须为空 | 常量 `host-protocol.ts:24`；编码 `host-protocol.ts:122` | 壳→子进程；正常结束上传体 | 私有线协议 |
| `REQUEST_FRAME_CANCEL = 4`，载荷必须为空 | 常量 `host-protocol.ts:25`；编码 `host-protocol.ts:127` | 壳→子进程；取消该 streamId 的请求与响应 | 私有线协议 |
| 请求帧顺序约束：streamId 必须严格递增 | 校验 `desktop-host/src/index.ts:458`–`desktop-host/src/index.ts:461` | 违反抛 `Electron reused or reordered request stream` | 私有线协议 |

响应方向帧类型（`host-protocol.ts:29`–`host-protocol.ts:32`）：

| 名称/类型 | 位置（相对路径:行号） | 方向/权限边界 | 稳定性判定及判据 |
|---|---|---|---|
| `RESPONSE_FRAME_START = 1`，载荷为 `{status, headers, hasBody}` JSON | 常量 `host-protocol.ts:29`；解码校验 `host-protocol.ts:185`–`host-protocol.ts:198` | 子进程→壳；`status` 必须在 100–599 | 私有线协议 |
| `RESPONSE_FRAME_DATA = 2`，单帧至多 64 KiB | 常量 `host-protocol.ts:30`；解码 `host-protocol.ts:173` | 子进程→壳 | 私有线协议 |
| `RESPONSE_FRAME_END = 3`，载荷必须为空 | 常量 `host-protocol.ts:31`；解码 `host-protocol.ts:175` | 子进程→壳 | 私有线协议 |
| `RESPONSE_FRAME_ERROR = 4`，载荷为 `{message: string}` JSON | 常量 `host-protocol.ts:32`；解码 `host-protocol.ts:200` | 子进程→壳；跨进程只传字符串，不传 Error 对象（`wire.ts:104`） | 私有线协议 |

Node IPC 只承载生命周期，不承载 Fetch 载荷：`DesktopHostCommand` 只有 `{type: 'shutdown'}`（`host-protocol.ts:43`–`host-protocol.ts:45`），`DesktopHostEvent` 只有 `ready`（带 `protocolVersion` 与 `dshVersion`）与 `fatal`（带 `message`）（`host-protocol.ts:48`–`host-protocol.ts:55`）。壳侧对 IPC 消息做形状校验，非法消息即判失败并 `SIGTERM`（`host-process.ts:137`–`host-process.ts:144`）。

流控与背压是代码事实而非契约文本：壳在响应体消费者 desiredSize 归零时暂停响应管道（`host-process.ts:323`–`host-process.ts:326`），子进程在请求体 desiredSize 归零时暂停请求管道（`desktop-host/src/index.ts:513`–`desktop-host/src/index.ts:516`）。

dsh 侧的请求分流发生在子进程内部，`desktop-host/src/index.ts:339`–`desktop-host/src/index.ts:343` 按 URL 路径三选一：`\u002f.dsh/remote-stream` 走 `remoteStreamHandler`，`/api/` 前缀走 `connection.createSharedFetchHandler('/api')`，其余一律走静态资源处理器。这是理解后文「远程连接为什么不可迁移」的关键一行。

### 1.4 `dsh-app://` 自定义协议

| 名称/类型 | 位置（相对路径:行号） | 方向/权限边界 | 稳定性判定及判据 |
|---|---|---|---|
| scheme 名 `dsh-app` | `apps/desktop/src/main.ts:23`；注册 `main.ts:30` | renderer 唯一可导航的协议（`main.ts:99` 拒绝其余协议） | 文档化行为契约；`README.md:5`、`README.md:16`、`docs/architecture.md:53` 均把它写成设计决策 |
| privileges：`standard`、`secure`、`supportFetchAPI`、`corsEnabled: false`、`stream`、`codeCache` | `apps/desktop/src/main.ts:32`–`main.ts:39` | 使该协议被视为标准安全源、可 fetch、可流式；关闭 CORS 开放 | 私有实现；README 只说「安全协议」，未列 privileges |
| 路由 `dsh-app://shell/<path>` → 静态服务 | `apps/desktop/src/main.ts:226`；实现 `main.ts:113`–`main.ts:131` | 只服务 `app.getAppPath()/renderer` 目录；只允许 GET 与 HEAD，其余 405；`..` 越界 403；坏百分号编码 400；未命中 404 | 私有实现 |
| 路由 `dsh-app://app/<path>` → 转发给 dsh 子进程 | `apps/desktop/src/main.ts:227`–`main.ts:230` | 唯一进入 dsh 后端的入口；host 非 `shell`/`app` 一律 404；子进程未就绪返回 503 `backend unavailable` | 文档化行为契约（README 说 `dsh-app://` 承载 Web 资源与 Fetch 流量） |
| MIME 表 `.css`/`.html`/`.js`/`.svg` | `apps/desktop/src/main.ts:42`–`main.ts:47` | 未知扩展名回落到 `application/octet-stream` | 私有实现 |
| 子进程侧的 Web 前端与 MIME 表 | `desktop-host/src/index.ts:122`–`desktop-host/src/index.ts:129` | 额外支持 `.json` 与 `.webmanifest`；`/plugins/` 前缀走 `ctx.clientModules.fetchBundle`（`index.ts:200`） | 私有实现 |

主窗口与插件窗口都从该协议加载：`main.ts:363` 加载 `dsh-app://app/index.html`，`main.ts:325` 加载 `dsh-app://shell/plugin-manager.html`。

`dsh-app://app` 之下还存在一条 desktop 自有的流式通道，它注入到页面 head 里，是本仓库未来可能用到的唯一「客户端半可见」的 desktop 扩展点：

| 名称/类型 | 位置（相对路径:行号） | 方向/权限边界 | 稳定性判定及判据 |
|---|---|---|---|
| `globalThis.__DSH_TRANSPORT__ = { ownsHost: true, openStream(endpoint, payload, signal) }` | 注入脚本常量 `desktop-host/src/index.ts:99`–`desktop-host/src/index.ts:120`；注入点 `index.ts:190` | 页面全局；声明本页拥有 Host，因而 `ctx.connection.isLoopback` 恒真；`openStream` 以 POST `/​.dsh/remote-stream` 打 NDJSON | 上游有文档：`packages/client/connection/src/client/index.ts:80` 起的 `ClientTransportHooks` 接口把它写成「shell 拥有不同物理传输时提供两半」的公开契约；字段 `ownsHost` 的语义在 `client/index.ts:91`–`client/index.ts:99` 有完整注释 |
| 路由 `/.dsh/remote-stream` | 子进程 `desktop-host/src/index.ts:97`（常量）与 `index.ts:223`–`index.ts:265`（处理器） | 只接受 POST；body 须是含 `endpoint` 字符串的 JSON；经 `ctx.get('typertGateway').wireStream.open(endpoint, payload, signal)` 转发；响应为 `application/x-ndjson` | 私有实现；`DESKTOP_STREAM_PATH` 是 desktop-host 内部常量，无跨包 import |

要点：`__DSH_TRANSPORT__` 是**客户端**扩展点，只影响浏览器半如何拿 RPC 与 bundle；它不向宿主半开放任何路由或进程能力。桌面自有的 `openStream` 也只在 `typertGateway` 已注册的 stream endpoint 上工作，`desktop-host/src/index.ts:229` 在 gateway 缺失时返回 503。

## 二、dsh-gui「远程连接」现状与迁移映射

### 2.1 现状流程

dsh-gui 的远程连接由三段组成，宿主能力全部在 `plugins/remote/dsh-remote/src/index.ts` 的 `/remote-api/*` 路由上。

1. 插件宿主半用 `inject = ['webServer']` 声明硬依赖（`plugins/remote/dsh-remote/src/index.ts:74`），在 `apply` 里先做回环绑定自检——`ctx.webServer.host !== '127.0.0.1'` 就直接拒绝启动并报 `/remote-api is unauthenticated`（`index.ts:1174`–`index.ts:1177`）；随后注册前缀路由（`index.ts:1181`–`index.ts:1185`），并把路由 disposer、本机后端、SSH 隧道、Docker 隧道、在途会话全部挂进 `ctx.effect` 的 teardown（`index.ts:1188`–`index.ts:1203`）。
2. 具体能力全在这些路由背后：`local.start` 起额外本机后端、`ssh.connect` 用纯 JS `ssh2` 建会话并在 tmux 里起远端 dsh 再做本地端口转发（`index.ts:784`–`index.ts:829`）、`docker.connect` 用 `docker exec -i` 的 stdio 隧道桥接容器回环端口（`index.ts:1036`–`index.ts:1091`）、`creds.*`/`keyfile.write` 走系统凭据库（`index.ts:1237`–`index.ts:1242`）。
3. Tauri 壳只做薄代理：Rust 侧的 `remote_call` 命令把 op 限制在 21 个白名单项内（`src-tauri/src/main.rs:1148`–`src-tauri/src/main.rs:1170`），再用裸 `TcpStream` 向 `127.0.0.1:<port>` 发 HTTP POST（`main.rs:1180`–`main.rs:1186`、`main.rs:1245`–`main.rs:1247`）。之所以不复用壳页面的 `fetch`，是因为壳页面处于应用源（app origin），对 `http://127.0.0.1:<port>` 属跨源，而 `/remote-api` 刻意拒绝跨源（`main.rs:1172`–`src-tauri/src/main.rs:1179` 的注释只写 "the shell page lives on the app origin"；仓库内没有把该源写成具体 scheme 的证据）。
4. 连接界面整体在 Tauri 原生标题栏，不在页面内：标签页与新建连接对话框由 `src-tauri/ui/app.js` 驱动（`app.js:455` 调 `remote_call`），每个连接一个子 webview（`app.js:318` 调 `view_create`，实现在 `src-tauri/src/views.rs:174`–`views.rs:193` 的 `WebviewBuilder::new` 与 `window.add_child`；`main.rs:12` 的模块注释明确写 "no iframe"）；插件浏览器半已置为 inert（`plugins/remote/dsh-remote/docs/README.md:108`）。

### 2.2 desktop 侧对应物与缺失能力

| 能力 | dsh-gui 现状 | desktop 是否有对应物 | 依据（相对路径:行号） |
|---|---|---|---|
| 宿主 HTTP 路由注册点 | `ctx.webServer.register({kind:'prefix', path:'/remote-api', handler})`，可注册任意前缀 | **只有一个受限替代品**：`webServer` 行被禁用（`apps/desktop-host/config/desktop.cordis.patch.yml:6`–`desktop.cordis.patch.yml:7`），但 `ctx.connection.fetch.register` 不依赖它，可注册路径被限制在 `/api/` 前缀下的精确路由（`packages/client/connection/src/rpc-host.ts:139`–`rpc-host.ts:156`、`rpc.ts:127`–`rpc.ts:135`） | `apps/desktop-host/src/index.ts:305` 取 handler、`index.ts:341`–`index.ts:342` 只把 `/api/` 前缀交给它；`api-path.ts:6` 定义 `API_PATH = '/api'` |
| 多窗口承载多个连接 | Tauri 多 webview，一连接一个子 webview | `dsh-app://` 只有主窗口与插件窗口两条固定路由，插件不能创建窗口 | `apps/desktop/src/main.ts:226`–`main.ts:230`；`main.ts:315`–`main.ts:326` 是唯一创建第二个窗口的路径，且只加载 `plugin-manager.html` |
| renderer → 宿主进程能力 | `remote_call` 白名单转发 | 只暴露插件增删改查与更新操作，无进程、无文件系统、无任意 pnpm 参数 | `apps/desktop/README.md:26`；`apps/desktop/src/ipc.ts:26`–`apps/desktop/src/ipc.ts:39` |
| 本机/远端后端启动 | `local.start`、`ssh.connect`、`docker.connect` 均在插件宿主半 | **无等价能力**。desktop 只启动自己那一个 `@deepseek-ai/dsh-desktop-host` 子进程 | 启动点 `apps/desktop/src/main.ts:159`–`apps/desktop/src/main.ts:163`；子进程入口写死在 `apps/desktop/src/host-process.ts:101` |
| 本地端口转发需要回环监听端点 | 本地端口转发需要 `127.0.0.1` 回环监听（`index.ts:802`–`index.ts:824` 的 `net.createServer` 与 `forwardOut`） | desktop 组合禁用了 `webserver` 行，因此插件不能把路由挂到宿主 HTTP 服务上；但插件所在的 host 进程是普通 Node 进程（`apps/desktop/src/host-process.ts:102`–`host-process.ts:113` 只用自带上游 Node 启动 `entry`、`projectDir` 与可选的 `--allow-linked-profile`，没有权限模型或组合层限制），仍可自行用 `node:net` 监听回环，故 desktop 只缺少宿主路由注册面，不限制插件的监听能力 | `apps/desktop-host/config/desktop.cordis.patch.yml:6`–`desktop.cordis.patch.yml:7`；`apps/desktop/README.md:5`、`README.md:16` |

### 2.3 扩展点排查

逐个排查 desktop 现存的服务与协议扩展面，结论如下。

- **Cordis service / slot / plugin**：profile bundle 里挂载的插件确实能进入 desktop 组合（`desktop-host/src/index.ts:152`–`desktop-host/src/index.ts:177` 调 `loadProfileDirectory` 并把每层 patch 平铺进 boot），也能注册客户端 slot。但 `webServer` 被禁用，任何声明 `inject = ['webServer']` 的插件在 desktop 中永远保持 pending。`connection` 服务虽然存在，它的两个注册入口要分开看：`connection.rpc.handle` 走 `HostConnectionService.register`，在 `rpc-host.ts:165` 构造 `WebRoute` 并在 `rpc-host.ts:179` 调 `owner.webServer.register(route)`（`rpc-host.ts:158`–`rpc-host.ts:182`），在 desktop 中不可用；`connection.fetch.register` 走 `registerFetchRoute`（`rpc-host.ts:139`–`rpc-host.ts:156`），只把路由写进本地 `fetchRoutes` 映射，全程不访问 `webServer`，因此**在 desktop 中仍然可用**。
- **`connection` 的精确 Fetch 路由表（宿主侧唯一可用的路由注册点）**：`registerFetchRoute` 只有一个前置条件——`assertFetchRoute` 要求路径能通过 `endpointFromPath(API_PATH, ...)`（`rpc-host.ts:292`–`rpc-host.ts:303`），而 `API_PATH` 定义为 `'/api'`（`packages/client/connection/src/api-path.ts:6`）；`rpc.ts:117` 把该 `path` 描述为 "Absolute path below `/api`"，`rpc.ts:127` 把整张表描述为 "Host registry for exact Fetch routes that cannot use JSON Remote invocation"。请求来临时由 `createSharedFetchHandler` 读该映射（`rpc-host.ts:117`–`rpc-host.ts:137`），desktop Host 已经在 `apps/desktop-host/src/index.ts:305` 取了这个 handler，并在 `index.ts:341`–`index.ts:342` 把 `/api/` 前缀的请求交给它。上游设计说明与此一致：`.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md:17` 写 "The Connection plugin provides its carrier-neutral RPC and Fetch registries without requiring `webServer`, while Client Modules provides the exact advertised combo-bundle responses to the shell-owned carrier; Web compositions attach their optional HTTP routes for both."。因此任何能注入 `connection` 的 profile bundle 插件都可以用 `ctx.connection.fetch.register({ path: '/api/<segment>', ... })` 挂一个经 `dsh-app://app/api/<segment>` 到达的精确路由。该注册点的能力上限是：路径必须落在 `/api/` 之下、只能注册精确路径（不是任意前缀树）、不提供跨源访问；它约束的是宿主路由注册面，不是插件进程的监听能力——插件所在的 host 进程是普通 Node 进程，只要插件自带代码即可自行监听回环。注册过程本身不做信任或认证检查，`requestRejection`（`rpc-host.ts:97`–`rpc-host.ts:100`）要由调用方自行使用，而 desktop Host 的 `/api/` 分派（`index.ts:341`–`index.ts:342`）只做请求转发，不调用它。
- **profile bundle**：这是唯一能把宿主代码带进 desktop 组合且不改 desktop 源码的入口。`desktopPatches` 读 profile manifest 的 `dsh.profile.bundles`，逐层 `loadOverlayPatches`（`desktop-host/src/index.ts:152`–`desktop-host/src/index.ts:177`），profile 自身的 `cordis.patch.yml` 也作为用户层被读入（`packages/boot/app-boot/src/profile.ts:799`–`profile.ts:802`）；`DesktopProjectManager.writeProfilePlugins` 会把装好的包名写回 `dsh.profile.bundles`（`apps/desktop/src/project-manager.ts:291`–`project-manager.ts:303`）。它能插入 Loader 行，于是插件可以借上一条的 `/api/` 注册点提供宿主处理函数；但它仍然不能注册 `/api/` 之外的前缀。`/api/` 注册点不提供的能力是路由前缀面，与插件进程能否自行监听回环无关。
- **client 半插件**：能拿到 `__DSH_TRANSPORT__`（`desktop-host/src/index.ts:99`–`index.ts:120`），从而用 desktop 自有的 `/.dsh/remote-stream` 走 `typertGateway.wireStream`。这条通道只能调已注册的 typert stream endpoint，不能起进程、不能开端口、不能写文件。
- **`dsh-app://` 协议注册**：只有 `apps/desktop/src/main.ts:224` 一处 `protocol.handle`，按 hostname 硬分流 `shell` 与 `app`，没有插件注册面、没有通配 host。新增 hostname（例如给远程连接用的 `dsh-app://remote/<端口>`）必须改 `main.ts:226`–`main.ts:230`。

由此得到「远程连接」在 desktop 中的三种可能形态，以及各自的真实含义：

1. **在 host 半用 profile bundle 实现（不改 desktop 源码）**：**不可行**。profile bundle 能插入 Loader 行，插件的宿主代码因此可以借 `ctx.connection.fetch.register` 在 `/api/` 之下挂精确路由，这是不改 desktop 源码时的能力上限。但 dsh-gui 的远程连接还需要 `/api/` 注册点给不了的东西：任意前缀的 HTTP 路由面。此外它还需要一份供壳页面调用的回环监听端点，以及 spawn 额外后端、建 SSH/Docker 隧道所需的宿主进程能力；这些都要由插件自带的宿主代码自己建立，且都落在插件进程，不在 `/api/` 注册点。现有 dsh-remote 宿主半做不到这些的原因不是 desktop 禁止，而是它依赖的前缀路由注册面在 desktop 不存在，加上「让连接界面进入某个独立视图」的约束在视图面，要改上游壳。现有的 dsh-remote 宿主半连注册这一行都走不到：`plugins/remote/dsh-remote/src/index.ts:74` 的顶层 `inject = ['webServer']` 让插件在缺该服务时保持 pending，`apply` 不执行，`index.ts:1174`–`index.ts:1177` 的 `webServer.host` 自检因此永远不会运行。
2. **改 `desktop.cordis.patch.yml` 重新启用 `webserver` 行**：这只是补回 desktop 组合里缺失的宿主 HTTP 服务与路由注册面，属于把 desktop 改回 web 形态；`process-manager`、`subprocess`、凭据库、ptrace/沙箱等在 desktop 组合中是否可用需另行验证，且与 `apps/desktop/README.md:16` 的传输决策直接冲突。
3. **改上游私有包**：在 `apps/desktop-host/src/index.ts:339`–`index.ts:343` 的路径分流上新增一个前缀（例如 `/remote-api`），把它指到一个宿主侧 handler；同时在 `apps/desktop/src/main.ts:224` 的协议处理器里放行该前缀或新增 hostname。这等于把 desktop 的私有实现改成第二个传输面，并且**随 desktop 版本绑定**——每上升一个 upstream tag 都要重新合并，`host-protocol.ts` 的协议常量一旦变动（当前为 3，`host-protocol.ts:4`）还要重新对齐。

### 2.4 结论

| 功能 | desktop 是否已有等价能力 | 迁移成本 | 是否必须改 desktop 源码 |
|---|---|---|---|
| 远程连接（本机额外后端 + SSH 隧道 + Docker 隧道 + 凭据库） | 无。desktop 只启动唯一一个 `dsh-desktop-host` 子进程；宿主半唯一可用的路由注册点是 `/api/` 前缀下的精确 Fetch 路由表，它不能注册任意前缀，也不提供宿主 HTTP 服务；这里的上限是路由注册面，不是插件进程的监听能力（插件仍可自行用 `node:net` 监听回环） | **不可行**（按原样迁移，在当前 upstream 组合下） | 是。最小可行改动落在 `apps/desktop-host/src/index.ts` 的路径分流与 `apps/desktop/src/main.ts` 的 `protocol.handle`；且改动无法在不绑定 upstream 版本的前提下维持 |

## 三、dsh-gui「插件升级」现状与迁移映射

### 3.1 现状流程

dsh-gui 有两条互不相同的「升级」路径，必须分开对照。

**路径 A：插件（含 harness 本体）的 git 源码升级。** 由 `src-tauri/src/update.rs` 扫描每个 git submodule 的 package.json（根 manifest 加 `packages/**`），与 `.dsh/gui/npm-installs.json` 的 npm 包名集合求交集，得到每一行的 npm 归属（`update.rs:342` 记录了这份记录文件的来源，写入方是 `scripts/plugin-install.mjs:336`–`scripts/plugin-install.mjs:343`）；再比较远端默认分支、最新 tag 与提交数（`update.rs:530`–`update.rs:547`）。安装侧由 `scripts/plugin-install.mjs` 统一实现：`installPlugin` 对源码目录走 `dsh plugin --profile web add link:<packageDir>`（`plugin-install.mjs:108`），`installNpmPlugin` 走 `dsh plugin --profile web add <packageSpec>`（`plugin-install.mjs:432`），两者都用 `dsh plugin add` 的 bundle reconcile——声明了 `dsh.bundle.patch` 的包会自行挂载，不再写 profile 的 `cordis.patch.yml` insert 行（`plugin-install.mjs:307`–`plugin-install.mjs:313`、`plugin-install.mjs:447`–`plugin-install.mjs:452`）。

**路径 B：dsh-gui 自身的显式「更新」对话框。** `src-tauri/ui/app.js:1651` 调 `local_update_projects` 取行、`app.js:1679` 调 `check_updates`、`app.js:1730` 调 `start_update`；npm 未发布对应 tag 版本时在行内标注（`docs/dsh-gui/update-check.md:49`–`docs/dsh-gui/update-check.md:57`）。真正的升级动作由 `dsh-gui-update` skill 的两阶段流程承载：先在 `.staging/dsh-gui` 副本验证，通过后才实装（`docs/dsh-gui/2026-09-11-harness-upgrade-v0-1-5-rc-2.md:7`）。

**路径 C：通过 plugin-market 的注册表安装/更新。** `plugins/plugin-market/dsh-market/src/index.ts:60` 用 `ctx.inject(['webServer', 'loader'], ...)` 挂载路由；已有 desktop 适配分支（`index.ts:87` 嵌套 inject `desktopPnpm`），但那个分支面向的是第三方实现 `anywhere-labs/deepseek-harness-desktop` 暴露的 `desktopProfiles` 与 `desktopPnpm` 服务，不是本文讨论的官方 desktop。

### 3.2 desktop 侧对应物

desktop 内建了一套完整的插件事务，比 dsh-gui 现有流程更严格。

| 环节 | desktop 实现 | 依据（相对路径:行号） |
|---|---|---|
| 只接受 npm registry 包 | `packageNameFromSpec` 拒绝 `-` 开头、含空白或反斜杠、含 `://`、`file:` 的 spec | `apps/desktop/src/project-manager.ts:162`–`project-manager.ts:180` |
| 版本字面量校验 | `VERSION_PATTERN`（`/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u`）与 `assertVersion`；update 拼 `name@version` 并带 `--save-exact`。该正则接受 `latest`/`beta`/`next` 与 `1.x`，拒绝空白、`^`、`~`、`*`、`||` | `project-manager.ts:108`、`project-manager.ts:153`–`project-manager.ts:155`、`project-manager.ts:489`–`project-manager.ts:494` |
| 必须是 bundle 包 | `inspectPlugin` 要求 manifest 声明 `dsh.bundle.patch`，且解析后的路径不得越出包目录、文件必须存在 | `project-manager.ts:305`–`project-manager.ts:326` |
| staging 事务 + 健康检查 + 回滚 | `mutate` → `newStagingProfile` → `applyMutation` → `hooks.healthCheck` → `activate` | `project-manager.ts:440`–`project-manager.ts:456`；前置与激活 `project-manager.ts:519`–`project-manager.ts:549` |
| 激活日志与崩溃恢复 | `pending.json` 记录 `prepared`/`active-moved`/`staging-activated` 三段，`recover()` 依据实际目录回放 | `project-manager.ts:67`–`project-manager.ts:73`、`project-manager.ts:342`–`project-manager.ts:363` |
| 事务锁 | 进程级 Electron 单实例锁 + `pending` 深度防御锁（`withLock` 用 `wx` 创建，记录 owner pid） | `apps/desktop/src/single-instance.ts`；`project-manager.ts:645`–`project-manager.ts:682` |
| 专用 pnpm 与离线 store | 始终用内置 Node 与内置 pnpm，store 固定在 `$DSH_HOME/desktop/pnpm/store`，registry 固定 `https://registry.npmjs.org/`，过滤全部 `DSH_DESKTOP_`、`npm_`、`pnpm_`、`corepack_` 环境变量 | `project-manager.ts:551`–`project-manager.ts:587`；路径来源 `apps/desktop/src/paths.ts:29`–`paths.ts:47` |
| 插件窗口 UI | 列表、安装、移除、更新（版本框预填当前版本，可改成任意通过 `VERSION_PATTERN` 的写法） | `apps/desktop/renderer/plugin-manager.js:29`–`plugin-manager.js:96` |
| 壳与 dsh 一起升级 | electron-updater 下载并 `quitAndInstall`；启动时 `applyRelease` 要求 seed 版本等于 Electron 版本 | `apps/desktop/src/update-coordinator.ts:74`–`update-coordinator.ts:94`；`project-manager.ts:400`–`project-manager.ts:402` |

### 3.3 逐项对照

| dsh-gui 环节 | desktop 对应物 | 结论 | 依据 |
|---|---|---|---|
| `dsh plugin add <npm 包>` | `plugins.add(spec)` → `plugin-add` 事务 | **可直接复用**（能力等价且更严格） | `project-manager.ts:466`–`project-manager.ts:477`；spec 校验见 `project-manager.ts:162`–`project-manager.ts:180` |
| `dsh plugin remove <包名>` | `plugins.remove(name)` → `plugin-remove` 事务 | **可直接复用** | `project-manager.ts:478`–`project-manager.ts:487` |
| 把插件升到指定版本 | `plugins.update(name, version)` → `plugin-update` 事务 | **可直接复用**；版本参数与 `plugins.add` 共用同一套 `VERSION_PATTERN` 校验，可传精确版本、tag 名或 `1.x` 这类写法，最终解析版本由 registry 决定 | `project-manager.ts:488`–`project-manager.ts:502` |
| `dsh plugin add link:<仓库内目录>` | 无。desktop 只从 registry 解析 | **需改写**：源码 link 型插件（本项目绝大多数）在 desktop 中装不进去 | `project-manager.ts:163` 明确拒绝 `file:`；link 是 pnpm 侧语法，desktop 的 spec 校验不接受 |
| `dsh plugin add <git 简写/URL/tarball>` | 无 | **不可行** | `project-manager.ts:163` 拒绝 `://`；第三方桌面实现（`anywhere-labs/deepseek-harness-desktop`）的安装边界只接受 `name@1.2.3`，这一行为由本仓库 `plugins/plugin-market/dsh-market/tests/desktop-runtime.spec.ts:207`–`desktop-runtime.spec.ts:225` 固定；官方 desktop 的同类拒绝由 `project-manager.ts:163` 支持 |
| 检查远端 tag / submodule 更新 | 无 git 相关 IPC | **需改写**：desktop 不暴露 git 状态，只能由插件自己在宿主半读（受 `webServer` 阻塞），或在 renderer 侧另想办法 | `apps/desktop/src/ipc.ts:26`–`apps/desktop/src/ipc.ts:39` 没有任何 git/仓库操作 |
| `.staging` 两阶段验证 | `manager.mutate` 的 staging + `healthCheck` + `activate` | **可直接复用且更强**：desktop 在激活前会起停一次完整的 staging 后端做健康检查 | `apps/desktop/src/main.ts:164`–`apps/desktop/src/main.ts:203` |
| dsh 本体版本升级 | 无。dsh 版本由 Electron 释放包绑定 | **不可行**：shell 与 dsh 同版本是硬约束（见 `docs/architecture.md:51`） | `project-manager.ts:400`–`project-manager.ts:402`；`apps/desktop/README.md:11` |
| 插件窗口 UI | desktop 自带 `plugin-manager.html/js/css` | **可直接复用**，但只有列表/安装/移除/更新四个动作，没有市场、没有 tag 状态标注 | `apps/desktop/renderer/plugin-manager.js:29`–`plugin-manager.js:96` |
| plugin-market 的注册表浏览与安装 | desktop 不提供 `desktopProfiles`/`desktopPnpm` 服务；`dsh-market` 依赖 `webServer` | **不可用**：`dsh-market` 在 desktop 组合中因缺 `webServer` 保持 pending | `packages` 全域 grep `desktopProfiles`/`desktopPnpm` 无匹配；`plugins/plugin-market/dsh-market/src/index.ts:60`、`index.ts:87` |

### 3.4 宿主半被 `webServer` 阻塞的本仓库插件

判定依据是每个插件宿主入口的 `inject` 声明；插件清单取自各 `plugins/<id>/install.mjs` 的安装调用。

| 插件 id | 宿主入口 `inject` 声明位置 | 安装方式 | 在 desktop 中的结果 |
|---|---|---|---|
| `remote` | `plugins/remote/dsh-remote/src/index.ts:74`（`['webServer']`） | `installPlugin`（link 源码） | pending（缺 `webServer`） |
| `deep-whale` | `plugins/deep-whale/dsh-deep-whale/skin-manager/src/index.ts:18`（`['webServer']`） | `installPlugin`（link 源码） | pending |
| `better-sidebar` | `plugins/better-sidebar/DSH-better-sidebar/src/index.ts:83`（`['webServer', 'sessions', 'webRuntime', 'tools']`）、`plugins/better-sidebar/dsh-sidebar-qa/src/index.ts:83`（`['webServer', 'sessionQuery', 'llm', 'loader']`） | `installNpmPlugin` | pending |
| `dsh-pet` | `plugins/dsh-pet/dsh-pet/dsh-pet/src/host/index.ts:70`（`['webServer', 'agentDefaultModel', 'credentials', 'llm', 'commands']`） | `installNpmPlugin`（精确版本） | pending |
| `dsh-web-ui` | 多个子包，例如 `plugins/dsh-web-ui/dsh-web-ui/packages/dsh-plugin-manager/src/index.ts:26`（`['webServer']`）、`plugins/dsh-web-ui/dsh-web-ui/packages/dsh-market/src/index.ts:21`（`['webServer']`） | `installNpmPlugin` | pending |
| `plugin-market` | `plugins/plugin-market/dsh-market/src/index.ts:60`（`ctx.inject(['webServer', 'loader'], ...)`） | `installNpmPlugin`（精确版本） | pending |
| `ai-update` | `plugins/ai-update/dsh-ai-update/src/index.ts:295`（`ctx.inject(['webServer', 'llm', 'agentDefaultModel', 'loader'], ...)`） | `installPlugin`（link 源码） | 插件体本身会 apply；只有这个 `ctx.inject` 回调及其宿主机路由不挂载 |

前 6 项把 `webServer` 放在宿主入口的顶层 `export const inject` 里，fiber 会因缺这个服务而整体保持 pending，插件一行代码都不执行。`ai-update` 不同：它的 `webServer` 依赖声明在 `plugins/ai-update/dsh-ai-update/src/index.ts:295` 的 `ctx.inject` 回调里，因此按 Cordis 语义只让该回调及其宿主机路由不挂载，插件其余部分照常 apply。两类都受 `webServer` 阻塞，阻塞的粒度不同。`plugins/ai-update/dsh-ai-update/src/context-types.ts:28`–`context-types.ts:29` 声明的是 `webServer` 服务面的类型，不是宿主入口的注入面。

`ai-update` 浏览器半注入的是 `['sessions', 'workspaces', 'conversation', 'uiWorkspace', 'remote', 'remote.agentPresets']`（`plugins/ai-update/dsh-ai-update/src/client/index.ts:135`），这些依赖在 desktop 组合中的提供方本次未逐一核对（见第五节）。

### 3.5 结论

| 功能 | desktop 是否已有等价能力 | 迁移成本 | 是否必须改 desktop 源码 |
|---|---|---|---|
| 插件安装 / 移除 / 更新（npm registry、bundle patch 包；版本写法经 `VERSION_PATTERN` 校验，tag 名与 `1.x` 都接受） | 有，且比 dsh-gui 现有流程更严格（staging + 健康检查 + 回滚 + 锁） | **低**（改用 desktop 自带插件窗口即可，不需要写新代码） | 否 |
| 把 dsh-gui 的 link 型源码插件装进 desktop profile | 无等价能力（只接受 registry 包，且要求 `dsh.bundle.patch`） | **高**：需先发布到 npm 并携带 bundle patch；`dsh-remote` 这类带客户端半的包还要求 bundle patch 里的 insert 行能被 desktop 组合接纳 | 否（装得上不需要） |
| 让已装插件在 desktop 中真正工作（`remote`、`deep-whale`、`better-sidebar`、`dsh-pet`、`dsh-web-ui`、`plugin-market`、`ai-update` 这 7 个宿主半声明了 `webServer` 依赖的插件） | 无 | **不可行**：`webserver` 行在组合层被禁用 | 是。`apps/desktop-host/config/desktop.cordis.patch.yml:6`–`:7`，且与 `apps/desktop/README.md:16` 的传输决策冲突 |

前 6 项在宿主入口顶层 `export const inject` 里声明 `webServer`，fiber 因此整体保持 pending；`ai-update` 只在 `ctx.inject` 回调里声明它，阻塞范围限于该回调及其宿主机路由。两者的共同结果是 desktop 中拿不到 `webServer` 提供的宿主路由能力。
| harness / dsh 本体升级 | 有，走 Electron 释放包（electron-updater） | **不可行**：dsh 版本与 Electron 版本同一，无法只升 dsh | 是。`project-manager.ts:400`–`project-manager.ts:402`、`apps/desktop/src/release.ts:9`–`release.ts:14` |

## 四、必须说清的「迁移意味着什么」

如果目标是把 dsh-gui 的远程连接与插件升级搬到 desktop，而不只是把插件包装进 desktop profile，会遇到一个绕不开的结构性约束：

- desktop 的**宿主半**只有唯一一个入口，即 `apps/desktop-host/src/index.ts` 的 `runDesktopHost`（`index.ts:278`），它写死了三层分流（`index.ts:339`–`index.ts:343`）。第三方插件能进入这个入口只有一条路：以 profile bundle 的形式被 `loadProfileDirectory` 读到（`apps/desktop-host/src/index.ts:152`–`index.ts:177`）。profile bundle 只能插入 Loader 行；它能带来的宿主 HTTP 能力上限，是借 `ctx.connection.fetch.register` 在 `/api/` 前缀下挂精确路由（§2.3），而不是 desktop 组合中并不存在的 `webServer` 前缀路由。
- `connection` 服务在 desktop 中存在，但它的两个注册入口处境不同：`connection.rpc.handle` 经 `rpc-host.ts:158`–`rpc-host.ts:182` 的 `register` 调用 `owner.webServer.register(route)`，在 desktop 中不可用；`connection.fetch.register` 经 `rpc-host.ts:139`–`rpc-host.ts:156` 的 `registerFetchRoute` 只写本地精确路由表，全程不访问 `webServer`，在 desktop 中仍然可用（详见 §2.3）。因此该服务在 desktop 中不是完全退化的分发器：它保留了一个受 `/api/` 前缀约束的路由注册面。

因此「迁移」在这两个功能上分别意味着：

- **远程连接**：只能改上游私有包（`apps/desktop-host/src/index.ts` 的分流 + `apps/desktop/src/main.ts` 的协议处理器），改动随 desktop 版本绑定，每次对齐 upstream tag 都要重新合并，且与 desktop 自述的传输决策（不开监听端口，改用 `dsh-app://` 与分帧管道）直接冲突。严格说，`ctx.connection.fetch.register` 提供了「不改 desktop 源码也能挂上宿主路由」的一点空间，但它的路径被钉在 `/api/` 之下，给不了 dsh-gui 所需的任意前缀路由面；而独立 webview 的硬约束在视图面，要改上游壳。这里的缺口是宿主路由注册面与视图面，不是插件进程的监听能力或 spawn 能力——插件所在的 host 进程是普通 Node 进程，自带代码即可自行监听回环并起子进程。
- **插件升级**：desktop 自带的插件事务可以直接替代 dsh-gui 的 `scripts/plugin-install.mjs` 路径（成本低，且更安全）；但 dsh-gui 现役插件中宿主半声明了 `webServer` 依赖的那 7 个，在 desktop 中拿不到它的宿主路由能力。要让它们工作，同样只能改上游源码。

## 五、不确定项清单

以下各项在本次阅读的 `dsh-v0.1.5-rc.2` 代码范围内无法定论，迁移决策前需要单独验证：

1. **`process-manager` / `subprocess` 服务在 desktop 组合中的可用性。** `desktop.cordis.patch.yml` 只禁用了 `web-startup`、`webserver`、`web-runtime`、`client-hmr`、`open-in-app`、`ui-open-in-app`、`directory-picker`，其余 base 与 web-app bundle 行照常保留。本地未运行 desktop，无法确认这些服务在 Electron 内置 Node 上是否真的注册成功。
2. **`typertGateway.wireStream` 的 endpoint 集合。** `/.dsh/remote-stream` 能转发哪些 endpoint 取决于 typert 类型图的生成结果（`desktop-host/src/index.ts:228`–`index.ts:246`）。本次未逐一枚举，因此「client 半插件能否借它做部分远程能力」只能否证到「不能起进程、不能开端口、不能写文件」这一层。
3. **`desktop` profile 的 `cordis.patch.yml` 生命周期。** `loadProfileDirectory` 会读 profile 目录下的用户补丁层（`profile.ts:799`–`profile.ts:802`），但 `DesktopProjectManager` 的 `copyMetadata` 只搬运 `DESKTOP_PROJECT_FILES` 五个文件（`project-manager.ts:39`–`project-manager.ts:45`、`project-manager.ts:193`–`project-manager.ts:204`），不含 `cordis.patch.yml`。这意味着手工写入的用户补丁层会在下一次插件事务后消失——需要实测确认，本次未验证。
4. **`dsh-pet` 等插件对 `electron` 的可选依赖。** 前次升级记录把 `dsh-pet` 记为「产物在运行期只额外请求 `electron`（可选桌面模式）」（`docs/dsh-gui/2026-09-11-harness-upgrade-v0-1-5-rc-2.md:52`）。该可选分支是否恰好适配官方 desktop 的 Electron 版本，本次未核对。
5. **`ai-update` 浏览器半在 desktop 中的激活状态。** 它的宿主入口在 `plugins/ai-update/dsh-ai-update/src/index.ts:295` 以 `ctx.inject(['webServer', 'llm', 'agentDefaultModel', 'loader'], ...)` 声明依赖，`context-types.ts:28`–`context-types.ts:29` 只是 `webServer` 服务面的类型声明。浏览器半注入 `['sessions', 'workspaces', 'conversation', 'uiWorkspace', 'remote', 'remote.agentPresets']`（`plugins/ai-update/dsh-ai-update/src/client/index.ts:135`），这些服务名在 desktop 组合中的提供方本次未逐一核对，因此它在 desktop 中的最终状态未定。
6. **`ctx.connection.fetch.register` 在 desktop 中的实际可用性未实测。** §2.3 的结论由静态阅读得出：`registerFetchRoute` 不访问 `webServer`，desktop Host 又把 `/api/` 前缀交给 `createSharedFetchHandler`。注册点上方的信任与认证管线由谁接手（桌面组合里 `webServer` 不存在，`bridge` 与 `requestRejection` 的接入点是否随之缺失），以及 `/api/` 下的精确路由是否真能被 `dsh-app://app/api/<segment>` 走到，本次未运行 Electron 验证。
7. **第三方 desktop 与官方 desktop 的服务命名是否会被上游统一。** `dsh-market` 的 desktop 分支依赖 `desktopProfiles`/`desktopPnpm`（`plugins/plugin-market/dsh-market/src/index.ts:17`–`index.ts:23`），这两个服务名在 pinned upstream 中不存在；若上游未来把同类服务纳入官方 desktop，本节关于「插件升级需改源码」的结论需要重新评估。
