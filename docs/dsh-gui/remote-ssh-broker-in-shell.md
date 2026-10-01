# SSH 引导器下沉到 Rust 壳层（设计文档）

本设计文档描述方案 B：把远端连接的 SSH 引导、隧道与凭据管理从本地 harness 插件迁入
dsh-gui 的 Rust 壳层。方案 A（watchdog 自动重启本地 harness）已落地，二者不冲突：A 保证
承载 `/remote-api` 的本地 harness 崩溃后自动恢复；B 把远端连接的全部机制移出 harness，
使远端连接的可用性与本地 harness 存活彻底解耦。本设计尚未实施，供后续按本文件实施时使用。

## 现状盘点

`/remote-api` 由 `plugins/remote/dsh-remote` 插件的 host 端注册在本地 harness 的 loopback
HTTP 服务上，`src-tauri/src/main.rs` 的 `remote_call` 命令经 `REMOTE_OPS` 白名单把每个 op
转发过去。下方按 op 列出当前语义与其在 `src-tauri/ui/app.js` 的调用点，方案 B 必须逐项
保留这些语义。

| op | 语义 | app.js 调用点 |
| --- | --- | --- |
| `env` | 返回发现信息（DSH_HOME、platform、node、repoRoot、harnessDir、bin）及 ssh/docker 可用性 | 未调用 |
| `probe` | 4 秒超时 HTTP GET，返回 `{reachable, loadable, status, error}`；`loadable` 要求 2xx | 第 914、945、1004 行 |
| `local.start` | 用发现到的 node 二进制再起一个 `dsh web --port <port>`（追加日志到 `gui/remote-<port>.log`），返回 `{ok, port, pid}` | 第 927 行 |
| `local.stop` | 树级结束本地后端（Windows 用 `taskkill /T /F`），返回 `{ok, stopped}` | 第 929、942、947、2591 行 |
| `local.list` | 返回已启动的本地端口列表 | 未调用 |
| `creds.has` | 凭据文件是否存在 | 未调用 |
| `creds.read` | 解密凭据文件，返回 `{exists, payload}` | 第 1034 行 |
| `creds.save` | 加密写凭据文件，返回 `{ok, error?}` | 第 1096 行 |
| `creds.remove` | 删除凭据文件 | 第 781 行 |
| `keyfile.write` | 把上传的私钥 base64 写入 `gui/keys/<name>.pem`（0o600），返回 `{ok, path}` | 第 805 行 |
| `auth.available` | 返回本机 ssh/plink/sshpass 可用性 | 未调用 |
| `tunnel.close` | 按 `{host}:{remotePort}` 或 `{container}:{remotePort}` 关闭隧道 | 未调用 |
| `ssh.connect` | 远端完整 dsh 引导与转发主链路，返回 `{ok, authRequired?, cancelled?, log, url?, tunnelKey?}` | 第 1081 行 |
| `ssh.cancel` | 取消进行中的连接并清理本次资源 | 第 2586 行 |
| `ssh.status` | 返回进行中连接的 `{running, startedAt, steps}`，UI 每 800 ms 轮询 | 第 1065 行 |
| `docker.available` | 探测 docker CLI 与 daemon，返回 `{docker, server?, error?}` | 第 1141 行 |
| `docker.list` | 列出运行中的容器 | 未调用 |
| `docker.connect` | Docker 容器后端引导与 stdio 隧道，返回 `{ok, cancelled?, log, url?, tunnelKey?}` | 第 1187 行 |
| `docker.cancel` | 取消进行中的 Docker 连接 | 第 2587 行 |
| `docker.status` | 同 `ssh.status`，供 `docker.connect` 轮询 | 第 1171 行 |
| `diag` | 自诊断：探活自身、列出本地后端与隧道计数 | 未调用 |

