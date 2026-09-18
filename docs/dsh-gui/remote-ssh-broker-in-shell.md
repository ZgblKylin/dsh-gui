# SSH 引导器下沉到 Rust 壳层（设计文档）

本设计文档记录 `dsh-remote` 插件的一条备选演进方向：把远端连接的 SSH 引导、隧道与
凭据管理从本地 harness 插件迁移到 dsh-gui 的 Rust 壳层。该方向目前未实施；当前仍采用
「插件寄生在本地 harness + 壳层 watchdog 自动重启」的组合（见 `src-tauri/src/main.rs`
的 `run_harness_loop`）。本文供后续按此方向修改时使用。

## 现状与结构性问题

当前 dsh-remote 插件加载在本地 harness 的 web profile 中，`/remote-api/*` 是本地
harness 自身 HTTP 服务上的路由。SSH 会话（ssh2）、本地端口转发隧道、凭据
（Windows DPAPI / Linux gpg）与上传的密钥文件都由本地 harness 进程持有。

远端连接是「先引导目标、再转发浏览器流量」的机制：目标 dsh 可能尚未运行，必须依赖
连接发起方一侧的常驻进程通过 SSH 先去启动它。这个引导器必然要存在一个常驻进程里，
当前选择的是本地 harness。

该选择把远端连接的可用性绑定到本地 harness 的存活：本地 harness 一旦退出，所有
`/remote-api` 操作立即失败（表现为「cannot reach the harness on 127.0.0.1:<port>」），
必须重启应用才能恢复。SSH 与隧道在语义上属于客户端壳的资源，不属于「提供 web 界面」的
harness。

## 目标架构

Rust 壳层直接拥有远端连接的全部机制：

- SSH 传输与会话：认证、`~/.ssh/config` 解析、known_hosts accept-new、shell 通道执行；
- 本地端口转发：将远端回环端口（或 Docker 容器内端口）转发到本机 `127.0.0.1` 随机端口；
- 远端 dsh 生命周期：tmux 会话检测、启动命令、服务端口发现、远端日志与 launch token 读取；
- 凭据与密钥文件：现有 `ZgblKylin+dsh-gui+<连接名>` 命名与存储路径可平移，加密实现改用
  Rust 侧方案（Windows DPAPI via windows API、Linux 门禁可选）；
- 连接进度与取消：以 Tauri 事件推送到标题栏 UI，替代当前的 `ssh.status` 轮询。

本地 harness 只保留「当前 web 界面」职责，其存活不再影响远端连接是否可用。

## 模块划分建议

| 模块 | 职责 |
| --- | --- |
| `src-tauri/src/remote/ssh.rs` | SSH 会话：认证候选、`~/.ssh/config`、known_hosts、exec 通道 |
| `src-tauri/src/remote/tunnel.rs` | 本机回环端口转发与 Docker `docker exec` stdio 隧道 |
| `src-tauri/src/remote/session.rs` | 远端 dsh 生命周期：tmux 检测/启动、端口发现、日志与 token 文件 |
| `src-tauri/src/remote/creds.rs` | 凭据与上传的密钥文件 |
| `src-tauri/ui/app.js` | 直接调用新的 Rust 命令，移除 `remote_call` 转发插件 |

保留在插件侧的候选：`local.start`（本机额外后端）与 Docker 容器发现等与本地 web profile
关系密切的操作；也可在所有能力迁移完成后停用插件。

## 迁移路径

分三个阶段，每阶段均可独立合并：

1. 先实现与 harness 无关的独立命令：`probe`、`ssh.status`、`tunnel.close`，标题栏 UI 直连。
2. 迁移 `ssh.connect` 主链路：认证输入、实时进度、取消清理、launch token 读取。
3. 迁移凭据与密钥文件，缩减壳层 `REMOTE_OPS` 白名单，直至插件停用。

## 边界与难点

- 引导顺序：目标 dsh 未运行时只能先经 SSH 启动，SSH 会话必须由壳层或壳层托管的常驻进程
  持有，不能依赖目标自身的 HTTP 服务。
- 认证输入：密码、密钥与口令、ssh-agent、`~/.ssh/config` 别名语义，Rust 侧需要等价实现，
  或回退到调用系统 `ssh`/`plink` 二进制。
- known_hosts accept-new 与主机密钥变更防护（防 MITM）必须保持。
- 取消与失败清理：中止进行中的连接要杀掉本次启动的 tmux 会话并关闭本次打开的隧道，
  且不影响既有连接。
- 多连接并发与隧道复用：连接记录仍由标题栏 localStorage 管理。
- token 引导：远端 `~/.dsh-gui-remote.token` 的写入/读取/失效规则与当前插件一致。

## 验收标准

- 本地 harness 退出后（模拟崩溃），已建立的远端连接与重新连接均不受影响，无需重启应用。
- 与 `docs/dsh-gui/ssh-provider-vs-dsh-remote.md` 的能力对照保持一致：该文档界定 dsh 执行
  层的归属，本方案只调整连接管理的承载位置。