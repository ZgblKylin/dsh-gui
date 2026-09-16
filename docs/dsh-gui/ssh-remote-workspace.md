# DSH 通过 SSH 使用远端工作区：文件、命令与 PTC 工具的远端执行

当前 harness 运行时为 `0.1.6-alpha.1`（`deepseek-harness` 子模块钉在
`dsh-v0.1.6-alpha.1`）。本版本新增的 SSH 提供方家族位于上游 `packages/ssh/`，它让本地
运行的 DSH 通过一条 OpenSSH 连接，把文件、命令、终端、沙箱与 PTC（模型编写的
TypeScript）执行放到同一台远端 POSIX 主机上。本文分析该功能如何使用。

## 概述

SSH 提供方家族实现既有文件系统、子进程与沙箱能力接口，不引入 SSH 专用模型工具。
Harness 保留 Cordis 对象、模型传输、权限、回调与 Session 持久化；远端主机提供文件与
进程。
「本地运行、远端工作区」是 headless 与自定义配置组合支持的部署方式，Web 工作区视图
（文件面板、目录选择器等假定可访问主机文件系统的页面）需要单独集成，不在本家族范围。

## 架构与组成

家族由四个包组成，全部共享同一份部署方身份与同一条已认证连接：

| 包 | 职责 | 承载的服务 |
| --- | --- | --- |
| `@deepseek-ai/dsh-ssh` | 部署方持有的 OpenSSH 连接、已安装辅助程序的身份校验与断连清理 | `ctx.ssh` |
| `@deepseek-ai/dsh-fs-ssh` | 远端文件身份、读取与带版本保护的原子修改 | `ctx.fs` |
| `@deepseek-ai/dsh-subprocess-ssh` | 远端可执行文件查找、普通进程、fd 7 控制流与终端 | `ctx.subprocess` |
| `@deepseek-ai/dsh-sandbox-ssh` | 远端文件效果限制与执行信息 | `ctx.sandbox` |

辅助程序是打包的远端入口（`dsh-ssh` 构建产物 `lib/helper.js`），它复用远端机器上的
本地文件与进程提供方（`fs-local`、`subprocess-local`、`sandbox-local` 等）执行请求。
SSH 只是传输方式；文件效果限制由所选远端沙箱后端执行。

### 与既有工具/消费方的对应关系

SSH 家族复用既有能力 seam，因此替换提供方后，消费方无需改动，自动指向远端：

| 工具/消费方 | seam | SSH 提供方 |
| --- | --- | --- |
| 文件工具（`tool-fs` 读/写/编辑）、`fs-observation-policy`、`tool-fs-search` | `ctx.fs` | `dsh-fs-ssh` |
| Bash 执行器（`bash-sandbox`）、终端（`terminal-bash`）、LSP（`lsp-stdio`）、进程外 subagent 后端 | `ctx.subprocess` | `dsh-subprocess-ssh` |
| Bash/终端/Node 的沙箱限制（`bash-sandbox`、`terminal-bash`） | `ctx.sandbox` | `dsh-sandbox-ssh` |
| PTC 运行时（`run_code`/PTC 模式的 `NodePtcRuntime`）、`workflow-ptc` | 直接消费方 | `dsh-ssh`（提供 `nodeExecutable` 与 `bootstrapPath`） |

文件系统身份、可执行文件查找、进程 cwd、沙箱工作区根目录与语言服务器文件 URL 都指向
SSH 主机。提供方在文件实际存在的位置规范化路径，保留文件系统对 `symlink/..` 的解释。

## 部署前置条件

两端都必须运行 Linux 或 macOS（辅助程序拒绝在非 POSIX 平台启动）。本地 `ssh` 命令必须
支持连接复用与 Unix 套接字转发，服务器也必须允许该转发。连接启用 `BatchMode`、要求严格
检查主机密钥、禁用认证代理转发，且不提供交互认证流程；主机别名、凭据与 known_hosts
记录需在启动前配置好。

在远端安装 Node.js、已构建的辅助程序及其声明的同版本运行时依赖（`dsh-ssh` 的 peer
依赖，例如 `dsh-fs-local`、`dsh-subprocess-local`、`dsh-sandbox-local`）。它们必须位于
工作区、可写临时目录以及后端会替换的临时目录树之外，例如 bwrap 的私有 `/tmp`；工作区
本身可以位于 `/tmp` 下。摘要校验在辅助程序启动后核对已安装产物的 SHA-256；它固定预期
部署产物，不用于认证恶意远端操作系统，也不保证可写部署文件的执行安全。

