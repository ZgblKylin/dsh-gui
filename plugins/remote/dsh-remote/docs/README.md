# dsh-remote

**本机后端 + Docker** 连接插件：在 **dsh-gui（Tauri 桌面壳）的原生标题栏**上提供连接标签页（VSCode 风格）、
新建连接对话框与汉堡菜单，支持本机端口后端与 **Docker 连接**（`docker exec` 启动容器内 dsh，并用 stdio 隧道转发，
**无需任何端口映射**）。非侵入：不修改 dsh 框架本体，仅作为 `plugins/remote/dsh-remote/` 插件包挂载到 web profile。
**不做任何远端部署**——容器内 dsh 由用户配置的启动命令自行启动。

SSH 远程连接**不在本插件内**：它由 [`plugins/desktop-tabs/dsh-desktop-tabs`](../../desktop-tabs/dsh-desktop-tabs)
的 host 半端提供（`/desktop-tabs/api/*`），Tauri 壳与 desktop 应用共用同一份实现与同一份配置。本插件已删除
SSH 传输（`ssh2` / `ssh-config`）、凭据存储与密钥文件写入，只保留 `/remote-api` 上的本机与 Docker op。

## 特性

- **原生标题栏标签页**：标签页像 VSCode 一样集成进 Tauri 自绘标题栏（`src-tauri/ui`），每个标签页对应一个已接入的
  DSH 后端；标签页带关闭按钮。**不在页面 iframe 内部绘制任何额外标题栏**。
- **加号新建连接**：点击标签栏末尾的 `+` 打开新建连接对话框（与浏览器标签页末端的加号同位置）；成功后新建标签页并在其中加载对应前端。
- **汉堡菜单**：复用标题栏既有的 `☰` 菜单，内含标签页切换列表、新建连接、关闭当前连接（另保留 关于 / 退出）。
- **全部关闭自动新建**：关闭所有标签页后自动弹出新建连接对话框。
- **已保存连接管理**：「新建连接」对话框左侧是已保存连接列表（localStorage `dsh.remote.saved.v1`）：每项带
  **启动 / 编辑 / 删除**，列表末端是「＋ 新建连接」。新建连接成功后自动记入列表；「编辑」把配置填回表单并切到
  对应配置页，连接按钮变为「保存并连接」；「启动」用已存配置直接建立新标签页。标题栏标签页**只保留已建立的连接**，
  未连接的记录只存在于对话框列表。
- **标签页内容持续有效**：每个已建立连接一个独立子 webview（`src-tauri/src/views.rs` 用 `WebviewBuilder` 加到主窗口，
  不是页面内 iframe），切换标签页只切换显示、**不重载页面**，各标签页的会话状态与页面保持。
- **本地后端**：对话框提供「本地」「SSH」「Docker」三张连接卡（SSH 卡的数据面由 desktop-tabs 提供，见下节）；
  `probe` / `local.start` / `local.stop` 供已保存的本地连接记录使用——连接时先探测端口是否可加载，可加载则直接加载前端，
  否则启动内置 dsh（`dsh web --port <端口> --no-open`）再加载前端。启动时钉住 `DSH_HOME`（与桌面外壳一致），
  全局 agent 模板（`AGENTS.md` 与 `docs/`、`skills/`）从 harness home 读取，因此第二实例看到的用户级 skill 与常驻文档
  和主后端一致。连接名与端口保存在软件本地存储。

