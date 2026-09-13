# DSH Desktop 分析文档独立验证（T5）

本文独立复核 `docs/dsh-gui/2026-09-13-desktop-architecture.md`（下称 T1）与 `docs/dsh-gui/2026-09-13-desktop-api-and-migration.md`（下称 T2）的事实性主张。复核不采信作者自述与作者给出的行号：每条主张都回到源码或命令重新取证据，行号逐条打开确认。

## 验证范围与方法

被验证对象是 T1（175 行）与 T2（250 行）；证据面是 pinned 子模块 `deepseek-harness/`（只读）与本仓库 `src-tauri/`、`plugins/`。

复核动作分四类：一是逐条打开被引用的文件与行号，判断该行确实陈述了被引用的内容；二是对可执行形式化的主张（如 spec 校验、规模计数）重跑轻量命令取独立结果；三是不依赖 T2 清单，自行 grep 枚举 desktop 侧的 IPC、preload、协议与 renderer 消费点，与 T2 清单求差集；四是把文档中与代码矛盾或缺乏证据的条目单独降级。

本次未运行 Electron、未执行发布流水线、未跑重型构建，因此运行时行为类主张不在可验证范围内（见第三节）。

## 一、已复核通过

### 1.1 T1 架构主张抽检

| 编号 | 主张 | 复核方法 | 证据 | 判定 |
|---|---|---|---|---|
| A1 | Electron main 进程职责为桌面项目所有权、自定义协议、窗口与生命周期 | 打开首个文件头 | `deepseek-harness/apps/desktop/src/main.ts:1` 的模块注释逐字对应 | 通过 |
| A2 | 主窗口 `webPreferences` 为 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`，并拒绝 `window.open` 与跳出 `dsh-app:` 的导航 | 读 `createWindow` | `main.ts:89-95` 四项齐全；`main.ts:97` 为 `setWindowOpenHandler(() => ({ action: 'deny' }))`，`main.ts:98-100` 在协议不同于 `dsh-app:` 时 `preventDefault()` | 通过 |
| A3 | 两个窗口、两个 preload、两条加载 URL；主窗口 preload 只暴露 `{ protocolVersion: 1 }` | 读 preload 与加载点 | `main.ts:148`、`main.ts:149` 解析 `preload-app.cjs` 与 `preload.cjs`；`main.ts:363`、`main.ts:325` 分别加载 `dsh-app://app/index.html`、`dsh-app://shell/plugin-manager.html`；`src/preload-app.ts:5` 为 `contextBridge.exposeInMainWorld('dshDesktop', { protocolVersion: 1 })` | 通过 |
| A4 | IPC 处理函数用 `assertDesktopSender` 校验发送方为 `dsh-app:` 且宿主名为 `shell`，调用点为 234、242、246、265、269 | 读函数体与全部调用点 | `main.ts:104-111` 校验 `senderFrame` 非空、协议为 `dsh-app:`、hostname 在白名单内；`main.ts:234,242,246,265,269` 五处均传 `['shell']` | 通过 |
| A5 | Host 侧由自带 Node.js 以 `spawn` 启动，stdio 为 `['ignore','pipe','pipe','pipe','pipe','ipc']`，父进程从 fd 3 与 4 取管道 | 读启动代码 | `host-process.ts:101` 计算 `node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`；`host-process.ts:102-113` spawn 参数与 stdio；`host-process.ts:114-119` 取 `stdio[3]`、`stdio[4]` 并校验类型 | 通过 |
| A6 | Host 入口 `main()` 在 `index.ts:376-578`，用同组 fd 打开管道，经 `runDesktopHost` 组合，`process.send` 上报 `ready` | 读 Host 入口 | `apps/desktop-host/src/index.ts:376` 为 `async function main()`；`index.ts:385-386` 用 `DESKTOP_REQUEST_PIPE_FD`、`DESKTOP_RESPONSE_PIPE_FD` 建流；`index.ts:289-296` 调 `boot`；`index.ts:407-411` 发 `ready` | 通过 |
| A7 | 协议版本 3、请求 fd 3、响应 fd 4、控制 fd 5、数据帧上限 64 KiB、帧头 13 字节、magic `0x44534833` | 读两侧常量与编码器 | `host-protocol.ts:4,7,10,13,16,18,19`；`host-protocol.ts:98-104` 按 0、4、5、9 偏移写入 magic、类型、streamId、载荷长度；Host 侧 `wire.ts:4,7,10,13,15,16` 同值且确实不含 fd 5 声明 | 通过 |
| A8 | Node IPC 只承载生命周期：命令仅 `shutdown`，事件仅 `ready` 与 `fatal`；壳侧做形状校验，非法即失败并 `SIGTERM` | 读类型与两侧处理 | `host-protocol.ts:43-45`、`48-55`；`host-process.ts:137-144` 在 `isDesktopHostEvent` 为假时 `fail` 并 `child.kill('SIGTERM')`；Host 侧 `index.ts:84-87` 只接受 `{ type: 'shutdown' }` | 通过 |
| A9 | 分帧管道承载 Fetch 与流式响应；请求按 start/data/end 顺序、响应有 start/data/end/error 四帧；写入串行化并等待 drain；背压双向；取消走 `cancel` 帧并在 `AbortSignal` 触发时结算 | 读编码与处理路径 | `host-process.ts:222-261` 发 start 后按 `DESKTOP_PIPE_CHUNK_BYTES` 切片发 data，再发 end；`host-protocol.ts:57-75` 四类响应帧；`host-process.ts:263-271` 与 Host 侧 `index.ts:387-395` 串行化写；`host-process.ts:323-326,384-386` 暂停与恢复；`index.ts:513-516,421-423` 请求侧背压；`host-process.ts:175-192` 取消路径 | 通过 |
| A10 | `dsh-app://` 注册为 privileged，`protocol.handle` 按宿主名分派，`shell` 读应用内 `renderer` 并防穿越，`app` 转发当前 Host，无 Host 返回 503，其余 404 | 读注册与分派 | `main.ts:30-40` 注册 `standard`、`secure`、`supportFetchAPI`、`corsEnabled: false`、`stream`、`codeCache`；`main.ts:226` 走 `serveShellAsset`（`main.ts:113-131` 的 405/403/400/404 分支）；`main.ts:227` 其余宿主名 404；`main.ts:228-230` 无 Host 时 503，否则 `active.fetch(request)` | 通过 |
| A11 | Host 侧三类路径分派：`/.dsh/remote-stream`、`/api/`、其余静态资源，`/plugins/` 交给 `clientModules.fetchBundle` | 读分派与静态处理器 | `index.ts:339-343` 三元分派；`index.ts:305` `connection.createSharedFetchHandler('/api')`；`index.ts:185-221` 静态处理器，`index.ts:200` `/plugins/` 前缀走 `ctx.clientModules.fetchBundle`；`index.ts:223-265` NDJSON 桥 | 通过 |
| A12 | 页面注入 `globalThis.__DSH_TRANSPORT__`，把 Remote stream 映射为对 `/.dsh/remote-stream` 的 POST 并逐行解析 NDJSON | 读注入脚本与注入点 | `index.ts:99-120` 脚本常量，`index.ts:102-104` POST + JSON body，`index.ts:112-118` 逐行解析；`index.ts:190` 作为 `webserver/index-inject` 的 head 脚本参与渲染 | 通过 |
| A13 | 组合层禁用了 `web-startup`、`webserver`、`web-runtime` 三行 | 读 patch 文件 | `apps/desktop-host/config/desktop.cordis.patch.yml:3-4,6-7,9-10` 三处 `disabled: true` | 通过 |
| A14 | patch 共禁用 7 行，且在 `web-app` bundle 中逐一对得上，行号与插件名均正确 | 逐行比对两个 patch 文件 | `desktop.cordis.patch.yml:3-4,6-7,9-10,12-13,15-16,18-19,21-22` 与 `packages/bundle/web-app/cordis.patch.yml` 的 `127-128`（`@deepseek-ai/dsh-web-app/startup`）、`135-136`（`@deepseek-ai/dsh-host-webserver`）、`154-155`（`@deepseek-ai/dsh-web-app`）、`167-168`（`@deepseek-ai/dsh-client-hmr`）、`65-66`（`@deepseek-ai/dsh-host-open-in-app`）、`72-73`（`@deepseek-ai/dsh-client-ui-open-in-app`）、`97-98`（`@deepseek-ai/dsh-host-directory-picker-auto`）全部一致 | 通过 |
| A15 | `connection` 行被改写为 `inject: [credentials]`、`config: {}`；web-app 层同注入 `webRuntime` 并取 `ctx.webRuntime.trustedHosts`；Loader 把 `name`、`inject`、`group` 视为替换项 | 读两个 patch 与 Loader | `desktop.cordis.patch.yml:24-27`；`web-app/cordis.patch.yml:181-188`；`vendor/loader/src/config/entry.ts:194` 为 `const replace = diff.some(key => key === 'name' \|\| key === 'inject' \|\| key === 'group')` | 通过 |
| A16 | patch 插入两行 `directory-picker-native`，对应包存在且作为运行时依赖出现在 Host 清单 | 读 patch、查目录、读清单 | `desktop.cordis.patch.yml:29-34`；`packages/host/directory-picker-native` 与 `packages/client/ui-directory-picker-native` 均存在；`apps/desktop-host/package.json:21,23` 两行依赖 | 通过 |
| A17 | 组合后额外做两件事：把 `agent-presets` 的 roots 指向 dsh 包内 `config/agent-presets` 且信任级为 `system`；非开发模式下强制每个 bundle 的 `packageDir` 落在 profile 内 | 读 `desktopPatches` | `index.ts:166-175` 追加 `roots: [{ path: join(dshRoot, 'config', 'agent-presets'), trust: 'system' }]`；`index.ts:152-159` 在 `allowLinkedPackages` 为假时对每层 `packageDir` 调 `isProjectPath`并在越界时报错 | 通过 |
| A18 | 组合必须提供 `connection`、`typertGateway`、`clientModules` 三者，否则释放 fiber 并报错 | 读启动校验 | `index.ts:298-304` 取三者，任一 `undefined` 即 `await ctx.fiber.dispose()` 后抛错 | 通过 |
| A19 | 桌面状态全部位于 `$DSH_HOME/desktop`，活动 profile 固定为 `$DSH_HOME/profiles/desktop`；同目录有 `staging/`、`rollback/profile/`、`pending.json`、`lock` 与 pnpm 五个子目录 | 读路径解析 | `src/paths.ts:30` 为 `join(dshHome, 'desktop')`；`paths.ts:34` 为 `join(dshHome, 'profiles', 'desktop')`；`paths.ts:35-38` 四个路径；`paths.ts:39-46` `store`、`cache`、`state`、`config`、`home` | 通过 |
| A20 | profile 清单名固定 `@deepseek-ai/dsh-desktop-runtime`、`private` 必须为 `true`；依赖指向 `desktop-packages/` 本地 `file:` tarball；事务复制 5 个元数据文件加 `desktop-packages/` 目录 | 读清单校验与复制函数 | `project-manager.ts:102` 常量；`project-manager.ts:258-262` 校验 `value.private !== true` 即抛错；`core-package-set.ts:108-123` 生成 `file:./desktop-packages/<file>`；`project-manager.ts:39-45` 与 `193-204` 的复制集合 | 通过 |
| A21 | 单实例锁在模块顶层、`app.whenReady()` 之前调用；未获锁即 `quit()` 并返回 `false`；持有者注册 `second-instance` | 读调用点与实现 | `main.ts:386` 模块顶层调用；`main.ts:388` 之后才 `app.whenReady()`；`single-instance.ts:20-25` 的逻辑；`main.ts:350-360` 的 `focusPrimaryWindow` 负责聚焦或重建主窗口 | 通过 |
| A22 | 事务锁以 `openSync(path, 'wx')` 独占创建、写入持有者 PID、用 `process.kill(pid, 0)` 判定存活；pnpm 子进程启动后把 PID 改为子进程，退出后改回 Electron | 读锁实现与 PID 移交 | `project-manager.ts:649`、`656-668`；`project-manager.ts:595`（`writeLockOwner(childPid)`）与 `613-618`（`writeLockOwner(process.pid)`）；README.md:52 的深度防御表述一致 | 通过 |
| A23 | CLI 侧在 profile 名大小写不敏感等于 `desktop` 时报错，错误信息为 `error: profile "desktop" is managed exclusively by the Electron application` | 读参数解析 | `apps/cli/src/args.ts:69-70` 逐字一致 | 通过 |
| A24 | `applyRelease` 先 `recover()`、`verifySeedIntegrity`、校验本地包集合、要求 seed 版本等于 Electron 版本；复用条件同时比对 release 文件版本、已装 dsh 版本与 Host 版本 | 读实现 | `project-manager.ts:396-402`、`403-408`；`core-package-set.ts:131-159` 的校验；README.md:41-48 的 6 步与之对应 | 通过 |
| A25 | 健康检查先停活动 Host、起停 staged Host、再重启活动 Host，两者皆失败抛 `AggregateError`；激活写 `pending.json` 三段并做目录搬移，失败时回滚；恢复函数做反向搬移并清理 staging | 读 hooks 与激活/恢复 | `main.ts:164-194`（含 `main.ts:187-190` 的 `AggregateError`）；`project-manager.ts:519-549`（`prepared`→`active-moved`→`staging-activated` 与失败回滚）；`project-manager.ts:342-363` | 通过 |
| A26 | seed 完整性遍历全部文件、拒绝符号链接与非普通文件、按 SHA-256 与 `integrity.json` 逐项比对 | 读实现 | `project-manager.ts:206-229`（`seedFiles` 的符号链接与非普通文件拒绝）与 `231-251`（逐项 JSON 比对） | 通过 |
| A27 | 核心包集合要求目录文件名集合与描述符完全一致、每个 tarball 的字节数与 `sha512` 匹配；lockfile 中本地化的核心包若以 registry 版本出现即报错 | 读两个校验函数 | `core-package-set.ts:137-157`（文件名集合比对、`bytes` 与 `sha512` 校验）与 `170-183`（正则匹配 lockfile 的 registry 解析行） | 通过 |
| A28 | pnpm store 按「路径 SHA-256 取模分片数」分到最多 256 个分片（默认 16），写成不压缩 tar 并记录条目数；解压前校验归档集合、路径安全、分片归属与条目总数；随后复制非索引文件并以事务 `INSERT OR REPLACE` 合并索引 | 读打包、解压与合并 | `seed-store.ts:62-64`、`25`（`DEFAULT_SHARD_COUNT = 16`）、`179-181`（上限 256）、`187-203`、`214-258` 的四项校验、`151-166` 与 `120-144`（`BEGIN IMMEDIATE` + `INSERT OR REPLACE` + `COMMIT`） | 通过 |
| A29 | pnpm 调用只用自带 Node 与自带 pnpm，注入四个 `--config.*`，`XDG_*`、`PNPM_HOME`、`COREPACK_HOME`、`NPM_CONFIG_*` 指向桌面目录，继承环境剔除 `DSH_DESKTOP_*`、`npm*`、`pnpm*`、`corepack*`；`allowBuilds` 只在 `pnpm-workspace.yaml` 显式列出 | 读 `runPnpm` 与 `workspaceFile` | `project-manager.ts:564-586`；`project-manager.ts:560-562` 的过滤正则；`project-manager.ts:124-134` 的 `allowBuilds` 段 | 通过 |
| A30 | `packageNameFromSpec` 拒绝空串、前导 `-`、空白与反斜杠、含 `://`、`file:` 开头；安装后必须能找到清单并声明 `dsh.bundle.patch` 且 patch 路径不越出包目录 | 读两个函数 | `project-manager.ts:163` 的五个拒绝条件；`project-manager.ts:305-326` 的清单、`dsh.bundle.patch` 与路径校验 | 通过 |
| A31 | 版本同一性：Electron、`@deepseek-ai/dsh`、桌面 Host 与仓库根清单在 `dsh-v0.1.5-rc.2` 中同为 `0.1.5-rc.2`；三处代码强制 | 读四份 manifest 与三处校验 | `apps/desktop/package.json:4`、`apps/cli/package.json:2,4`、`apps/desktop-host/package.json:4`、根 `package.json:2-3` 均为 `0.1.5-rc.2`；`project-manager.ts:400-402`；`scripts/package-target.ts:102-106`（`dshVersion` 取自 `REPOSITORY_ROOT`）；`scripts/prepare-seed.ts:55` | 通过 |
| A32 | `desktop-release.json` 携带 `hostProtocolVersion`，解析时必须等于 3 | 读类型与解析 | `src/release.ts:11` 字段声明；`release.ts:23` 的 `value.hostProtocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION` 即抛错 | 通过 |
| A33 | `electron-updater` 协调器构造时关闭自动下载与自动安装，默认启用条件为已打包且存在 `app-update.yml`；`install()` 先等 `checkOperation`；安装流程为下载、发 `ready`、`beforeRestart`、`quitAndInstall(false, true)` | 读协调器 | `update-coordinator.ts:26-32`、`43-50`、`74-93`；`main.ts:214-222` 的 `beforeRestart`；`main.ts:368` 的 10 秒检查；`main.ts:337` 的菜单项 | 通过 |
| A34 | 发布侧由 electron-builder 生成 generic provider 元数据，macOS 为 `dmg` 与 `zip`，Windows 为 `nsis`，NSIS 打开差分包 | 读配置 | `electron-builder.config.mjs:105`（`publish: [{ provider: 'generic', url: update.publicUrl }]`）、`70`（`target: ['dmg', 'zip']`）、`94`（`target: ['nsis']`）、`100-104`（`differentialPackage: true`） | 通过 |
| A35 | 规模表九个数字 | 用 `Get-ChildItem` 统计文件数与物理行数 | `apps/desktop/src/*.ts` 14/2576；`apps/desktop-host/src/*.ts` 2/771；`apps/desktop/renderer/*` 3/244；`apps/desktop/scripts/*` 21 个模块（另有 `windows-sign.cmd` 17 行不计入）加 `electron-builder.config.mjs` 109 行与 `tsdown.config.ts` 30 行共 23 文件、3100 行；`apps/desktop/tests/*.spec.ts` 17/2381；`src-tauri/src/*.rs` 8/5503；`src-tauri/ui/*` 4 个文本文件共 4851 行（另有二进制 `window-icon.png` 不计）；`main.rs` 内 `#[cfg(all(test, windows))] mod tests` 自 `main.rs:1616` 至文件末共 118 行；`update_script.mjs` 305 行 | 通过 |
| A36 | Agent Note 的四处引用 | 打开 note 对应行 | `note:17` 含 "The Connection plugin provides its carrier-neutral RPC and Fetch registries without requiring `webServer`" 与 "it opens no listening port"；`note:21` 含一次发布编号同时标识 Electron 与精确 dsh、Host 依赖；`note:33` 为职责表的 `Installed dsh package` 一行；`note:72` 为 "The process-lifetime Electron lock is the authoritative Desktop owner."；`note:29-35` 正是该职责表 | 通过 |

