# desktop 多 host 标签页原型验证

本文件记录 `plugins/desktop-tabs/` 原型的实现与验证过程，Lead 持有。上游分析见 [2026-10-02-desktop-plugin-injection.md](2026-10-02-desktop-plugin-injection.md)。

## 已确认的设计决定

1. **标签控件放标题栏带内、锚在菜单右侧**：Windows 的标题栏是「40px 预留带 + 各自定位的占用者」，没有可插入的布局容器；菜单 host 带 `data-windows-menu` 属性、可由 `getBoundingClientRect()` 取右边界，`--dsh-windows-menu-start` 给出左偏移，`--dsh-windows-titlebar-height` 给出带高。
2. **每个远端标签一个 `<webview>`**，经 `dshDesktop.browser.acquire()` 的租约通道创建（上游 `ui-sidebar-browser` 是同一通道的先例）。
3. **切换即卸载前端**：切走销毁 webview，切回重新创建并导航。dsh 前后端分离，后端会话与轮次不受影响；好处是内存不随标签数增长，也绕开隐藏 guest 被节流的问题。代价是每次切回一次前端 boot，且该标签的客户端视图状态（滚动、草稿）丢失。
4. **token URL 沿用 dsh-remote 的约定**：远端把裸 token 写进 `$HOME/.dsh-gui-remote.token`，读回后拼 `http://127.0.0.1:<port>/?token=<t>`（[dsh-remote/src/index.ts:883](../../plugins/remote/dsh-remote/src/index.ts)）。
5. **本机是默认视图**：本机 host 不能作为 guest（guest 白名单禁止指向本机 Host authority），所以本机永远是主文档本身，远端标签覆盖其内容区；切回本机 = 隐藏 webview 层，不重载。

## 验证目标（原型必须回答）

| # | 问题 | 判据 |
|---|---|---|
| V1 | 标签条能否落在标题栏菜单右侧并对齐 | 截图/几何：标签条 `left` 等于菜单 host 右边界，纵向在标题栏带内 |
| V2 | webview 租约通道在插件（而非 shell 代码）里可用 | 标签激活后 webview `getWebContentsId()` 可用且页面加载成功 |
| V3 | **切走销毁、切回重建后是否免重新认证** | 重建后导航同一 URL，是否直接进入已登录界面（同 partition 复用）或落回 401/303 |
| V4 | 单次切换的 boot 时间 | 从点击标签到页面可见的秒数 |
| V5 | 卸载期间后端不受影响、重连后能接上 | 切走时有进行中的流式轮次，切回后历史与进行中的输出完整 |
| V6 | 内存不随标签数线性增长 | 多标签反复切换后进程数与工作集不持续增长 |
| V7 | 本机视图不受影响 | 切回本机后原生 UI 可交互，宿主 conversation 面板未被卸载 |

## 原型范围（最小闭环）

- `plugins/desktop-tabs/`：wrapper `install.mjs` + 包（host 半 + client 半 + `dsh.bundle.patch`），按仓库插件约定编写，能被 `npm run build:desktop -- --plugins-only` 装进 desktop profile。
- host 半：读 tab 目标配置（`<DSH_HOME>/gui/desktop-tabs.json`，字段 `{id,title,url}` 或 `{id,title,port,tokenFile}`），并把列表交给 client 半。
- client 半：标题栏菜单右侧的标签条；每个远端标签按需创建 webview、切走销毁；本机标签隐藏 webview 层。
- 验证用的"第二个 host"：另起一个本地 dsh web（独立 `DSH_HOME` 与端口），取其 `dsh web: http://127.0.0.1:<port>/?token=...` 写进配置。

## 分工

| 任务 | 归属 | 产出 |
|---|---|---|
| 实现原型插件 | `tabs-plugin-dev` | `plugins/desktop-tabs/`、`.work/desktop-tabs/01-plugin.md` |
| 独立验证 V1–V7 | `tabs-verifier` | `.work/desktop-tabs/02-verification.md` |

## 进度日志

- 2026-10-03 Lead：设计敲定（标题栏锚定 + 卸载式切换 + token 文件约定），落地本规划并派发实现与验证。

## 结论

原型在隔离的 desktop 实例里跑通，**V1–V7 全部通过**，验收报告见 `.work/desktop-tabs/02-verification.md`。

