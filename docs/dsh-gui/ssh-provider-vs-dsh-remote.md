# 上游 SSH 提供方家族能否替代 SSH 远程连接

本仓库的 SSH 远程连接由 `plugins/desktop-tabs/dsh-desktop-tabs` 的 host 半提供（Tauri 壳与
desktop 壳共用，下文称 desktop-tabs），`plugins/remote/dsh-remote` 只负责本机后端与 Docker。
上游 SSH 提供方家族（`packages/ssh/`，当前 `0.2.2-rc.1`）实现「远端工作区」。常常有人
把两者都当作「SSH 远程」，但它们是两种相反的部署模型，不能互相直接替换配置。本文对照
能力并给出替代判定。

## 结论摘要

上游 SSH 家族**不能等价替代** desktop-tabs 的 SSH 远程连接：两者目标不同。只有当「本机跑 dsh、
远端仅作执行与工作区，双端都是 POSIX」这一前提成立时，才能用「配置 ssh profile」取代
desktop-tabs 的 SSH 后端；对于远端完整 dsh、Docker 容器与并行多连接场景，上游没有
对应能力，仍需 desktop-tabs（Docker 由 dsh-remote 提供）。

## 本质差异：谁在跑 dsh

| 维度 | desktop-tabs（现状） | 上游 SSH 家族 |
| --- | --- | --- |
| dsh 本体 | 在远端运行完整 dsh（默认 `npx '@deepseek-ai/dsh' web`，tmux 保活，只绑回环） | 在本机运行完整 dsh（headless 或 web profile） |
| 显示给用户的界面 | 远端 WebUI 经本机 `ssh -L` 本地端口转发加载，标签页看到的即远端界面 | 本地 GUI 正常工作区；远端只提供后端工具的执行 |
| 模型、会话、设置、插件 | 都在远端 `~/.dsh`（可用 `DSH_HOME` 指定），与本机完全隔离 | 都在本机 `$DSH_HOME`（settings、credentials、sessions、storages 共享） |
| 文件｜命令｜PTC｜沙箱 | 远端 dsh 用自己的本地提供方执行 | 本地 dsh + 远端 helper（`fs-ssh`、`subprocess-ssh`、`sandbox-ssh`）执行 |

一句话：desktop-tabs 把「命令、会话、整个界面」搬到远端，本机只是浏览器；上游家族把
「会话与界面」留在本机，只把「执行」搬到远端。

## 能力逐项对照

| 能力 | desktop-tabs (0.2.1) | 上游 SSH 家族 (0.2.2-rc.1) | 判定 |
| --- | --- | --- | --- |
| 文件工具（读写/编辑/版本保护） | 远端 dsh 的 `tool-fs`，界面里直接可见远端文件 | 本机 `tool-fs` 经 `fs-ssh` 作用于远端文件；工作区实体按主机路径创建与校验，远端独有的路径建不成工作区 | 后者有，Web 工作区不可用（见 [ssh-remote-workspace.md](ssh-remote-workspace.md) 的限制一节） |
| Bash/终端/LSP | 远端 dsh 内执行，终端面板即远端 | 本机会话的 Bash/终端经 `subprocess-ssh` 执行于远端 | 后者有 |
| PTC/`run_code` | 远端 dsh 的 PTC 运行时 | 本机 `NodePtcRuntime` 配远端 node+引导程序 | 后者有 |
| 沙箱/审批 | 远端 dsh 的策略 | 本机策略经 `sandbox-ssh` 由远端后端执行 | 后者有，语义一致 |
| Docker 容器（免端口映射 stdio 隧道） | 无（由 dsh-remote 提供） | 无（仅 OpenSSH，目标端需 sshd） | 两者都没有 |
| Windows 本机 | 支持（调用本机 OpenSSH `ssh`，Windows 自带） | 不支持（两端须 Linux/macOS，需本机 ssh CLI 支持连接复用+Unix 套接字转发） | 前者独有 |
| 认证方式 | 交给 `ssh` 自身：`~/.ssh/config`、ssh-agent、免口令密钥；`BatchMode=yes` 禁止交互式认证，无密码路径 | 仅密钥（BatchMode、严格主机密钥、禁代理转发、禁交互认证，无密码路径） | 相当 |
| 多连接并行标签页/隧道复用 | 有（壳层标签条 + `/desktop-tabs/api/connections` 进度日志） | 无（profile 级单连接，换远端=换 profile/改 patch，组合成员变化须重启） | 前者独有 |
| 远端部署负担 | 零部署（远端需 node/npm/tmux） | 需在远端装 Node+helper 及其依赖并按 SHA-256 校验 | 后者更重 |
| 配置归属 | 连接配置在 `<DSH_HOME>/gui/desktop-tabs.json`（两个壳共用），认证走 OpenSSH 主机配置 | 组合配置在 profile 的 `cordis.patch.yml`，认证走 OpenSSH 主机配置 | 形式不同 |
| Web 工作区视图（文件面板等） | 显示的是远端界面，天然正确 | 目录选择器与工作区实体都在主机文件系统上，远端独有的路径无法建成工作区 | 前者独有 |

