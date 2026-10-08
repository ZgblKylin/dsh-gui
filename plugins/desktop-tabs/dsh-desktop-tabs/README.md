# dsh-desktop-tabs

desktop 端多 host 标签页原型：在 Windows 标题栏菜单右侧画一条标签条，每个远端标签按需
创建一个 `dshDesktop.browser` 租约下的 `<webview>`，**切走即销毁、切回重建并重新导航**；
本机标签隐藏 webview 层，露出原生界面。`+` 面板管理**已保存连接**与 `~/.ssh/config` 的
SSH 主机：搜索筛选、分组折叠、悬停编辑/删除、右侧启动参数面板；激活一个需要连接的标签时
**立即**切到该标签的空白占位页并显示连接日志（轮询 `/desktop-tabs/api/connections`），
连接成功后再加载 webview。

本插件是 desktop-shell-only 原型：`install.mjs` 只在 `DSH_PLUGIN_PROFILE=desktop` 时安装，
普通 `web` profile 的组合不会被改动。浏览器半在非 desktop 环境（没有
`window.dshDesktop.browser`）不渲染任何东西，宿主半在普通 `dsh web` 下只注册路由、不产生
可见行为。

## 结构

| 部件 | 文件 | 职责 |
|---|---|---|
| host 半 | `src/index.ts` | 注册 `/desktop-tabs/api/tabs` 的 `GET`/`HEAD`/`PUT`，并在同一 effect 内挂载远程连接路由，把 `{ tabs, connections }` 交给连接管理器 |
| host 半 | `src/targets.ts` | 读写 `<DSH_HOME>/gui/desktop-tabs.json`：解析 `url`、`port` + `tokenFile`、`ssh`，校验并原子替换 `tabs` 与 `connections` 两个列表 |
| host 半 | `src/remote/**` | 远程连接路由与连接管理器（`remote-conn-dev` 负责，本包只调用 `registerRemoteConnections`） |
| client 半 | `src/client/index.ts` | 探测 `window.dshDesktop.browser`（protocol version 1）；缺失则完全惰性 |
| client 半 | `src/client/tabs.ts` | 标签条几何、标签与连接状态、切换与增删改、持久化、连接日志轮询 |
| client 半 | `src/client/panel.ts` | `+` 面板：搜索框、可折叠的「已配置」「SSH 主机」两组、行内编辑/删除 |
| client 半 | `src/client/config-panel.ts` | 右侧启动参数面板：工作路径、启动命令、两个内置预设、确认/取消 |
| client 半 | `src/client/api.ts` | 宿主 API 客户端（读写 `{ tabs, connections }`、连接状态、`up`/`down`、SSH 主机） |
| client 半 | `src/client/types.ts` | client 半共享的 `DesktopTab`、`SavedConnection`、`ConnectionStatus`、`SshHost` |
| client 半 | `src/client/view.ts` | 远端视图层：占位页、状态行、连接日志、租约与 webview 生命周期 |
| client 半 | `src/client/styles.ts` | 自有的 `<style>`（`--dsw-*` token、`no-drag`、`z-index: 1100`/`900`） |

## 配置：`<DSH_HOME>/gui/desktop-tabs.json`

```json
{
  "tabs": [
    { "id": "local", "title": "本机" },
    { "id": "dev", "title": "测试机", "url": "http://127.0.0.1:19999/?token=<t>" },
    { "id": "dev2", "title": "测试机 2", "port": 19999, "tokenFile": "C:/Users/me/.dsh-gui-remote.token" },
    { "id": "ssh-WSL", "title": "WSL", "ssh": { "host": "WSL" } }
  ],
  "connections": [
    { "id": "ssh-WSL", "title": "WSL", "type": "ssh", "ssh": { "host": "WSL" },
      "workdir": "$HOME/dsh", "startCommand": "npm '@deepseek-ai/dsh' web" }
  ]
}
```

- `tabs` 是**当前打开的标签**；`connections` 是**已保存的连接**。关闭标签只移除标签，不删除
  连接，因此「已配置」里的连接可以随时重新打开。
