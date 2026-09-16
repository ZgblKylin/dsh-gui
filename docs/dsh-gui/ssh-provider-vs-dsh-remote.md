# 上游 SSH 提供方家族能否替代 dsh-remote 远程连接

本仓库现有 `plugins/remote/dsh-remote`（下文称 dsh-remote）实现「远连接」，上游
`0.1.6-alpha.1` 新增的 SSH 提供方家族（`packages/ssh/`）实现「远端工作区」。常常有人
把两者都当作「SSH 远程」，但它们是两种相反的部署模型，不能互相直接替换配置。本文对照
能力并给出替代判定。

## 结论摘要

上游 SSH 家族**不能等价替代** dsh-remote：两者目标不同。只有当「本机跑 dsh、远端仅作
执行与工作区，双端都是 POSIX」这一前提成立时，才能用「配置 ssh profile」取代 dsh-remote
的 SSH 后端；对于远端完整 dsh、Docker 容器、Windows 本机与并行多连接场景，上游没有
对应能力，仍需 dsh-remote。

## 本质差异：谁在跑 dsh

| 维度 | dsh-remote（现状） | 上游 SSH 家族 |
| --- | --- | --- |
| dsh 本体 | 在远端运行完整 dsh（默认 `npx '@deepseek-ai/dsh' web`，tmux 保活，只绑回环） | 在本机运行完整 dsh（headless 或 web profile） |
| 显示给用户的界面 | 远端 WebUI 经 SSH 本地端口转发（ssh2 `forwardOut`）加载，标签页看到的即远端界面 | 本地 GUI 正常工作区；远端只提供后端工具的执行 |
| 模型、会话、设置、插件 | 都在远端默认 `~/.dsh`，与本机完全隔离 | 都在本机 `$DSH_HOME`（settings、credentials、sessions、storages 共享） |
| 文件｜命令｜PTC｜沙箱 | 远端 dsh 用自己的本地提供方执行 | 本地 dsh + 远端 helper（`fs-ssh`、`subprocess-ssh`、`sandbox-ssh`）执行 |

一句话：dsh-remote 把「命令、会话、整个界面」搬到远端，本机只是浏览器；上游家族把
「会话与界面」留在本机，只把「执行」搬到远端。

## 能力逐项对照

| 能力 | dsh-remote (0.2.0) | 上游 SSH 家族 (0.1.6-alpha.1) | 判定 |
| --- | --- | --- | --- |
| 文件工具（读写/编辑/版本保护） | 远端 dsh 的 `tool-fs`，界面里直接可见远端文件 | 本机 `tool-fs` 经 `fs-ssh` 作用于远端文件，但 web 工作区视图不显示远端路径 | 后者有，视图有缺口 |
| Bash/终端/LSP | 远端 dsh 内执行，终端面板即远端 | 本机会话的 Bash/终端经 `subprocess-ssh` 执行于远端 | 后者有 |
| PTC/`run_code` | 远端 dsh 的 PTC 运行时 | 本机 `NodePtcRuntime` 配远端 node+引导程序 | 后者有 |
| 沙箱/审批 | 远端 dsh 的策略 | 本机策略经 `sandbox-ssh` 由远端后端执行 | 后者有，语义一致 |
| Docker 容器（免端口映射 stdio 隧道） | 有 | 无（仅 OpenSSH，目标端需 sshd） | 前者独有 |
| Windows 本机 | 支持（纯 JS ssh2，无本机 ssh 依赖；DPAPI 凭据） | 不支持（两端须 Linux/macOS，需本机 ssh CLI 支持连接复用+Unix 套接字转发） | 前者独有 |
| 密码/口令/ssh config 别名认证 | 有（ssh2 原生，`ssh-config` 解析） | 仅密钥（BatchMode、严格主机密钥、禁代理转发、禁交互认证，无密码路径） | 前者更多 |
| 多连接并行标签页/隧道复用/取消清理 | 有（壳层 UI + `ssh.status` 实时进度） | 无（profile 级单连接，换远端=换 profile/改 patch，组合成员变化须重启） | 前者独有 |
| 远端部署负担 | 零部署（远端需 node/npm/tmux） | 需在远端装 Node+helper 及其依赖并按 SHA-256 校验 | 后者更重 |
| 配置归属 | 连接配置在壳 localStorage，凭据在系统钥匙库，UI 在标题栏 | 组合配置在 profile 的 `cordis.patch.yml`，认证走 OpenSSH 主机配置 | 形式不同 |
| Web 工作区视图（文件面板等） | 显示的是远端界面，天然正确 | 假定可访问主机文件系统，仅替换提供方不会让这些视图支持远端 | 前者独有 |

