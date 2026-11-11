# desktop 远程连接插件接入 WSL

本记录描述 `plugins/desktop-tabs/dsh-desktop-tabs` 的 WSL 远程连接：配置、启动流程与 SSH 共用同一套连接管理器、共享 tmux 会话与连接界面，仅传输层与端口来源不同。行为契约以插件 [README](../../plugins/desktop-tabs/dsh-desktop-tabs/README.md) 的「WSL 远程连接」一节为准，本文件记录设计依据与验证结果。

## 背景

desktop-tabs 的远程连接原只有 SSH 一种方式：`ssh -L` 把远端回环端口转发到本机，`<webview>` 加载隧道地址。WSL 运行在同一台 Windows 机器上，不需要 SSH 登录，但需要把 Linux 侧的 `dsh web` 暴露给 desktop 外壳的 `<webview>`，并且用户期望它与 SSH 的连接界面、启动流程一致。

## 设计决定

**绑定地址取 `127.0.0.1`，经 WSL2 localhost 转发访问。** dsh 的 web 服务器拒绝绑定 `0.0.0.0`（`packages/host/webserver/src/index.ts` 对 wildcard 地址报错：绑定全部接口会把远程代码执行暴露到网络）。WSL 与 SSH 因此都绑定回环地址，Windows 侧访问 `http://127.0.0.1:<端口>/` 由 WSL2 的 `localhostForwarding` 完成，连接流程与 SSH 对齐，也不需要隧道。

**WSL 与 SSH 共用同一个 `dsh-gui` tmux 会话、同一份日志与 token 文件。** 两者绑定的都是回环地址，谁先启动的后端另一边都能直接复用，因此不需要为 WSL 引入独立会话或独立进程管理。会话名 `dsh-gui`、日志 `$HOME/.dsh-gui-remote.log`、token 文件 `$HOME/.dsh-gui-remote.token` 与 `plugins/remote/dsh-remote` 的约定一致，同一发行版上的后端可被三个插件共享。

**端口从 3080 起、被占用则向上递增。** Windows 侧访问的端口就是后端在 WSL 内绑定的端口，因此端口必须在启动前确定。候选端口同时满足两个条件才被采用：WSL 内无监听（`ss -ltn`，缺失时 `netstat -ltn`），且 Windows 回环可绑定（试绑后立即释放）。WSL2 的转发与 Windows 进程各自可能占用端口，单侧检查不足以保证可访问。

**端口占用与 harness 启动失败分开处理。** 扫描与启动之间存在竞争，且启动命令可能自行决定端口，所以启动后仍可能因 `EADDRINUSE` 失败。此时按 pane 日志尾部是否出现 `EADDRINUSE` / `address already in use` 分类：是则换下一个端口重试（最多 10 次），否则立即报「WSL 内 dsh 启动失败（不是端口占用）」并回显日志尾部。启动命令写死了 `--port` 时递增不会改变实际绑定端口，扫描从该端口起，被占用时在启动前直接失败并给出「去掉 `--port` 或先结束占用进程」的提示。

**账号是连接级的平铺字段。** SSH 连接传 `ssh -l <账号>`，WSL 连接传 `wsl.exe -u <账号>`；留空时由 ssh config / 发行版默认用户决定。tmux 会话按用户隔离，同一发行版的不同账号各自维护自己的后端。

## 传输与启动

每条控制命令是一次 `wsl.exe [-d <发行版>] [-u <账号>] -- bash -l -s` 调用，脚本经 stdin 传入：命令不经过 Windows → WSL 的参数再解析，脚本里的引号无需额外转义。控制通道是登录但**非交互**的 bash——`-i` 会让交互式 rc 把 OSC 3008 / 标题序列写进 stdout、把 prompt 写进 stderr，污染探测与 token 解析；后端本身仍在 tmux 面板里以 `bash -l -i -c` 启动，nvm 等只由交互式 `~/.bashrc` 注入的运行时照旧可用。`WSL_UTF8=1` 让 `wsl.exe` 自身提示为 UTF-8，旧版无视该变量时按 UTF-16LE 兜底解码。

健康检查直接探测 `http://127.0.0.1:<端口>/`：旧版 dsh 裸 URL 返回 2xx，token 网关版裸 URL 返回 401、带 token 返回 303/2xx。探活失败且 WSL 内该端口仍在监听时，错误文案指向 `localhostForwarding`。

失败路径只清理本次尝试创建的 tmux 会话；`down` 与 `dispose` 只结束本地 `wsl.exe` 与隧道，不发任何 WSL 内停止命令，后端继续在 tmux 中运行。

## 界面

