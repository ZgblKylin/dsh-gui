# dsh-desktop-tabs

desktop 端多 host 标签页原型：在 Windows 标题栏菜单右侧画一条标签条，每个远端标签各自
持有一个 `dshDesktop.browser` 租约下的 `<webview>`，**切走只隐藏、不卸载**：旧标签的
文档状态、滚动位置、连接与在页任务都保留，切回时直接露出；本机标签隐藏整个 webview 层，
露出原生界面。**活跃标签的关闭按钮旁有 `⟳` 刷新**：卸载该标签的内容并重新建立连接。
`+` 面板管理**已保存连接**、`~/.ssh/config` 的 SSH 主机与 `wsl.exe -l -v` 的 WSL 发行版：
搜索筛选、分组折叠、悬停编辑/删除、右侧启动参数面板（账号、工作路径、启动命令）；连接分
**SSH**（`ssh -L` 隧道）与 **WSL**（WSL2 localhost 转发直连，无隧道）两种方式。激活一个需要
连接的标签时**立即**切到该标签的空白占位页并显示连接日志（轮询
`/desktop-tabs/api/connections`），连接成功后再加载 webview。

**本插件由两个外壳共用，但只在一处以 UI 呈现。** host 半（`src/index.ts` + `src/remote/**`）
是 SSH 远程连接的唯一实现与唯一配置来源，`web` profile（Tauri 壳 `dsh-gui.exe`）与
`desktop` profile 都安装它：两边都经 `/desktop-tabs/api/*` 建连、读写同一份
`<DSH_HOME>/gui/desktop-tabs.json`，远端 `dsh-gui` tmux 会话与磁盘 token 文件也共享，因此
任一边断开后另一边可以直接接上同一个远端会话。browser 半仍只在 desktop 壳里工作：普通
`dsh web` 页面拿不到 `window.dshDesktop.browser`，`apply()` 直接返回，标签条、`+` 面板、
设置面板与远端视图都不渲染——`web` profile 只多出路由与 host 半，不改动既有页面。

## 与 Tauri 壳共用

Tauri 壳（`web` profile）的 SSH 远程连接不再有自己的 `ssh2` 实现，而是复用本插件：

| 维度 | 共用方式 |
|---|---|
| 后端 | Tauri 的 Rust 命令代理本插件的 `/desktop-tabs/api/*`（`GET`/`PUT tabs`、`GET connections`、`POST connections/<id>/up`、`POST connections/<id>/down`、`GET ssh-hosts`、`GET wsl-hosts`），拿到 `up` 返回的 `url` 后由外壳创建子 webview |
| 配置 | 同一份 `<DSH_HOME>/gui/desktop-tabs.json` 的 `connections`（SSH 与 WSL 两种 `type`）；`tabs` 仍是 desktop 打开标签的列表，Tauri 只读它做保留式回写，Tauri 自己的标签仍在自己的 `localStorage` |
| 远端会话 | 同一套 `dsh-gui` tmux 会话、`$HOME/.dsh-gui-remote.log` 与 `.dsh-gui-remote.token`（见「远程连接生命周期」） |
| UI 控件 | `src/client/ui/connection-list.js` 与 `src/client/ui/connection-settings.js` 是**无 import 的纯 DOM ESM 工厂**：desktop 的 `tabs.ts` 直接 import，Tauri 构建把它们原样复制到 `src-tauri/ui/` 并挂到 `window.__dshRemoteUi`；两边因此渲染同一份三组列表与「账号」设置页 |
| 认证 | 统一为只走本机 `ssh`（`BatchMode=yes`）：`~/.ssh/config` + ssh-agent + 免口令密钥；不再有密码、上传密钥或 `~/.ssh/config` 之外的凭据来源 |

代价是 password 认证消失（desktop 实现从不做交互认证）；Windows 需要系统 OpenSSH 的
`ssh.exe`。失败文案与本文档都按此说明。

## 结构

| 部件 | 文件 | 职责 |
|---|---|---|
| host 半 | `src/index.ts` | 注册 `/desktop-tabs/api/tabs` 的 `GET`/`HEAD`/`PUT`，并在同一 effect 内挂载远程连接路由，把 `{ tabs, connections }` 交给连接管理器 |
| host 半 | `src/targets.ts` | 读写 `<DSH_HOME>/gui/desktop-tabs.json`：解析 `url`、`port` + `tokenFile`、`ssh`、`wsl`、`type`、`account`，校验并原子替换 `tabs` 与 `connections` 两个列表 |
| host 半 | `src/remote/**` | 远程连接路由与连接管理器（经 `registerRemoteConnections` 挂载；远端 dsh 在 `dsh-gui` tmux 会话中长期存活，SSH 与 WSL 共用该会话，见「远程连接生命周期」） |
| host 半 | `src/remote/wsl.ts` | `wsl.exe` 传输层（`-d <发行版>` / `-u <账号>`、脚本走 stdin 的 `bash -l -s`、`WSL_UTF8` 与 UTF-16LE 兜底解码）、发行版列表解析、端口探测脚本、启动失败分类 |
| client 半 | `src/client/index.ts` | 探测 `window.dshDesktop.browser`（protocol version 1）；缺失则完全惰性 |
| client 半 | `src/client/tabs.ts` | 标签条几何、标签与连接状态、切换与增删改、持久化、连接日志轮询 |
| 双壳共享 | `src/client/ui/connection-list.js` | `+` 面板：搜索框、可折叠的「已配置」「SSH 主机」「WSL 主机」三组、行内编辑/删除（无 import 纯 DOM 工厂） |
| 双壳共享 | `src/client/ui/connection-settings.js` | 右侧启动参数面板：账号、工作路径、启动命令、两个内置预设、确认/取消（无 import 纯 DOM 工厂） |
| client 半 | `src/client/api.ts` | 宿主 API 客户端（读写 `{ tabs, connections }`、连接状态、`up`/`down`、SSH 与 WSL 主机） |
| client 半 | `src/client/types.ts` | client 半共享的 `DesktopTab`、`SavedConnection`、`ConnectionStatus`、`SshHost`、`WslHost` |
| client 半 | `src/client/view.ts` | 远端视图层：按标签各自保留的 guest（切走只隐藏）、占位页、状态行、连接日志、租约与 webview 生命周期 |
| client 半 | `src/client/window-title.ts` | 窗口标题层：激活的远程页面上报标题时接管主文档 `document.title`，切回本机/连接中/失败时恢复本机标题，接管期间被 harness 改写的本机标题会被记录并立即写回 |
| client 半 | `src/client/webview-host.ts` | 远端 guest 的求值面（`executeJavaScript`），视图层与通知转接共用 |
| client 半 | `src/client/notify-relay.ts` | 远端通知转接：向 guest 注入 Notification shim、取回队列并在应用文档重放 |
| client 半 | `src/client/clipboard-relay.ts` | 远端剪贴板回退：向 guest 注入 writeText 回退，异步写被拒时走 `execCommand('copy')` |
| client 半 | `src/client/image-menu.ts` | 远端图片右键菜单：guest 取图脚本、data URL 写剪贴板、应用文档自绘菜单与生命周期 |
| client 半 | `src/client/styles.ts` | 自有的 `<style>`（`--dsw-*` token、`no-drag`、`z-index: 1100`/`900`） |

