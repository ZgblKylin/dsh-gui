# tauri 与 desktop 的 SSH 远程连接统一为 desktop 实现

本文记录一次跨外壳的远程连接收敛：Tauri 壳（`dsh-gui.exe`，`web` profile）的 SSH 远程连接改为复用
desktop 插件 `dsh-desktop-tabs`（desktop profile）的远程连接实现与配置，使两边运行流程一致；之后在任一边
修改远程连接本体时，另一边都能继续连接同一个远端会话。

- 状态：已实施并验证，落点与验证证据见「实施结果」一节
- 相关文档：[desktop-tabs 原型](2026-10-03-desktop-tabs-prototype.md)、
  [desktop 应用](desktop-app.md)、[remote-ssh-broker-in-shell.md](remote-ssh-broker-in-shell.md)

## 目标与范围

1. **配置界面与配置管理统一**：Tauri 远程连接对话框的 SSH 配置页改用 desktop `dsh-desktop-tabs`
   的面板控件（`panel.ts` 的连接/SSH 主机列表 + `config-panel.ts` 的工作路径/启动命令/预设），
   配置存到同一份 `<DSH_HOME>/gui/desktop-tabs.json`。
2. **启动—后端通信—前端加载统一**：Tauri 的 SSH 连接不再走 `dsh-remote` 的纯 JS `ssh2` 实现，而是
   调用 desktop 插件的 `/desktop-tabs/api/*` 路由（本机原生 `ssh` + `dsh-gui` tmux 会话 + 端口转发 +
   token 采集 + 健康检查），拿到返回的 `url` 后由外壳创建子 webview 加载。
3. **一次修改两边受益**：远程连接的后端实现只有一份（desktop 插件），UI 控件由同一份源码提供，
   两个外壳只是各自的呈现与承载方式不同。

不在范围：Docker 连接（desktop 无对应能力，仍由 `dsh-remote` 提供）、本机后端（`local.*`）、
远端标签的剪贴板/通知转接（desktop 壳专属，Tauri 壳的子 webview 已按浏览器原生方式工作）。

## 现状对照

| 维度 | Tauri（`web` profile） | desktop（`desktop` profile） |
| --- | --- | --- |
| 插件 | `plugins/remote/dsh-remote`（in-tree） | `plugins/desktop-tabs/dsh-desktop-tabs`（in-tree，desktop-only 安装） |
| SSH 传输 | 纯 JS `ssh2` + `ssh-config`，每步一个 RPC | 本机 `ssh` 可执行文件（`BatchMode=yes`），每步一次 `ssh` 调用 |
| 认证 | 密码 / 上传密钥 / `~/.ssh/config` / agent | 只交给 `ssh` 自身（`~/.ssh/config` + agent + key） |
| 远端进程 | tmux `dsh-gui` 会话（`$HOME/.dsh-gui-remote.log`、`.dsh-gui-remote.token`） | 同一套 tmux 会话与同名文件（已与 `dsh-remote` 兼容） |
| 配置 | 浏览器 `localStorage`（`dsh.remote.saved.v1` 等） | `<DSH_HOME>/gui/desktop-tabs.json` 的 `tabs` / `connections` |
| 前端承载 | Rust `views.rs` 创建子 webview（WebView2 profile 一 tab 一个） | Electron `<webview>` guest（`window.dshDesktop.browser` 租约） |
| 控制面 | Rust `remote_call` → `/remote-api/<op>` | 页面同源 `fetch` → `/desktop-tabs/api/*` |

两边**已经**共享远端 tmux 会话与 token 文件，因此「断开一边、另一边接上同一个远端会话」在协议层已成立；
本任务要统一的是实现与配置，避免两边继续分叉。

## 设计决策

### D1 远程连接后端只有一份：`dsh-desktop-tabs` 的 host 半

`plugins/desktop-tabs/dsh-desktop-tabs/src/remote/**` 与 `src/targets.ts` 保持为唯一实现，
插件改为**两个 profile 都安装**：

- `web` profile：host 半注册 `/desktop-tabs/api/*` 路由，供 Tauri 壳使用；browser 半在普通
  `dsh web` 页面里依旧完全惰性（没有 `window.dshDesktop.browser` 时 `apply()` 直接返回）。
- `desktop` profile：行为不变（browser 半继续挂载标题栏标签条）。

`plugins/desktop-tabs/install.mjs` 去掉 desktop-only 短路；README 相应说明 host 半为跨外壳共享、
browser 半仍 desktop-only。