### 1.2 T2 API 与迁移主张抽检

| 编号 | 主张 | 复核方法 | 证据 | 判定 |
|---|---|---|---|---|
| B1 | 稳定性三条判据，以及 `DESKTOP_IPC`、`DshDesktopApi`、`DesktopUpdateState` 判为私有实现的依据 | 读自述注释与 README | `ipc.ts:1` 为 "Typed preload operations exposed only by the Electron shell"；`ipc.ts:6` 为 "IPC channel names kept private to the desktop application bundle"；`apps/desktop/README.md:26,28` 只有自然语言描述，未命名标识符；跨包 import 仅存在于同目录内 | 通过 |
| B2 | 8 个 IPC channel 的名称与注册点 | 自行 grep 并与 `DESKTOP_IPC` 定义逐项比对 | `ipc.ts:8-15` 八个键名与 T2 表一致；注册点 `main.ts:241,245,250,254,258,264,268` 七个 `ipcMain.handle`，`updatesState` 为 `main.ts:154` 的 `webContents.send`，无 invoke 注册 | 通过 |
| B3 | `DshDesktopApi` 成员、preload 实现与 `DesktopUpdateState` 六态的行号 | 打开两个文件 | `ipc.ts:27,28,30,31,32,33,36,37,38,20` 与 `preload.ts:8,10,11,12,13,16,17,18-22` 全部命中；`publishUpdate` 在 `main.ts:151-157` 广播、发送点 `main.ts:154` | 通过 |
| B4 | `assertDesktopSender` 要求 `senderFrame` 非空、协议为 `dsh-app:`、hostname 在调用方白名单内，否则抛 `rejected IPC from an unowned renderer`；插件与更新类 channel 全部传 `['shell']`；开发模式整体拒绝插件变更并让列表返回空数组；菜单项在开发模式 `enabled: false`；变更成功后强制重载主窗口 | 读函数与调用点 | `main.ts:104-111`（非空分支抛 `rejected IPC without a sender frame`，协议或宿主名不符抛 `rejected IPC from an unowned renderer`）；`main.ts:234,242,246,265,269`；`main.ts:235-237`、`247`、`334`；`main.ts:239` | 通过 |
| B5 | wire 协议：fd 3/4/5、13 字节帧头、magic、1 字节类型、4 字节大端 streamId、4 字节大端长度、streamId 范围 1 到 `0xffff_ffff`、数据帧 64 KiB 上限、控制帧 1 MiB 上限、请求帧顺序约束与 Host 侧独立同值常量 | 读两侧源码 | `host-protocol.ts:7,10,13,18,19,86-90,94,16,20,99-102`；`wire.ts:7,10,15,16`；请求帧类型与编码 `host-protocol.ts:22-25,35,112,117,122,127`；`index.ts:457-461` 对 `frame.streamId <= lastStreamId` 抛 `Electron reused or reordered request stream`；`wire.ts:104` 的注释明示不跨进程传 Error 对象 | 通过 |
| B6 | 响应帧四类与解码校验（`status` 在 100 到 599、载荷上限、end 帧载荷必须为空） | 读解码器 | `host-protocol.ts:29-32,162-165,171-181,185-198,200-206` | 通过 |
| B7 | `dsh-app://` 的 scheme、六项 privileges、两条路由与 MIME 表；`shell` 只服务 `app.getAppPath()/renderer`，非 GET 与 HEAD 为 405、越界 403、坏百分号编码 400、未命中 404；`app` 为唯一进入 dsh 后端的入口 | 读 `main.ts` | `main.ts:23,30-40`（`standard`、`secure`、`supportFetchAPI`、`corsEnabled: false`、`stream`、`codeCache`）；`main.ts:114,119-121,124`、`127,129`；`main.ts:226,227-230`；`main.ts:42-47`；Host 侧 MIME 表 `index.ts:122-129` 多出 `.json` 与 `.webmanifest` | 通过 |
| B8 | `__DSH_TRANSPORT__` 是客户端扩展点，`ownsHost: true` 使 `ctx.connection.isLoopback` 恒真，`openStream` 以 POST `/.dsh/remote-stream` 打 NDJSON；该接口在上游有公开文档；gateway 缺失时返回 503 | 读脚本常量、上游接口与 Host 处理器 | `index.ts:99-120`（`ownsHost:true`）；`packages/client/connection/src/client/index.ts:80` 起为导出的 `ClientTransportHooks`，`91-99` 为 `ownsHost` 的完整注释，且该包 `package.json:21-23` 公开 `./client` 入口；`index.ts:229` 在 `gateway === undefined` 时 503；`index.ts:227,236-238,262` 的 POST、body 校验与 `application/x-ndjson` | 通过 |
| B9 | `connection` 服务的 RPC 注册入口在 `owner.webServer.register(route)` 上注册；`createSharedFetchHandler` 的精确路由表由 `registerFetchRoute` 写入；profile 自身 `cordis.patch.yml` 作为用户层被读入 | 读上游源码 | `rpc-host.ts:158-182`（`owner.effect(() => owner.webServer.register(route))`）；`rpc-host.ts:139-156` 与 `117-137`；`packages/boot/app-boot/src/profile.ts:799-802` | 通过（该行对 `connection.rpc.handle` 成立；`connection.fetch.register` 的判定见 E5） |
| B10 | dsh-gui 远程连接现状：`inject = ['webServer']` 硬依赖、回环自检拒绝非 `127.0.0.1`、注册前缀路由、teardown 挂进 `ctx.effect`、SSH 与 Docker 隧道实现位置、凭据实现位置 | 逐行打开 | `plugins/remote/dsh-remote/src/index.ts:74`（`export const inject = ['webServer']`）、`1174`（`ctx.webServer.host !== '127.0.0.1'`）、`1181`（`ctx.webServer.register({`）、`1188`（`ctx.effect(() => () => {`）、`784`（`openTunnel`）、`802`（`createServer`）、`1036`（`openDockerTunnel`）、`1237`（`credFile`） | 通过 |
| B11 | Tauri 侧 `remote_call` 把 op 限制在 21 个白名单项内，用裸 `TcpStream` 向 `127.0.0.1:<port>` 发 POST；`/remote-api/<op>` 路径；UI 由 `app.js` 驱动；插件浏览器半已置为 inert | 读 Rust 与 UI 源码 | `src-tauri/src/main.rs:1148-1170` 的 `REMOTE_OPS` 实测 21 项；`main.rs:1180-1186` 的 `http_post_json_raw` 建 `TcpStream`；`main.rs:1245-1247` 拼 `/remote-api/{op}`；`main.rs:1172-1179` 的注释说明跨源与信任围栏；`src-tauri/ui/app.js:455` 调 `remote_call`、`app.js:318` 调 `view_create`；`plugins/remote/dsh-remote/docs/README.md:108` 的 inert 表述 | 通过 |
| B12 | desktop 自带的插件事务比 dsh-gui 更严格：spec 校验、精确版本、bundle 校验、staging 事务、激活日志与恢复、两级锁、内置 pnpm 与离线 store、插件窗口 UI、壳与 dsh 一起升级 | 逐条打开 `project-manager.ts` 等 | `project-manager.ts:162-180`、`108`、`153-155`、`494`、`305-326`、`440-456`、`519-549`、`67-73`、`342-363`、`single-instance.ts`、`645-682`、`551-587`、`paths.ts:29-47`、`renderer/plugin-manager.js:29-96`、`update-coordinator.ts:74-94`、`project-manager.ts:400-402` | 通过 |
| B13 | `packages` 全域 grep `desktopProfiles` 与 `desktopPnpm` 无匹配；`dsh-market` 的 desktop 分支依赖这两个服务名 | 自行 grep | 在 `deepseek-harness/packages/` 下检索两名称命中 0 次；`plugins/plugin-market/dsh-market/src/index.ts:87` 为 `hostCtx.inject(['desktopPnpm'], ...)`，`index.ts:62,88` 读取 `desktopProfiles` | 通过 |
| B14 | §3.4 六插件的宿主入口 `inject` 位置与内容 | 逐个打开被引用的行 | `plugins/remote/dsh-remote/src/index.ts:74` = `['webServer']`；`plugins/deep-whale/dsh-deep-whale/skin-manager/src/index.ts:18` = `['webServer']`；`plugins/better-sidebar/DSH-better-sidebar/src/index.ts:83` 与 `plugins/better-sidebar/dsh-sidebar-qa/src/index.ts:83` 两项均含 `webServer`；`plugins/dsh-pet/dsh-pet/dsh-pet/src/host/index.ts:70` 以 `webServer` 起头；`plugins/dsh-web-ui/dsh-web-ui/packages/dsh-plugin-manager/src/index.ts:26` 与 `packages/dsh-market/src/index.ts:21` 均含 `webServer`；`plugins/plugin-market/dsh-market/src/index.ts:60` 为 `ctx.inject(['webServer', 'loader'], ...)`；安装方式与 `install.mjs` 的 `installPlugin` 与 `installNpmPlugin` 调用一致 | 通过 |

