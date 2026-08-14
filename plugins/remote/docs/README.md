# dsh-remote

多后端远程连接插件：在 **dsh-gui（Tauri 桌面壳）的原生标题栏**上提供连接标签页（VSCode 风格）、新建连接对话框与汉堡菜单，支持本机端口后端与（VSCode Remote SSH 模式）远端 SSH 部署。非侵入：不修改 dsh 框架本体，仅作为 `plugins/remote/` 插件包挂载到 web profile。

## 特性

- **原生标题栏标签页**：标签页像 VSCode 一样集成进 Tauri 自绘标题栏（`src-tauri/ui`），每个标签页对应一个已接入的 DSH 后端；标签页带关闭按钮。**不在页面 iframe 内部绘制任何额外标题栏**。
- **加号新建连接**：点击标签栏右侧 `+` 打开新建连接对话框；成功后新建标签页并在其中加载对应前端。
- **汉堡菜单**：复用标题栏既有的 `☰` 菜单，内含标签页切换列表、新建连接、关闭当前连接（另保留 关于 / 退出）。
- **全部关闭自动新建**：关闭所有标签页后自动弹出新建连接对话框。
- **本地连接**：可配置端口（默认 3080 自动填入）。连接时先探测端口是否可加载：可加载则直接加载前端；否则启动内置 dsh（`dsh web --port <端口>`）再加载前端。连接名与端口保存在软件本地存储。
- **远程连接**：可配置地址（不含 `http://` 头）与端口。连接时先探测端口是否可加载：可加载则直接加载；否则尝试 SSH 部署。连接名、地址、端口保存在软件本地存储。
- **SSH 部署（VSCode Remote 风格，安全隧道）**：
  - 与 dsh 地址**分离**的 SSH 主机字段（可用 `~/.ssh/config` 的 Host 别名，如 `ASUS`），复用现有 ssh config。
  - 密码 / 密钥文件二选一（密钥文件通过文件选择上传），可勾选"保存认证"。
  - 密码与密钥都留空时，若 ssh config 中存在对应 Host，则直接使用该别名尝试免密连接。
  - 连接过程中出现认证需求（`Permission denied` / publickey / password 等）时判定连接失败，回退到连接配置让用户补齐认证。
  - **远端后端以 `--host 127.0.0.1` 只绑定回环地址**，绝不暴露到 LAN；前端通过 **SSH 本地端口转发**
    （`ssh -N -L 127.0.0.1:<本机端口>:127.0.0.1:<远端服务端口>`）经加密会话访问，标签页只看到 `http://127.0.0.1:<本机端口>/`。
  - 连接建立后：对端检测 `dsh-gui` 命名的 tmux 会话并且会话内 dsh **存活**；缺失/失效才重新部署与启动
    （检查 `~/.dsh-gui`，缺失则按固定 ref 克隆 deepseek-harness 并编译）。随后**读取会话实际监听的服务端口**，做 SSH 端口转发加载前端。

> **关于"不生成本机监听端口"**：SSH `-L` 本地转发需要一个本机回环监听端点，标签页才能经 `http://127.0.0.1:<port>/` 访问隧道；该端点只绑定 `127.0.0.1`（不带 `-g`/GatewayPorts），不对外网及局域网开放，即标准的安全隧道形态。若需要"完全不监听本机端口"，则需在 dsh-gui 内部再包一层代理——当前设计采用前者。

## 架构：谁负责什么

这是一次**架构调整**：连接界面（标签页、新建连接、SSH 认证弹窗）不再作为页面内覆盖层渲染，而是整体迁入 **Tauri 桌面壳原生标题栏**（`src-tauri/ui/`），与标题栏原有控件合并。

```
浏览器 Web 应用（iframe, 127.0.0.1:<port>）── 不渲染任何连接 chrome（插件 client 半端 inert）
        ▲ 加载对应后端的 URL（切换标签页即改 iframe src）
        │
Tauri 壳（src-tauri/ui/*.html/css/js）
  标题栏: ☰ 汉堡菜单 + 标签页条 + ＋ 连接 + 最小化/最大化/关闭
  新建连接对话框: 本地 / 远程(SSH) 表单
        │  invoke('remote_call', { op, body })   ← Rust 命令
        ▼
Rust（src-tauri/src/main.rs, remote_call）
  白名单校验 op → 本机回环 HTTP POST /remote-api/<op>（无 Origin 头，同源视同）
        ▼
插件 Host 半端（plugins/remote/src/index.ts, Node ESM）
  /remote-api/*: probe / local.start / ssh.connect / creds.* / keyfile.write / tunnel.close / diag
```

