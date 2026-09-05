# dsh-remote

多后端远程连接插件：在 **dsh-gui（Tauri 桌面壳）的原生标题栏**上提供连接标签页（VSCode 风格）、新建连接对话框与汉堡菜单，支持本机端口后端、（VSCode Remote SSH 模式）远端 SSH 启动 + 端口转发，以及 **Docker 连接**（`docker exec` 启动容器内 dsh 并用 stdio 隧道转发，**无需任何端口映射**）。非侵入：不修改 dsh 框架本体，仅作为 `plugins/remote/dsh-remote/` 插件包挂载到 web profile。**不做任何远端部署**——远端/容器内 dsh 由用户配置的启动命令自行启动。

## 特性

- **原生标题栏标签页**：标签页像 VSCode 一样集成进 Tauri 自绘标题栏（`src-tauri/ui`），每个标签页对应一个已接入的 DSH 后端；标签页带关闭按钮。**不在页面 iframe 内部绘制任何额外标题栏**。
- **加号新建连接**：点击标签栏右侧 `+` 打开新建连接对话框；成功后新建标签页并在其中加载对应前端。
- **汉堡菜单**：复用标题栏既有的 `☰` 菜单，内含标签页切换列表、新建连接、关闭当前连接（另保留 关于 / 退出）。
- **全部关闭自动新建**：关闭所有标签页后自动弹出新建连接对话框。
- **已保存连接管理**：「新建连接」对话框左侧是已保存连接列表（localStorage `dsh.remote.saved.v1`）：每项带 **启动 / 编辑 / 删除**，
  列表末端是「＋ 新建连接」。新建连接成功后自动记入列表；「编辑」把配置填回表单并切到对应配置页，连接按钮变为「保存并连接」；
  「启动」用已存配置直接建立新标签页。标题栏标签页**只保留已建立的连接**，未连接的记录只存在于对话框列表。
- **标签页内容持续有效**：每个已建立连接一个独立子 iframe（`#harness-frame` 容器内），切换标签页只切换显示、**不重载页面**，
  各标签页的会话状态与页面保持。
- **本地连接**：可配置端口（默认 3080 自动填入）。连接时先探测端口是否可加载：可加载则直接加载前端；否则启动内置 dsh（`dsh web --port <端口>`）再加载前端。连接名与端口保存在软件本地存储。
- **远程连接**：可配置地址（不含 `http://` 头）与端口。连接时先探测端口是否可加载：可加载则直接加载；否则通过 **SSH 启动远端 dsh 并转发端口**。连接名、地址、端口保存在软件本地存储。
- **Docker 连接**：填一个**运行中**的容器名/ID 与端口（默认 3090），插件用 `docker exec -d` 在容器内启动 dsh（只绑容器内
  `127.0.0.1`），再用 **`docker exec -i` stdio 隧道**把容器回环端口桥接到本机 `127.0.0.1` 的随机端口——**容器不需要 `-p`
  端口映射**，也不需要 socat / nc / SSH 服务端（将 dsh 即可，node 是 dsh 自身的运行时）。连接名、容器、端口保存在软件本地存储。