### 1.3 独立枚举差集比对

不依赖 T2 清单，直接对 `deepseek-harness/apps/desktop` 与 `apps/desktop-host` 检索五类出现点，再与 T2 清单求差集。

| 类别 | 我的枚举结果 | 与 T2 清单的差集 |
|---|---|---|
| `ipcMain.handle` | 7 处：`main.ts:241,245,250,254,258,264,268` | T2 表列出这 7 个 invoke/handle channel 加 1 个 send-only channel；无漏项、无多项 |
| `ipcRenderer.invoke` | 7 处：`preload.ts:8,10,11,12,13,16,17` | 与 T2 清单一一对应 |
| `ipcRenderer.on` 与 `off` | 1 组：`preload.ts:20,21` | T2 的 `updates.subscribe` 行已覆盖 |
| `contextBridge.exposeInMainWorld` | 2 处：`preload.ts:26`、`preload-app.ts:5` | 与 T2 的「两个 preload 各暴露一个对象」一致 |
| `protocol.handle` | 1 处：`main.ts:224` | T2 §2.3 的「只有一处」成立 |
| `dshDesktop` | 3 处：`preload-app.ts:5`、`preload.ts:26`、`renderer/plugin-manager.js:1` | T2 未列 renderer 侧消费点；不构成漏项（消费方不是暴露面），建议补一句说明 |