- **Docker 连接（启动 + `docker exec` 隧道转发，无需端口映射）**：
  - **原理**：宿主半端用 `docker exec -d <容器> sh -c '…'` 启动容器内 dsh（自动补 `--host 127.0.0.1 --port <端口>`
    与 **`--no-open`**——无浏览器的容器里 `dsh web` 会自动尝试拉起来并把 HTTP 服务卡住）；随后在
    `127.0.0.1:<本机随机端口>` 起一个 `net.Server`，每次连接 spawn 一个
    `docker exec -i <容器> node -e '<stdio↔TCP 桥>'`，把流量桥接到容器自身 `127.0.0.1:<端口>`。
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
  - **进度与认证**：`docker.status` 实时进度管道；浏览器认证（launch token）从容器日志提取，
    `303 / 2xx` 即前端就绪，旧版无 token 的 profile 直接按裸 URL 2xx 兼容。
  - **容器内启动命令可配置**：对话框「容器内启动 dsh 的命令」默认
    `npx -y '@deepseek-ai/dsh' web`，可用环境变量 `DSH_DOCKER_START_COMMAND` 改全局默认；
    也可写 `DSH_HOME=… node /path/to/bin.js web` 直接复用容器内已有 checkout（也可改从环境变量列表里配 `DSH_HOME`）。
    例如用容器内已有 checkout 时配 `npm run harness` 也**可以**（见下文 `--` 分隔符与 `DSH_GUI_PORT` 说明）。
  - **启动失败即刻反馈**：容器内进程若在启动后几秒内退出（如 `npm error Unknown cli flags`、`command not found`、
    工作目录不存在），插件会**立刻**读取 `/tmp/dsh-gui-docker-<端口>.log` 尾部并把真实错误回显到连接日志，
    不再傻等 300s 端口超时。
  - **备选方案（默认不用）**：① Linux 主机 + bridge 网络下可直接访问容器 IP
    （`--host 0.0.0.0` + `http://<容器IP>:<端口>`，但会暴露到 Docker bridge）；② 容器内
    `ssh -R` 反向隧道（需容器有 ssh 客户端 + 主机 sshd）；③ 同用户自定义网络起 nginx/caddy
    sidecar 反代并（可选）只发布 sidecar 端口。上面三种要么暴露面更大、要么多容器/多依赖，
    所以插件默认走 `docker exec` stdio 隧道。

## SSH 远程连接（已迁到 dsh-desktop-tabs）

SSH 连接的后端实现与配置只有一份，位于 desktop 插件
[`plugins/desktop-tabs/dsh-desktop-tabs`](../../desktop-tabs/dsh-desktop-tabs) 的 host 半端；Tauri 壳与 desktop 应用都调用
同一组路由，配置存在同一份 `<DSH_HOME>/gui/desktop-tabs.json`，因此两边可以接着连同一个远端会话：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/desktop-tabs/api/tabs` | `{ tabs, connections }` |
| PUT | `/desktop-tabs/api/tabs` | 原子替换（请求体必须带 `tabs`） |
| GET | `/desktop-tabs/api/connections` | 各 SSH 连接的 `state`/`url`/`error`/`log` |
| POST | `/desktop-tabs/api/connections/<id>/up` | 建立连接，返回 `{ id, url }` |
| POST | `/desktop-tabs/api/connections/<id>/down` | 只断开本地隧道 |
| GET | `/desktop-tabs/api/ssh-hosts` | `~/.ssh/config` 中可导入的 Host |

- **认证只交给本机 `ssh`**：desktop 实现调用本机 `ssh` 可执行文件（`BatchMode=yes`），因此只支持
  `~/.ssh/config` / ssh-agent / 免口令密钥——**交互式密码认证不再提供**。Windows 需要系统 OpenSSH（`ssh.exe`）。
- **远端进程与配置**：远端仍是名为 `dsh-gui` 的 tmux 会话（`$HOME/.dsh-gui-remote.log`、`$HOME/.dsh-gui-remote.token`），
  与本插件历史上的会话布局兼容，因此旧 tmux 会话可被 desktop 实现直接复用。
- **本插件保留的 `/remote-api` op**：`env`、`probe`、`local.start`、`local.stop`、`local.list`、
  `docker.available`、`docker.list`、`docker.connect`、`docker.cancel`、`docker.status`、`diag`。
- **已删除的 op**（Tauri 壳不再转发）：`ssh.connect`、`ssh.cancel`、`ssh.status`、`creds.has`、`creds.read`、
  `creds.save`、`creds.remove`、`keyfile.write`、`auth.available`、`tunnel.close`。
- **旧数据可手动清理**：`<DSH_HOME>/gui/credentials/`（DPAPI/gpg 加密的连接凭据）与 `<DSH_HOME>/gui/keys/`
  （上传的 SSH 私钥）已无任何代码读取，可直接删除。SSH 启动命令的旧全局默认值环境变量 `DSH_REMOTE_START_COMMAND`
  同样不再生效（启动命令随 desktop 的 `connections` 条目保存）。
- **op 形状的两处收缩**（其余 op 行为不变）：`env` 不再返回 `ssh` 字段（ssh/plink/sshpass 可用性探测随 SSH 实现移除）；
  `diag` 不再返回 `tunnels`（SSH 隧道计数），只保留 `locals` 与 `dockerTunnels`。

## 架构：谁负责什么

连接界面（标签页、新建连接、SSH 认证弹窗）不作为页面内覆盖层渲染，而是整体位于 **Tauri 桌面壳原生标题栏**（`src-tauri/ui/`），
与标题栏原有控件合并。

```
浏览器 Web 应用（子 webview, 127.0.0.1:<port>）── 不渲染任何连接 chrome（插件 client 半端 inert）
        ▲ 加载对应后端的 URL（切换标签页即切换子 webview 的 URL）
        │