- **插件 client 半端已置为 inert**：它随 web 应用加载但 `apply` 不注册任何槽位/样式，因此内嵌页面始终干净、不再有"太高了"的重复标题栏。
- **所有重活仍在插件 Host 半端**：探测、本机后端启动、SSH 部署、凭据（Windows DPAPI / Linux gpg）、隧道复用与清理。Tauri 壳只做薄代理（Rust 命令白名单 + 回环 POST），不重复实现。
- 之所以走 Rust 命令而非页面 `fetch('/remote-api')`：壳页面源是 `tauri://`，对 `http://127.0.0.1:<port>` 是跨源，而 `/remote-api` 刻意拒绝跨源请求；Rust 侧裸 TCP 请求不带 `Origin` 头，被视作同源放行。

## 配置归属

- **dsh-gui 管理**：连接配置（连接名、地址/端口、SSH 主机/用户名/端口、保存的认证）。
  连接名与地址端口等保存在壳页面（Tauri webview 源）的 localStorage（key `dsh.remote.*`）；凭证在系统密钥库
  （Windows DPAPI / Linux gpg，路径/文件名含 `ZgblKylin+dsh-gui+<连接名>`），密钥文件存于
  `<DSH_HOME>/gui/keys/`。
- **远端管理**：远端后端自身的 dsh 配置与插件配置，位于远端 `~/.dsh-gui`（DSH_HOME 指向 `~/.dsh-gui/.dsh`），
  与本机完全隔离。

## 结构

```
plugins/remote/          插件包（Host 引擎 + 空 client）
  src/index.ts           Host 半端（Node ESM）：/remote-api 路由 + 本地启动/SSH 部署/凭据
  src/client/index.ts    浏览器半端：inert（不再渲染连接 chrome，见"架构"节）
  build.mjs              esbuild 构建：lib/index.js（Host）+ lib/client.js（Browser module）
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
npm run install:plugins   # 构建 + 安装 + 挂载 plugins/ 下所有插件
# 或单独（build.mjs 需在插件目录内运行，glob 相对 cwd）：
node .toolchain/node_modules/pnpm/bin/pnpm.cjs install --store-dir .pnpm-store
node build.mjs
```

挂载到 web profile（由 `npm run install:plugins` 自动完成，等价于）：

```text
注入 .dsh/profiles/web/package.json      "dsh-remote": "link:./plugins/remote"
注入 .dsh/profiles/web/cordis.patch.yml  - id: remote / name: dsh-remote
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
- 密码方式 SSH 需要本机有 `plink` 或 `sshpass`；否则请使用密钥文件或依赖 ssh config。
- 远端部署默认克隆 `deepseek-harness` 上游 `main`；可用环境变量 `DSH_REMOTE_REPO_URL` / `DSH_REMOTE_REPO_REF` 固定仓库与 ref 以复现部署。远端 dsh 配置与插件配置位于 `~/.dsh-gui/.dsh`，与本机完全隔离。
- 安全边界：`/remote-api` 为未认证的本机 RPC，插件会拒绝在非回环绑定（`webServer.host !== 127.0.0.1`）下启动；Tauri 壳的 `remote_call` 只放行白名单 op，并仅向 `127.0.0.1:<port>` 发送请求。
- Linux gpg 凭据使用内置口令（`dsh-remote-app-pin`）作**混淆级**保护，明文与密钥强度取决于部署环境；如需更强保护请改用系统钥匙环或加密文件系统。

## 评审与改进

代码评审结论见 [review.md](review.md)，按严重程度列出待改进项（就绪误判、WinDPAPI 凭据往返、
信任边界、远端部署固定版本等）。后续改进请同步更新该清单。

## 测试

SSH 远程模式可用 `~/.ssh/config` 中已有的别名测试，例如：

- 新建连接 → 远程连接 → 地址填目标机地址，SSH 主机填 `ASUS`，用户名留空（ssh config 提供 User）
- 密码/密钥留空：若 `~/.ssh/config` 的 `ASUS` 可免密登录（`PreferredAuthentications publickey` + IdentityFile），
  则直接复用该配置连接；若需要认证则回退到连接配置，提示填写用户名/密码/密钥。