结论：T2 的 IPC 与协议清单没有漏项，也没有把不存在的 channel 写进清单。

## 二、有误或需修正

### E1（实质性）T2 §1.2 与 §3.2 对 `plugins.update` 的版本校验表述与代码不符

主张：`DshDesktopApi.plugins.update(name, version)` 的 `version`「必须是精确版本，不接受版本范围、`latest`、GitHub 简写或 tarball URL」（`2026-09-13-desktop-api-and-migration.md:46`）。

复核方法：打开 `assertVersion` 使用的正则并实跑匹配。

证据：`project-manager.ts:108` 定义 `VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u`，`project-manager.ts:153-155` 的 `assertVersion` 只做该正则匹配，`plugin-update` 分支在 `project-manager.ts:489-494` 调用它后拼 `name@version`。用同一正则实测：`latest` 为真、`beta` 为真、`next` 为真、`1.x` 为真，而 `^1.2.3`、`~1.2.3`、`>=1.0.0`、`1.2.3 || 2.0.0`、`*` 为假。

判定：需修正。代码确会拒绝含空白、`^`、`~`、`*`、`||` 的规格，但接受 `latest` 这类 tag 与 `1.x` 这类范围写法；T2 同一文档第 44 行对 `plugins.add` 写的是「可带精确版本或 tag」，两处自相矛盾。