| # | 结论 | 关键实测 |
|---|---|---|
| V1 | 标签条能锚在菜单右侧、落在 40px 标题栏带内 | 标签条左边界 146 == 菜单 host 右边界 146，纵向 y∈[0,40] |
| V2 | 插件侧可用 webview 租约通道加载另一个 host | guest 完整加载远端界面（截图证据） |
| V3 | 切走销毁、切回重建后**免重新认证** | 重建后 partition 完全同一（仅 lease name 变）；导航**不含 token**的裸地址仍进已登录界面且无新 Set-Cookie；裸 HTTP 对照为 401 |
| V4 | 重建耗时中位约 0.9 s（0.86–1.08 s）；首次冷启动十余秒 | 点击到页面可见 |
| V5 | 卸载期间后端继续跑，切回后输出完整 | 本地 stub LLM 产出 25 个 chunk：+8.9 s 切走（已出 3 个），+23.9 s 切回时 transcript 含全部 25 个与完成行 |
| V6 | 内存不随切换次数增长 | 本机 5 进程约 733 MB、远端 6 进程约 930–946 MB，8 轮切换无增长 |
| V7 | 本机视图不受影响 | 切回后 `#root`/侧栏/composer 为同一 DOM 节点、innerHTML 未变、输入可用 |

三点值得单独记下：

1. **V3 的语义要精确**：partition 在销毁/重建之间被复用，所以 cookie 仍在、免认证成立；但 URL 里的 token 本身可重复使用，每次重建仍会走一次 303 刷新 cookie。若要省掉这次往返，插件可以按 lease/partition 记住「已认证」，重建时直接导航 origin。
2. **V5 是这套设计成立的前提**，现已实证：客户端消失期间后端继续产出，重连后从会话日志完整重建。
3. **本机不能作为 guest**（guest 白名单禁止本机 Host authority），因此本机永远是主文档本身，形态是「本机视图 + 远端标签」。

## 环境约束（复现与落地时必须知道）

- desktop 外壳把 Host 端口**硬编码为 19387**，因此桌面应用无法双实例共存；隔离验证靠 profile 的 `cordis.patch.yml` 覆盖 `webserver.config.port` 才跑起来（该覆盖能赢过命令行硬编码端口）。
- 继承 `ELECTRON_RUN_AS_NODE=1` 会让 `DeepSeek Harness.exe` 退化成 node 解释器（退出码 9）；以宿主身份启动前必须清空该变量。
- `--dsh-windows-menu-start` 在实测中为空，锚点只能取 `[data-windows-menu]` 的 `getBoundingClientRect()`（原型即按此实现）。
- 全新的 `--user-data-dir` 首次启动要先过引导窗口，隔离验证要预留这一步的时间。

## 远程连接链路（2026-10-03 Lead 手工验证，作为实现依据）

目标机：WSL，`ssh WSL`（`127.0.0.1`，用户 `chongfei`，密钥登录已配）；远端 dsh-gui 位于 `~/dsh-gui-home`，CLI 在 `~/dsh-gui-home/.harness/node_modules/@deepseek-ai/dsh/lib/bin.js`，node v25.7.0。

已验证的完整链路：

1. 远端启动：`DSH_HOME=$HOME/dsh-gui-home/.dsh nohup node .harness/node_modules/@deepseek-ai/dsh/lib/bin.js web --port <remotePort> --no-open > /tmp/dsh-web.log 2>&1 &`，从日志取 `dsh web: http://127.0.0.1:<remotePort>/?token=<t>`。
2. 本地隧道：`ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L <localPort>:127.0.0.1:<remotePort> WSL`。
3. 标签 URL：`http://127.0.0.1:<localPort>/?token=<t>`。

实测：远端本机 `无 token=401 / 带 token=303`；经隧道后同样 `无 token=401`、`带 token=303 + Set-Cookie`，cookie 名由 authority 哈希得到（`dsh-auth-<hash>`，`SameSite=Strict`，30 天）。

两个必须处理的坑：

- **本地端口必须确认真空闲**：本机 20001 被 `Ingress`（pid 24924）占用，`ssh -L` 静默失败后请求打到那个服务的 HTTP 页（`Server: wz simple httpd`，正文「找不到网关」），表现为「隧道像通了但内容不对」。实现要先探测空闲端口，并用 `ExitOnForwardFailure=yes` 让绑定失败立刻暴露。
- 远端进程要在 SSH 会话结束后存活（`nohup` + `&`），并在关闭标签时按记录的远端 PID 回收。

