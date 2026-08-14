# 代码审查结论（dsh-remote）

> 审查对象：commit `caff7aa`（feat: add dsh-remote plugin for multi-backend connection tabs）
> 审查日期：2026-08-14
> 结论来源：人工评审该提交的 12 个新文件，并对照 `dsh-terminal` 插件、harness `dsh-host-webserver`
> 注册面与 `shell.overlay` 槽位；实测运行中 GUI 的 `/remote-api/env` 正常返回。
>
> 本文件作为后续改进清单，条目按严重程度排序；状态：`[已修复]` = 已合入，`[待办]` = 未处理。
>
> **架构调整（2026-08-15）**：连接界面由页面内 `shell.overlay` 覆盖层整体迁入
> **Tauri 原生标题栏**（`src-tauri/ui` + Rust `remote_call` 命令），插件 client 半端置为
> inert（`src/client/index.ts` 的 `apply` 不再注册槽位/样式），避免在嵌入 iframe 内出现
> 过高的重复标题栏；Host 半端（`/remote-api` 引擎）保持不变并被 Tauri 壳经回环代理复用。
> 本清单中凡涉及 `RemoteApp.tsx` / client 渲染的条目，其影响载体转为 `src-tauri/ui/app.js`。

## 总体

结构与 `dsh-terminal` 一致：host 半端挂 `/remote-api` 前缀路由、client 半端注 `shell.overlay`、
`build.mjs` 直接调用 esbuild 二进制、`inject: ['webServer']`、teardown 用 `ctx.effect`。
`webServer.register({ kind: 'prefix', path: '/remote-api' })`、`shell.overlay` 槽位均已核实存在并挂载运行。

## 中等问题

### 1. [已修复] `probe` 把 4xx 当作"可加载/就绪"，就绪判断会提前误报

- 位置：`src/index.ts`（probe）；消费方：deployRemote 就绪轮询、RemoteApp.tsx 各探测
- 修复：`probe` 现返回 `{ reachable, loadable, status }`，`loadable` 严格要求 2xx；
  部署就绪轮询与前端初始探测只用 `loadable`。404 启动窗口、任意 403/404 服务不再被误判就绪。

### 2. [已修复] Windows DPAPI 解密经 `[Console]::Write` 输出，非 ASCII 凭据往返可能损坏

- 位置：`src/index.ts`（WIN_DECRYPT / credRead）
- 修复：解密侧改为 `[Convert]::ToBase64String` 输出 base64 字节，父进程按 base64→UTF-8 解码，
  绕开控制台 OEM/UTF-8 编码差异，中文用户名/密码可正确往返。

### 3. [已修复] `/remote-api` 是未认证本地 RPC，权限面远大于其"参照物"

- 位置：`src/index.ts`（apply / trusted）
- 修复：`apply` 在 `ctx.webServer.host !== '127.0.0.1'` 时拒绝启动并打错误日志；
  该接口（起进程、跑远端 bash、写文件、解密凭据）强制限定在回环绑定。文档已声明该信任边界。

## 一般/设计层面

### 4. [已修复] 远端部署永远克隆未固定的上游 main

- 位置：`src/index.ts`（deployRemote）
- 修复：默认仍克隆上游 `main`，但新增 `DSH_REMOTE_REPO_URL` / `DSH_REMOTE_REPO_REF` 环境变量
  固定仓库与 ref（非默认 ref 时 fetch 后 checkout）；去掉 `|| pnpm install` 回退，
  构建固定为 `pnpm install --frozen-lockfile`。

### 5. [已修复] 远端前置条件（git/node/pnpm/tmux）无预检

- 位置：`src/index.ts`（checkRemoteToolchain）
- 修复：首个 SSH 往返执行工具预检，逐一报告 `OK <tool>` / `MISSING <tool>`；
  缺失则中止部署并明确提示。

### 6. [已修复] client 在 state updater 内调用另一个 setState

- 位置：`src/client/RemoteApp.tsx`（closeTab）
- 修复：在事件处理器内先算出 `next` 标签列表与 `nextActive`，再依次 `setTabs` / `setActiveId`，
  不再在 updater 内调用 setState。

### 7. [已修复] plink 路径无条件强制 `-P`

- 位置：`src/index.ts`（buildSshArgv / openTunnel）
- 修复：ssh `-p` / sshpass `-p` / plink `-P` 统一为"仅在显式非 22 端口时携带"。

## 次要

- [已修复] `RemoteApp.tsx`：透明化与 iframe 判断统一用 `normUrl` 去掉尾斜杠比较，
  避免"本机端口"新建连接得到重复 iframe 副本。
- [已修复] `diag` 自探改用 `ctx.webServer.port`（不再硬编码 3080）；`env` 仍返回绝对路径（仅同源可见）。
- [已修复] `readJson` 与 `keyfile.write` 增加体积上限（1 MiB / 8 MiB base64），防内存/磁盘压力。
- 安全边界与 gpg 口令强度：已写入 `docs/README.md` 运维一节，明确 `/remote-api` 仅回环、
  gpg 内置口令为混淆级。
- [待办] 无自动化测试；建议后续为 probe/credential/部署命令补单元测试。