修改建议：把该行改为「版本字面量经 `VERSION_PATTERN` 校验并按 `--save-exact` 落盘；含空白、`^`、`~`、`*`、`||` 的版本范围与 `://`、`file:` 规格被拒绝，但 `latest` 等 tag 名与 `1.x` 写法会通过校验，最终解析版本由 registry 决定」。`§3.2` 的「精确版本」行应同步改述，不要用「精确版本」概括该正则。

### E2（实质性）T2 §2.3 与 §4 关于「host 半不存在任何路由注册点」的结论过强

主张：`2026-09-13-desktop-api-and-migration.md:154` 称「profile bundle 只能插入 Loader 行；宿主能力需要 HTTP 入口，而 desktop 不向插件开放任何路由注册点」，`§4` 据此得出「不存在通过 profile bundle 或 Cordis 插件在 host 半实现远程连接的路径」。

复核方法：读 `connection` 服务的公开注册面，确认其两个注册表各自的前置条件，再对照 desktop Host 的分派路径。

证据：`packages/client/connection/src/rpc.ts:127-135` 把 `HostConnectionFetch.register` 写成「Host registry for exact Fetch routes that cannot use JSON Remote invocation」；`rpc-host.ts:89-94` 的 `get fetch()` 直接委派到 `registerFetchRoute`，而 `rpc-host.ts:139-156` 只把路由写入本地 `fetchRoutes` 映射，全程不访问 `webServer`；`rpc-host.ts:117-137` 的 `createSharedFetchHandler` 在请求时才读该映射；`rpc-host.ts:292-303` 的 `assertFetchRoute` 只要求路径能通过 `endpointFromPath(API_PATH, ...)`，而 `api-path.ts:6` 定义 `API_PATH = '/api'`。desktop Host 在 `apps/desktop-host/src/index.ts:305` 取 `connection.createSharedFetchHandler('/api')`，并在 `index.ts:341-342` 把 `/api/` 前缀的请求交给它。T1 第 33 行引用的 `note:17` 原文同样写着 "The Connection plugin provides its carrier-neutral RPC and Fetch registries without requiring `webServer`"。

