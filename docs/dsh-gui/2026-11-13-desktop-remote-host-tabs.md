# Desktop 远程主机标签：把 ds-harness-remote 主机接入独立 tab

## 目标

把 ds-harness-remote 列出的远程主机与工作区，通过 desktop 应用的标题栏标签条打开为独立 tab。每个 tab 只对应一个已保存的 `remote` 连接；主 tab 保持本机视图，侧栏 Remote 面板继续负责登录、主机授权与单窗口切换。

## 为什么每个 tab 需要一个子后端

ds-harness-remote 的远程目标是每个本地 dsh 后端进程一份的 `gatewaySwitch` 单例：选择主机与工作区后，插件覆盖该进程的官方 Typert Gateway，把本页的 API 调用转发到远端。官方所有已认证浏览器连接共享同一个 `browserPeer`，gateway 调用没有 tab 标识，因此同一个后端无法为不同 tab 路由不同远程目标。多 tab 并行查看不同主机的可行边界是每个 tab 一个本地 `dsh web` 子后端，各自持有 gateway 与 client 身份；`ds-harness-remote` 的 P2P 协议与远端 Host 均不修改。

## 结构

| 部件 | 位置 | 职责 |
|---|---|---|
| 主机发现与连接路由 | `plugins/desktop-tabs/dsh-desktop-tabs/src/remote-tab/routes.ts` | `/remote-hosts`、`/remote-workspaces`，并把 remote 连接并入 connections 状态 |
| 子 profile 生成 | `src/remote-tab/profile.ts` | 解析宿主 runtime/profile、生成 `<childHome>/profiles/remote-tab`、父组合原样复制、写 loader |
| 子运行时 loader | `src/remote-tab/loader.ts` | 把 `@deepseek-ai/*` 先解析到选中的真实 runtime、再 fallback 父 profile |
| 子身份 / provider | `src/remote-tab/providers/ds-harness-remote.ts` | 从 `dshRemoteClient` / `dshRemote` 反射构造器，mint 或复用 owned client 设备，声明 patch/bundles/homeFiles/discovery |
| 子进程监督 | `src/remote-tab/supervisor.ts` | spawn、URL 与哨兵就绪、超时、日志脱敏、`down`/`forget`/`dispose` |
| 子后端引导 | `plugins/remote-tab-boot/dsh-remote-tab-boot/src/index.ts` | 读 `DSH_REMOTE_TAB_TARGET`，调用 `openRemoteWorkspace`，打印哨兵 |
| 标签条与面板 | `src/client/tabs.ts`、`src/client/ui/connection-list.js` | `+` 面板第四组「远程主机」、工作区展开、保存并打开 tab |
| 持久化 | `<DSH_HOME>/gui/desktop-tabs.json` | `remote` 连接描述；URL 与 token 不落盘 |

## 数据流

1. `+` 面板向 `/desktop-tabs/api/remote-hosts` 请求主机列表；展开主机时请求 `/desktop-tabs/api/remote-workspaces?targetDeviceId=…`。父端处于 remote 模式时，工作区路由返回可操作的拒绝原因，不打开第二条 control 连接。
2. 选择工作区后，client 写入 `remote` 连接并 `PUT /desktop-tabs/api/tabs`；随后 `POST /connections/<id>/up`。
3. host 端解析宿主 runtime/profile，provider 用父 Host token 为该连接 mint 或复用 owned client 设备；随后生成 child home 与 profile：`node_modules` 复用父 profile，`dsh.profile.bundles` 与父 `cordis.patch.yml` **原样复制**（没有白名单/排除清单），provider 只追加自己的 bundle/patch；`settings.yaml` 与 provider 声明的 homeFiles 在 child home 首次创建时复制。子后端**不会**注册成 Host（provider 配置 `hostControl.enabled: false`）。
4. 子进程启动：优先选真实 dsh 运行时（`DSH_REMOTE_TAB_RUNTIME` → `<runtimeRoot>/.harness` → 源码构建 → 父 runtimeDir 真实目录 → asar 兜底）和真实 Node（`DSH_REMOTE_TAB_NODE` → `npm_node_execpath` → PATH `node` → 运行时自带 Node → Electron 兜底）；子 CLI 用选中 runtime 的 `@deepseek-ai/dsh/lib/bin.js`，参数为 `[--expose-internals?] --experimental-loader <child loader> --profile remote-tab --host 127.0.0.1 --port 0 --no-open`；独立 `DSH_HOME`，环境移除父端 `DSH_PROFILE*` 与 session 键。loader 把 `@deepseek-ai/*` 先解析到选中 runtime、再 fallback 父 profile，使核心包与子宿主共享实例；asar + Electron 组合会直接报可操作错误，不会让 loader 挂住。
5. 子进程同时输出 `dsh web: http://127.0.0.1:<port>/?token=…` 与 `[remote-tab-boot] ready …` 后，父端把 URL 返回给 tab，`<webview>` 加载它；子后端的 gateway 已经指向目标主机/工作区。
6. 关闭 tab 只 `down` 子进程，保留 child home 与设备身份；删除连接调用 `forget`，停进程、revoke 设备并删除 home。