## 远程连接与凭据：调研结论与决定（task-9）

现状（详见 `.work/desktop-tabs/03-remote-store.md`）：

- 非敏感连接记录存在**外壳页面的 localStorage**（`tauri.localhost` 源，键 `dsh.remote.saved.v1`），字段形如 `{name,type,port,sshHost?,sshUser?,sshPort?,workdir?,startCommand?,saveAuth?}`；本机当前**没有**记录。
- 凭据存在 `<DSH_HOME>\gui\credentials\<user>+dsh-gui+<名>.bin`（DPAPI/gpg）；本机无该目录。远端 token 仍是远端 `$HOME/.dsh-gui-remote.token`。
- **凭据对同源插件是可读的**：client 插件在 harness 同源页里 `fetch('/remote-api/creds.read', {name})` 即可取回明文口令/密钥路径（`trusted()` 只校验 Origin/Sec-Fetch-Site）。这不是绕过沙箱（插件本就同进程可信，该路由自称未认证本机 RPC），但不符合最小权限预期；DPAPI 只防其他用户与离线副本，同用户进程可解密。

**决定**：desktop-tabs **不读凭据**，也不调用 `creds.read`/`creds.has`。

- 导入面收窄为「SSH 目标」：host 半解析 `~/.ssh/config` 暴露 `GET /desktop-tabs/api/ssh-hosts`，`+` 面板列出别名，点选即建 `{ id, title: alias, ssh: { host: alias } }` 标签。
- 认证完全交给 `ssh` 自身（config + ssh-agent + 默认密钥），与本机 `ssh WSL` 免密同一条路；需要口令时由用户在外壳的连接管理里配置，插件不碰。
- 外壳 localStorage 里的已存连接**不作数据源**：它在 `tauri.localhost` 源，插件跨源读不到，且本机为空。
- 用户已确认（2026-10-03）：**界面里不放密码/密钥输入框**，认证固定走 `~/.ssh/config`（含其 `IdentityFile`）与 ssh-agent。插件源码中 `password`/`secret`/`keyFile` 等字样仅出现在说明注释里，无任何凭据输入或读取；`+` 面板只有「地址（粘贴带 token 的 URL）」「已配置标签」「SSH 主机（来自 `~/.ssh/config`）」三组。

## A + B + C 验收结果（task-10 / task-13）

在隔离 desktop 实例 + **真实 WSL 远程**下端到端验收，结论见 `.work/desktop-tabs/06-integration-verification.md` 与 `09-fix-verification.md`。

| 项 | 结果 | 关键证据 |
|---|---|---|
| A1 `+` 入口 | 通过 | `+` 是标签条末元素；面板三组齐全；SSH 主机列表解析出 52 个条目（含 `WSL`） |
| A2 持久化 | 通过 | 粘贴 URL 新增标签，**重启后仍在** |
| A3 关闭 | 通过 | `×` 仅远端标签有；关闭后配置同步移除 |
| B 凭据边界 | 通过 | 全过程仅 7 个请求，全部 `/desktop-tabs/api/*`；零 `/remote-api/*`、零凭据读取；DOM 无口令输入 |
| C1 远端界面 | 通过（含修复后复验） | 标签内是 **WSL 的 host**：guest 会话/工作区与本机不同、远端 `sessions` 空、`__DSH_BOOT__` 为 WSL profile 的 76 项且不含本插件、隧道 `-L …:WSL` + 远端 `bin.js web` |
| C2 回收 | 通过 | 关闭后隧道进程消失、本地端口 1→0 且可重绑、远端 `pgrep` 有→空、临时日志删除 |
| C3 错误路径 | 通过 | 不存在主机 1.5 s 内给出可读错误、不崩溃 |
| C4 隔离 | 通过 | 真实会话（3080）与真实 `.dsh` 全程未被触碰 |

验收中发现并已修复两个缺陷（均经定向复验确认）：