判定：需修正（结论过强）。desktop 确实存在一个宿主侧路由注册点：任何能注入 `connection` 的 profile bundle 插件都可以用 `ctx.connection.fetch.register({ path: '/api/<segment>', ... })` 注册一个经 `dsh-app://app/api/<segment>` 到达的精确路由。该注册点受 `/api/` 前缀约束、不能注册任意前缀、不能开监听端口，因此仍不足以承载 `/remote-api/*` 那种跨源 HTTP 形态；但「没有任何注册点」的表述与代码和上游设计说明都不符。

修改建议：把 `§2.3` 第三条与 `§4` 的对应句改为「宿主侧唯一可用的路由注册点是 `connection` 的精确 Fetch 路由表，路径被限制在 `/api/` 前缀下；它能提供页面内可达的宿主处理函数，但不能注册任意 HTTP 前缀、不能监听端口，因此远程连接所需的 `/remote-api/*` 形态仍不可迁移」。`§2.3` 第一种形态（改上游私有包）可与这一条并列讨论，说明「无需改 desktop 源码」的上限止于 `/api/`。

### E3（实质性）T2 §5 第 5 条关于 `ai-update` 宿主入口的陈述与代码矛盾

主张：`2026-09-13-desktop-api-and-migration.md:249` 称「它的宿主入口不注入 `webServer`（只声明类型，`plugins/ai-update/dsh-ai-update/src/context-types.ts`）」。