- **SSH 连接（启动 + 安全隧道转发，VSCode Remote 风格）**：
  - **传输层为纯 JS `ssh2`**（不再依赖本机 `ssh`/`plink`/`sshpass` 二进制）：密码认证**原生可用**
    （旧实现的密码只能经 `plink -pw` / `sshpass -p` 传入，只有 OpenSSH 的 Windows 机器会静默拒绝填写的密码）。
  - 与 dsh 地址**分离**的 SSH 主机字段（可用 `~/.ssh/config` 的 Host 别名，如 `ASUS`），复用现有 ssh config：
    `~/.ssh/config` 由成熟库 **`ssh-config`** 解析（OpenSSH 精确语义：首值优先、`Host`/`Match` 块、`*`/`?`/`!`
    通配、多 `IdentityFile` 累积、大小写不敏感），别名免密 / 加端口免密照常工作。
  - 密码 / 密钥文件二选一（密钥文件通过文件选择上传），可勾选"保存认证"；**选了密钥文件后又填了密码，该密码会被当作密钥口令
    （passphrase）解锁加密密钥**——同一输入框的两种语义都接通了。
  - 密码与密钥都留空时，若 ssh config 中存在对应 Host，则直接使用该别名尝试免密连接（并可回落到默认密钥 /
    ssh-agent）；需要认证则回退到连接配置，提示补齐用户名/密码/密钥。
  - **主机密钥 accept-new**：首次连接的远端会按 `~/.ssh/known_hosts` 记录；已记录主机密钥变更会拒绝连接（防 MITM）。
  - 连接过程中出现认证需求（`Permission denied` / publickey / password 等）时判定连接失败，回退到连接配置让用户补齐认证。
  - **远端启动命令可配置**：新建连接对话框提供「远端启动 dsh 的命令」输入框，默认 `npx '@deepseek-ai/dsh' web`
    （留空即用默认）。该命令在远端 `$HOME` 下、名为 `dsh-gui` 的 tmux 会话中运行（会话保证进程在 ssh 命令返回后继续存活）；
    若命令本身未含 `--host` / `--port`，插件会追加 `--host 127.0.0.1 --port <端口>`。
  - **远端后端只绑定回环地址**（追加了 `--host 127.0.0.1`），绝不暴露到 LAN；前端通过 **SSH 本地端口转发**（纯 JS `ssh2`
    会话内 `forwardOut`：本机 `127.0.0.1:<本机端口>` → 远端 `127.0.0.1:<远端服务端口>`）经加密会话访问，标签页只看到
    `http://127.0.0.1:<本机端口>/`。
  - **进度实时流式回显**：`ssh.connect` 全程在宿主半端一条往返内执行，插件通过 `ssh.status` 轮询接口把每一步
    （工具预检 / tmux 启动 / 端口等待倒计时 / 隧道 / 前端就绪）实时推回连接对话框，不再"卡在建立连接"看着空白。
  - **失败可诊断**：远端 `dsh-gui` tmux 面板的输出被重定向到 `$HOME/.dsh-gui-remote.log`；端口迟迟不开放或前端超时时，
    对话框会直接回显该日志尾部（即使会话已退出也能看到真实报错）。
  - **浏览器认证适配（dsh v0.1.2-alpha.1+）**：升级到该版本后，Web profile 引入一次性 launch token
    （`packages/client/connection/src/browser-auth.ts`，见 `docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md`）：
    启动时打印 `dsh web: http://127.0.0.1:<port>/?token=<token>`，裸请求一律 **401**、带 token 首访 **303 + Set-Cookie**
    （此后凭 cookie 得 200）。此前 remote 流程只认 2xx，导致隧道建立后仍永远"前端就绪"超时，进而 teardown 杀掉
    本次启动的远端会话（日志尾部出现 `Killed`）。现已修正：连接时自动从远端 `$HOME/.dsh-gui-remote.log` 提取
    launch token，用带 token 的隧道 URL 做就绪探测（**303 / 2xx 即就绪**）并作为标签页 URL 返回（与本地壳层
    `spawn_harness` 的 token 适配一致）；旧版无 token 的 profile 仍按裸 URL 2xx 直连，自动兼容。
  - **启动命令必须是"起 web 服务"的命令**：`npm run harness`（本仓库 `scripts/harness.mjs`）现在会**直接启动 web 服务**
    （固定 `node bin.js web --port <DSH_GUI_PORT|3080> --no-open`，忽略额外 argv；**端口由 `DSH_GUI_PORT` 决定，默认 3080**）。
    插件对 `npm|pnpm|bun run <script>` 命令会自动在附加的 `--host/--port/--no-open` 前插入 ` -- `，因此这类启动命令不会再被
    npm 当成自身配置参数报 `Unknown cli flags`；若端口不是 3080 且使用的是 `npm run harness`，请在环境变量列表加
    `DSH_GUI_PORT=<端口>`，或改用直接命令 `node <repo>/deepseek-harness/apps/cli/lib/bin.js web` / 默认 `npx '@deepseek-ai/dsh' web`。

> **关于"不生成本机监听端口"**：本地端口转发需要一个本机回环监听端点，标签页才能经 `http://127.0.0.1:<port>/` 访问隧道；该端点只绑定 `127.0.0.1`（不对外网及局域网开放），即标准的安全隧道形态。若需要"完全不监听本机端口"，则需在 dsh-gui 内部再包一层代理——当前设计采用前者。