1. **SSH 标签首次点击必失败**：客户端「先连接、后持久化」竞态——`activate` 立即 `POST /connections/<id>/up`，而宿主半此时从 `desktop-tabs.json` 还读不到该 id 的 `ssh` 描述符。修复：`await putTabs(tabs)` 提到 `guard(activate(...))` 之前（`src/client/tabs.ts`），并用打桩负向对照锁定该顺序。
2. **Windows 上 ssh 错误文案乱码**：根因不是「GBK 被按 UTF-8 解码」（`ssh.exe` 的 stderr 全是 ASCII），而是 Win32-OpenSSH 把本地化消息渲染成 `\ooo` 八进制转义。修复：win32 先把连续 `\ooo` 折叠回字节再用 `TextDecoder('gbk')` 还原、失败降级为替换字节（`src/remote/ssh.ts`）。修复后同一错误路径输出 `不知道这样的主机。`。

首点成功率修复后实测：第一次点击 `WSL` 即成功，7.9 s 就绪，全程无错误标记。

## 遗留

- 断线重连未实现（隧道意外断开后需重新点选标签触发 `up`）。
- 插件无自动化测试、未打包发布；每次重建多走一次 303 可优化。
- 卸载式切换的代价是每次切回一次前端 boot（约 0.9 s），以及该标签的客户端视图状态（滚动、草稿）丢失。
- 未验证：两个远端标签之间的 cookie 隔离、应用重启后 partition 的持久性、macOS/Linux 外壳上的表现；V5 用的是本地 stub 模型，未接真实模型凭据。

## 交互补齐（2026-10-04，用户实机反馈）

实机试用后提出的五条，目标是对齐 dsh-remote 的完整度：

1. **列表被压扁（已修）**：`+` 面板的「SSH 主机」列表在 52 条时每行被压到约 3px 且没有滚动条。根因是列表容器 `display:flex; max-height:180px` 而行按钮默认 `flex-shrink:1`，超出部分被压缩而非溢出。修复：行 `flex: 0 0 auto; min-height: 26px`，容器保留 `overflow:auto` 并加 `overscroll-behavior: contain`，面板加 `max-height` 兜底。实测行高 26px、`scrollHeight 1454 / clientHeight 180`、滚轮后 `scrollTop 140`；恢复可收缩的负向对照复现 1.5px。
2. **搜索筛选取代地址输入**：不再支持粘贴 token URL；输入框改为对「已配置」与「SSH 主机」两组做模糊筛选，逐字符刷新。
3. **分组可折叠**：两组标题可点击折叠，左侧显示展开状态符号；为后续 docker / wsl 分组预留同构结构。
4. **已配置行 hover 操作**：悬停时行尾出现「编辑」与「×」；编辑打开启动参数面板，× 删除该连接。
5. **配置面板 + 启动参数**：点击 SSH 主机或「编辑」时在右侧弹出面板，配置**工作路径**与**启动命令**；启动命令带 `▾` 预设菜单，内置两个预设（`npm '@deepseek-ai/dsh' web`、`npm run harness`），语义与 `src-tauri/ui/app.js:570-620`、`dsh-remote/src/index.ts:84-89,1770-1782` 一致（补齐 `--host 127.0.0.1` / `--port`，`npm run` 形态插 `--`）。
6. **连接期间显示空白页与日志**：点击远程标签后立即切到空白占位页并显示连接日志（对齐 dsh-remote 的「连接日志」），不再停留在上一个标签的内容；日志由 host 半按连接维护并随 `GET /desktop-tabs/api/connections` 返回。

数据结构随之调整：`desktop-tabs.json` 增加 `connections`（**已保存连接**，关标签不删除），条目含 `type`（当前仅 `ssh`，为 docker/wsl 预留）、`ssh.host`、可选 `workdir`、可选 `startCommand`；连接/标签条目上的 `workdir`、`startCommand` 为平铺字段。

### 验收结果（task-17 / task-19）