## 配置：`<DSH_HOME>/gui/desktop-tabs.json`

```json
{
  "tabs": [
    { "id": "local", "title": "本机" },
    { "id": "dev", "title": "测试机", "url": "http://127.0.0.1:19999/?token=<t>" },
    { "id": "dev2", "title": "测试机 2", "port": 19999, "tokenFile": "C:/Users/me/.dsh-gui-remote.token" },
    { "id": "ssh-WSL", "title": "WSL", "ssh": { "host": "WSL" } },
    { "id": "wsl-archlinux", "title": "archlinux", "wsl": { "distro": "archlinux" } }
  ],
  "connections": [
    { "id": "ssh-WSL", "title": "WSL", "type": "ssh", "ssh": { "host": "WSL" },
      "account": "chongfei", "workdir": "$HOME/dsh", "startCommand": "npm '@deepseek-ai/dsh' web" },
    { "id": "wsl-archlinux", "title": "archlinux", "type": "wsl",
      "wsl": { "distro": "archlinux", "port": 3080 }, "account": "chongfei" }
  ]
}
```

- `tabs` 是**当前打开的标签**；`connections` 是**已保存的连接**。关闭标签只移除标签，不删除
  连接，因此「已配置」里的连接可以随时重新打开。
- 连接条目：`id`、`title`、`type`（`ssh` 或 `wsl`）、`ssh` 或 `wsl`（由 `src/remote/**`
  解释）、可选 `account`（登录账号：SSH 走 `ssh -l`、WSL 走 `wsl.exe -u`）、可选 `workdir`
  （缺省表示远端 `$HOME`）、可选 `startCommand`（缺省表示远端默认命令）。空字符串视为未设置，
  不会写回文件。一个条目同时带 `ssh` 与 `wsl` 时按 SSH 处理。
- `wsl` 描述对象：`distro`（发行版名，空字符串表示默认发行版）、可选 `runtimeRoot`（默认
  `~/dsh-gui-home`）、`dshHome`、`dshBin`、`node`、`port`（**起始端口，默认 3080**，被占用
  时向上递增，见「WSL 远程连接」）。`ssh` 描述对象同前（`host`、`port` 等）。
- WSL 主机列表来自 `wsl.exe -l -v`，点选即建 `{ id: "wsl-<发行版>", title: <发行版>, type: "wsl",
  wsl: { distro: <发行版> } }`；SSH 主机列表同前，来自 `~/.ssh/config`。
- `url`：直接使用的远端地址（仅接受 http/https）。`port`（+ 可选 `tokenFile`，缺省
  `~/.dsh-gui-remote.token`）：宿主半读裸 token 后拼成 `http://127.0.0.1:<port>/?token=<token>`。
- 既无 `url`、也无 `port`、也无 `ssh` 的条目是本机视图；**恰好一个**本机标签始终排第一位。
- 文件缺失：只显示本机标签，不报错。文件解析失败、条目缺 `id`、重复 `id`：报一次警告（每个
  宿主进程每个不同问题只报一次）。`port` 标签的 token 文件缺失或格式不符时该标签被隐藏。
- 读取发生在每次请求；`PUT` 会整体替换两个列表。请求体缺少 `connections` 时**保留**文件中
  已保存的连接（旧版只发 `tabs` 的调用方不会清空它们），显式传 `connections: []` 才会清空。

## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET`/`HEAD` | `/desktop-tabs/api/tabs` | 返回 `{ tabs, connections }` |
| `PUT` | `/desktop-tabs/api/tabs` | 以 `{ tabs, connections }` 原子替换配置文件，成功返回新列表 |
| `POST` | `/desktop-tabs/api/connections/<id>/up` | 建立该连接，返回 `{ url }` |
| `POST` | `/desktop-tabs/api/connections/<id>/down` | 断开并回收该连接 |
| `GET` | `/desktop-tabs/api/connections` | 各连接的 `state`/`url`/`error` 与 `log` |
| `GET` | `/desktop-tabs/api/ssh-hosts` | `~/.ssh/config` 中可导入的 Host |
| `GET` | `/desktop-tabs/api/wsl-hosts` | `wsl.exe -l -v` 报告的 WSL 发行版（`{ hosts: [{ name, state?, version?, default? }] }`）；WSL 不可用时仍返回 200 + 空列表 + `error` |