复核方法：检索该插件宿主入口的全部注入声明。

证据：`plugins/ai-update/dsh-ai-update/src/index.ts:295` 为 `ctx.inject(['webServer', 'llm', 'agentDefaultModel', 'loader'], () => {`。`context-types.ts:28-29` 确实只声明 `AiUpdateWebServer` 类型，但那不是宿主入口的注入面。

判定：需修正（事实错误）。该插件宿主入口以 `ctx.inject` 声明了 `webServer`。

修改建议：改为「宿主入口在 `plugins/ai-update/dsh-ai-update/src/index.ts:295` 以 `ctx.inject(['webServer', 'llm', 'agentDefaultModel', 'loader'], ...)` 声明依赖；`context-types.ts:28-29` 只声明 `webServer` 服务面的类型」。

### E4（实质性）T2 §3.4 与 §3.5 的「6 个插件」清单漏项

主张：`§3.4` 与 `§3.5` 把受 `webServer` 阻塞的本仓库插件固定为 6 个（`remote`、`deep-whale`、`better-sidebar`、`dsh-pet`、`dsh-web-ui`、`plugin-market`），并把 `ai-update` 列为待定。

复核方法：用同一判据（宿主入口是否以注入声明硬依赖 `webServer`）重新枚举。

证据：除 E3 的 `plugins/ai-update/dsh-ai-update/src/index.ts:295` 外，§3.4 表内 6 项的位置与内容全部核对通过（见 B14）。

判定：需修正（清单漏项）。按 T2 自述的判据，`ai-update` 也应列入受 `webServer` 阻塞的一组，数量为 7。

修改建议：把 `ai-update` 并入 `§3.4` 表，并在「在 desktop 中的结果」列注明它与前 6 项的性质差异：前 6 项因顶层 `export const inject = ['webServer']` 使整个 fiber 保持 pending，而 `ai-update` 的插件体会 apply，只有 `ctx.inject` 回调及其宿主机路由不挂载。`§3.5` 的计数随之更新。

### E5（低危）T2 §1.4 把连接服务的两个注册入口合并引用

主张：`2026-09-13-desktop-api-and-migration.md:234` 称 `connection` 服务的「两个注册入口都依赖 `webServer`（`rpc-host.ts:165`、`rpc-host.ts:179`）」。

复核方法：打开两个被引用行并确认其所属函数与另一个注册入口的前置条件。

证据：`rpc-host.ts:165` 与 `rpc-host.ts:179` 同属 `rpc-host.ts:158-182` 的 `register` 方法内部，前者构造 `WebRoute`，后者调用 `owner.webServer.register(route)`；它并不构成「两个入口」。另一个入口 `registerFetchRoute`（`rpc-host.ts:139-156`）不访问 `webServer`。

判定：需修正（引用与表述错误）。该句与 E2 同源。

修改建议：改为「`connection.rpc.handle` 经 `rpc-host.ts:158-182` 依赖 `webServer`；`connection.fetch.register` 经 `rpc-host.ts:139-156` 只写本地精确路由表，不依赖 `webServer`」。

### E6（低危）T2 §3.3 的测试引用缺少路径，且被引用的上游文件不存在

主张：`2026-09-13-desktop-api-and-migration.md:198` 用「`desktop-runtime.spec.ts:207`–`desktop-runtime.spec.ts:225`」固定「第三方 desktop 边界只接受 `name@1.2.3`」这一事实。

复核方法：在上游 `apps/desktop/tests/` 列目录并全仓查找该文件名。

证据：`deepseek-harness/apps/desktop/tests/` 下 17 个 spec 中没有 `desktop-runtime.spec.ts`；该文件实际位于本仓库 `plugins/plugin-market/dsh-market/tests/desktop-runtime.spec.ts`，其 `207-225` 断言 `supportsExactRollbackTarget('example-plugin@1.2.3')` 为真、`github:owner/repo#...` 与 `https://...tgz` 为假。按 T2 第 5 行「本仓库源码引用相对仓库根」的约定，该引用本应带 `plugins/plugin-market/...` 前缀。