凭据与密钥文件位于本机 `{DSH_HOME}/gui/`：凭据文件名
`credentials/ZgblKylin+dsh-gui+<name>.bin`，Windows 用 DPAPI（经 PowerShell
`ProtectedData` 子进程加解密，输出走 base64），Linux 用 `gpg --symmetric`（固定口令，
混淆级）；上传的密钥写入 `keys/<name>.pem`。

SSH 侧当前语义：`buildSshPlan` 合并显式字段与 `~/.ssh/config`（`ssh-config` 库解析；
`IdentitiesOnly`、多 `IdentityFile` 累积、`~` 展开），认证候选顺序为填写的密码、密钥文件
（键入密码兼作口令）、`SSH_AUTH_SOCK` agent、默认密钥，最后兜底空密码；`hostVerifier`
对 `~/.ssh/known_hosts` 做 accept-new（同主机密钥变更拒绝），首次连接成功后追加主机密钥；
`exec` 一律 `bash -s` 喂脚本；隧道按 `{host}:{remotePort}` 键复用。

远端 dsh 生命周期：tmux 会话 `dsh-gui` 的 ALIVE/STALE/MISSING 三态检测；pane 命令在
登录交互 shell 内执行（`bash -l -i -c`），输出重定向到 `$HOME/.dsh-gui-remote.log`；
启动前先 `tmux kill-session` 并删除持久化 token 文件；端口从 pane 启动命令解析或回退到
配置端口；ALIVE 复用先等 30 s 端口、失效则重建会话再等 300 s。launch token 三件套：
`$HOME/.dsh-gui-remote.token` 的写入（`umask 077; printf`，正则 `^[A-Za-z0-9_-]{8,}$`）、
读取（`tr -d '[:space:]' | head -c 256`）、失效（`rm -f`）；读取优先级为存储文件、日志 tail
（`tail -n 2000 $HOME/.dsh-gui-remote.log | grep -a 'dsh web:'` 取最后一个 `token=`）。

Docker 侧：`docker ps` 定位容器与列表；`docker exec -d` 在容器内启动 dsh（pid 文件 +
`node -v` 证据 + 日志重定向到 `/tmp/dsh-gui-docker-<port>.log`，缺 `--no-open` 则补）；
存活探针 `kill -0 $(cat pid)`；端口探针用容器内 node TCP 连接；隧道为每连接
`docker exec -i [-u U] <c> node -e '<stdio↔TCP bridge>'`，键为 `{container}:{remotePort}`。

## 驱动选型