全部路由只在 `webServer.host === '127.0.0.1'` 时注册，并带最小同源栅栏。`PUT` 会校验提交
内容（形如 `{ "tabs": [...] }`、非空且唯一的 `id`、http/https `url`、对象 `ssh`/`wsl`、
可选非空 `account`、端口范围、可选 `workdir`/`startCommand`、最多各 64 项、请求体上限
256 KiB），不合法时返回 400/413 与 `{ error }`，文件保持原样。

宿主半把与 `GET /api/tabs` 相同的 `{ tabs, connections }` 交给 `registerRemoteConnections`
的 `tabs` 回调：连接管理器按 id 取行，`connections` 的字段优先，因此保存的 `workdir`、
`startCommand` 与 `account` 会被远端启动使用。

## 交互

- 标签行是**一个控件**：外层容器承担整行的 hover/激活背景（`--dsw-alias-interactive-bg-hover`
  等与标题栏菜单一致的 token），内部的文本按钮、`⟳` 与 `✕` 都没有自己的背景（`⟳`/`✕` 只在
  自身 hover 时改颜色）。文本按钮保留 `aria-pressed` 与 `aria-label` 语义、`⟳`/`✕` 带
  `aria-label`，键盘仍可分别聚焦；点文本激活标签，点 `⟳` 刷新该标签，点 `✕` 关闭该标签
  （`stopPropagation`，不触发激活）。
- 切换标签只切换可见的 surface：旧标签的 webview **不销毁、不重新导航**，切回时原样露出，
  文档状态、滚动位置与在页任务都保留；关闭标签（`✕`）才卸载它的 guest 并 `down` 它的连接。
  本机标签隐藏整层，其他标签的 guest 仍在后台运行。
- **窗口标题跟随活跃远程标签页自身的 `document.title`**（harness 的 DocumentTitle，形如
  `会话标题 — 产品标题`）：desktop 主窗口标题默认跟随主文档 `document.title`，而远程 guest
  的页面标题不会影响主文档，所以由视图层接管。首个远程标题到达时采样当时的本机标题并开始
  监听主文档标题改动，再把窗口标题写成远程标题；接管期间 harness 改写本机标题会被**记录为
  最新本机标题并立即写回远程标题**。切到本机标签、切到一个还没上报标题的标签（连接中/失败）、
  刷新/关闭活跃标签、隐藏或 dispose 时恢复最新本机标题。空/纯空白标题视为本机标题，不接管。
- 只有**活跃标签**带 `⟳` 刷新（紧邻 `✕`；非活跃标签上该按钮带 `hidden`，不占位也不进
  tab 序）：点击后卸载该标签当前内容并重新建立连接。`ssh`/`wsl` 标签先 `down`（只断开本机隧道
  与 `wsl.exe`，远端 tmux 里的后端不动）再走一次正常的 `up` 流程，占位页与连接日志照常显示；
  `url` 标签没有连接，卸载后重新加载同一地址即可。连接正在进行中的标签忽略刷新，以免中断刚
  建立的会话；刷新不写配置，标签与连接条目保持不变。
- 标签条右侧的 `+` 打开面板：**搜索框**对「已配置」「SSH 主机」「WSL 主机」三组做大小写
  不敏感的模糊筛选（子序列匹配连接的类型前缀/`title`/`id`/`ssh.host`/`wsl.distro`/`account`，
  SSH 主机的 `alias`/`HostName`/`User`，以及 WSL 发行版的名称/状态/版本），每次输入即刷新；
  无匹配显示空提示。
- 三组标题可点击折叠/展开（`▾`/`▸`，标题带 `已显示/总数`），折叠状态只存在内存。
- 「已配置」行文本带**连接方式前缀**：`SSH - 连接名` / `WSL - 连接名`，悬停 `title` 附详情
  （SSH 主机或 WSL 发行版、账号）。行悬停（或键盘聚焦）时在行尾显示两个字形按钮
  **`✎`（编辑）** 与 **`✕`（删除）**，两者都以中文 `title` 与 `aria-label` 标注：`✎` 打开右侧
  启动参数面板并预填，`✕` 删除该连接（其标签若打开则一并关闭并 `down`）。行本身点击即
  打开/激活该标签。
- 「WSL 主机」组每行是一个发行版名，`title` 形如 `WSL 发行版 archlinux（运行中，版本 2，默认）`，
  点击即新建 WSL 连接并打开右侧启动参数面板；空列表提示「没有可用的 WSL 发行版」。
- 右侧面板含**账号**（占位按连接方式区分：`SSH 用户名（留空用 ssh config）` /
  `WSL 用户名（留空用默认用户）`）、**工作路径**（占位 `/srv/dsh 或 $HOME/dsh`，留空即远端
  `$HOME`）与**启动命令**（留空即远端默认命令），`▾` 展开两个内置预设
  `npm '@deepseek-ai/dsh' web` 与 `npm run harness`，命中当前值时显示 `✓`；标题为
  `新建/编辑 SSH|WSL 连接`。**确认**保存连接并打开（或先 `down` 再重连）标签，**取消**关闭面板。
- 面板会自动隐藏：点击两个面板之外的任何区域（含标签条与应用其它区域）或按 `Esc` 都关闭两个
  面板；配置面板**确认成功**、以及点「已配置」行开始打开连接后，两个面板一并关闭。失败时面板
  保留并显示原因。
- 激活一个 `ssh`/`wsl` 且尚无地址的标签时，视图层**立刻**切到该标签自己的空白占位页（其他
  标签的 guest 只是隐藏，仍在运行）。整层 `position: fixed` + `var(--dsw-alias-bg-base)` 覆盖
  标题栏以下的内容区，底下原生 UI 完全不可见；状态行显示当前步骤，日志区自带背景与内边距，
  按 500 ms 轮询连接日志并自动滚到底部；成功后用 webview 替换占位页，失败时保留日志、在状态
  行与标签上显示失败原因。