`+` 面板增加第三组「WSL 主机」，内容来自 `wsl.exe -l -v`（`{ name, state?, version?, default? }`），与「SSH 主机」同构：可折叠、参与同一搜索框、点击即新建 `wsl-<发行版>` 连接并打开启动参数面板。启动参数面板增加「账号」输入，占位与标题随连接方式变化。已配置连接行显示连接方式前缀（`SSH - 名称` / `WSL - 名称`），悬停标题附主机或发行版与账号。

没有 WSL 的机器上「WSL 主机」组为空，SSH 主机列表与已保存连接不受影响；两个列表各自独立获取、独立失败。

## 实现位置

| 位置 | 内容 |
|---|---|
| `src/remote/wsl.ts` | `wsl.exe` 进程层、输出解码、发行版列表读取与解析、端口探测脚本、启动失败分类、激活错误诊断 |
| `src/remote/commands.ts` | `RemoteChannel`（ssh / wsl）与目标解析、`--port` 固定检测、启动脚本的端口覆盖、启动等待的三种快速失败标记 |
| `src/remote/session.ts` | SSH / WSL 分流、WSL 端口双检扫描与占用重试、无隧道健康检查、共享会话复用与失败清理 |
| `src/remote/{ssh,ports}.ts` | `ssh -l` 账号参数、WSL 扫描所需的 Windows 回环端口探测 |
| `src/remote/{config,types,rows,text}.ts` | `wsl` 描述符与 `account` 的读取、合并、控制序列清洗 |
| `src/targets.ts` | `wsl` / `account` 的校验与 round-trip，本地视图判定 |
| `src/remote/index.ts` | `GET /desktop-tabs/api/wsl-hosts` 路由与导出 |
| `src/client/{types,api,panel,config-panel,tabs}.ts` | WSL 主机组、连接方式前缀、账号字段、保存与加载 |

## 验证

构建与自动化测试（worktree `feat/wsl-remote`，包目录内）：

```
pnpm run build
pnpm run test    # remote、wsl、panel、view-retention、window-title、clipboard-relay、notify-relay、image-menu 共 8 个 spec
```

真实 WSL（`archlinux`，用户 `chongfei`，`~/dsh-gui-home` 内有 harness 检出）的端到端验证通过，覆盖：

| 项 | 实测结果 |
|---|---|
| 首次连接 | 12.4s 就绪，URL `http://127.0.0.1:3080/?token=***`；裸 URL 401、带 token 303 + Set-Cookie；连接日志 8 行且无明文 token |
| 复用 | `down` 后再次 `up` 1.9s 返回同一 URL，日志出现复用，tmux 会话创建时间与 pane pid 不变 |
| `down` | 本地记录清除，WSL 内会话与端口仍在，Windows 再访问仍返回 401/303；不发远端命令 |
| 端口占用 | WSL 内占住 3080 后选到 3081，日志记录占用与递增 |
| 启动失败分类 | `node /nonexistent.js` 立即报「会话消失（不是端口占用）」并附日志；占住 3080 且命令写死 `--port 3080` 时启动前失败并给出可操作提示 |
| 账号 | `chongfei` 与留空均可用；不存在的账号给出中文诊断（`WSL_E_USER_NOT_FOUND`） |
| 路由 | `/wsl-hosts` 返回真实发行版（含默认标记），跨站请求 403、响应 `no-store`；`/connections` 的 `up`/`down` 与日志脱敏正常 |
| 旧 SSH 行为 | 只有 `ssh` 的配置解析与命令 argv 与改动前一致（未配置 `account` 时不多传任何参数） |

未覆盖：desktop 渲染层的运行期验证（应用正在运行且不能重启，UI 行为以假 DOM 测试与代码审查为准，需用户重启后人工确认）、真实 SSH 主机（本机不可用，只做静态与单测回归）、多 WSL 标签并发、WSL1、mirrored 网络与防火墙组合、无 `ss`/`netstat` 的极简发行版。

## 已知限制

与 README「已知限制」一致，其中与 WSL 直接相关的有：依赖 WSL2 `localhostForwarding`；发行版需有 `node`/`npm` 与 `tmux`；不同账号的后端互相独立；WSL1 与无 `ss`/`netstat` 的发行版只能靠启动期 `EADDRINUSE` 兜底判定端口占用。

## 验证记录

- `verification.md`（独立验收报告，含逐项证据与建议）与 `e2e-wsl.mjs` / `e2e-results.json`（可重跑的真实 WSL 端到端脚本与证据）位于任务草稿目录 `.work/wsl-remote-notes/`，任务收尾时按仓库约定清理。