推荐主驱动为 [russh](https://docs.rs/russh)（纯 Rust SSH 客户端，Apache-2.0，基于
tokio），其能力与现状的映射如下：

| 现状（ssh2 / 系统命令） | russh 对应 |
| --- | --- |
| 密码 / 密钥 / keyboard-interactive / agent 认证 | `authenticate_password`、`authenticate_publickey`（`russh::keys::load_secret_key` 带口令）、`authenticate_keyboard_interactive`、agent 可选能力 |
| `hostVerifier` accept-new | `client::Handler::check_server_key`（[Handler](https://docs.rs/russh/latest/russh/client/trait.Handler.html)）结合 `ssh-key` crate 的 known_hosts 模块 |
| `client.forwardOut` 本地端口转发 | `Handle::channel_open_direct_tcpip("127.0.0.1", port, None)`，本机 `TcpListener` 每连接起一个 channel 双向拷贝 |
| `client.exec('bash -s')` | `channel_open_session` + `channel.exec` + `channel.data`/`channel.eof`/`channel.close`，读 `exit_status` |
| 断线标记死会话 | Handler 回调（`disconnected` 等）置位会话状态并关闭其隧道与 socket |
| keepalive | 客户端 keepalive 配置或定时通道 ping |

关键权衡：russh 最新版（0.63.x，2026-09）MSRV 为 Rust 1.89、edition 2024；本工程
`src-tauri/Cargo.toml` 当前声明 `rust-version = "1.77"`，本机工具链为 1.98。建议把
`rust-version` 提升到 1.89 并跟随最新 russh；若要守住低 MSRV 可钉 0.50.4（Rust 1.75），
但其 crypto 后端与 API 形态较旧，需重新核对能力映射，不作为默认。

备选一：`ssh2` crate（libssh2-sys）同步阻塞 API，Windows 需要 C 编译器 vendoring，
known_hosts API 覆盖不足；不选。备选二：调用系统 `ssh`/`plink`，密码认证在 Windows
存在 sshpass/plink 缺口，且无进程内进度与取消句柄；仅作为诊断回退，不作为主路径。

凭据加密：Windows 改用 `windows` crate 的
`Win32::Security::Cryptography::CryptProtectData` / `CryptUnprotectData`（本工程已依赖
`windows = "0.61"`，需新增该 feature），去除 PowerShell 子进程；Linux 保留 `gpg` 子进程
（行为不变）。`~/.ssh/config` 解析需要 Rust 侧最小解析器或 `openssh-config` crate，
语义必须与插件 `resolveSshConfigFromText` 一致（大小写不敏感、禁止 `Match exec`、
不展开 `Include`、`IdentityFile` 累积、`IdentitiesOnly`）。

## 目标架构

本地 harness 只保留「提供当前 web 界面」职责；Rust 壳层常驻持有远端连接的全部机制，
远端连接可用性不再依赖本地 harness 存活。运行时复用 Tauri 的 tokio
（`tauri::async_runtime`），SSH 会话与隧道任务都在其 runtime 上执行。

```text
src-tauri/src/remote/
├── mod.rs        # RemoteManager 注册表、命令入口、进度存储、取消令牌
├── ssh.rs        # SshPlan 构建（~/.ssh/config 解析）、SshSession（russh 包装）、known_hosts accept-new
├── tunnel.rs     # SSH 本地端口转发注册表；Docker exec stdio 隧道注册表
├── session.rs    # 远端 dsh 生命周期：tmux 三态、启动、端口发现、日志 tail、token 三件套
├── docker.rs     # docker CLI 可用性、容器定位/列表、容器内启动/存活/停止、端口与 token 探针
├── creds.rs      # 凭据与上传密钥文件（Windows DPAPI 直调、Linux gpg）
├── progress.rs   # ConnectProgress 与 Tauri 事件推播
```

`RemoteManager` 作为 `tauri::State` 管理，增补进 `ShellState` 同级：`sessions` 与
`tunnels`（键 `${host}:${remotePort}`）、`docker_tunnels`（键 `${container}:${remotePort}`，
含活跃 `docker exec` 子进程集合）、`progress`（`Arc<Mutex<ConnectProgress>>`）、
`cancel_token`（u64，实现「新连接取代旧连接」与取消）。

SSH 会话建模沿用插件的 `SshSession` 责任：持有 russh 连接句柄；断线回调把会话标记为
dead 并释放其 socket 与转发监听；`exec` 以「单次连接跑一个脚本后关闭」的 `sshRun`
变体或长会话复用两种形态提供（对齐插件现状：`exec` 走 `bash -s`，`openTunnel` 起长会话）。

## 命令与事件契约

`app.js` 的改动是机械的：把 `rpc(op, args)` 改为直接调用下表的具名命令，请求参数与返回
JSON 响应体保持逐字节兼容，避免 UI 逻辑变化。`remote_call` 族命令去重后需要新增的命令如下：

| 现 op | 新命令 | 返回（保持兼容） |
| --- | --- | --- |
| `probe` | `remote_probe` | `{reachable, loadable, status?, error?}` |
| `local.start` / `local.stop` | `remote_local_start` / `remote_local_stop` | `{ok, port, pid}` / `{ok, stopped}` |
| `creds.read` / `creds.save` / `creds.remove` | `remote_creds_read` / `remote_creds_save` / `remote_creds_remove` | 同现状 |
| `keyfile.write` | `remote_keyfile_write` | `{ok, path}` |
| `ssh.connect` / `ssh.cancel` | `remote_ssh_connect` / `remote_ssh_cancel` | 同现状 |
| `docker.available` / `docker.connect` / `docker.cancel` | `remote_docker_available` / `remote_docker_connect` / `remote_docker_cancel` | 同现状 |

`ssh.status` / `docker.status` 轮询取消，改为 Tauri 事件推送。每步进度以事件
`remote-progress` 发送：`{attempt: u64, step, ok?, detail?}`；`done: true` 时命令响应体
仍按现状返回完整 `log` 数组与 `{ok, url?, tunnelKey?}`，UI 沿用现状的 `res.log` 终绘。
UI 端由 800 ms 轮询改为订阅事件，事件合并逻辑保留插件的「同一步文本折叠」行为。

`env`、`auth.available`、`tunnel.close`、`local.list`、`creds.has`、`docker.list`、`diag`
未被 UI 调用，随阶段推进逐个下沉或随插件停用而消失。

取消语义：`remote_ssh_cancel` / `remote_docker_cancel` 自增 `cancel_token`，并把当前进行
中的 SSH 会话断开（等价插件 `activeSession.current.close()`），使管道在下一个 await 点
退出；新发起连接自增令牌并使得更旧的在途连接失效。清理动作（杀掉本次启动的 tmux 会话、
关闭本次打开的隧道、删除本次写入的 pid 文件）只针对本次尝试创建的资源，不影响既有连接。

## 隧道注册表与多连接

SSH 隧道与 Docker 隧道维持进程内注册表，键与现状一致。存在存活连接时直接复用并返回既有
本机端口；连接已断（dead）时先关旧隧道再重建，不重用一个连接已消失的隧道。隧道不随标签页
关闭而关闭，跨标签按 `host:remotePort`（或 `container:remotePort`）复用；应用退出
（沿用 watchdog 的 `shutdown` 信号：窗口 CloseRequested/Destroyed 与 `start_update`）时
逐项关闭会话、转发监听与 docker 子进程。取消或失败仅清理本次尝试。

## launch token 文件规则

远端 token 三件套语义不因承载方改变而改变，全部经 SSH exec 通道在远端执行，本机不落盘：

- 写入：harvest 到匹配 `^[A-Za-z0-9_-]{8,}$` 的 token 时执行
  `umask 077; printf '%s\n' '<token>' > $HOME/.dsh-gui-remote.token`；
- 读取：`cat $HOME/.dsh-gui-remote.token 2>/dev/null | tr -d '[:space:]' | head -c 256`，
  正则校验通过才使用；
- 失效：`rm -f $HOME/.dsh-gui-remote.token`，在重建 tmux 会话（kill-session 之后、新
  会话之前）执行，防止旧进程的 token 冒充本次启动。

token 来源优先级为存储文件、远端启动日志 tail；日志源取到 token 后先写文件再返回。
`$HOME/.dsh-gui-remote.log` 同时作为启动失败诊断与 token 备源。

## 远端脚本移植

方案 B 不改变远端行为，`session.rs` 与 `docker.rs` 内嵌的远端脚本逐字节沿用插件现有
字符串，仅把执行主体从 Node 改为 Rust 子进程（docker 侧）或 russh exec 通道（ssh 侧）：

- tmux 三态：`tmux has-session -t dsh-gui` 与 `tmux list-panes -t dsh-gui -F '#{pane_dead}'`；
- pane 启动：`bash -l -i -c '<paneCommand>'`，`paneCommand` 为
  `{ node -v; cd "$HOME" && <serveFlags>; } > $HOME/.dsh-gui-remote.log 2>&1`；
- serveFlags 追加规则（缺失时补 `--host 127.0.0.1` 与 `--port <port>`，`npm|pnpm|bun run`
  命令后补 ` -- ` 分隔）原样保留；
- 端口发现：`tmux list-panes -t dsh-gui -F '#{pane_start_command}'` 解析 `--port`；
- 端口探测：`(echo > /dev/tcp/127.0.0.1/<port>) >/dev/null 2>&1 && echo OPEN || echo CLOSED`；
- 日志 tail：`tail -n <lines> <file> 2>/dev/null || true`。

Docker 侧：`docker exec -d [-u U] [-e K=V]... <c> sh -c '<cd && echo $$ > pidfile && { node -v; exec sh -c <startCmd>; } > log 2>&1>'`，
存活 `kill -0`、停止 `pkill -TERM -P` + `kill -TERM`、端口探测经容器内 node TCP、日志与
token 探针经 `docker exec -i` 读取。

## 迁移阶段

分三个阶段，每阶段可独立合并、独立验证：

1. 下沉无 SSH 依赖的命令：`probe`、`local.start/stop`、`docker.available/list` 直接实现
   为 Rust 命令，`app.js` 改调用名，`REMOTE_OPS` 同步收缩；本阶段已保证「本地 harness
   崩溃不打断本机后端连接与 docker 可用性探测」。
2. 下沉 SSH 全链路：`ssh.rs`、`tunnel.rs`、`session.rs`、`progress.rs`，实现
   `remote_ssh_connect/cancel` 与事件推送，UI 移除轮询；此阶段远端连接完成解耦。
3. 下沉 `docker.connect/cancel`（Docker 隧道与容器内 token）、`docker.status` 移除与
   `creds.*`、`keyfile.write`；凭据与密钥文件切换到 Rust 侧加密（Windows DPAPI 直调、
   Linux gpg）。`creds.*` 与 `keyfile.write` 只被 SSH 连接路径使用，故随凭据加密一并
   后置。全部能力落地后，从 profile 卸载 `dsh-remote` 插件行（`local.start` 由 Rust
   直接 `spawn` 实现，参见 `spawn_harness` 的形态）并删除 `REMOTE_OPS` 与 `remote_call`
   命令。

每一阶段的完成判据是：停用对应依赖后标题栏「新连接」仍可用，且 `env`/`diag` 类残留 op
不再被 UI 引用。

## 边界与难点

- known_hosts：accept-new 与主机密钥变更拒绝必须等价于插件 `checkHostKeyAcceptNew`，
  处理 `@cert-authority`/`@revoked` 标记、哈希主机条目（`|1|`）以不匹配方式保守处理；
- `~/.ssh/config`：禁止 `Match exec` 执行 shell、不展开 `Include`、`IdentitiesOnly` 与
  多 `IdentityFile` 的语义必须与现状一致；
- 认证：密码、密钥、口令、agent 与 keyboard-interactive 兜底的尝试顺序不变量；
- 引导顺序：目标 dsh 未运行只能经 SSH 先启动，SSH 会话由壳层持有，不能依赖目标自身的
  HTTP 服务；
- 取消与失败清理：中止进行中的连接要杀掉本次启动的 tmux 会话并关闭本次隧道，不影响
  既有连接与新连接发起；
- MSRV：引入 russh 后 `rust-version` 需提升到 1.89（或钉 0.50.4 守 1.77）；
- 事件与轮询：推送事件要处理窗口关闭后的收听方缺失，且与本地 `HARNESS_STATUS_EVENT`
  的命名空间不冲突。

## 验收标准

- 本地 harness 退出后（模拟崩溃），已建立的远端连接照常浏览，重新连接可用，无需重启应用；
- 每个新命令的返回 JSON 与现状 op 的响应体逐字节兼容，`app.js` 只改调用名；
- 远端 `$HOME/.dsh-gui-remote.token` 的写入、读取与失效行为与现插件一致；
- 取消与超时清理不留 tmux 会话、隧道或容器内 dsh 进程；主机密钥变更被拒绝；
- 与 `docs/dsh-gui/ssh-provider-vs-dsh-remote.md` 的能力对照保持一致：该文档界定 dsh
  执行层的归属，本方案只调整连接管理的承载位置。