Tauri 壳（src-tauri/ui/*.html/css/js）
  标题栏: ☰ 汉堡菜单 + 标签页条 + ＋ 连接 + 最小化/最大化/关闭
  新建连接对话框: 本地 / SSH / Docker 表单
        │  invoke('remote_call', { op, body })          ← 本机后端 / Docker（本插件）
        │  invoke('remote_tabs*', 'remote_connections' 等) ← SSH 连接（desktop-tabs）
        ▼
Rust（src-tauri/src/main.rs）
  remote_call: 白名单 op → 本机回环 HTTP POST /remote-api/<op>（无 Origin 头，同源视同）
  桌面标签命令: 方法+路径代理 GET/PUT /desktop-tabs/api/*（id 百分号编码）
        ▼
插件 Host 半端
  dsh-remote        /remote-api/*:        probe / local.* / docker.* / diag
  dsh-desktop-tabs  /desktop-tabs/api/*:  tabs / connections / ssh-hosts（SSH 连接本体）
```

- **插件 client 半端已置为 inert**：它随 web 应用加载但 `apply` 不注册任何槽位/样式，因此内嵌页面始终干净、不再有"太高了"的重复标题栏。
- **SSH 能力只有一份**：位于 `dsh-desktop-tabs` 的 host 半端（`src/remote/**` 与 `src/targets.ts`），两个 profile 都安装它；
  Tauri 壳与 desktop 应用只是各自的呈现与承载方式不同。
- 之所以走 Rust 命令而非页面 `fetch('/remote-api')`：壳页面源是 `tauri://`，对 `http://127.0.0.1:<port>` 是跨源，
  而 `/remote-api` 刻意拒绝跨源请求；Rust 侧裸 TCP 请求不带 `Origin` 头，被视作同源放行。`/desktop-tabs/api/*` 同理，
  并复用壳层已拿到的 cookie。

## 配置归属

- **dsh-gui 管理**：本机与 Docker 连接配置（连接名、端口、容器、容器内用户名/工作目录/环境变量列表）保存在壳页面
  （Tauri webview 源）的 localStorage（key `dsh.remote.*`）。
- **desktop-tabs 管理**：SSH 连接配置（`ssh.host`、标题、远端工作目录、启动命令、预设）保存在
  `<DSH_HOME>/gui/desktop-tabs.json` 的 `connections`，与 desktop 应用共用；旧凭据/密钥目录不再使用（可手动清理）。
- **容器管理**：Docker 连接不修改容器——不装包、不写镜像、不改端口映射；只通过 `docker exec -d` 启动 dsh 进程并写
  容器内 `/tmp/dsh-gui-docker-<端口>.{log,pid}` 两个文件，进程存活判断与清理均以 PID 文件为准。用户名/工作目录/环境变量列表
  作为连接配置随 localStorage 保存（环境变量值会明文存在本机，包含敏感值请自行斟酌）。

## 结构

```
plugins/remote/            插件 wrapper（install.mjs 归本仓库）
  install.mjs              构建 + 安装 + 挂载本插件（委托 scripts/plugin-install.mjs）
  dsh-remote/              插件包（Host 引擎 + 空 client）
    src/index.ts           Host 半端（Node ESM）：/remote-api 路由 + 本机后端启动 + Docker exec 隧道
    src/client/index.ts    浏览器半端：inert（不再渲染连接 chrome，见"架构"节）
    tsdown.config.ts       tsdown 构建：lib/index.js（Host）+ lib/client.js（Browser module）
    tests/                 Host 半端回归测试（见"测试"节）
    docs/                  本目录（插件文档）

src-tauri/ui/            dsh-gui 桌面壳 UI（标签页 / 新建连接对话框 / 汉堡菜单 / 关于）
  index.html             标题栏结构 + 标签条 + 新建连接对话框 + 空状态视图
  app.js                 标签页状态/切换/关闭 + 连接流程 + remote_call / desktop-tabs 路由调用
  titlebar.css           紧凑标签页（VSCode 风格）+ 对话框/表单样式
src-tauri/src/main.rs    `remote_call`（op 白名单 + 回环 POST 代理）与 desktop-tabs 路由代理命令
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

装好后 **重启 dsh-gui** 生效。生效后标签页出现在原生标题栏；嵌入页面不显示任何额外 chrome。

## 运维

- 本机后端日志：`<DSH_HOME>/gui/remote-<端口>.log`
- 关闭标签页不强制断 Docker 隧道（隧道按 `container:remotePort` 复用，重连即用）；dsh-gui 退出或插件 teardown 时所有隧道一并关闭。
  SSH 隧道由 desktop-tabs 管理（`POST /desktop-tabs/api/connections/<id>/down` 只断本地隧道）。
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
- **启动命令在 `--` 处拆分**：对 `npm|pnpm|bun run <script>` 形式的启动命令，插件会在追加 `--host/--port/--no-open`
  前自动插入 ` -- `，避免被包管理器当成自身参数（`Unknown cli flags`）。`npm run harness`（本仓库
  `scripts/harness.mjs`）会直接启动 web 服务，**端口由 `DSH_GUI_PORT` 决定（默认 3080）**；若端口不是 3080，
  请在环境变量列表加 `DSH_GUI_PORT=<端口>`，或改用直接命令
  `node <repo>/deepseek-harness/apps/cli/lib/bin.js web` / 默认 `npx '@deepseek-ai/dsh' web`。
- **取消即清理**：对话框「取消」会走 `docker.cancel` 中止进行中的连接——停止实时进度轮询，并**杀掉本次启动的
  容器内 dsh 进程、关掉本次打开的 Docker 隧道**；连接**失败**时也一样清理。仅在本次尝试实际创建的资源上清理，
  不会动早前成功建立的连接。
- 安全边界：`/remote-api` 为未认证的本机 RPC，插件会拒绝在非回环绑定（`webServer.host !== 127.0.0.1`）下启动；
  Tauri 壳的 `remote_call` 只放行白名单 op，并仅向 `127.0.0.1:<port>` 发送请求。
- 本插件**不再存储任何凭据**：没有 DPAPI/gpg 凭据库、没有私钥文件写入；SSH 认证完全交给本机 `ssh`
  （`~/.ssh/config` / agent / 免口令密钥）。

## 测试

**自动化回归（不依赖真实远端，也不需要 Docker daemon；需先 `pnpm run build`）**：`tests/` 下两个可执行测试。
`package.json` 没有 `test` 脚本，用 `node` 直接运行：

- `node tests/transport.test.mjs` —— 构建产物与 manifest 的静态不变量：导出面只剩 `apply` /
  `defaultDockerStartCommand` / `inject` / `name`，manifest 无 `ssh2` / `ssh-config` / `@types/ssh2`，
  `lib/index.js` 不含这两个依赖的引用，`apply()` 的回环绑定围栏与 teardown 注册正常。
- `node tests/transport-e2e.test.mjs` —— 起临时回环 HTTP 服务器驱动**真实注册的** `/remote-api` 处理器：
  `env`（无 `ssh` 字段）、`probe`（2xx / 404 / 端口关闭三态）、`local.list` / `local.stop`、
  `docker.available` / `docker.list`（只校验形状，daemon 有无都通过）、`diag`（无 `tunnels` 字段）、
  10 个已删除 op 一律返回 `unknown op`、同源围栏 403 与非法 JSON 400。

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

手工验证（本机后端）：

- 新建连接 → 本地 → 端口填一个空闲端口 → 连接：端口无服务时插件启动 `dsh web --port <端口> --no-open`，
  日志落在 `<DSH_HOME>/gui/remote-<端口>.log`；再点一次同一记录应直接加载（不重复启动）。

SSH 连接的手工验证见 desktop 插件文档（`plugins/desktop-tabs/dsh-desktop-tabs/README.md`）。