| 项 | 结果 | 关键实测 |
|---|---|---|
| 搜索筛选 | 通过 | 逐字符刷新：SSH 主机 52→45→14→9→8（`o`/`or`/`ori`/`orin`），已配置 2→1，清空恢复，标题带 `已显示/总数` |
| 分组折叠 | 通过 | 标题点击 `▾↔▸`、列表 `display:none`、计数不变 |
| 配置面板与启动参数 | 通过 | 两条预设且当前值带 `✓`；`workdir=~/dsh-gui-home/dsh-gui` + `npm run harness` 后 6.1 s 连上；远端证据 `CWD=/home/chongfei/dsh-gui-home/dsh-gui`、`CMD=node scripts/harness.mjs --host 127.0.0.1 --port 0`（`--` 分隔符生效） |
| 连接中空白页 + 日志 | 通过 | 确认后 **375 ms** 即切空白占位页（`webviews=0`），重连场景 900 ms 时旧 guest 已销毁；日志逐行增长至就绪（6.1 s），末行 `连接就绪：…?token=***`，**无明文 token**；失败路径 1.5 s 给出可读错误并保留日志 |
| 回归 | 通过 | up/down、关闭后隧道与远端进程回收、重启后 `tabs`/`connections` 各自正确 |

验收中发现并修复一个**阻塞级缺陷**：点击「已配置」行的 `×`（以及点该行打开一个不存在的主机）会让 **desktop 应用整体退出**（3/3 复现：shell 目标立即关闭、Host 随之消失、约 8.8 s 后 exit 0）。根因是 `src/client/panel.ts` 中包裹这两个动作的 `run()` 与 `onEscape` 调用了**未限定的 `close()`**——关闭按钮改名 `closeButton` 后，该标识符解析到了全局 `window.close`，于是关掉了外壳主窗口（Electron 无窗口即正常退出，故 exit 0）。修复：改回 `closePanel()`，并清理同类命名隐患（`config-panel.ts`、`tabs.ts`）。修复后用负向对照断言锁死（把调用改回未限定 `close()` 时断言立即翻转），并在隔离实例复验：点 `×` 后 +7/+12/+17/+22/+27/+32 s 全部存活、配置正确删除、Host 与 CDP 端口仍在。

### 细节修复（task-20 / task-21，真实外壳验证）

| 问题 | 修复 | 实测 |
|---|---|---|
| 标签文本与 `×` 是两个按钮、各自 hover，观感割裂 | 激活/hover 背景移到外层容器，内部文本与 `✕` 恒透明（`✕` 仅自身 hover 改色） | 容器 `rgba(255,255,255,.08)`（激活与悬停同值），文本与 `✕` 均 `rgba(0,0,0,0)` |
| 连接中日志悬浮在上一页面之上、无法阅读 | 占位层 `fixed` + `--dsw-alias-bg-base` 覆盖标题栏以下整屏，日志区自带背景与内边距 | 层 `rgb(21,21,23)`、`rect=[0,40,1280,782]`，三个采样点 `elementFromPoint` 均命中层内 |
| 点面板外 / 确认后不自动隐藏 | document 捕获 `pointerdown` + `Esc` 关闭两个面板；配置面板确认成功后关闭主面板 | 外部点击、`Esc`、确认三种情况均 `{panel:true,config:true} → {false,false}` |
| 行操作用文字「编辑」，与 `×` 图标风格不一致 | 改为 `✎`（编辑）/`✕`（删除）字形，中文 `title` 与 `aria-label` | `✎`/`✕` 背景透明 22×22；点 `✎` 打开配置面板且不触发行打开 |

### 两个环境性发现（均已处理）

1. **`npm run harness` 预设把远端端口固定在 3080**：`scripts/harness.mjs` 不把 `--port 0` 当临时端口，因此远端已有实例占用 3080 时新连接会 `EADDRINUSE`。已在 `up` 的失败文案里附带提示（默认启动命令走 `--port 0`，或先结束旧实例）；要多连接并存时用默认启动命令。
2. **远端进程会成孤儿**（已实现回收，见下）：实测 WSL 残留过 `bin.js web --port 3080`（用户环境）与两个 `--port 0`（Lead 强退自验时留下），都来自应用被直接关闭而未走 `down`。

### 孤儿回收（task-24，Lead 实现 + 自测）

`remote-conn-dev` 连续两轮因传输失败未产出，由 Lead 直接实现：

- 新增 `src/remote/records.ts`：`<DSH_HOME>/gui/desktop-tabs-remote.json` 原子读写，按连接 id 记 `{host,pid,pgid,at}`；文件损坏/类型不对降级为无记录，写失败不影响连接。
- 新增 `src/remote/reap.ts`：远端脚本先判进程组是否存在、再用 `case` 匹配命令行是否属于 `bin.js web`/`harness` 家族，**不匹配就报 `foreign` 并跳过**；注册路由时后台执行一次，回收后删除记录。
- `session.ts`：启动成功写记录；失败路径 `stopRemote` 后删记录；`down()` 删记录；`dispose()` **故意保留**记录（detached 清理失败时由下次启动接手）；`up` 失败含 `EADDRINUSE` 时追加提示。
- `index.ts`：`registerRemoteConnections` 注册后 `void reapStaleRemoteProcesses(...)`。