- **Docker 连接（启动 + `docker exec` 隧道转发，无需端口映射）**：
  - **原理**：宿主半端用 `docker exec -d <容器> sh -c '…'` 启动容器内 dsh（自动补 `--host 127.0.0.1 --port <端口>`
    与 **`--no-open`**——无浏览器的容器里 `dsh web` 会自动尝试拉起来并把 HTTP 服务卡住）；随后在
    `127.0.0.1:<本机随机端口>` 起一个 `net.Server`，每次连接 spawn 一个
    `docker exec -i <容器> node -e '<stdio↔TCP 桥>‘`，把流量桥接到容器自身 `127.0.0.1:<端口>`。
  - **容器零改动**：不要求 `-p`、不要求容器重启、不要求容器预装 socat/nc/ssh 服务端；只要求容器
    **有 node/npm/npx**（dsh 的运行前提）且 Docker CLI 能访问目标 daemon（本机 socket / `docker context` /
    `DOCKER_HOST` 均可）。
  - **容器内进程管理**：启动命令写入**容器内 `/tmp/dsh-gui-docker-<端口>.pid`**（实际 dsh 进程 PID）与
    **`/tmp/dsh-gui-docker-<端口>.log`**（启动输出，首行 `node -v`）——用 `/tmp` 以便任意 `-u` 用户可写，
    按端口后缀可让同一容器并存多个后端；连接失败/取消时只清理**本次启动**的 PID 与隧道，已有进程存活则复用。
  - **可用指定用户 / 工作目录 / 环境变量列表**：Docker 表单提供「用户名（容器内，`docker exec -u`）」「工作目录
    （容器内，启动前 `cd` 到该路径，留空用 `$HOME`）」「环境变量列表（每行 `KEY=VALUE`，经 `docker exec -e` 传入，
    值不需要 shell 转义；日志只显示变量条数，不回显值）」。未指定用户名时用容器默认用户；`docker exec -u <用户>`
    会自动把 `HOME` 设为该用户家目录。
  - **进度与认证**：与 SSH 同一条 `docker.status` 实时进度管道；浏览器认证（launch token）同样从容器日志
    提取，`303 / 2xx` 即前端就绪，旧版无 token 的 profile 直接按裸 URL 2xx 兼容。
  - **容器内启动命令可配置**：对话框「容器内启动 dsh 的命令」默认
    `npx -y '@deepseek-ai/dsh' web`，可用环境变量 `DSH_DOCKER_START_COMMAND` 改全局默认；
    也可写 `DSH_HOME=… node /path/to/bin.js web` 直接复用容器内已有 checkout（也可改从环境变量列表里配 `DSH_HOME`）。
    例如用容器内已有 checkout 时配 `npm run harness` 也**可以**（见上文 `--` 分隔符与 `DSH_GUI_PORT` 说明）。
  - **启动失败即刻反馈**：容器内进程若在启动后几秒内退出（如 `npm error Unknown cli flags`、`command not found`、
    工作目录不存在），插件会**立刻**读取 `/tmp/dsh-gui-docker-<端口>.log` 尾部并把真实错误回显到连接日志，
    不再傻等 300s 端口超时。
  - **备选方案（默认不用）**：① Linux 主机 + bridge 网络下可直接访问容器 IP
    （`--host 0.0.0.0` + `http://<容器IP>:<端口>`，但会暴露到 Docker bridge）；② 容器内
    `ssh -R` 反向隧道（需容器有 ssh 客户端 + 主机 sshd）；③ 同用户自定义网络起 nginx/caddy
    sidecar 反代并（可选）只发布 sidecar 端口。上面三种要么暴露面更大、要么多容器/多依赖，
    所以插件默认走 `docker exec` stdio 隧道。

## 架构：谁负责什么

这是一次**架构调整**：连接界面（标签页、新建连接、SSH 认证弹窗）不再作为页面内覆盖层渲染，而是整体迁入 **Tauri 桌面壳原生标题栏**（`src-tauri/ui/`），与标题栏原有控件合并。

```
浏览器 Web 应用（iframe, 127.0.0.1:<port>）── 不渲染任何连接 chrome（插件 client 半端 inert）
        ▲ 加载对应后端的 URL（切换标签页即改 iframe src）
        │
Tauri 壳（src-tauri/ui/*.html/css/js）
  标题栏: ☰ 汉堡菜单 + 标签页条 + ＋ 连接 + 最小化/最大化/关闭
  新建连接对话框: 本地 / 远程(SSH) / Docker 表单
        │  invoke('remote_call', { op, body })   ← Rust 命令
        ▼
Rust（src-tauri/src/main.rs, remote_call）
  白名单校验 op → 本机回环 HTTP POST /remote-api/<op>（无 Origin 头，同源视同）
        ▼
插件 Host 半端（plugins/remote/dsh-remote/src/index.ts, Node ESM）
  /remote-api/*: probe / local.start / ssh.connect / docker.connect / creds.* / keyfile.write / tunnel.close / diag
```