- 每次增删改后把两个列表 `PUT` 回宿主半；连接相关的操作都先落盘再发起（`up` 从配置文件读取
  连接设置）。本机标签始终保留且第一位。

## 远端权限转接（通知 / 剪贴板）

桌面外壳的租约 guest 会话拒绝一切权限（`deepseek-harness/apps/desktop/src/browser-guests.ts`
的 `configureSession`），远端页面的 `Notification.requestPermission()` 因此直接得到
`denied`、`new Notification(...)` 不产生任何界面，`navigator.clipboard.writeText()` 也以
`NotAllowedError` 拒绝。会话是主进程概念，插件在应用文档的渲染进程里没有改写入点，所以
转接发生在页面层（每次 `dom-ready` 注入、无 preload 可用，见「已知限制」）：

- **通知**：注入 `NOTIFY_SHIM_SOURCE`，把 `Notification.permission` 报成 `granted`、
  `requestPermission()` 解析 `granted`、`navigator.permissions.query({ name: 'notifications' })`
  报 `granted`；`new Notification(title, options)` 不再创建被拒的浏览器通知，而把载荷（标题、
  正文、按 guest 源绝对化后的图标、`tag`、`requireInteraction`、`silent`、可 JSON 序列化的
  `data`）推进 `window.__dshNotifyRelay` 队列。
- **剪贴板**：注入 `CLIPBOARD_SHIM_SOURCE`，把 `navigator.clipboard.writeText` 包一层——先试
  原生异步写，被拒时改用 `document.execCommand('copy')`（带用户手势与选区的旧式复制不走会话
  权限检查）；两种路径都不行才拒绝。harness `writeClipboard` 在 writeText 存在但被拒时不会
  自己落到 execCommand，这正是回退补齐的缺口。
- 视图层在 guest 存活期间按 1 s `executeJavaScript` 读取并清空通知队列（`<webview>` 在这条
  Electron 线上不暴露 `contentWindow`/`postMessage`，且 guest 被外壳剥掉全部
  `webPreferences`、无法挂 preload，求值取回是唯一稳定通道）；应用文档用自身的 `Notification`
  重放每条载荷（应用会话放行通知权限），得到真实系统通知，点通知聚焦应用窗口并关闭它。
- 可见标签的 guest 在挂载或重新显示时调用 `webview.focus()`，覆盖「刚切到标签还未点击」的
  聚焦缺口（聚焦也是复制按钮失效的成因之一）；后台完成的标签只挂载不抢焦点。

验证：连上远端标签后，在该 guest 内触发一次通知（如任务完成后 dsh-pet 的 toast，或在
devtools 里执行 `window.__dshNotifyRelay.test()`），应用未聚焦时应出现系统通知；点击代码块
复制按钮后，在应用文档或任意编辑器粘贴应得到代码块内容。

## 远端图片右键菜单（复制图片）

Electron 不为 `<webview>` guest 提供默认右键菜单（desktop 主进程只处理主窗口的可编辑控件与
选区文本），所以远端会话里打开会话大图预览后右键没有任何菜单。应用文档的渲染进程能拿到 guest
的 `context-menu` 事件，菜单与剪贴板写入都在这里完成：

- **菜单**：`view.ts` 给每个 guest 监听 `context-menu`；`params.mediaType === 'image'` 时用
  guest 的 `getBoundingClientRect().left/top + params.x/y` 作为视口坐标，在应用文档里显示一个
  `role="menu"` 的自绘菜单（唯一菜单项「复制图片」；打开时聚焦菜单项并夹取进窗口内）。再次
  右键重开；`Esc`、菜单外 `pointerdown`、窗口 `blur`/`resize`/`scroll`、切换/隐藏/刷新/关闭
  标签、图层 dispose 都会关闭菜单。关闭后焦点交还当前 guest；被替换（generation 失效）的
  guest 不再弹菜单。
- **取图**：打开菜单时向 guest 求值取图脚本（`webview.executeJavaScript`，与通知/剪贴板转接
  同一通道）：`document.elementFromPoint(x, y)` 向上找 `IMG`，找不到再按 `currentSrc/src`
  匹配 `document.images`；canvas 按 `naturalWidth`/`naturalHeight` 绘制后
  `toDataURL('image/png')`。canvas 被污染（`toDataURL` 抛错）或找不到元素时，用
  `fetch(srcURL, { credentials: 'include' })` 取回 blob，经 `Image` + canvas 重编码为 PNG。
  只有 `data:image/png;base64,` 前缀的结果会被接受。
- **为什么在应用文档写剪贴板**：guest 会话拒绝一切权限（`navigator.clipboard.write` 被拒，也
  没有可用 preload），不能直接写图；应用文档是 `dsh-app://app`（secure context），其 session
  放行非媒体权限，且点击菜单项本身给应用文档焦点与用户激活。写入把 guest 返回的 data URL 用
  `fetch(dataUrl)` 转成 Blob，再 `new ClipboardItem({ 'image/png': blob })` 交给
  `navigator.clipboard.write`。放在应用文档也让写入不必与 guest 的权限检查对抗。
- **失败文案**：guest 没取到图（元素找不到、取图被拒、返回非 PNG）时菜单项显示
  「无法读取图片」并禁用；应用文档写入失败（无 `ClipboardItem`、解码失败、权限拒绝）时显示
  「复制失败，请重试」，1.5 s 后恢复为可重试的「复制图片」。

验证：连上远端标签、打开会话里的大图预览后右键图片，菜单应只有「复制图片」；点击后可在任意
编辑器粘贴出该图。`tests/image-menu.spec.ts` 用 Node 直跑的 fake DOM 覆盖定位、取图、复制、
失败与关闭路径。

## 凭据