自测（真实 WSL，见 `.work/desktop-tabs/20-orphan-reap.md`）：①制造孤儿（杀本地隧道后退出）→ 回收报 `killed`、远端进程消失、记录清空；②**负向对照**——用真实存在的 `sleep 300` 进程组写记录 → 报 `foreign`、诱饵存活；③**绝不泛杀**——远端一个未记录的 dsh（`--port 3081`）在回收后仍存活。远程模块 `tsc --strict` exit 0、`npm run test:scripts` 12/12。

### 连接中覆盖修复（task-22，Lead 自验）

用户实机截图显示上一版占位层**没有盖住界面**：侧栏、「新会话」与皮肤壁纸都从日志后面透出来。原因是该层处在应用自身 UI 之下的层叠上下文，且皮肤壁纸画在 `#root` 之外，靠"盖一层"穷尽不了。修复为组合拳：

- `view.ts` 在占位态给 `<html>` 设 `data-dsh-desktop-tabs-cover`，`hide()`/`dispose()` 时移除；
- `styles.ts`：`html[data-dsh-desktop-tabs-cover] #root { visibility: hidden; }`（保住 React 状态）+ 给 `html`/`body` 兜底背景；占位层改为 `inset: 0` 全视口不透明（内容用 padding 避开标题栏带）；层级抬到 `2147483000`（占位层）/ `2147483001`（标签条与两个面板），仅低于外壳强提示层的 `2147483647`；
- 进入占位态前确保上一会话的 guest 已移除。

Lead 自验（隔离实例 + CDP，模拟一个 z-index `2147482999` 的激进壁纸）：

| 阶段 | 结果 |
|---|---|
| 连接中 | `data-…-cover` 存在、`#root` 为 `hidden`、占位层 `[0,0,1280,822]` 且 `z=2147483000`；**侧栏坐标 (100,300)**、内容区 (640,400)、右侧 (1150,600) 三处 `elementFromPoint` 全部命中层内元素 → 壁纸与侧栏均被盖住；日志 2 行并增长 |
| 连接成功 | webview 创建并显示（`webviews=1`）、活动标签 `WSL` |
| 切回本机 | `cover` 标记移除、`#root` 恢复 `visible`、占位层隐藏、三处取样点不再命中层内 → 原生 UI 完整可用 |

过程说明：本轮两名队友（`tabs-plugin-dev` 两次、`tabs-verifier` 一次）都在传输失败中断，其中一次留下"`COVER_ATTR` 已导出但未被使用"的半成品；最终由 Lead 补完层级加固（z-index）并自行完成验收。这也再次印证：**打桩床必须在侧栏坐标取样、并考虑皮肤类插件的层级**，否则漏判。

另：Lead 自验期间因直接结束隔离实例，远端留下两个 `--port 0` 的孤儿 dsh（已清理；用户自己的 `--port 3080` 未动）——是上面第 2 条孤儿问题的又一次实证。

验收中发现并修复一个**阻塞级缺陷**：点击「已配置」行的 `×`（以及点该行打开一个不存在的主机）会让 **desktop 应用整体退出**（3/3 复现：shell 目标立即关闭、Host 随之消失、约 8.8 s 后 exit 0）。根因是 `src/client/panel.ts` 中包裹这两个动作的 `run()` 与 `onEscape` 调用了**未限定的 `close()`**——关闭按钮改名 `closeButton` 后，该标识符解析到了全局 `window.close`，于是关掉了外壳主窗口（Electron 无窗口即正常退出，故 exit 0）。修复：改回 `closePanel()`，并清理同类命名隐患（`config-panel.ts`、`tabs.ts`）。修复后用负向对照断言锁死（把调用改回未限定 `close()` 时断言立即翻转），并在隔离实例复验：点 `×` 后 +7/+12/+17/+22/+27/+32 s 全部存活、配置正确删除、Host 与 CDP 端口仍在。