- **插件 client 半端已置为 inert**：它随 web 应用加载但 `apply` 不注册任何槽位/样式，因此内嵌页面始终干净、不再有"太高了"的重复标题栏。
- **所有重活仍在插件 Host 半端**：探测、本机后端启动、SSH 启动与隧道、凭据（Windows DPAPI / Linux gpg）、隧道复用与清理。Tauri 壳只做薄代理（Rust 命令白名单 + 回环 POST），不重复实现。
- 之所以走 Rust 命令而非页面 `fetch('/remote-api')`：壳页面源是 `tauri://`，对 `http://127.0.0.1:<port>` 是跨源，而 `/remote-api` 刻意拒绝跨源请求；Rust 侧裸 TCP 请求不带 `Origin` 头，被视作同源放行。

## 配置归属

- **dsh-gui 管理**：连接配置（连接名、地址/端口、SSH 主机/用户名/端口、Docker 容器/端口/用户名/工作目录/环境变量列表、保存的认证）。
  连接名与地址端口等保存在壳页面（Tauri webview 源）的 localStorage（key `dsh.remote.*`）；凭证在系统密钥库
  （Windows DPAPI / Linux gpg，路径/文件名含 `ZgblKylin+dsh-gui+<连接名>`），密钥文件存于
  `<DSH_HOME>/gui/keys/`。
- **远端管理**：远端后端自身的 dsh 配置与插件配置位于远端默认 DSH_HOME（`~/.dsh`），或由用户配置的启动命令自行设置（如命令内 `DSH_HOME=... npx dsh web`），与本机完全隔离。插件不向远端部署任何代码。
- **容器管理**：Docker 连接不修改容器——不装包、不写镜像、不改端口映射；只通过 `docker exec -d` 启动 dsh 进程并写
  容器内 `/tmp/dsh-gui-docker-<端口>.{log,pid}` 两个文件，进程存活判断与清理均以 PID 文件为准。用户名/工作目录/环境变量列表
  作为连接配置随 localStorage 保存（环境变量值会明文存在本机，包含敏感值请自行斟酌）。

## 结构

```
plugins/remote/            插件 wrapper（install.mjs 归本仓库）
  install.mjs              构建 + 安装 + 挂载本插件（委托 scripts/plugin-install.mjs）
  dsh-remote/              插件包（Host 引擎 + 空 client）
    src/index.ts           Host 半端（Node ESM）：/remote-api 路由 + 本地启动/SSH 启动与隧道/Docker exec 隧道/凭据
    src/client/index.ts    浏览器半端：inert（不再渲染连接 chrome，见"架构"节）
    tsdown.config.ts       tsdown 构建：lib/index.js（Host）+ lib/client.js（Browser module）
    docs/                  本目录（插件文档）

src-tauri/ui/            dsh-gui 桌面壳 UI（标签页 / 新建连接对话框 / 汉堡菜单 / 关于）
  index.html             标题栏结构 + 标签条 + 新建连接对话框 + 空状态视图
  app.js                 标签页状态/切换/关闭 + 连接流程 + remote_call RPC
  titlebar.css           紧凑标签页（VSCode 风格）+ 对话框/表单样式
src-tauri/src/main.rs    新增 `remote_call` Rust 命令（op 白名单 + 回环 HTTP POST 代理）
```

## 构建与安装

```powershell
# 从仓库根目录
npm run install:plugins   # 运行 plugins/ 下每个 wrapper 的 install.mjs
# 或单独运行本 wrapper（内部使用 .toolchain 固定的 pnpm）
node plugins/remote/install.mjs
```

挂载到 web profile（由 install 脚本自动完成，等价于）：

```text
注入 .dsh/profiles/web/package.json   "dsh-remote": "link:<repo>/plugins/remote/dsh-remote"
注入 .dsh/profiles/web/package.json   dsh.profile.bundles: [... "dsh-remote"]
（包内 cordis.patch.yml 是 dsh.bundle.patch，其 insert 行 - id: remote / name: dsh-remote
  作为 bundle 层自行挂载，无需手工改 profile 的 cordis.patch.yml）
```

