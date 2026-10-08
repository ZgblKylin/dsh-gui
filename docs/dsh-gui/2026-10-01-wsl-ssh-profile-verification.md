# WSL 作为 SSH 主机验证 DSH 远端工作区组合（2026-10-01）

本文记录一次以 WSL 发行版充当 SSH 主机、端到端验证 DSH SSH 提供方家族的实验。验证对象是 [ssh-remote-workspace.md](ssh-remote-workspace.md) 描述的组合方式与配置字段；该文承载当前状态的组合契约，本文只记录本次执行的环境、步骤、证据与未覆盖范围。

## 目的与判定标准

本次验证要回答三个问题：SSH 组合在 `0.2.0-rc.2` 运行时能否按文档装配并启动；文件、命令与沙箱三类能力是否真的落在 SSH 主机上；文档给出的组合改写是否可直接照做。判定标准是三处证据同时成立：`dsh --profile ssh --dump-config` 无 patch 跳过告警；提供方级验收全部通过；真实 profile 启动时 SSH 连接确实建立。

## 环境

| 项 | 值 |
| --- | --- |
| 宿主 | Windows，`uname` 报告 `Linux Zgbl-X13 6.6.114.1-microsoft-standard-WSL2` |
| WSL | 2.7.1.0，内核 6.6.114.1-1，`networkingMode=nat` |
| 发行版 | `archlinux`（WSL2），用户 `chongfei`，登录 shell 为 zsh |
| 远端 Node | v25.7.0（`/usr/sbin/node`，`/usr/sbin` 是指向 `/usr/bin` 的符号链接） |
| OpenSSH | 客户端与服务端均为 10.2p1 |
| harness | `@deepseek-ai/dsh@0.2.0-rc.2`，独立安装在 WSL 内，`DSH_HOME` 隔离为 `~/dsh-ssh-verify/home` |

同一台 WSL 发行版同时充当本地端与 SSH 主机：本地 dsh 在 WSL 内运行，sshd 在 WSL 内监听 `127.0.0.1:2222`。因此本实验覆盖传输、摘要校验、提供方替换与沙箱语义，不覆盖跨机器的文件系统差异、主机密钥变更、网络延迟与断连场景。

## 步骤

隔离的 SSH 主机：生成专用 ed25519 客户端密钥与主机密钥，写一份专用 `sshd_config`（`Port 2222`、`ListenAddress 127.0.0.1`、`AuthorizedKeysFile` 指向该目录、`PasswordAuthentication no`、`UsePAM no`、`AllowStreamLocalForwarding yes`），以 root 运行 `/usr/sbin/sshd -f <config>`，未修改 `/etc/ssh` 下的任何系统配置。

客户端别名写在 WSL 用户 `~/.ssh/config` 的托管块中（先备份原文件），关键字段为 `HostName 127.0.0.1`、`Port 2222`、`IdentityFile`、`IdentitiesOnly yes`、`UserKnownHostsFile` 指向专用文件、`StrictHostKeyChecking yes`。主机密钥经 `ssh-keyscan -p 2222 -t ed25519 127.0.0.1` 预置，满足 `BatchMode=yes` + `StrictHostKeyChecking=yes` 的无交互要求。

远端产物：在 `~/dsh-ssh-verify/helper` 下 `npm install @deepseek-ai/dsh-ssh@0.2.0-rc.2`（连带解析 41 个包，含 `dsh-fs-local`、`dsh-subprocess-local`、`dsh-sandbox-local` 等 peer），辅助程序入口为 `node_modules/@deepseek-ai/dsh-ssh/lib/helper.js`，`sha256sum` 得 `42373bff731239ab5e50bfd908fba8d7e9b9f127463586fa346715135a8ada0b`。

profile：`dsh plugin --profile ssh add` 依次安装四个 SSH 包与 `@deepseek-ai/dsh-headless@0.2.0-rc.2`，随后写入组合改写。工作脚本与验收程序位于仓库内被 `.gitignore` 排除的任务 scratch `.work/ssh-remote-verify/`（任务收尾后已清理）。

## 证据

组合树：`dsh --profile ssh --dump-config` 退出码 0，stderr 为空。输出中 `ssh`、`fs-ssh`、`subprocess-ssh`、`sandbox-ssh` 四行由 profile patch 插入，`fs-sandbox`、`subprocess`、`sandbox` 三行带 `disabled: true`，`sandbox-policy` 的 `config` 同时含 `mode` 与远端 `workspaceRoot`。