- 连接条目：`id`、`title`、`type`（当前只有 `ssh`，为 docker/wsl 预留）、`ssh`（由
  `src/remote/**` 解释）、可选 `workdir`（缺省表示远端 `$HOME`）、可选 `startCommand`
  （缺省表示远端默认命令）。空字符串视为未设置，不会写回文件。
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

全部路由只在 `webServer.host === '127.0.0.1'` 时注册，并带最小同源栅栏。`PUT` 会校验提交
内容（形如 `{ "tabs": [...] }`、非空且唯一的 `id`、http/https `url`、对象 `ssh`、端口范围、
可选 `workdir`/`startCommand`、最多各 64 项、请求体上限 256 KiB），不合法时返回 400/413 与
`{ error }`，文件保持原样。

宿主半把与 `GET /api/tabs` 相同的 `{ tabs, connections }` 交给 `registerRemoteConnections`
的 `tabs` 回调：连接管理器按 id 取行，`connections` 的字段优先，因此保存的 `workdir` 与
`startCommand` 会被远端启动使用。

## 交互

- 标签行是**一个控件**：外层容器承担整行的 hover/激活背景（`--dsw-alias-interactive-bg-hover`
  等与标题栏菜单一致的 token），内部的文本按钮与 `✕` 都没有自己的背景（`✕` 只在自身 hover 时
  改颜色）。文本按钮保留 `aria-pressed` 与 `aria-label` 语义、`✕` 带 `aria-label`，键盘仍可
  分别聚焦；点文本激活标签，点 `✕` 关闭该标签（`stopPropagation`，不触发激活）。
- 标签条右侧的 `+` 打开面板：**搜索框**对「已配置」与「SSH 主机」两组做大小写不敏感的模糊
  筛选（子序列匹配 `title`、`id`、`ssh.host`，以及主机的 `alias`/`HostName`/`User`），每次输入
  即刷新；无匹配显示空提示。
- 两组标题可点击折叠/展开（`▾`/`▸`，标题带 `已显示/总数`），折叠状态只存在内存。
- 「已配置」行悬停（或键盘聚焦）时在行尾显示两个字形按钮 **`✎`（编辑）** 与 **`✕`（删除）**，
  两者都以中文 `title` 与 `aria-label` 标注：`✎` 打开右侧启动参数面板并预填，`✕` 删除该连接
  （其标签若打开则一并关闭并 `down`）。行本身点击即打开/激活该标签。
- 右侧面板含**工作路径**（占位 `/srv/dsh 或 $HOME/dsh`，留空即远端 `$HOME`）与**启动命令**
  （留空即远端默认命令），`▾` 展开两个内置预设 `npm '@deepseek-ai/dsh' web` 与
  `npm run harness`，命中当前值时显示 `✓`。**确认**保存连接并打开（或先 `down` 再重连）标签，
  **取消**关闭面板。
- 面板会自动隐藏：点击两个面板之外的任何区域（含标签条与应用其它区域）或按 `Esc` 都关闭两个
  面板；配置面板**确认成功**、以及点「已配置」行开始打开连接后，两个面板一并关闭。失败时面板
  保留并显示原因。
- 激活一个 `ssh` 且尚无地址的标签时，视图层**立刻**切到该标签的空白占位页（上一个标签的
  webview 已销毁，不会继续显示）。整层 `position: fixed` + `var(--dsw-alias-bg-base)` 覆盖
  标题栏以下的内容区，底下原生 UI 完全不可见；状态行显示当前步骤，日志区自带背景与内边距，
  按 500 ms 轮询连接日志并自动滚到底部；成功后用 webview 替换占位页，失败时保留日志、在状态
  行与标签上显示失败原因。
- 每次增删改后把两个列表 `PUT` 回宿主半；连接相关的操作都先落盘再发起（`up` 从配置文件读取
  连接设置）。本机标签始终保留且第一位。

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