本插件不读取任何凭据：不调用 `/remote-api/creds.read`，不读 `<DSH_HOME>\gui\credentials\`，
不读 `.credentials.yaml`，也不解析 `~/.ssh/config` 的 `IdentityFile`。认证一律交给 `ssh`
自身（`~/.ssh/config` + ssh-agent + key）。日志与错误文案在渲染前再把 `token=` 值替换为
`***`，作为远端半已做脱敏之外的第二层保护。

## 依赖的 service / slot

- host 半：`inject: ['webServer']`（仅注册路由，不消费其它服务）。
- client 半：`inject: []`；不注册任何 slot，只在标题栏带内挂自有 DOM。桌面壳的
  `window.dshDesktop.browser` 通过特征探测读取，不进入 cordis `inject`，因此普通
  DSH 环境下插件依旧能加载。

## 已知限制

- `web` profile 只启用 host 半：标签条、`+` 面板、设置面板与远端视图都只在 desktop 壳出现，
  普通 `dsh web` 页面不会被改动；Tauri 壳自己承载对话框与标签。
- SSH 认证只有 `BatchMode=yes` 一条路：密码、上传密钥、`ssh.config` 之外的凭据来源都不可用，
  远端必须配好 `~/.ssh/config` / ssh-agent / 免口令密钥；Windows 需系统 OpenSSH 的 `ssh.exe`。
- 两个外壳共享 `connections`，不共享打开标签：`desktop-tabs.json` 的 `tabs` 是 desktop 的
  标签列表，Tauri 只读它做保留式回写，Tauri 自己的标签仍存在它自己的 `localStorage`。
- 租约通道与 `webviewTag` 是上游内部实现，没有对外契约；desktop 升级可能改变行为。
- 远端标签的 partition 由外壳随机生成且无 `persist:` 前缀：同一标签 id 在**同一次应用
  进程内**重建可复用 cookie（免重复认证），但应用重启后丢失，需要重新建立连接。
- 指向本机 Host 的地址会被外壳拒绝（guest 白名单禁止应用自身的 authority），因此“本机”
  永远是主文档本身，不能做成 guest 标签。
- 只出现在 `tabs` 里、没有对应 `connections` 条目的旧式 `ssh`/`wsl` 标签仍可打开并连接，但不会
  出现在「已配置」组，也没有可编辑的启动参数（含账号）；`port`/`url` 标签不是连接，不参与该组。
- WSL 连接依赖 WSL2 的 localhost 转发（`.wslconfig` 的 `localhostForwarding` 默认开启）：
  关掉它、或镜像网络（mirrored）下防火墙拦截时，WSL 内端口在监听但 Windows 侧连不上，连接
  会以 `localhostForwarding` 提示失败。WSL1 发行版与「无 `ss`/`netstat` 的极简发行版」只能靠
  启动期 `EADDRINUSE` 兜底判定端口占用。
- WSL 连接要求发行版内有 `tmux`（与 SSH 远端相同）：缺失时错误文案给出安装提示；同一发行版
  的不同账号因 tmux 会话按用户隔离，各自维护自己的 `dsh-gui` 后端。
- WSL 的 `<webview>` 地址是 `127.0.0.1:<端口>`，与桌面应用自身 Host 端口相同时会被外壳当作
  应用自身 authority 拒绝；端口扫描会跳过 Windows 本机已占用的端口，实际不会选中它。
- SSH 主机列表只解析 `Host`/`HostName`/`User`/`Port`，不跟随 `Include`，不展开通配符与取反
  模式；WSL 主机列表只解析 `wsl.exe -l -v` 的表格（旧版 wsl.exe 回退到 `-l -q`，此时没有
  状态/版本/默认标记）。`up` 失败后标签保留错误标记，直到下一次成功激活或刷新。
- 常驻标签有成本：每个打开的远端标签都保留一个 guest（连同它的页面进程），内存与渲染开销
  随标签数增加，关闭标签才释放。切走的标签只是隐藏，其滚动位置、草稿等客户端视图状态保留
  （远端 dsh 与其任务一直不受影响，见「远程连接生命周期」）。
- 本机视图只隐藏 webview 层，不切换宿主 `main` 面板的 key（避免卸载宿主 conversation 面板）。
- 标签条只在 Windows 标题栏（`data-windows-menu` 存在）下出现；macOS/Linux 的 desktop
  外壳不渲染。
- 远端 guest 不带 `data-sidebar-browser-frame` 标记，因此桌面外壳的快捷键转发不会作用到
  远端 guest（普通键盘输入仍由焦点决定）。
- 通知/剪贴板转接是页面层改写：shim 最早在 `dom-ready` 生效，早期就读走并缓存
  `Notification.permission`、或把 `navigator.clipboard.writeText` 引用固化到模块闭包里的
  页面仍会走旧分支；通知 shim 报出的 `granted` 是伪造的授权状态，没有经过真实权限询问。
  远端页面结构或调用方式改变时需要同步 shim。
- 远端通知按 guest 转接：所有**打开着**的远端标签的 guest 都在运行，各自的通知队列按 1 s
  轮询取出并在应用文档重放，因此后台标签完成任务也会出现系统通知；关闭标签后它的通知引擎
  随 guest 一并卸载。
- 窗口标题接管依赖 desktop 外壳（Electron 主窗口）保持默认的 `page-title-updated` 行为：
  主窗口标题跟随主文档 `document.title`。若外壳改为自行管理窗口标题（例如 `preventDefault`），
  本插件便无法再影响窗口标题（标签页内行为不受影响）。远程标题**原样使用**，不截断、不拼接
  标签名；空/纯空白标题按本机标题处理。后台标签的标题更新只会被记录，等它再次激活才应用。
- 远端右键菜单只处理 `mediaType === 'image'`：图片以外的右键（文本、链接、可编辑控件）仍没有
  应用菜单（Electron 不给 guest 默认菜单），维持桌面外壳的现状。
- 「复制图片」是 canvas 重编码得到的 PNG 位图：动图只取当前帧，EXIF/色彩配置等原始格式信息
  丢失（透明通道保留），超大图还受 Chromium 的 canvas 尺寸上限约束。
- 取图依赖 guest 页面的 image 元素：命中 `elementFromPoint` 或 `document.images` 的
  `src/currentSrc`；两者都失败时回退 `fetch(srcURL)`，跨源且无 CORS 的图片会落到
  「无法读取图片」。正常 harness 大图预览（blob:/同源）可用。

## 远程连接生命周期（tmux 长期存活）

一条连接的远端 dsh 放在名为 `dsh-gui` 的 tmux 会话中长期存活，**SSH 连接与 WSL 连接共用
同名会话、同一份日志与 token 文件**——两边绑定的都是回环地址，谁先启动的后端另一边都能直接
复用，因此不会互相重启。会话名、日志路径（`$HOME/.dsh-gui-remote.log`）与磁盘 token 文件
（`$HOME/.dsh-gui-remote.token`）都和 `plugins/remote/dsh-remote` 一致，多个外壳与同一台远端
主机（或同一个 WSL 发行版）可共享同一个后端。差异只在传输与承载层：本插件 SSH 经本机的原生
`ssh` 开隧道、WSL 经 `wsl.exe` 执行命令并由 WSL2 localhost 转发直连；desktop 壳用租约
`<webview>` 承载标签页，Tauri 壳经同一组路由与同一份配置建连、用子 webview 承载，所以切换
外壳可以继续同一个远端会话。`plugins/remote/dsh-remote` 收缩为本机后端与 Docker 连接，不再
自带 SSH 实现。

`up` 先对 `dsh-gui` 会话做一次幂等确保：会话 MISSING 或 STALE（面板已死）时新建会话并启动 dsh，
ALIVE 时直接复用、不重启。存活判定读远端磁盘 token 文件（token 采集自启动日志
`dsh web: ...?token=...`，以 `umask 077` 落盘）拼 `http://127.0.0.1:<localPort>/?token=<token>`
探活，303/2xx 即存活，无 token 的旧版后端按裸 URL 2xx 判定；未存活则清掉旧会话与旧 token，
在 tmux 里重启 dsh，重采集端口与 token、重开隧道、重探活。