### D2 控制面沿用 desktop 的路由，不新增 Tauri 专用接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/desktop-tabs/api/tabs` | `{ tabs, connections }`（`tabs` 是 desktop 的打开标签，Tauri 只读它做保留式回写） |
| PUT | `/desktop-tabs/api/tabs` | 原子替换；请求体必须带 `tabs`，`connections` 可省略 |
| GET | `/desktop-tabs/api/connections` | 各 SSH 连接的 `state`/`url`/`error`/`log` |
| POST | `/desktop-tabs/api/connections/<id>/up` | 建立连接，返回 `{ id, url }` |
| POST | `/desktop-tabs/api/connections/<id>/down` | 只断开本地隧道 |
| GET | `/desktop-tabs/api/ssh-hosts` | `~/.ssh/config` 中可导入的 Host |

Tauri 侧由 Rust 新增命令代理这些路由（见 D3）。路由自带回环 bind 与同源栅栏；Rust 的裸 TCP 请求不带
`Origin`/`Sec-Fetch-Site`，与既有 `remote_call` 同款放行方式，并复用同一 cookie。

`connections` 的写入由 Tauri 读—改—写完成（保留 `tabs`），不新增「只写 connections」的接口，避免
改变 desktop 的契约。

### D3 Rust 桥：新增桌面标签路由命令

在 `src-tauri/src/main.rs` 增加（`build.rs` 的命令清单同步）：

- `remote_tabs()` → GET tabs
- `remote_tabs_put(body: String)` → PUT tabs
- `remote_connections()` → GET connections
- `remote_connection_up(id: String)` → POST up
- `remote_connection_down(id: String)` → POST down
- `remote_ssh_hosts()` → GET ssh-hosts

`id` 作为路径段必须做百分号编码（未保留字符以外全部编码），避免路径注入；请求沿用
`ready_cookie` 的 cookie 与既有 600 s 读超时。HTTP 帮助函数从「只有 POST」泛化为可指定方法。

### D4 UI 控件共享：desktop 的 `panel.ts` / `config-panel.ts` 抽成无依赖的 ESM 模块

- 位置：`plugins/desktop-tabs/dsh-desktop-tabs/src/client/ui/`
  - `connection-list.js`：搜索框 + 可折叠的「已配置」「SSH 主机」两组 + 行内编辑/删除（由
    `panel.ts` 迁移，保留 `data-dsh-desktop-tabs-*` 标记与中文文案）。
  - `connection-settings.js`：工作路径、启动命令、两个内置预设、确认/取消（由 `config-panel.ts`
    迁移）。
  - 两者都是纯 DOM 工厂、无 import，导出工厂函数。
- desktop 侧：`tabs.ts` 改为 import 这两个模块，`panel.ts` / `config-panel.ts` 删除；原有 DOM 测试
  依赖的标记属性保持不变。
- Tauri 侧：`scripts/dsh-gui.mjs` 在 cargo 构建前把这两个文件原样复制到 `src-tauri/ui/`
  （生成物加入 `.gitignore`），`index.html` 用内联 `type="module"` 桥把工厂挂到
  `window.__dshRemoteUi`；`app.js` 仍为经典脚本，打开对话框时 `await window.__dshRemoteUiReady`。

### D5 Tauri SSH 页的交互收敛

删去 SSH 卡的「SSH 用户名 / SSH 端口 / 密码 / 密钥文件 / 保存认证」等 desktop 不存在的字段；
SSH 卡的配置页由 D4 的控件承载：

- 已配置连接行：点击 = 启动（`up` → 新标签），✎ = 在 settings 面板编辑（确认后 PUT 并重连），
  ✕ = 删除（PUT 去掉该连接，若标签打开则一并关闭并 `down`）。
- SSH 主机行：点击 = 用该别名开新连接草稿（`ssh: { host: alias }`，标题为别名，id 取
  `ssh-<alias>` 的可用变体）。
- settings 面板确认：PUT（新增或更新连接）→ 若标签已打开先 `down` 再 `up`，否则直接 `up`。
- 连接日志：对话框打开期间按 500 ms 轮询 `GET /desktop-tabs/api/connections`，复用 desktop 的
  `log` 行渲染；连接就绪后用返回 `url` 调 `view_create` 建标签。
- 一次性迁移：首次打开 SSH 卡时把 `localStorage` 里 `type === "remote"` 的旧记录转换成
  `connections` 条目（`title`←`name`、`ssh.host`←`sshHost`、保留 `workdir`/`startCommand`），
  写入成功后记录迁移标记；docker/local 记录留在 `localStorage`，仍由 `dsh-remote` 提供。
- Docker 卡保持现状（`dsh-remote` 的 `docker.*` RPC 不变）。