## 能替代的场景

当且仅当同时满足以下条件时，可以把「远端连接配置」改为「配置 ssh profile」：

- 目标是把本机运行的 dsh（或 dsh-gui）直接工作在远端服务器目录上，会话、模型配置、
  凭据留在本机；
- 本机与远端都是 Linux 或 macOS（helper 拒绝在非 POSIX 平台启动）；
- 接受一次性的远端 helper 部署（Node + 打包的 `lib/helper.js` + 校验 SHA-256）；
- 接受 web 工作区视图（文件面板、目录选择器等）不显示远端路径，改用 headless 或
  所有消费方都遵守提供方路径语义的组合。

此时上游家族是官方、更干净的替代：省掉远端 dsh 与隧道，无需在远端常驻 dsh 进程，
也不需要把远端 WebUI 搬回本机。

## 不能替代的场景

- 远端作为完整 dsh（模型、会话、插件配置都在远端 `~/.dsh`）的部署模型：上游明确把
  Harness、模型传输与 Session 存储留在本机。
- Docker 容器后端：上游没有 ``docker exec`` stdio 隧道这类免端口映射、免 sshd 的通道。
- Windows 本机：上游要求双端 POSIX，且依赖本机 `ssh` 二进制的连接复用与 Unix 套接字
  转发；dsh-remote 纯 JS `ssh2` 可在 Windows 本机直接运行。
- 密码认证、交互式认证与并行多连接标签页 UX：上游是密钥专用的 profile 级单连接。
- 上游官方 Electron 桌面（`apps/desktop`）：dsh-remote 依赖的 `webServer` 行在 desktop
  组合中被禁用（该插件在官方 desktop 会永久 pending）；上游 SSH 家族与此无关，但同样
  不提供远端工作区视图，两者都不改变「Electron 桌面不能承载独立远端 webview」的既有
  结论。

## dsh-gui 落地建议

两者定位不同，可以共存互补：

- 保留 dsh-remote：用于「远端完整 dsh 的界面搬运」「Docker 容器」「Windows 本机」与
  「并行多连接」。
- 新增 ssh profile（按 [ssh-remote-workspace.md](ssh-remote-workspace.md) 组合）：用于
  「本机 dsh 以远端仓库/服务器为工作区执行文件、命令与 PTC」，双端 POSIX、接受 helper
  部署的场景。

决定切换前先确认主导诉求是「界面也要在远端」还是「只把执行放到远端」；前者继续用
dsh-remote，后者才考虑 ssh profile。

## 暂缓迁移期间可观察的信号

上游 SSH 家族目前是 alpha，迁移可留待以下能力补足后再评估：

- SSH 家族随正式版（非 alpha）发布。
- 解除双端 POSIX 限制（Windows 本机可用）。
- Web 工作区视图（文件面板、目录选择器、终端面板）官方支持远端路径。
- 提供密码认证或更完整的 OpenSSH 配置支持。
- helper 的部署/引导自动化，消除手工安装与 SHA-256 校验负担。
- 官方提供多连接/profile 切换的操作体验（对等 dsh-remote 的并行标签页与隧道复用）。

## 参考

- `plugins/remote/dsh-remote/docs/README.md` —— 现有远连接实现的能力与边界
- 上游 `packages/ssh/README.zh.md`、`docs/subsystems/ssh.zh.md` —— SSH 提供方家族契约
- `docs/dsh-gui/ssh-remote-workspace.md` —— ssh profile 的配置与组合方式
- `docs/dsh-gui/2026-09-13-desktop-remote-connection-feasibility.md` —— 官方 Electron
  桌面承载远端界面的可行性核实