任何「判定已死 → 重启」都先证明 SSH 传输可达（先跑到远端命令），断网或隧道断开不会误杀正在
运行的后端；失败路径只清理本次创建的隧道与本尝试新建的 tmux 会话，复用已有存活会话时失败不
清会话。进程就绪后探测空闲本地端口，经 `ssh -L` 转发，等隧道健康检查通过后上报 `up`。

关闭标签（`down`）与退出应用（`dispose`）**只断开本地前端**：终止本机的隧道与 ssh 子进程、
把该连接移出活动表，**不发任何远端停止命令**。远端 dsh 与其承载的任务在 tmux 会话里继续
运行，下次打开同一连接直接复用；应用被强退或崩溃也不会留下孤儿进程，因此不存在也不会维护
`desktop-tabs-remote.json` 一类的进程记录。

远端启动因端口被占失败（`EADDRINUSE`）时，SSH 路径的错误文案会附带提示：默认启动命令会走
`--port 0`，或先结束远端旧实例；WSL 路径由端口扫描与失败分类处理（见下节）。

## WSL 远程连接

WSL 连接的**配置面板与启动流程与 SSH 相同**（同一套 `+` 面板、启动参数面板、连接日志与
占位页；`account` 走 `wsl.exe -u`），差异只在传输与端口：

- **传输**：每条命令是一次 `wsl.exe [-d <发行版>] [-u <账号>] -- bash -l -s` 调用，脚本经
  stdin 喂入（避免 Windows → WSL 的参数再解析），`WSL_UTF8=1` 让 wsl.exe 的提示为 UTF-8，
  旧版无视该变量时按 UTF-16LE 兜底解码。控制通道是**登录但非交互**的 bash：`-i` 会让交互式
  rc 把 OSC 3008 / 标题序列写进 stdout、把 prompt 写进 stderr，污染解析；后端本身仍在 tmux
  面板里用 `bash -l -i -c` 启动，nvm 之类的交互 rc 环境照旧生效（见「远端启动使用的 shell
  环境」）。
- **绑定与访问**：dsh 在 WSL 内绑 `127.0.0.1`（与 SSH 相同；`dsh web` 明确拒绝 `--host
  0.0.0.0`），**不开任何隧道**，Windows 侧经 WSL2 的 localhost 转发访问
  `http://127.0.0.1:<端口>/`；健康检查探活失败时若 WSL 内该端口仍在监听，错误文案会指出
  `localhostForwarding`（`.wslconfig`）可能需要开启或 `wsl --shutdown` 后重试。
- **端口从默认 3080 起、占用则向上递增**：候选端口必须**同时**在 WSL 内（`ss -ltn`，缺失时
  `netstat -ltn`）与 Windows 本机 `127.0.0.1`（试绑）空闲，最多扫描 20 个；WSL 内两种工具都
  没有时按空闲处理并记一条提示，由启动结果兜底。SSH 连接仍沿用 `port: 0` 让远端自选端口，
  不受影响。
- **区分「端口被占用」与「harness 本身启动失败」**：选中端口启动后若 pane 立刻退出/会话消失，
  按日志尾部是否出现 `EADDRINUSE` / `address already in use` 分类——是则换下一个端口重试
  （最多 10 次），否则立即报「WSL 内 dsh 启动失败（**不是端口占用**）」并回显 WSL 内日志尾部；
  tmux 缺失、工作目录不可进入、会话消失各有专门文案。启动命令里**写死了 `--port`** 时递增不会
  改变实际绑定端口：扫描从该端口起，若它被占用则在启动前直接失败并给出「去掉 `--port` 或先
  结束占用进程」的可操作提示。