## 能替代的场景

当且仅当同时满足以下条件时，可以把「远端连接配置」改为「配置 ssh profile」：

- 目标是把本机运行的 dsh（或 dsh-gui）直接工作在远端服务器目录上，会话、模型配置、
  凭据留在本机；
- 本机与远端都是 Linux 或 macOS（helper 拒绝在非 POSIX 平台启动）；
- 接受一次性的远端 helper 部署（Node + 打包的 `lib/helper.js` + 校验 SHA-256）；
- 接受 Web 工作区不可用（目录选择器与工作区实体都在主机文件系统上，远端独有的路径无法
  建成工作区），改用 headless 或所有消费方都遵守提供方路径语义的组合。

此时上游家族是官方、更干净的替代：省掉远端 dsh 与隧道，无需在远端常驻 dsh 进程，
也不需要把远端 WebUI 搬回本机。

## 不能替代的场景

- 远端作为完整 dsh（模型、会话、插件配置都在远端 `~/.dsh`）的部署模型：上游明确把
  Harness、模型传输与 Session 存储留在本机。
- Docker 容器后端：上游没有 ``docker exec`` stdio 隧道这类免端口映射、免 sshd 的通道。
- Windows 本机：上游要求双端 POSIX，且依赖本机 `ssh` 二进制的连接复用与 Unix 套接字
  转发；desktop-tabs 只把 `ssh` 当作非交互命令通道并自行开 `-L` 隧道，Windows 自带的
  OpenSSH 即可满足。
- 交互式认证与并行多连接标签页 UX：上游是密钥专用的 profile 级单连接。
- 官方 Electron 桌面（`apps/desktop`）：上游 SSH 家族与此无关，但同样不提供远端工作区
  视图，两者都不改变「Electron 桌面不能承载独立远端 webview」的既有结论。

## dsh-gui 落地建议

两者定位不同，可以共存互补：

- 保留 desktop-tabs 的 SSH 后端：用于「远端完整 dsh 的界面搬运」与「并行多连接」；
  Docker 容器由 dsh-remote 提供。
- 新增 ssh profile（按 [ssh-remote-workspace.md](ssh-remote-workspace.md) 组合）：用于
  「本机 dsh 以远端仓库/服务器为工作区执行文件、命令与 PTC」，双端 POSIX、接受 helper
  部署的场景。

决定切换前先确认主导诉求是「界面也要在远端」还是「只把执行放到远端」；前者继续用
desktop-tabs，后者才考虑 ssh profile。

## 暂缓迁移期间可观察的信号

上游 SSH 家族目前是 alpha，迁移可留待以下能力补足后再评估：

- SSH 家族随正式版（非 alpha）发布。
- 解除双端 POSIX 限制（Windows 本机可用）。
- Web 工作区改为「由提供方负责的工作区资源」：工作区路径的规范化与状态检查、目录选择
  都走执行提供方，而不是主机 `node:fs`。
- 提供密码认证或更完整的 OpenSSH 配置支持。
- helper 的部署/引导自动化，消除手工安装与 SHA-256 校验负担。
- 官方提供多连接/profile 切换的操作体验（对等 desktop-tabs 的并行标签页与隧道复用）。

## 参考

- `plugins/desktop-tabs/dsh-desktop-tabs/README.md` —— SSH 远程连接实现的能力与边界
- `plugins/remote/dsh-remote/docs/README.md` —— 本机后端与 Docker 连接
- 上游 `packages/ssh/README.zh.md`、`docs/subsystems/ssh.zh.md` —— SSH 提供方家族契约
- `docs/dsh-gui/ssh-remote-workspace.md` —— ssh profile 的配置与组合方式
- `docs/dsh-gui/2026-09-13-desktop-remote-connection-feasibility.md` —— 官方 Electron
  桌面承载远端界面的可行性核实