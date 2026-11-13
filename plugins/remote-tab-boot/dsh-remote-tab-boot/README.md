# dsh-remote-tab-boot

远程桌面标签页的子进程引导插件。desktop 应用为每个远程连接生成一个独立的 `remote-tab` 子 profile 与一个 `dsh web` 子进程；本插件只挂载在该子 profile 中，在子进程启动时通过 `ds-harness-remote` 的客户端服务打开目标 Host 上的工作区，然后打印父端监督器等待的哨兵行。没有目标的 profile 中插件完全惰性。

## 环境变量契约

父端通过 `DSH_REMOTE_TAB_TARGET` 把目标以 JSON 对象传给子进程：

```json
{
  "targetDeviceId": "…",
  "workspacePath": "E:/code/project",
  "backend": "harness",
  "title": "host · workspace"
}
```

| 字段 | 必需 | 含义 |
|---|---|---|
| `targetDeviceId` | 是 | 远程 Host 的设备 id，作为 `openRemoteWorkspace` 的第一个参数 |
| `workspacePath` | 是 | 该 Host 上的工作区路径，作为 `openRemoteWorkspace` 的第二个参数 |
| `backend` | 否 | 工作区所属后端，缺省为 `harness`；当前只支持 `harness` |
| `title` | 否 | 连接标题，随载荷传入供诊断；插件解析后保留该字段，不参与打开流程 |

变量缺失、为空串或只含空白时，插件视为「本次启动没有远程标签目标」。非法 JSON、缺少必需字段、`backend` 不是 `harness` 时，插件写 stderr 并抛错。

## profile 行为

- 父 profile（desktop 应用自身的组合，以及其他任何 profile）：`DSH_REMOTE_TAB_TARGET` 不存在，`apply` 立即返回。插件不声明 `dshRemoteClient` 依赖，不注册回调，也不产生日志。
- 子 profile（`remote-tab`）：子 profile 的 `dsh.profile.bundles` 列出本包，本包的 `cordis.patch.yml` 以 bundle 层插入 entry `remote-tab-boot`。`apply` 用 `ctx.inject(['dshRemoteClient'], …)` 等待 `ds-harness-remote` 注册客户端服务，随后调用 `openRemoteWorkspace(targetDeviceId, workspacePath, AbortSignal.timeout(60000))`，成功后向 stdout 打印：

  ```
  [remote-tab-boot] ready <targetDeviceId> <workspacePath>
  ```

## 失败语义

- 目标载荷非法、缺少必需字段或 `backend` 不受支持：写 `console.error` 并抛错，不打开工作区，也不打印哨兵行。
- `dshRemoteClient` 未提供 `openRemoteWorkspace`（例如安装的 `ds-harness-remote` 版本过旧）：写 `console.error` 并抛错，错误信息点名缺失的方法签名。
- `openRemoteWorkspace` 抛错或超过 60 秒：写 `console.error` 并重新抛错；超时的错误信息为 `timed out after 60000ms`。
- 插件不会让子进程退出：错误之后 `dsh web` 继续启动并打印自己的 URL。父端监督器同时等待该 URL 与哨兵行，整体超时 90 秒；失败原因会出现在它保留的子进程日志尾部。

## 安装

`plugins/remote-tab-boot/install.mjs` 只在 `DSH_PLUGIN_PROFILE === 'desktop'` 时调用共享安装器 `installPlugin` 构建并链接包；其他 profile 只打印跳过并退出 0。子 profile 的 `node_modules` 是指向 desktop profile `node_modules` 的 junction，因此包只需要安装在 desktop profile。

本包声明 `dsh.bundle.patch`，`dsh plugin add` 会把它 reconcile 进 `dsh.profile.bundles`，并按其 `cordis.patch.yml` 以 bundle 层插入 entry，不需要手工修改 profile 的 `cordis.patch.yml`。

## 构建与测试

```sh
pnpm install --store-dir <runtime-root>/.pnpm-store
pnpm run build   # tsdown → lib/index.js（ESM）
pnpm test        # node tests/boot.spec.ts：fake ctx 与 fake client，无真实服务
```

包内 `pnpm-workspace.yaml` 固定 `nodeLinker: hoisted`：构建期依赖只有 tsdown、typescript 与 `@types/node`，hoisted 布局让它们以真实目录解析，避免 Windows 上 isolated 链接器的 junction 让 Node 的裸导入解析落到错误路径。

测试覆盖：变量缺失或空白时保持惰性；变量存在时注入 `dshRemoteClient`、传递设备 id、工作区路径与超时信号、打印哨兵行；`backend` 不受支持、载荷非法、缺少字段、服务方法缺失、打开失败与超时（用 25 ms 短超时验证）时的 stderr 输出与抛错行为。

## 已知限制

- 只支持 `harness` 后端；`codex`、`cursor`、ACP 等后端不在本版范围。
- 只尝试打开一次，不重连、不重试；连接失败由父端重启子进程处理。
- 依赖 `ds-harness-remote` 暴露 `dshRemoteClient.openRemoteWorkspace`；服务缺失时子进程只留下错误日志，父端按超时处理。