### D6 `dsh-remote` 收缩为「本机后端 + Docker」

删除 SSH 相关实现与 op：`ssh.connect` / `ssh.cancel` / `ssh.status`、`creds.*`、`keyfile.write`、
`auth.available`、`tunnel.close`，以及 `ssh2` / `ssh-config` 依赖；`REMOTE_OPS` 白名单同步收缩。
保留：`env`、`probe`、`local.*`、`docker.*`、`diag`。README 与 `docs/README.md` 说明 SSH 已迁到
`dsh-desktop-tabs`。

## 取舍与风险

- **密码认证消失**：desktop 实现不做交互认证（`BatchMode=yes`），SSH 必须靠 `~/.ssh/config` / agent /
  免口令密钥。Windows 需本机 `ssh.exe`（系统 OpenSSH，本机已具备）。这是「统一为 desktop 版本」的
  直接后果，README 与失败文案需说明。
- **标签列表归属**：`desktop-tabs.json` 的 `tabs` 仍是 desktop 打开标签；Tauri 自己的标签仍在
  `localStorage`。两边共享的是 `connections` 与远端会话，符合「切换外壳继续连接」的目标。
- **web profile 新增插件行**：`dsh-desktop-tabs` 的 browser 半会在 web 页面加载（惰性返回），
  host 半只在回环 bind 时注册路由，与 `dsh-remote` 的既有约束一致。
- **生成文件**：`src-tauri/ui/` 下的共享 UI 拷贝是构建产物，缺少时 cargo 构建会在 `npm run build`
  的复制步骤生成；直接 `cargo build` 前需先跑一次 npm 构建（文档说明）。

## 工作分解与写入范围

| 编号 | 任务 | 主要写入范围 |
| --- | --- | --- |
| T1 | 共享 UI 模块抽取 + 插件双 profile 安装 + 插件测试/README | `plugins/desktop-tabs/**` |
| T2 | Rust 桥命令 + 方法泛化 + 命令清单 | `src-tauri/src/main.rs`、`src-tauri/build.rs` |
| T3 | Tauri 对话框 SSH 页改写、迁移、标签/日志流程、共享 UI 接线 | `src-tauri/ui/**`、`scripts/dsh-gui.mjs`、`.gitignore` |
| T4 | `dsh-remote` 去除 SSH/凭据实现，白名单与文档同步 | `plugins/remote/**` |
| T5 | 集成验证、文档收尾（本文件「实施结果」、README/文档索引） | 本文件、相关 README |

依赖：T3 依赖 T1 的共享 UI 模块文件名与导出（契约在 D4 已固定）；T2 与 T3 的路径/方法契约在 D2/D3
固定；T4 可与 T1–T3 并行（文件不重叠），端到端验证需 T1–T4 全部落地。

## 验证计划

1. `plugins/desktop-tabs/dsh-desktop-tabs`：`pnpm run build` + `pnpm run test`（既有 remote/view/
   window-title/clipboard/notify/image-menu 测试全过；新增共享 UI 模块的最小 DOM 测试若需要）。
2. `node src/remote/selfcheck.mjs WSL`（真实 SSH 链路自检，需要 WSL 主机可达）——验证 host 半未回归。
3. `npm run build`（cargo release）：确认复制步骤、编译、exe 落位；启动一次 Tauri 壳，确认
   对话框 SSH 页渲染共享控件、`ssh-hosts` 列表出现、`已配置` 为空态正常。
4. 真实连接：用 `WSL` 别名建连接 → 加载远端 WebUI → 关闭标签只断本地隧道 → 用 desktop 侧同一配置
   打开同一连接（tmux 会话复用）。若远端主机条件不允许，记录未验证项。
5. `dsh-remote`：构建 + 其测试；确认 `docker.*`/`local.*` 仍工作（不可实测时至少类型/构建通过）。
6. `git status` 检查不包含生成物与构建缓存。

## 实施结果

T1–T4 全部落地，Tauri 壳与 desktop 壳的 SSH 远程连接现在是同一份实现、同一份配置、同一套远端会话。