- **共享会话**：WSL 用同一个 `dsh-gui` tmux 会话与 `$HOME/.dsh-gui-remote.{log,token}`；ALIVE
  时直接复用（先探活，不健康才重启）。关闭标签 / 退出应用只结束本地 `wsl.exe` 与隧道，
  **不发任何 WSL 内停止命令**，后端继续在 tmux 里运行、下次复用。
- **账号**：`account` 传给 `wsl.exe -u`；留空用发行版默认用户。注意 tmux 会话按用户隔离，
  同一发行版的不同账号各有自己的 `dsh-gui` 后端与端口。
- **前提**：Windows 已安装 WSL2 与目标发行版，发行版内有 `node`/`npm`（dsh 的运行前提）与
  `tmux`（复用会话的前提），并且 WSL2 的 localhost 转发可用（默认开启）。
- **日志**：WSL 内 `$HOME/.dsh-gui-remote.log`（与 SSH 共享），失败时错误文案回显其尾部；
  token 以 `umask 077` 落在 `$HOME/.dsh-gui-remote.token`，连接日志与 `/connections` 响应中
  一律显示为 `token=***`。

WSL 主机列表来自 `wsl.exe -l -v`（`{ name, state?, version?, default? }`）；没有 WSL 的机器
上该组为空，不影响 SSH 主机列表与已保存连接（两个列表各自独立失败）。

## 远程主机标签（ds-harness-remote）