文档旧版改写方式不可用：把 `fs-sandbox` 行的 `name` 改为 `@deepseek-ai/dsh-fs-ssh` 时，`--dump-config` 对三行各输出一次 `patch: name mismatch for "<id>" (expected "<old>", got "<new>"), skipping`，该行保持本地提供方不变。规则来自 `deepseek-harness/vendor/include/src/index.ts` 的 `applyEntryPatches`：`name` 只用于校验目标行身份，不匹配即跳过；patch 对其余字段是整体覆盖，因此 `sandbox-policy` 必须复述 `mode`，否则退回 schema 默认值 `read-only`。

提供方级验收：以与 profile 相同版本的四个包直接搭出「本地 harness + 远端工作区」组合，`ctx.ssh.ready` 返回 `{ protocol: 1, platform: 'linux', nodeVersion: 'v25.7.0', node: '/usr/bin/node', root: '/tmp/dsh-ssh-<随机>', workspace: '/home/chongfei/dsh-ssh-verify/workspace' }`，且 `hash` 与配置的 `helperHash` 一致。19 项检查全部通过：

| 检查 | 结果 |
| --- | --- |
| 连接建立、helper 就绪、摘要一致、Node 与工作区一致 | 通过（`hello.node` 为 `execPath`，符号链接解析后与配置的 `/usr/sbin/node` 相同） |
| SSH 主机上存在 helper 进程 | 通过（`ps` 可见 `ssh -T -M -S /tmp/dsh-ssh-*/master … dsh-wsl-verify '/usr/sbin/node' '--disable-sigusr1' '<helper>'` 与其子进程） |
| `ctx.fs` 创建、编辑、字节窗口读取远端文件 | 通过 |
| 过期版本写入被拒绝 | 通过（`FS_STALE_VERSION`） |
| 文件身份为远端绝对路径 | 通过 |
| Bash 经 `ctx.subprocess` 在远端 cwd、以远端用户运行 | 通过（`pwd` 为远端目录，`uname -s` 为 `Linux`，`id -un` 为 `chongfei`） |
| Bash 读到 `ctx.fs` 写下的同一份远端文件，写回后对 `ctx.fs` 可见 | 通过 |
| 只读策略与工作区外写入被拒绝 | 通过（均为 `FS_SANDBOX_DENIED`） |
| 独立 SSH 会话看到同一远端文件 | 通过 |

摘要拒绝路径：把 `helperHash` 换成 64 个 `f`，`await` 插件 fiber 被拒绝，错误为 `SSH helper digest differs from the configured artifact`。

Windows 本地端：在 Windows 上安装同版本 `@deepseek-ai/dsh-ssh` 并构造 `SshConnection`，同步抛出 `SSH runtime requires a POSIX client`。因此 Windows 上的 dsh-gui `web` profile 无法承载该家族，harness 必须运行在 POSIX 环境内。

真实 profile 启动：以假 API key 运行 `dsh --profile ssh --json "<任务>"`，启动期间 `ps` 观察到 helper 进程，进程退出码 1 且 stderr 只有 `AUTH: Authentication Fails … api key: **** is invalid`。失败点落在模型调用，SSH 连接与远端准备均已完成。

## 操作注意

`dsh plugin` 把参数转发给 `pnpm`，因此本地端需要可用的 `pnpm`。SSH 家族在 npmmirror 上的同步可能滞后：本次 `@deepseek-ai/dsh-fs-ssh@0.2.0-rc.2` 在 `registry.npmmirror.com` 返回 404，在 `registry.npmjs.org` 存在；WSL 内同时存在 IPv6 无路由的问题，需要 `NODE_OPTIONS=--dns-result-order=ipv4first` 才能让 npm 走 IPv4。

## 未覆盖范围

本次未搭建 PTC 引导对，因此 `bootstrapPath`/`bootstrapHash` 与 `NodePtcRuntime` 接线未验证；fd 7 二进制流、终端操作、LSP、符号链接身份与输出暂停时的控制进展未验证；断连、租期到期、取消与重放语义未验证。本地端与 SSH 主机是同一台机器，本实验不构成跨主机或恶意主机的证据。