- 租约通道与 `webviewTag` 是上游内部实现，没有对外契约；desktop 升级可能改变行为。
- 远端标签的 partition 由外壳随机生成且无 `persist:` 前缀：同一标签 id 在**同一次应用
  进程内**重建可复用 cookie（免重复认证），但应用重启后丢失，需要重新建立连接。
- 指向本机 Host 的地址会被外壳拒绝（guest 白名单禁止应用自身的 authority），因此“本机”
  永远是主文档本身，不能做成 guest 标签。
- 只出现在 `tabs` 里、没有对应 `connections` 条目的旧式 `ssh` 标签仍可打开并连接，但不会
  出现在「已配置」组，也没有可编辑的启动参数；`port`/`url` 标签不是连接，不参与该组。
- 不支持保活：切走的标签完全卸载，其滚动位置、草稿等客户端视图状态不保留。
- 本机视图只隐藏 webview 层，不切换宿主 `main` 面板的 key（避免卸载宿主 conversation 面板）。
- 标签条只在 Windows 标题栏（`data-windows-menu` 存在）下出现；macOS/Linux 的 desktop
  外壳不渲染。
- 远端 guest 不带 `data-sidebar-browser-frame` 标记，因此桌面外壳的快捷键转发不会作用到
  远端 guest（普通键盘输入仍由焦点决定）。
- SSH 主机列表只解析 `Host`/`HostName`/`User`/`Port`，不跟随 `Include`，不展开通配符与取反
  模式；`up` 失败后标签保留错误标记，直到下一次成功激活。

## 孤儿进程回收

正常情况下关闭标签会 `down` 掉远端进程组。应用被强退或崩溃时没有代码执行的机会，远端
`dsh web` 会继续占用端口——因此插件把每次启动的远端进程记在
`<DSH_HOME>/gui/desktop-tabs-remote.json`（按连接 id 记 `host`/`pid`/`pgid`/`at`，原子写），
并在**下次启动注册路由时**后台回收：

- 只处理记录里写明的进程组，且远端核对命令行仍属于 `bin.js web` / `harness` 家族才发信号；
- 进程已消失（`absent`）或 pgid 已被复用成别的程序（`foreign`）时**只删记录、不杀进程**；
- 从不会枚举或泛杀 `bin.js web`，用户自己跑着的实例不受影响；
- 记录文件缺失/损坏按「无记录」处理，写失败也不影响连接。

远端启动因端口被占失败（`EADDRINUSE`）时，错误文案会附带提示：默认启动命令会走
`--port 0`，或先结束旧实例（多数情况下上面的回收已经处理）。

## 远端启动使用的 shell 环境

启动脚本经 `bash -l -i -c` 执行（与 `plugins/remote/dsh-remote` 的 `startSession` 同款），
不是 `ssh <host> <command>` 的默认非登录非交互 shell。原因是远端常把 Node/npm 装在
nvm 之类的版本管理器下，而它们的 PATH 只由交互式 `~/.bashrc` 注入；被守卫的 rc
（`case $- in *i*) ;; *) return;; esac`）在非交互 shell 里直接返回，于是启动会退回系统
Node。系统 Node 过旧时这种失败是**静默**的：dsh CLI 入口写作
`if (import.meta.main) await runCli()`，Node 20 上 `import.meta.main` 为 `undefined`，
进程不打印任何内容并以 0 退出，表现为「远端进程已启动」但永远等不到启动 URL。

远端日志的第一行是 `TABS_LAUNCH_RUNTIME=<node 路径> <node 版本>`，用来直接确认这次启动
用的是哪个 Node。

`dispose()` 故意**保留**记录：它的远端清理是 detached 的尽力而为，若没执行成功，下次启动
的回收会接手。

## 构建与安装

```powershell
npm run build:desktop -- --plugins-only   # 装进 <runtime-root>/.dsh/profiles/desktop
```

包内直接构建：`pnpm install && pnpm run build`（产出 `lib/index.js` 与 `lib/client.js`）。