外壳 UI 与 Rust 命令改动后需重新编译入口 exe：

```powershell
npm run build -- --skip-harness   # cargo release + 复制 dsh-gui.exe + 重建/挂载插件
npm start                          # 启动桌面壳
```

装好后 **重启 dsh-gui** 生效。生效后标签页出现在原生标题栏；嵌入页面（iframe）不显示任何额外 chrome。

## 运维

- 本地后端日志：`<DSH_HOME>/gui/remote-<端口>.log`
- 关闭标签页不强制断隧道（隧道按 `host:remotePort` 复用，重连即用）；dsh-gui 退出或插件 teardown 时所有隧道一并关闭。
- **Docker 连接运维**：
  - 前提：宿主有 Docker CLI 且目标 daemon 可达（本机 socket / `docker context use <name>` / `DOCKER_HOST`），容器处于
    **Running** 状态且内有 `node`/`npm`/`npx`；容器自身无需任何 `-p` 端口映射。
  - 进程日志：容器内 `/tmp/dsh-gui-docker-<端口>.log`；进程 PID：容器内 `/tmp/dsh-gui-docker-<端口>.pid`；启动命令首行回显 `node -v`。
  - 可配置项：**用户名**（`docker exec -u`，留空用容器默认用户）、**工作目录**（启动前 `cd`，留空用容器 `$HOME`）、
    **环境变量列表**（每行 `KEY=VALUE`，`docker exec -e` 传入；日志只显示条数不回显值）。
  - 默认会给启动命令追加 `--host 127.0.0.1 --port <端口> --no-open`（已含则跳过）；容器内无浏览器时
    必须 `--no-open`，否则 dsh web 尝试拉起浏览器可卡住服务。
  - 连接失败/取消只清理本次创建的容器进程与隧道；容器内 dsh 若已存活（PID 文件存在且 `kill -0` 通过）则复用不重启。
  - 手动清理：`docker exec <容器> sh -c 'kill $(cat /tmp/dsh-gui-docker-<端口>.pid)'`（或直接 `pkill -f …`）；重连前最好
    `rm -f /tmp/dsh-gui-docker-<端口>.pid /tmp/dsh-gui-docker-<端口>.log`。
- **ssh2 传输与已知边界**：密码 / 密钥（含口令）通过 `ssh2` 原生认证（`keyboard-interactive` 也自动尝试）；`~/.ssh/config`
  由 **`ssh-config` 库**解析（支持 `Host`/`Match`、`HostName`/`User`/`Port`/`IdentityFile`/`IdentitiesOnly`、`*`/`?`/`!`
  通配与 OpenSSH **首值优先**语义；**`Include` 不展开**、`Match exec` / `CanonicalizeHostName` **不执行**）。
  仍**不支持** `ProxyJump`、证书主机密钥（`@cert-authority`）与哈希式 known_hosts 条目（未匹配时按首次连接接受）；
  Windows 下不读命名管道 ssh-agent（有 `~/.ssh/id_*` 默认密钥即可）。远端 `~/.ssh/config` 由远端 ssh 自行处理，与本机解析互不影响。
- 远端启动命令默认 `npx '@deepseek-ai/dsh' web`；可在对话框「远端启动 dsh 的命令」输入框覆盖单个连接的启动命令，
  也可用环境变量 `DSH_REMOTE_START_COMMAND` 为所有连接改默认值。远端 dsh 配置与插件配置位于远端默认 `~/.dsh`
  （或启动命令设置的 DSH_HOME），与本机完全隔离。启动所需远端工具：`node` / `npm`（含 `npx`）/ `tmux`。
- 连接时若远端 `dsh-gui` tmux 会话已存活则**复用不重启**（幂等）；变更启动命令后需先清理旧会话再连接，
  在远端执行 `tmux kill-session -t dsh-gui` 即可。
- 远端若尚未安装 `@deepseek-ai/dsh`，`npx` 首次拉取会弹安装确认，在 detached tmux 面板里可能等待输入：
  此时把启动命令写成 `npx -y '@deepseek-ai/dsh' web`（或在远端先全局安装 dsh）。