判定：需修正（引用位置错误，事实本身成立）。该测试固定的是第三方 desktop 边界（`desktopProfiles`/`desktopPnpm`）的行为，不是官方 desktop 的校验函数。

修改建议：把引用补全为 `plugins/plugin-market/dsh-market/tests/desktop-runtime.spec.ts:207-225`，并说明它验证的是第三方宿主边界；官方 desktop 的拒绝行为另行由 `project-manager.ts:163` 支持。

### E7（低危）T2 §2.1 把 Tauri 的子 webview 称作 iframe；T2 关于壳页面源的表述缺乏仓库证据

主张：`2026-09-13-desktop-api-and-migration.md:128` 称「壳页面源是 `tauri://`」，`129` 称「每个连接一个子 iframe」。

复核方法：检索仓库内 `tauri://` 字面量，并读 Tauri 侧的视图创建实现。

证据：`src-tauri/` 全目录检索 `tauri://` 命中 0 次；`main.rs:1172-1176` 的注释只写 "the shell page lives on the app origin"。视图实现为子 webview：`src-tauri/src/views.rs:174-193` 用 `WebviewBuilder::new(...)` 与 `window.add_child(...)`；`main.rs:12` 的模块注释明确写 "no iframe"。T1 在同一处使用的「子 webview」与源码一致。

判定：需修正（术语）。「子 iframe」与源码注释直接冲突；「`tauri://`」在当前仓库没有可引用的证据，运行时原源取决于 Tauri 平台与配置，本次无法据此断言。

修改建议：把「iframe」统一改为「子 webview」；把壳页面源改为「应用源（app origin），与 `http://127.0.0.1:<port>` 跨源」，不写具体 scheme。

### E8（低危）T1 §1.1 的 privileges 列举不全

主张：`2026-09-13-desktop-architecture.md:15` 称该方案「带 `standard`、`secure`、`supportFetchAPI`、`stream` 与关闭 CORS 的权限」。

复核方法：读注册调用。

证据：`main.ts:30-40` 实际声明六项，除上述五项外还有 `codeCache: true`。T2 的 `§1.4`（其第 103 行）已完整列出六项。

判定：需修正（枚举不全，未声称穷举，风险低）。

修改建议：补上 `codeCache`，或改为「带 `standard`、`secure`、`supportFetchAPI`、`stream`、`codeCache` 与关闭 CORS 的权限」，与 T2 保持一致。

## 三、无法验证

1. T1 与 T2 中依赖实际运行环境的结论：T1 `§不确定项` 第 1、4、5 条（发布流水线未运行、macOS 种子行为未复现、未运行 Electron）与 T2 `§五` 第 1、2、3、4 条（`process-manager` 与 `subprocess` 在 Electron 内置 Node 上是否注册成功、`typertGateway.wireStream` 的 endpoint 集合、desktop profile 用户补丁层的生命周期、`dsh-pet` 对 `electron` 的可选依赖）。本次只做只读核对，同样无法验证这些运行时行为；两份文档已自行标注为不确定项，标注本身与本次能力边界一致。
2. T1 `§不确定项` 第 2 条与 T2 对上游历史的引用：文档把「desktop 于 `dsh-v0.1.5-alpha.1` 的 commit `19444907f0` 引入」记为来自任务描述且未核对 git 历史。本次同样未执行 git 历史查询，无法验证。
3. T2 `§2.1` 关于壳页面源的具体 scheme（见 E7）：仓库内没有 `tauri://` 证据，实际值取决于 Tauri 平台与 `frontendDist` 的运行期解析，未在本次范围内复现。
4. T2 `§3.1` 路径 A 与路径 B 引用的行号：`scripts/plugin-install.mjs:108,432,307-313,336-343,447-452`、`src-tauri/src/update.rs:342,530-547`、`src-tauri/ui/app.js:1651,1679,1730`、`docs/dsh-gui/update-check.md:49-57`、`docs/dsh-gui/2026-09-11-harness-upgrade-v0-1-5-rc-2.md:7` 未逐条抽查。这些引用不承载 T2 的核心结论，但完整复核前不应视为已验证。

## 四、总体判定

T1 的 36 个抽检项全部通过，唯一问题是 privileges 列举不全（E8），属低危表述问题；其规模表九个数字、patch 对照表、wire 协议与事务路径的引用精度都很高。

T2 的 14 个抽检项通过，但发现 4 处实质性问题：`plugins.update` 的版本校验主张与代码不符（E1）、「host 半不存在任何路由注册点」的结论过强且与上游说明矛盾（E2）、`ai-update` 宿主入口的陈述与代码矛盾（E3）、受 `webServer` 阻塞的插件清单漏 1 项（E4），另有 4 处低危问题（E5 至 E7 与 B9 的限定）。

其中 E2 与 E4 会改变读者对结论强度的理解：E2 影响「远程连接必须改上游源码」这一结论的绝对性，E4 影响 pending 插件数量的计数。两份文档的独立枚举差集比对未发现 IPC 或协议清单漏项。

在这 8 项修正完成前，建议不把两份文档按现状放行；修正成本集中在 T2 的 `§1.2`、`§2.3`、`§3.3`、`§3.4`、`§3.5`、`§4` 与 `§五`，T1 只需改 `§1.1` 一行。