## 配置

### `ssh` 配置字段

`@deepseek-ai/dsh-ssh` 的配置位于 profile 组合中名为 `ssh` 的插件行。所有路径字段都为
远端视角的绝对路径：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `host` | 必填 | 已有的 OpenSSH 主机别名，含其用户、密钥与 known_hosts 配置 |
| `node` | 必填 | 远端 Node 可执行文件绝对路径 |
| `helper` | 必填 | 已安装、打包的辅助程序入口绝对路径 |
| `helperHash` | 必填 | 该入口的小写 SHA-256；与实际不符的连接在就绪前被拒绝 |
| `workspace` | 必填 | 远端默认工作区绝对路径 |
| `bootstrapPath`、`bootstrapHash` | 省略 | 成对提供的远端 PTC 入口及其小写 SHA-256 |
| `requestTimeoutMs` | `30000` | 连接与管理请求的截止时限，范围为 1 至 2,147,483,647 毫秒 |
| `maxFrameBytes` | `67108864` | 每条 JSON 消息的负载上限，最大为 64 MiB |
| `maxPending` | `128` | 普通未完成请求的数量上限；心跳与有界清理请求使用预留容量 |
| `leaseMs` | `30000` | 辅助程序心跳租期，范围为 3000 至 600000 毫秒 |

只使用文件系统与 Bash 时可以省略 PTC 引导对；未配置 PTC 部署时 `bootstrapPath` getter
会拒绝访问。

### 组合改写

在 profile 的 `cordis.patch.yml`（或用户级 overlay）中，把 base bundle 的三个提供方行
换成 SSH 提供方，并新增 `ssh` 行：

```yaml
# <profile>/cordis.patch.yml
- id: ssh
  name: '@deepseek-ai/dsh-ssh'
  config:
    host: my-remote
    node: /usr/bin/node
    helper: /opt/dsh/ssh-helper.js
    helperHash: 0123…abcd
    workspace: /home/deploy/workspace
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-ssh'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-ssh'
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-ssh'
- id: sandbox-policy
  config:
    workspaceRoot: /home/deploy/workspace
```

`bash-sandbox`、`tool-bash`、`tool-fs`、`terminal-bash`、`lsp-stdio` 等消费方行保持
原样，它们通过 seam 自动改用新的提供方。`sandbox-policy` 的 `workspaceRoot` 必须设为
远端工作区绝对路径，保证 Bash 与文件系统的限制根目录一致。

### PTC 接线

`dsh-ptc-runtime-node` 的 `nodeExecutable` 与 `bootstrapPath` 取自已验证的 SSH 连接，
这两个值只能在运行时取得，无法在 YAML 中静态引用。组合层因此需要一个小的包装插件
（或程序化 headless 组合），声明 `inject: ['ssh']`，在 `apply` 中把
`ctx.ssh.nodeExecutable` 与 `ctx.ssh.bootstrapPath` 作为配置挂载 `NodePtcRuntime`：

```js
export default {
  inject: ['ssh'],
  async apply(ctx) {
    const { NodePtcRuntime } = await import('@deepseek-ai/dsh-ptc-runtime-node')
    return ctx.plugin(NodePtcRuntime, {
      nodeExecutable: ctx.ssh.nodeExecutable,
      bootstrapPath: ctx.ssh.bootstrapPath,
    })
  },
}
```

PTC 需要成对配置 `bootstrapPath`/`bootstrapHash`。未配置时 `bootstrapPath` getter 拒绝
访问，PTC 程序在真正执行前失败。

## 启用方式

推荐新建独立的 headless/自定义 profile，而不是改写 dsh-gui 的 `web` profile：Web 的
工作区视图假定主机文件系统，只替换提供方不会让这些视图支持远端。

在 profile 中安装四个 SSH 包（版本与 harness 一致）：

```text
dsh plugin --profile ssh add @deepseek-ai/dsh-ssh@0.1.6-alpha.1 @deepseek-ai/dsh-fs-ssh@0.1.6-alpha.1 @deepseek-ai/dsh-subprocess-ssh@0.1.6-alpha.1 @deepseek-ai/dsh-sandbox-ssh@0.1.6-alpha.1
```

安装后按上文在 profile 的 `cordis.patch.yml` 完成组合改写，再以该 profile 启动
dsh（例如 `dsh --profile ssh "任务"`）。`dsh-ssh` 就绪前会校验远端辅助程序摘要，结果
不符时连接失败并报告「SSH helper digest differs from the configured artifact」。