### 代码落点

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 连接后端（唯一实现） | `plugins/desktop-tabs/dsh-desktop-tabs/src/remote/**`、`src/targets.ts` | 未改语义；`install.mjs` 改为同时安装进 `web` 与 `desktop` profile |
| 共享 UI 控件 | `plugins/desktop-tabs/dsh-desktop-tabs/src/client/ui/connection-list.js`、`connection-settings.js` | 无 import 的纯 DOM ESM 模块；desktop 的 `tabs.ts` import 它们，`panel.ts` / `config-panel.ts` 删除；`tests/shared-ui.spec.ts` 覆盖标记、筛选、折叠、行内操作、预设、确认/取消与失败文案 |
| Tauri 控制面 | `src-tauri/src/main.rs`、`build.rs`、`capabilities/default.json` | `LoopbackMethod` 封闭枚举 + `http_request_raw`（POST 版 `http_post_json_raw` 保留为薄包装，`remote_call` 行为不变）、`response_error`、`desktop_tabs_request`、`encode_path_segment`；6 个命令与 2 个单元测试 |
| Tauri 界面 | `src-tauri/ui/{index.html,app.js,titlebar.css}` | SSH 卡挂载共享控件，删去旧 SSH 字段与 `creds.*` / `keyfile.write` / `ssh.*` 调用；日志轮询 `/connections`；一次性迁移 `localStorage` 旧记录 |
| 构建接线 | `scripts/dsh-gui.mjs`、`.gitignore` | `buildExe()` 在 cargo 之前把两个共享模块复制为 `src-tauri/ui/dsh-connection-*.js`（产物忽略） |
| 已收缩的插件 | `plugins/remote/dsh-remote/**` | 2201 行 → 938 行（-58.8% 字节），移除 ssh2 / ssh-config / `@types/ssh2` 与 SSH、凭据、密钥、隧道实现；保留 11 个 op；version `0.3.0`，lockfile 已重写 |
| 白名单 | `src-tauri/src/main.rs` 的 `REMOTE_OPS` | 21 项 → 11 项（`env`、`probe`、`local.*`、`docker.*`、`diag`） |

### 验证结果

- `plugins/desktop-tabs/dsh-desktop-tabs`：`pnpm run build` 成功（`lib/index.js` 72804 B、`lib/client.js` 103676 B），`pnpm run test` 八个脚本全绿。
- `plugins/remote/dsh-remote`：`pnpm install` 后 lockfile 不再含 ssh2/ssh-config，`pnpm run build` 成功（`lib/index.js` 31.91 kB），`tests/transport.test.mjs` 5 项、`tests/transport-e2e.test.mjs` 7 项全过；`lib/index.js` 无 ssh2/ssh-config 引用。
- `npm run build -- --skip-harness`：打印 `Sync shared connection UI` 与两行 `synced ...`，cargo release 编译通过，组合冒烟通过（web profile 组合中出现 `desktop-tabs` 行），`git status` 不含两个生成物。
- web profile 路由实测（启动 `dsh-gui.exe` 后用 harness token 换 cookie 请求回环地址）：`GET /desktop-tabs/api/tabs`、`/ssh-hosts`（54 个 Host）、`/connections` 均返回 200 JSON。
- 真实 SSH 链路：`POST /connections/ssh-ASUS/up` 5.9 s 返回 `url`，日志含「复用远端 tmux 会话」「隧道已建立」「健康检查通过：/ 返回 401，/?token=*** 返回 303」；经隧道加载远端 UI 返回 200（48 KB）；`down` 后本地监听端口消失、`tmux has-session` 仍为 ALIVE、状态回到 `idle`。
- GUI 实测：连接管理对话框渲染共享控件（搜索框、「已配置 (5)」「SSH 主机 (54)」、行内 ✎/✕、连接日志区）；点击已配置行建立隧道并在标题栏开出远端标签、日志区滚动显示步骤；关闭该标签后隧道关闭、远端 tmux 会话保留；`64-6001` 同样通过。迁移路径与 Docker 卡未在真实数据上演练。

### 行为变化与已知限制

- SSH 认证只走 `ssh` 自身：`~/.ssh/config`、ssh-agent、免口令密钥；对话框不再有用户名、端口、密码、密钥上传与「保存认证」。远端必须能从这台机器以 `BatchMode=yes` 免交互登录。
- 旧凭据与上传密钥（`<DSH_HOME>/gui/credentials`、`gui/keys`）不再被任何插件读取，可手动删除。
- `desktop-tabs.json` 的 `tabs` 是 desktop 壳的打开标签列表，Tauri 只原样回写；两个壳共享 `connections` 与远端 tmux 会话。
- `dsh-remote` 的 `env` 不再返回 `ssh` 字段、`diag` 不再返回 `tunnels`；`DSH_REMOTE_START_COMMAND` 不再生效（`DSH_DOCKER_START_COMMAND` 保留）。
- 在非回环绑定（`dsh web --host <LAN>`）下 `desktop-tabs` 的 host 半拒绝注册路由并记录错误，与 `dsh-remote` 的既有姿态一致。