`+` 面板新增第四组「远程主机」，把 [`ds-harness-remote`](https://github.com/liguobao/ds-harness-remote)
的主机与工作区打开为**独立 tab**：每个已保存的 `remote` 连接各起一个本地
`dsh web` 子后端，子后端的 gateway 在页面加载前整体切到目标主机/工作区，tab 的
`<webview>` 只加载子后端的回环 URL。`ds-harness-remote` 本体、P2P 协议与远端主机
都不改动。

- **为什么不是纯前端**：ds-harness-remote 的远程目标是**每个本地 dsh 进程一份**的
  `gatewaySwitch` 单例；官方所有浏览器 tab 共享同一个 `browserPeer`，gateway 调用
  没有 tab 标识。要在同一界面里同时看多个主机，必须每个 tab 有自己的后端进程。
- **子后端**：`<DSH_HOME>/gui/remote-tabs/<safe connection id>/home/` 是独立
  `DSH_HOME`；`profiles/remote-tab/` 是生成的子 profile：`node_modules` 复用父
  profile，`dsh.profile.bundles` 与父 `cordis.patch.yml` **原样复制**（没有白名单/
  排除清单），provider 只追加自己的 bundle/patch。子进程通过生成的 ESM loader 把
  `@deepseek-ai/*` 先解析到**宿主 runtime**、再 fallback 到父 profile，使核心包与
  宿主共享实例，profile-only 插件包也能加载；app-boot 仍会跳过 `link:` 类 bundle
  （更新、桌面壳、opencode/mcp 等），这是运行时行为而不是插件自身的清单。
- **身份**：provider（当前为 ds-harness-remote）负责把每个已保存连接 mint 成一个
  **owned client 设备**：由本机已授权的 Remote Host 通过服务器 `register-owned-role`
  自动注册（host → client 允许；client → client 会 409），不需要交互登录，也不会与
  父端客户端互相 `CONNECTION_REPLACED`。关闭 tab 只停进程、保留身份；删除连接才
  revoke 并删除 child home。没有 provider 时 remote-tab 功能报不可用，SSH/WSL 不受影响。
- **启动**：service 层从宿主解析 parent profile（`argv[3]`、`DSH_PROFILE_DIR`、
  `$DSH_HOME/profiles/<DSH_PROFILE|web>`），子运行时优先选**真实 dsh 运行时**：
  `DSH_REMOTE_TAB_RUNTIME` → `<runtimeRoot>/.harness` → 源码构建 → 父 runtimeDir（真实
  目录）→ 父 runtimeDir（asar 兜底）。子 Node 优先真实 Node：`DSH_REMOTE_TAB_NODE` →
  非 Electron 的 `npm_node_execpath` → PATH 上的 `node` → 运行时自带 Node → Electron
  兜底（asar + Electron 组合会直接给出可操作错误，不再让 loader 挂住）。子 CLI 与
  loader anchor 用选中的 runtime；子 home 生成 `remote-tab-loader.mjs`；spawn 参数为
  `[--expose-internals?] --experimental-loader <loader> <cli> --profile remote-tab
  --host 127.0.0.1 --port 0 --no-open`，环境擦掉父端 `DSH_PROFILE*`/session 键并注入
  独立 `DSH_HOME` 与 provider 的目标变量。
- **就绪**：stdout 同时出现 `dsh web: http://127.0.0.1:<port>/?token=…` 与
  `[remote-tab-boot] ready <deviceId> <workspacePath>` 才算成功（90 s 超时）；日志
  token 一律脱敏。bootstrap 在子进程里调用
  `dshRemoteClient.openRemoteWorkspace(deviceId, path)`，失败时子进程保留日志、父端
  tab 显示错误，`⟳` 可重试。

**前提**：desktop 应用（Electron）或任何能提供 provider 的 dsh 宿主；ds-harness-remote
已登录并启用「允许控制本机」（host 授权用于 mint client 设备）；`dsh-remote-tab-boot`
已安装在当前 profile（`node plugins/remote-tab-boot/install.mjs` 或
`npm run build:desktop -- --plugins-only`，安装前退出桌面应用）。子进程需要一个真实的
dsh 运行时（默认 `<runtimeRoot>/.harness` 或源码构建）和一个真实 Node；只有 asar 运行时
+ Electron 时无法可靠加载 loader，会给出明确错误，可用 `DSH_REMOTE_TAB_RUNTIME` /
`DSH_REMOTE_TAB_NODE` 指定。安装/重启后生效。

**配置**：`<DSH_HOME>/gui/desktop-tabs.json` 的连接条目：

```json
{
  "id": "remote-<hash>",
  "title": "Desktop-ZgblKylin · /srv/app",
  "type": "remote",
  "remote": {
    "targetDeviceId": "…",
    "targetName": "Desktop-ZgblKylin",
    "workspacePath": "/srv/app",
    "backend": "harness"
  }
}
```

URL/token 只在运行时内存里，不落盘。

**路由**（除现有 `/desktop-tabs/api/*` 外）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/desktop-tabs/api/remote-hosts` | ds-harness-remote 的在线主机列表 |
| GET | `/desktop-tabs/api/remote-workspaces?targetDeviceId=<id>` | 该主机的 harness 工作区；父端处于 remote 模式时拒绝 |
| POST | `/desktop-tabs/api/connections/<id>/forget` | 停子后端 + revoke 子设备 + 删 child home（删除连接用） |

**集成限制**：

- 仅桌面应用（Electron）有标签条；Tauri 壳不渲染远程主机组。
- v1 只支持 `harness` 工作区；Codex/Cursor/ACP 目录在 host 路由被过滤。
- 父端 `ds-harness-remote` 处于 remote 模式时不做工作区实时发现（同身份第二次
  control 连接会顶掉现有连接）；已保存连接仍可直接打开。
- 一个已保存连接一个子进程；同一主机不同工作区请保存多条连接（各自独立 client
  设备）。子后端有自己的本地 settings（父 `cordis.patch.yml` 与 provider 声明的
  homeFiles 在首次生成时复制）；远端设置仍由远端提供。
- 子页面是 guest webview，没有 desktop 壳的 preload；依赖 `window.dshDesktop` 的
  客户端插件（例如 better-sidebar 的 desktop preset）可能只渲染 Web fallback。
- app-boot 在子 profile 中会跳过一些 `link:` bundle（更新、desktop-tabs、dsh-remote、
  opencode/mcp 等）；这是 app-boot 的解析行为，不是插件的 bundle 清单。
- 子后端成本：每个打开的 tab 一个 Node 进程；关闭 tab 才释放。设备会出现在账号
  设备列表，删除连接时回收；远端 Host 的 trusted-peers 上限 256，避免无限创建连接。
- 当前 provider 是 ds-harness-remote 0.6.3；通用 core 不直接依赖它，provider 缺失时
  远程标签功能报不可用，SSH/WSL 与其余界面不受影响。provider 依赖 ds-harness-remote
  的公开/非 `#private` 运行时字段（`dshRemoteClient.server`、`.identities`、
  `dshRemote.serverApi`）、CLI 输出与 profile 配置语义；升级该包或 dsh 运行时后需要回归。

## 远端启动使用的 shell 环境

远端启动命令在 `dsh-gui` tmux 面板里经 `bash -l -i -c`（登录 + 交互）执行，与
`plugins/remote/dsh-remote` 的 tmux 启动同款，不是 `ssh <host> <command>` 的默认非登录
非交互 shell。原因是远端常把 Node/npm 装在 nvm 之类的版本管理器下，而它们的 PATH 只由
交互式 `~/.bashrc` 注入；被守卫的 rc（`case $- in *i*) ;; *) return;; esac`）在非交互
shell 里直接返回，于是启动会退回系统 Node。系统 Node 过旧时这种失败是**静默**的：dsh CLI
入口写作 `if (import.meta.main) await runCli()`，Node 20 上 `import.meta.main` 为
`undefined`，进程不打印任何内容并以 0 退出，表现为「远端进程已启动」但永远等不到启动 URL。

面板输出重定向到 `$HOME/.dsh-gui-remote.log`；日志首行回显本次启动实际使用的 Node 版本
（`node -v`），用来直接确认用的是哪套运行时。

## 构建与安装

```powershell
npm run build                             # 装进 <runtime-root>/.dsh/profiles/web（Tauri 壳使用）
npm run build:desktop -- --plugins-only   # 装进 <runtime-root>/.dsh/profiles/desktop（desktop 壳使用）
```

两个 profile 都安装本插件（`install.mjs` 不再按 profile 短路）：`web` profile 里只有 host 半
生效，`desktop` profile 里 browser 半额外挂载标签条。Tauri 壳构建时还会把
`src/client/ui/connection-list.js` 与 `src/client/ui/connection-settings.js` 原样复制到
`src-tauri/ui/`（生成物，`.gitignore` 排除），让该壳的 SSH 页复用同一份控件。

包内直接构建：`pnpm install && pnpm run build`（产出 `lib/index.js` 与 `lib/client.js`）。

行为测试直接以 Node 运行 `tests/` 下的脚本（`pnpm run test` 依次执行）：`remote.test.mjs`
（host 半的会话脚本与路由）、`wsl.test.mjs`（WSL 传输层：输出解码、发行版列表解析、端口探测
脚本、启动失败分类、错误码诊断、脚本通道清洗）、`panel.spec.ts`（双壳共用控件：`+` 面板三组、
连接方式前缀、WSL 主机行、搜索筛选与折叠、行内编辑/删除、配置面板账号字段与 draft、预设与
确认取消、失败文案在面板内可见）、`view-retention.spec.ts`（切换保留、刷新卸载、租约与轮询
释放、窗口标题跟随活跃标签与恢复）、`window-title.spec.ts`（窗口标题状态机：采样、接管期间
写回、远程切换不重采样、恢复与 dispose）、`clipboard-relay.spec.ts`、`notify-relay.spec.ts`
与 `image-menu.spec.ts`（远端图片右键菜单：取图脚本、菜单定位与关闭、复制、失败文案、视图层
`context-menu` 接线）。