- **启动命令在「完整登录 + 交互」shell 中运行**：tmux 面板命令以 `bash -l -i -c`（登录 + 交互）执行，
  强制 `~/.profile` 与 `~/.bashrc` 完整加载（即使用户的 `.bashrc` 带"非交互即 return"守卫也能过），
  保证只在 rc 里出现的工具/环境变量（如 **nvm 托管的 Node**、自定义 PATH、DSH_HOME）对启动命令可见——
  否则后端会以裸系统 Node 启动，插件树报 `Cannot find package '@deepseek-ai/...'`。面板日志首行会回显
  `node -v`（如 `v24.20.0`），用于确认实际用到的运行时。
- **旧 tmux 环境残留**：`dsh-gui` 的 tmux server/session 一旦创建就固定继承当时的进程环境；若早前以非登录环境起过，
  先清理再重连：远端执行 `tmux kill-server`（或 `tmux kill-session -t dsh-gui`）。
- **取消即清理**：对话框「取消」会走 `ssh.cancel` 中止进行中的连接——停止实时进度轮询，令宿主端尽快退出并**杀掉本次启动的
  远端 `dsh-gui` tmux 会话、关掉本次打开的 SSH 隧道**；连接**失败**时也一样清理（会话不再残留），因此取消/失败后重新打开
  对话框即可干净地重连。仅在本次尝试实际创建的会话/隧道上清理，不会动早前成功建立的连接。
- 安全边界：`/remote-api` 为未认证的本机 RPC，插件会拒绝在非回环绑定（`webServer.host !== 127.0.0.1`）下启动；Tauri 壳的 `remote_call` 只放行白名单 op，并仅向 `127.0.0.1:<port>` 发送请求。
- Linux gpg 凭据使用内置口令（`dsh-remote-app-pin`）作**混淆级**保护，明文与密钥强度取决于部署环境；如需更强保护请改用系统钥匙环或加密文件系统。

## 测试

**自动化回归（不依赖真实远端）**：`tests/` 下两个可执行测试，需先 `pnpm run build`：

- `node tests/transport.test.mjs` —— 纯逻辑：`~/.ssh/config` 解析/合并、连接计划、known_hosts accept-new、连接失败路径。
- `node tests/transport-e2e.test.mjs "<scratch-dir>"` —— 在 127.0.0.2 起临时 `ssh2` 服务器做端到端验证：**密码认证**、
  `bash -s` stdin 脚本通道、端口转发、accept-new 落盘、会话清理。**必须传隔离 HOME 目录**，避免改动真实 `~/.ssh`。

手工验证（真实远端/`~/.ssh/config` 别名）：

- 新建连接 → 远程连接 → 地址填目标机地址，SSH 主机填 `ASUS`，用户名留空（ssh config 提供 User）
- 密码/密钥留空：若 `~/.ssh/config` 的 `ASUS` 可免密登录（`PreferredAuthentications publickey` + IdentityFile），
  则直接复用该配置连接；若需要认证则回退到连接配置，提示填写用户名/密码/密钥。
- 只填密码（不选密钥）：应能直接密码认证连接（旧版在无 plink/sshpass 的机器上会拒绝此路径）。

手工验证（Docker，无端口映射）：

- `docker run -d --name dsh-test node:24-alpine sleep infinity`（或任意含 node 的运行中容器）；
- 新建连接 → Docker → 容器名填 `dsh-test`，端口填 3090 → 连接：插件用 `docker exec -d` 启动 dsh、
  开 `docker exec -i` 隧道，标签页加载出 DSH Web 前端（token 303 就绪）；
- **用户 / 工作目录 / 环境变量**：容器名填 `dsh-test`，用户名填容器内已有用户，工作目录填该用户可写路径，
  环境变量列表加一行 `DSH_HOME=/path/to/.dsh` → 连接成功后容器内 `ps -o user= -p $(cat /tmp/dsh-gui-docker-3090.pid)`
  应显示该用户、`/tmp/dsh-gui-docker-3090.log` 首行 `node -v` 为该用户 PATH 里的版本；
- 全程 `docker exec -it dsh-test sh -c 'ps aux'` 只看到 dsh 进程、`docker port dsh-test` 为空（无映射）、
  宿主 `netstat -ano` 只有 `127.0.0.1:<随机端口>` 监听；
- 二次连接复用进程与隧道；取消连接后容器内 PID 被杀、隧道关闭。