## 配置与路由

`remote` 连接条目：

```json
{
  "id": "remote-<hash>",
  "title": "Desktop-ZgblKylin · /srv/app",
  "type": "remote",
  "remote": {
    "targetDeviceId": "…",
    "targetName": "Desktop-ZgblKylin",
    "workspacePath": "/srv/app",
    "backend": "harness"
  }
}
```

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/desktop-tabs/api/remote-hosts` | ds-harness-remote 主机列表 |
| GET | `/desktop-tabs/api/remote-workspaces?targetDeviceId=<id>` | 该主机的 harness 工作区 |
| POST | `/desktop-tabs/api/connections/<id>/up` | 启动或复用子后端，返回 URL |
| POST | `/desktop-tabs/api/connections/<id>/down` | 停止子后端，保留身份 |
| POST | `/desktop-tabs/api/connections/<id>/forget` | 停止、revoke、删除 child home |

## 前提与安装

- 当前 provider（ds-harness-remote）已登录并启用「允许控制本机」，host token 用于 mint client 设备；通用 core 在没有 provider 时仍可加载，远程标签功能报不可用。
- `dsh-remote-tab-boot` 安装到宿主所在的 profile：运行 `node plugins/remote-tab-boot/install.mjs`，或 `npm run build:desktop -- --plugins-only`。安装前退出桌面应用。
- 子进程使用宿主 runtime；生成的 loader 把 `@deepseek-ai/*` 指回该 runtime，因此不需要在 profile 里另外安装核心包。ds-harness-remote 的 optional peer 由 provider 在父 profile 内修复。
- 重启宿主使新 host 半、client 半与 bootstrap 生效。

## 验证

- Phase 0：本机已授权 Host 设备通过服务器 `register-owned-role` 注册 owned client 设备成功，子设备可枚举主机并撤销。
- 子后端：`Desktop-ZgblKylin` 的 Linux（archlinux WSL）主机上，子进程加载 ds-harness-remote、client 身份就绪、P2P `LAN` 传输、`openRemoteWorkspace` 成功，bootstrap 哨兵与 `dsh web:` URL 均出现。
- 自动化：`plugins/desktop-tabs/dsh-desktop-tabs` 的 `pnpm run test` 覆盖 profile 生成（父组合原样 + provider）、loader 双 anchor、provider 身份 mint/revoke、监督器 spawn/就绪/超时/脱敏/down/forget/dispose、路由与 targets 校验、client 类型与面板；bootstrap 的 `pnpm test` 覆盖 env 缺失、正常工作、失败与超时。

## 已知限制

- 仅桌面应用（Electron）有标签条；Tauri 壳不渲染远程主机组。
- v1 只支持 harness 工作区；Codex/Cursor/ACP 目录在 host 路由过滤。
- 父端处于 remote 模式时不做工作区实时发现；已保存连接仍可直接打开。
- 同一主机不同工作区需要保存多条 remote 连接；每条连接一个 client 设备与一个子进程。
- 子后端有自己的本地 settings；父端 `cordis.patch.yml` 与 provider 声明的 homeFiles 在 child home 创建时复制。远端会话、模型与经 gateway 的设置来自选中的 Host；纯客户端的皮肤选择、侧栏布局等位于 tab 自己的 webview localStorage，与父页面分区隔离。
- 子页面是 guest webview，没有 desktop 壳的 preload；依赖 `window.dshDesktop` 的客户端插件可能只渲染 Web fallback。
- app-boot 在子 profile 中会跳过一些 `link:` bundle（更新、desktop-tabs、dsh-remote、opencode/mcp 等），这是 app-boot 的解析行为，不是插件的 bundle 清单。
- 设备会出现在账号设备列表；删除连接时回收。远端 Host 的 trusted-peers 上限为 256，不应无限创建连接。
- 子进程需要真实 dsh 运行时与真实 Node；默认 `<runtimeRoot>/.harness` + PATH Node。只有 asar 运行时 + Electron 时会报错；可用 `DSH_REMOTE_TAB_RUNTIME` / `DSH_REMOTE_TAB_NODE` 覆盖。
- 当前 provider 是 ds-harness-remote 0.6.3；通用 core 不直接依赖它，provider 缺失时远程标签功能报不可用。provider 依赖 ds-harness-remote 的运行时字段布局、CLI 输出与 profile 配置语义；升级后需要回归。