### 新建 profile 与第三方插件的继承关系

每个 profile 是独立的：独立的 manifest（`package.json` 与 `dsh.profile.bundles`）与独立
的 pnpm `node_modules`。profile 之间没有继承。`--from-default-profile <模板>` 只把随附
模板（`web`、`headless`、`sdk`、`sdk-minimal`、`acp`）的当前组合包列表与 `patchReload`
值复制进一个依赖为空、patch 为空的新 manifest，不复制模板自己已安装的依赖或 patch，
也不持久化继承字段；`dsh plugin --profile <name> add ...` 在 profile 缺失时初始化它
（有随附模板的用模板，其他名称只装 `@deepseek-ai/dsh-base`）。

因此 SSH profile 必须单独安装四个 SSH 包，以及任何需要的第三方插件。web profile 中
安装的 agent-team bundle、皮肤、插件市场系列等不会自动进入新 profile；需要时逐个
`dsh plugin --profile ssh add <pkg>`。跨 profile 自动共享的只有以下内容：

- 内置组合包（`dsh-base`、`web-app`、`headless` 等）与 core 的 `@deepseek-ai/*`
  依赖始终从 dsh 安装目录（`.harness`）解析，launcher 通过物化的 fallback 链接让
  profile 使用它们，无需在每个 profile 重装。
- home 级 `$DSH_HOME/cordis.patch.yml` 应用于每个 profile，是机器本地共享的组合叠加
  层；其中新增行引用的插件必须在对应 profile 中可解析，否则该 profile 启动报错。
  本仓库当前的 home patch 只有两行皮肤 `disabled` 设置，不会给新 profile 引入任何
  未安装插件。
- home 级数据共享：`settings.yaml`（模型配置）、`.credentials.yaml`（凭据）、
  `sessions`（会话历史）、`storages`（插件持久化状态）都在 `$DSH_HOME` 下，新 profile
  天然继承；插件代码则按 profile 各自安装。

## 验证

- 用 `dsh --profile ssh --dump-config` 检查组合树：`ssh` 行在位，`fs-sandbox`、
  `subprocess`、`sandbox` 行已指向 SSH 提供方，无缺失插件与 patch 报错。
- 文件工具对远端路径的读写、编辑与版本保护走 `ctx.fs`，与远端 Bash 看到的文件一致。
- Bash 在远端 cwd 运行，`pwd` 与文件写入验证与文件工具处于同一命名空间。
- PTC 程序在远端 Node 中运行：`process.cwd()` 为远端工作区，程序可见环境为空字典，
  文件写入落到辅助程序所在文件系统。

调试与验收可参考上游 `packages/ssh/ssh/tests/live.e2e.ts`：它通过
`DSH_SSH_TEST_CONFIG` 配置连接，覆盖远端文件保护与符号链接身份、Bash 限制、fd 7 二进制
流、输出暂停时的控制进展、终端操作、LSP 与 Node 执行，以及摘要不符即拒绝连接。

## 限制与注意事项

- 不提供 Windows 端点、自动配置远端环境、重连或重放；连接丢失会使待处理操作失效，
  客户端如实报告未确认结果，绝不通过重连重放可能已执行的操作。
- Web 工作区视图仍假定可访问主机文件系统；SSH 组合面向 headless 与所有消费方都遵守
  提供方路径语义的自定义组合。
- 文件效果限制不约束网络访问或进程可见性；远端 `partial` 沙箱后端仍属于部分执行。
  SSH 主机与已安装辅助程序属于可信基础设施，摘要检查与文件效果限制不构成对抗恶意
  主机的安全边界。
- `processPathFromHostPath()` 在 SSH 下不可用，因此需要已安装可执行文件或引导程序的
  消费方必须显式提供远端产物。
- 辅助程序将整段文本读取及单次字节窗口限制为 8 MiB；更大的读取需使用文本流或多个
  字节窗口，其他 JSON 传输受连接消息大小上限（默认 64 MiB）约束。
- 远端文件 URL 是执行坐标，不是主机文件系统句柄或 Web 下载链接。

## 参考

- 上游 `packages/ssh/README.zh.md` 与各提供方 README —— 包级契约与配置
- 上游 `docs/subsystems/ssh.zh.md` —— 执行坐标、传输语义与生命周期归属
- 上游决策记录 `.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md`
  —— 替代方案、影响与验证要求
- 上游 `docs/config-catalog.zh.md` 的 `@deepseek-ai/dsh-ssh` 一节 —— 配置字段权威定义