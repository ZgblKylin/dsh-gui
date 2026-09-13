# DSH Desktop 升级的插件不兼容失败边界与 AI 兼容性预检（T11）

## 结论摘要

打包版 desktop 的每次启动都在创建任何窗口之前先等待一次 profile 对账：`deepseek-harness/apps/desktop/src/main.ts:205-211` 调用的 `manager.applyRelease(...)` 早于 `deepseek-harness/apps/desktop/src/main.ts:362` 的 `createMainWindow()`。该调用没有被 `try` 包裹，抛错时整个 `main()` 进入模块顶层的 catch，弹原生错误框并以退出码 1 结束进程（`deepseek-harness/apps/desktop/src/main.ts:388-397`）。主窗口创建之后才存在的 `dsh-app://app` 503 降级分支（`deepseek-harness/apps/desktop/src/main.ts:228-230`）在这条路径上不可达。

**用户最关心的问题的答案：插件不兼容是否让应用无法启动，取决于失败落在宿主半还是浏览器半。** 宿主半的 fiber 停在 pending 或 failed 时，Cordis 启动审计把两者一律判为启动失败（`deepseek-harness/packages/boot/app-boot/src/index.ts:722-755`），staged 后端因此拿不到 `ready`，健康检查失败，对账抛错，应用每次启动都失败；只在浏览器半失败（例如请求了模块表里没有的裸模块）不会被健康检查发现，也不阻塞宿主启动；其后果范围见 3.2 第 1、2 条与第六节第 4 条。

`deepseek-harness/apps/desktop/src/project-manager.ts:400-402` 的版本校验比较的是**打包 seed 的 `desktop-release.json` 与 Electron 自身版本**，不是旧 active profile 与 seed。它拒绝的是「签名发布包内部不自洽」；旧 profile 过期的处理在 `deepseek-harness/apps/desktop/src/project-manager.ts:403-408` 的复用快速路径与 `412-424` 的离线插件恢复。

启动失败后的恢复路径只有两类：装回上一版发布包，或手工修 profile。`rollback/profile` 只服务于目录替换被中断的恢复（`deepseek-harness/apps/desktop/src/project-manager.ts:342-363`、`519-549`），不是插件不兼容时的自动回滚；代码里没有「用旧 active profile 起窗」的任何分支。

### 判定速查

| 不兼容形态 | 判定位置 | 打包版结果 |
| --- | --- | --- |
| 宿主半 `inject` 的服务在新版不存在，或 `apply` 抛错，或原生模块加载失败 | 审计的条目遍历与判定见 `deepseek-harness/packages/boot/app-boot/src/index.ts:726-747` | 无法启动，且每次启动重复失败 |
| 插件声明不合 bundle 契约（缺 `dsh.bundle.patch`、patch 越界或文件不存在） | `deepseek-harness/apps/desktop/src/project-manager.ts:305-326` | 无法启动 |
| 插件 patch 插入的 Loader 行 id 与既有行重复 | 先例见 `plugins/README.md:56-69` | 无法启动 |
| 依赖含 build script 且包名不在 `allowBuilds` | `deepseek-harness/apps/desktop/src/project-manager.ts:124-134`、`deepseek-harness/apps/desktop/README.md:179` | 无法启动 |
| `dsh.client` 声明非法、缺 `./client` 导出或产物文件缺失 | `deepseek-harness/packages/client/modules/src/index.ts:559-568`、`767`、`892` | 无法启动 |
| 浏览器半请求了不在 `PLATFORM_MODULES` 的裸模块 | `deepseek-harness/packages/client/modules/src/client/system.ts:205-211` | 启动成功，该插件 UI 失效 |
| 插件在运行期对某个请求报错 | `deepseek-harness/apps/desktop-host/src/index.ts:361-367` | 应用存活，单个请求失败 |

## 一、升级链路与逐步失败语义

### 1.1 下载与安装：应用仍在运行，失败不改变任何 profile 状态

自动检查在主窗口就绪 10 秒后触发，菜单项触发同一路径（`deepseek-harness/apps/desktop/src/main.ts:368`、`337`、`273-313`）。可用版本进入原生确认对话框，用户接受后才开始下载与安装（`deepseek-harness/apps/desktop/src/main.ts:295-312`）。

`deepseek-harness/apps/desktop/src/update-coordinator.ts:26-31` 在构造时关闭自动下载与自动安装，默认启用条件是「已打包且资源目录存在 `app-update.yml`」。检查失败或没有可用版本只发布一个状态（`update-coordinator.ts:52-72`）；安装阶段依次为下载、发布 `ready`、调用 `beforeRestart` 停掉 dsh 子进程、`quitAndInstall(false, true)`（`update-coordinator.ts:74-93`，`beforeRestart` 实现在 `main.ts:214-222`），任何一步抛错都只发布 `error` 状态（`update-coordinator.ts:87-93`），当前应用继续运行，active profile、staging、journal 均未被触碰；但 `quitAndInstall` 抛错时 dsh 子进程已被 `beforeRestart` 停掉（`main.ts:216-221` 把 `host` 置为 `undefined` 并 `stop()`），应用此后以 503 应答（`main.ts:228-230`）直到重启。

### 1.2 下次启动的对账：逐步失败语义

`applyRelease` 的完整步骤与失败后果如下（步骤号在同一文件内顺序执行）：

| 步骤 | 代码 | 失败时的状态 |
| --- | --- | --- |
| 1. 恢复激活 journal | `project-manager.ts:396` 调 `recover()`，实现 `342-363`；另外 `main.ts:140` 在进入 `main()` 后先调用一次 | journal 非法即抛错，启动失败；`profile` 缺失而 `rollback` 存在时把 rollback 搬回 `profile`（`357-360`），随后删除该 staging 目录（`361`） |
| 2. 校验 seed 完整性 | `project-manager.ts:397` 调 `verifySeedIntegrity`，实现 `231-251` | 抛错，启动失败；`profile`、staging 均未触碰 |
| 3. 校验 seed 本地包集合 | `project-manager.ts:399` 调 `verifyDesktopCorePackageSet`，实现 `deepseek-harness/apps/desktop/src/core-package-set.ts:131-159` | 同上 |
| 4. seed 版本必须等于 Electron 版本 | `project-manager.ts:400-402` | 抛错，启动失败 |
| 5. 复用快速路径 | `project-manager.ts:403-408`：profile 的 release 版本、已装 dsh 版本、已装 Host 版本三者都等于 seed 版本时只复验包集合并返回 `false` | 版本不一致时不抛错，继续走步骤 6 的全量安装 |
| 6. 合并 seed 的 pnpm store | `project-manager.ts:409` 调 `mergeSeedPnpmState`，实现 `508-517`；解压与索引合并见 `seed-store.ts:214-270`、`120-166` | 抛错，启动失败；临时事务目录在 `finally` 中删除（`514-516`） |
| 7. staging 安装与离线插件恢复 | `project-manager.ts:410-428`：`newStagingProfile`（`458-462`）→ 读旧 profile 插件清单（`413`）→ `copyMetadata`（`414`，实现 `193-204`）→ `pnpm install --offline --frozen-lockfile --trust-lockfile`（`415`）→ 有插件时用一次 `pnpm add` 批量传入全部 `name@version` 规格并带 `--save-exact` 与 `--offline`（`417-422`）→ 回写 bundle 列表（`423`，实现 `291-303`） | 抛错后 staging 目录被整棵删除（`432-435`）；active profile 不变；启动失败 |
| 8. 完整后端健康检查 | `project-manager.ts:429` 调 `hooks.healthCheck`，实现在 `main.ts:164-194` | 抛错后同样删除 staging 并抛出（`432-435`）；active profile 不变；启动失败 |
| 9. 激活 | `project-manager.ts:430` 调 `activate`，实现 `519-549`；启动路径下 `beforeActivate`/`afterActivate` 被替换为空操作（`main.ts:205-211`） | 见下文 1.3 |
| 10. 失败收尾 | `project-manager.ts:432-435` | 删除该次 staging 目录并原样抛出异常 |

首次安装（active profile 不存在）走 `project-manager.ts:425-428`：只做 seed 的离线安装，没有插件恢复步骤，因此首次安装路径上不存在「旧插件不兼容」这一失败源。

把步骤 4 的比较对象固定下来后，用户场景可以逐步读出：Electron 已升到新版本而 active profile 仍是旧 release 时，步骤 4 比较的是 seed 与 Electron（两者同属新的签名发布包，相等，不抛错），步骤 5 的复用条件因为 profile 的 release 版本仍是旧的而不成立，于是每次启动都走步骤 6 至 8 的全量对账；对账成功则激活并起窗，失败则按上表的失败语义退出。步骤 4 拒绝的因此只有一种情形：签名发布包内部不自洽（seed 与 Electron 版本不同），而这在正常发布流程下不会出现，它由打包期的两处校验固定（`deepseek-harness/apps/desktop/scripts/package-target.ts:102-106`、`deepseek-harness/apps/desktop/scripts/prepare-seed.ts:51-56`）。

### 1.3 激活与回滚的真实边界

`activate` 先写下 `pending.json` 的 `prepared` 阶段，再依次写 `active-moved`、把 active 移到 `rollback/profile`、写 `staging-activated`、把 staging 移入 `profiles/desktop`（`project-manager.ts:520-541`）。任何一步抛错时，它删除已就位的 profile、把 rollback 搬回 profile、删掉 journal，并再调一次 `afterActivate`（`542-548`）。启动路径下这个 `afterActivate` 是空操作，所以「回滚后恢复运行」并不成立：异常继续向上传播到 `main()` 的 catch，进程仍然退出。

`rollback/profile` 只被两处读取：`recover()` 在 `profile` 缺失时把它搬回（`project-manager.ts:357-360`），以及 `activate` 的失败分支（`544`）。没有任何代码尝试用 rollback 里的旧 dsh 版本启动后端，也没有任何代码跳过步骤 4 的版本相等要求。

### 1.4 失败后的可观测结果与重复性

启动失败表现为一个原生错误框（`main.ts:395`）加进程退出（`396`），诊断文本可选写入 `DSH_DESKTOP_DIAGNOSTIC_FILE`（`main.ts:391-394`）。失败不写任何「已失败」标记：步骤 2 至 8 失败时 `pending.json` 尚未创建，staging 已被删除，因此下一次启动从完全相同的状态重放同一次对账，得到同样结果。**不存在进程内重试或退避，也不存在「反复尝试安装新 seed 而卡住」的循环：每次启动只尝试一次，失败即退出。**

两个例外值得单列。其一是挂起：`DesktopHostProcess.start()` 等待 `ready` IPC，没有任何超时（`deepseek-harness/apps/desktop/src/host-process.ts:99-155`；带超时的只有 `stop()`，`210-216`），一个永不 resolve 的插件 `apply` 会让第 8 步永久等待，表现为无窗口、无提示的挂起。其二是单实例锁：它在模块顶层、`app.whenReady()` 之前获取（`main.ts:386`、`388`），而 `focusPrimaryWindow` 在 `main()` 内部第 350 行才被赋值为有意义的实现，之前是空函数（`main.ts:24`），所以在对账挂起期间再次双击启动只会静默退出，不会把已挂起的实例带到前台。

## 二、插件不兼容的四类判定

### 2.1 安装与解析阶段

解析阶段的第一个失败源是**旧 active profile 的插件清单本身**。`project-manager.ts:413` 在复制 seed 元数据之前先调 `pluginRecords`（`287-289`）→ `profilePluginNames`（`274-285`）→ `projectManifest`（`253-272`）→ `inspectPlugin`（`305-326`）。任一条件不满足即抛出并导致启动失败：包在 profile 的 `node_modules` 下没有清单、清单的 `name` 与请求名不一致或没有 `version`、清单没有声明 `dsh.bundle.patch`、patch 路径解析后越出包目录或文件不存在。同一批校验里，`projectManifest` 还要求 profile 的 `package.json` 依赖映射与 `desktop-packages.json` 一致、且 `pnpm-workspace.yaml` 的文本逐字节等于生成值（`project-manager.ts:264-270`）。

第二个失败源是 pnpm 本身。恢复插件走 `pnpm add <name>@<version> --save-exact --offline`（`project-manager.ts:417-422`），由 `runPnpm` 执行（`551-634`）；非零退出会把最多 64 KiB 的诊断拼进错误（`603-609`、`628-630`）。离线解析不到该精确版本、或依赖的 build script 被 `strictDepBuilds` 与 `allowBuilds` 拒绝（`project-manager.ts:106`、`124-134`）都会在这一步失败。`allowBuilds` 的清单是固定的四个允许项与三个显式拒绝项，写死在 `workspaceFile()` 里，插件无法在安装时扩充。

### 2.2 装上但宿主半 pending 或抛错

Cordis 层面对缺失依赖的设计是让插件保持 pending：`deepseek-harness/packages/client/AGENTS.md:91` 明确 `inject` 未满足是「stays PENDING, with no timeout」，服务缺失不会被当成空实现（`deepseek-harness/docs/subsystems/workspace.md:5` 记录了同一意图）。但**启动流程并不会把 pending 当成可继续的状态**：`boot()` 在整棵树 settle 之后调用 `assertEntriesActivated`（`deepseek-harness/packages/boot/app-boot/src/index.ts:812-814`），该函数遍历所有 enabled 的 Loader 条目，pending 条目按「等待哪些服务」记失败（`740-743`），failed 条目取回原始拒绝原因并记失败（`731-738`），另有 `assertEntriesLoaded`（`688-694`）覆盖 import 失败；只要失败集合非空就抛错（`748-754`）。入口级被跳过的只有 `disabled` 条目（`728`；它在升级路径上的适用范围见 3.2 第 6 条）；此外 `boot()` 在 loader 服务已消失时整体跳过审计（`812-813`），该路径对应启动期间整棵树被处置的情形，桌面场景下不常见。

这条规则在本仓库自己的插件上有立即可见的实例，而且两种声明方式的后果完全不同。desktop 组合禁用了提供 `webServer` 的那一行（`deepseek-harness/apps/desktop-host/config/desktop.cordis.patch.yml:6-7` 禁用 `deepseek-harness/packages/bundle/web-app/cordis.patch.yml:135-136` 的 `@deepseek-ai/dsh-host-webserver`），而该服务在整个 harness 内只有一个生产提供者（`deepseek-harness/packages/host/webserver/src/index.ts:144`）。以顶层 `export const inject` 声明该服务的插件，其整个 fiber 在 desktop 上永远停在 pending，装进 desktop profile 即无法启动；本仓库在使用插件的源码检出中至少有六处这样声明：`plugins/remote/dsh-remote/src/index.ts:74`、`plugins/better-sidebar/DSH-better-sidebar/src/index.ts:83`、`plugins/better-sidebar/dsh-sidebar-qa/src/index.ts:83`、`plugins/dsh-web-ui/dsh-web-ui/packages/dsh-plugin-manager/src/index.ts:26`、`plugins/dsh-web-ui/dsh-web-ui/packages/dsh-web-settings/src/index.ts:54`、`plugins/deep-whale/dsh-deep-whale/skin-manager/src/index.ts:18`。相反，在 `apply` 内用 `ctx.inject([...])` 声明只让该回调及其注册的路由不挂载，插件本体照常激活，不阻塞启动（`plugins/ai-update/dsh-ai-update/src/index.ts:295`、`plugins/plugin-market/dsh-market/src/index.ts:60` 属于这一种）；这一区分同时写在 T5 文档的 E4 一节。

两条启动路径都经过这个审计：desktop 的 host 入口在 `deepseek-harness/apps/desktop-host/src/index.ts:289-296` 调 `boot`，CLI 在 `deepseek-harness/apps/cli/src/profile-boot.ts:336` 调 `boot`。对 desktop 而言，审计抛错意味着 `runDesktopHost` 不返回，`ready` 事件不会发出（`deepseek-harness/apps/desktop-host/src/index.ts:406-411`），子进程在顶层 catch 中上报 `fatal` 并设置退出码 1（`index.ts:580-586`），壳侧 `start()` 的 promise 被 `fail()` 拒绝（`host-process.ts:146-153`、`401-412`），第 8 步健康检查失败。对 CLI 而言，审计抛错使 harness 进程退出，dsh-gui 外壳报 `harness exited before becoming ready`（`src-tauri/src/main.rs:615`）。

同一类别还有两类：插件 patch 插入的 id 与既有行重复会让整棵树加载失败，本仓库的 `plugins/README.md:56-69` 记录了 `duplicate loader entry id` 这个先例；插件若通过自己的 patch 层禁用了提供 `connection`、`typertGateway`、`clientModules` 的行，host 会在组合校验处自己抛错——`deepseek-harness/apps/desktop-host/src/index.ts:298-304` 要求这三个服务存在，否则释放 fiber 并抛错。

### 2.3 健康检查到底检查什么

健康检查就是「完整启动一次 staged 后端再停掉」：`main.ts:166-177` 先停当前 host，再用 `startHost(stagingProfile)` 起一个探针，成功后 `stop()`；启动路径下 `active` 为 `undefined`，所以只走探针分支。`startHost` 只构造 `DesktopHostProcess` 并 `await next.start()`（`main.ts:159-163`），而 `start()` 只有在收到 `ready` IPC 事件时才 resolve（`host-process.ts:137-144`、`388-392`），因此这一步等价于「`boot()` 成功返回且三个必需服务齐备」。失败时 `main.ts:186-193` 分三种情况抛出：探测与重启都失败抛 `AggregateError`，仅探测失败抛探测错误，仅重启失败抛重启错误。

它**不检查浏览器**：整个健康检查只涉及 Node 子进程的起停，renderer 从未被加载（`main.ts:165-194`；`deepseek-harness/apps/desktop-host/src/index.ts:283-304` 组合的是宿主侧上下文）。客户端图只被检查到宿主半能检查的深度：`deepseek-harness/packages/client/modules/src/index.ts:559-568` 在服务构造时同步扫描一次，能捕获 `dsh.client` 声明非法（`189`、`193`、`198`）、声明了 `dsh.client` 却无 `./client` 导出（`767`）、产物文件缺失（`892`）、同一包从多个 Loader 源解析（`957`）；但它不校验 `dsh.client.external` 里的每个名字是否是有效的平台模块——`orderByModuleGraph` 只排拓扑顺序、只拒绝自引用与环（`423-455`），名字没有对应行时直接忽略。这类不匹配在浏览器侧才抛「missed the module table」（`deepseek-harness/packages/client/modules/src/client/system.ts:205-211`），也就是本仓库 `dsh-pet` 记录的那一类（`plugins/README.md:100-107`、`203-215`）。

### 2.4 激活完成之后才发现的问题

激活成功、`main()` 继续走到 `main.ts:212` 之后，问题不再影响「能否启动」。请求级错误由 host 侧转换成响应错误帧（`deepseek-harness/apps/desktop-host/src/index.ts:361-367`），应用与窗口存活；只有传输级错误会走 `failTransport` 让子进程退出（`index.ts:451-455`、`489`），壳仍持有那个已拒绝的 `DesktopHostProcess`，`dsh-app://app` 请求开始抛错，窗口还在但后端不可用，需要重启。

GUI 内的插件变更失败同样不再致命，但会留下降级态：`mutate` 失败时删除 staging、active profile 不变（`project-manager.ts:451-454`），而健康检查过程中当前 host 已被停掉（`main.ts:166-168`），若探测失败且 active 重启也失败，异常是 `AggregateError`（`main.ts:186-191`），若仅重启失败则抛重启错误（`193`）；两种情况下 `host` 都停在 `undefined`，运行中的应用此后以 503 应答（`main.ts:228-230`）直到重启。这与「启动失败」是两回事，也是同一份插件在 GUI 内操作与在下一次启动时被恢复的全部差别。

## 三、判据清单

### 3.1 导致无法启动的条件

以下条件在打包版上导致对账抛错，应用每次启动都失败；失败时 active profile 的既有内容不被新内容覆盖：步骤 2 至 8 只写 staging，唯一改动 active 目录的是步骤 9 的激活与步骤 1 的 journal 恢复（步骤 1 只在 `profile` 缺失时把 rollback 搬回，见 1.2 表）：

1. 已安装插件的宿主半 fiber 停在 pending（顶层 `inject` 声明的服务在新版不存在或改名）或 failed（`apply` 抛错、原生模块加载失败），由 `deepseek-harness/packages/boot/app-boot/src/index.ts:722-755` 判定。
2. 旧 profile 里的插件包不满足 bundle 契约：无清单、name/version 不一致、缺 `dsh.bundle.patch`、patch 越界或不存在（`deepseek-harness/apps/desktop/src/project-manager.ts:305-326`）。
3. 旧 profile 的依赖映射或 `pnpm-workspace.yaml` 与 `desktop-packages.json` 不一致（`project-manager.ts:253-272`）。
4. 插件 patch 插入的 Loader 行 id 与既有行重复（先例 `plugins/README.md:56-69`），或插件通过自己的 patch 层禁用了提供 `connection`、`typertGateway`、`clientModules` 三者的行，使 host 的组合校验抛错（`deepseek-harness/apps/desktop-host/src/index.ts:298-304`）。
5. 插件（或其依赖）的 install script 所属包不在 `allowBuilds`（`project-manager.ts:124-134`、`deepseek-harness/apps/desktop/README.md:179`）。
6. 插件的宿主半 `dsh.client` 声明与产物不自洽（`deepseek-harness/packages/client/modules/src/index.ts:767`、`892`、`957`）。

以下条件与插件无关，但产生同一种「无法启动」，用于把故障从「插件不兼容」里区分出来：

1. seed 完整性或本地包集合校验失败（`project-manager.ts:397-399`、`231-251`、`core-package-set.ts:131-159`）。
2. seed 版本与 Electron 版本不等（`project-manager.ts:400-402`），或 `desktop-release.json` 的 `hostProtocolVersion` 不等于当前协议版本（`deepseek-harness/apps/desktop/src/release.ts:21-27`）。
3. seed 的离线安装失败（`project-manager.ts:415`、`425-428`）。
4. 激活阶段的目录替换失败（`project-manager.ts:519-549`）。
5. 事务锁被另一个活跃进程持有（`project-manager.ts:645-682`，判定在 `656-668`）。
6. 插件恢复期的挂起（无超时，`host-process.ts:99-155`）。

### 3.2 属于安全降级的条件

1. 浏览器半请求了不在 `PLATFORM_MODULES` 的未知平台模块：客户端在模块表未命中处抛错（`deepseek-harness/packages/client/modules/src/client/system.ts:205-211`；先例 `plugins/README.md:100-107`），不阻塞宿主启动。
2. 浏览器半的 slot 键变化与组件渲染报错：需实测。slot 声明冲突在客户端加载期即失败（`deepseek-harness/packages/client/AGENTS.md:12`），而窗口与其余插件是否继续渲染没有代码或文档证据（见第六节第 4 条）。
3. 插件宿主半已激活但某个具体请求报错：单个请求返回错误（`deepseek-harness/apps/desktop-host/src/index.ts:361-367`），进程存活。
4. 更新下载或签名校验失败：当前应用继续运行，只弹错误提示（`update-coordinator.ts:87-93`、`main.ts:306-312`）。
5. GUI 内插件安装、更新、移除失败：窗口存活，active profile 不变（`project-manager.ts:451-454`）；但如前所述，运行中的后端可能已停，需重启恢复（`main.ts:166-193`、`228-230`）。
6. 把插件行置 `disabled`：入口级审计跳过该条目（`deepseek-harness/packages/boot/app-boot/src/index.ts:728`），但**只在版本已一致、走复用快速路径（`project-manager.ts:403-408`）的启动中有效**。补丁层由被启动的 profile 目录提供（`deepseek-harness/packages/boot/app-boot/src/profile.ts:799-802`，desktop Host 传入的正是被启动的项目目录，`deepseek-harness/apps/desktop-host/src/index.ts:154`），而升级后的第一次启动必然走全量对账、被启动的是 staging：staging 的元数据来自 `copyMetadata(seedDir, stagingProfile)`（`project-manager.ts:414`），它复制的文件集（`project-manager.ts:39-45`，实现 `193-204`）不含 `cordis.patch.yml`，`createSeedMetadata`（`686-703`）也不产出补丁层（同一代码事实已由 T2 记录，`2026-09-13-desktop-api-and-migration.md:257`），因此写在 active profile 里的 `disabled` 行不会进入被健康检查审计的 profile（`project-manager.ts:429` → `main.ts:165-194`）。升级后要保住启动，只能把该插件从 active profile 的 `dsh.profile.bundles` 中移除（该字段经 `pluginRecords` → `writeProfilePlugins` 传递到新 profile），即第六节第 5 条那条尚未验证的手工修复；改 desktop Host 自带的 overlay 也不可靠，因为 staging 的 Host 由本地 tarball 重新安装，其中的 overlay（`deepseek-harness/apps/desktop-host/src/index.ts:94`）不携带旧 profile 内的编辑。

## 四、AI 升级前可读的判据清单

### 4.1 两个升级面与预检时点

官方 desktop 的升级是单一签名发布单元：Electron、dsh、私有 Host 三者同版本，由 `electron-updater` 下载并重启（`deepseek-harness/apps/desktop/README.md:11`、`167-169`；`deepseek-harness/.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md:21`、`86`）；版本同一性在打包期由两处硬校验固定：Electron 包与根 dsh 包版本必须相等（`deepseek-harness/apps/desktop/scripts/package-target.ts:102-106`），seed 的 release 版本也取自同一对 manifest 并要求相等（`deepseek-harness/apps/desktop/scripts/prepare-seed.ts:51-56`）。因此目标版本的服务面就是 harness 仓库该 tag 的源码，不需要先安装 desktop 才能分析；而预检的正确时点是在「更新可用」与「确认安装」之间（`update-coordinator.ts:52-94`；`main.ts:295-312`），因为安装完成后的下一次启动就可能直接失败。

本仓库 web profile 的升级面是 git 子模块，流程由 `.agents/skills/dsh-gui-update/SKILL.md`（下称 `SKILL.md`）承载：兼容分析是该文件第 3 节的第 3 步（`SKILL.md:45`），适配验证与不兼容插件的屏蔽是第 4 至 6 步（`SKILL.md:46-51`），全部落点在持久化副本 `.staging/dsh-gui`（`SKILL.md:39-52`）。

### 4.2 输入清单

| 输入项 | 来源（相对仓库根） | 用途 |
| --- | --- | --- |
| 已安装插件清单与精确版本 | desktop：`$DSH_HOME/profiles/desktop/package.json` 的 `dsh.profile.bundles`（路径见 `deepseek-harness/apps/desktop/src/paths.ts:34`，校验见 `project-manager.ts:274-285`）与各包 `node_modules/<name>/package.json`（`project-manager.ts:306-312`）；仓库 web profile：`.dsh/profiles/web/package.json:24-43` 的同一字段 | 确定预检对象与版本 |
| bundle 挂载声明 | 插件 `package.json` 的 `dsh.bundle.patch`；desktop 的强制校验在 `project-manager.ts:314-324`，Loader 的强制校验在 `deepseek-harness/packages/boot/app-boot/src/profile.ts:792-797` | 判定插件能否被识别为 bundle 层 |
| Loader 行 id 全集 | 各 bundle 的 patch 文件；组合算法 `deepseek-harness/packages/boot/app-boot/src/profile.ts:846-852`；重复 id 的先例 `plugins/README.md:56-69` | 检测 id 冲突与 double-mount |
| 宿主半 `inject` 服务名集合 | 插件源码的顶层 `inject` 导出与 `apply` 内的 `ctx.inject([...])` 调用；目标版本的服务面取自目标 tag 的源码：检索 `super(ctx, '<service>')` 与 `ctx.provide('<service>'`（含 `reflect.provide`）得到 Provider 集合，再与该 tag 的 `cordis.patch.yml` 行集合求启用面，与 4.1 的路线一致。`cordis_inspect_list` / `cordis_inspect_query` 查询的是当前运行的 Host（`deepseek-harness/packages/extensions/tool-cordis/src/index.ts:45`、`64`；`deepseek-harness/docs/tool-catalog.md:410`），只在会话本身运行目标版本时可用 | 顶层 `inject` 的差集非空即 pending，即无法启动；`ctx.inject` 的差集只让该回调不挂载 |
| 浏览器模块基线 | `deepseek-harness/packages/client/web/src/platform.ts:8-14` 的 `PLATFORM_MODULES`，与插件 `dsh.client.external` 声明（`deepseek-harness/packages/client/modules/src/index.ts:55-57`、`196`）；失败点 `deepseek-harness/packages/client/modules/src/client/system.ts:205-211` | 判定浏览器半是否命中模块表 |
| 依赖闭包与 peer 范围 | 插件 `package.json` 的 `dependencies`/`peerDependencies`；profile 的 `pnpm-lock.yaml`；desktop 侧 seed 的 lockfile | 判定 peer 冲突与依赖可达性 |
| `allowBuilds` 策略 | `project-manager.ts:124-134`；`deepseek-harness/apps/desktop/README.md:179` | 判定 build script 会被放行还是被拒 |
| 原生模块 ABI | 打包 Node 版本（`deepseek-harness/apps/desktop/README.md:161` 记录 24.17.0）与 host 启动用的自带 Node（`host-process.ts:102`） | 判定预编译原生模块是否可用（需实测） |
| Node 引擎下限 | 插件 `engines.node`；harness 实际下限 24.2 的记录在 `docs/dsh-gui/2026-09-11-harness-upgrade-v0-1-5-rc-2.md:66` | 判定运行时是否可达 |
| npm 发布状态与 pin | `src-tauri/src/update.rs:472-507`、`30-55`；`.dsh/gui/npm-installs.json`（`update.rs:337-357`）；pin 理由与插件安装方式 `plugins/README.md:89-108` | 判定源码已更新但插件本体未发布的情形 |
| 目标版本的变更证据 | 目标 tag 的 `deepseek-harness/docs/config-catalog.md`、`deepseek-harness/docs/cordis-api/`、`deepseek-harness/docs/subsystems/slots.md`；结论模板 `docs/dsh-gui/2026-09-11-harness-upgrade-v0-1-5-rc-2.md:9-60` | 生成服务面、slot 树与模块基线的差集 |
| 现有 AI 流程的实际输入 | 提示词只携带模块名、路径、当前版本与更新目标（`src-tauri/ui/app.js:2139-2145`、`2148-2202`，手势常量 `app.js:2123`，工作区与只读约定 `app.js:2129`、`2135`） | 说明预检结论目前产自副本检出目标版本之后，而非 desktop 更新安装之前 |

### 4.3 可执行判据

按下列顺序逐项检查。第 1 至 5 项的任一命中都会导致无法启动；第 6 项不阻塞启动，只让该插件的浏览器半失效；第 7 项需实测：

1. 对每个已安装插件区分两种声明：顶层 `export const inject` 让整个 fiber 停在 pending，`apply` 内的 `ctx.inject` 只让该回调不挂载。把顶层声明的服务名集合与目标版本的服务面求差集，差集非空即启动失败（`deepseek-harness/packages/boot/app-boot/src/index.ts:740-743`）。把该插件的行置 `disabled` 不能用于升级路径：它只在版本已一致、走复用快速路径的启动中生效，升级后的第一次启动必须改为把该插件从 `dsh.profile.bundles` 中移除（理由与行号见 3.2 第 6 条）。
2. 检查插件的 patch 文件是否插入与目标组合重名的 Loader 行 id；desktop 组合的基础行集是 `project-manager.ts:105` 的两个内置 bundle，可从 `deepseek-harness/apps/desktop-host/config/desktop.cordis.patch.yml` 与这两份 bundle 的 patch 读出。
3. 检查插件是否声明 `dsh.bundle.patch` 且 patch 文件在包目录内存在（desktop 场景；`project-manager.ts:314-324`）。
4. 检查插件的 `dsh.client` 声明与产物：是否导出 `./client`、构建产物是否存在、是否从多个 Loader 源解析（`deepseek-harness/packages/client/modules/src/index.ts:767`、`892`、`957`）。
5. 检查依赖里是否存在 build script 且所属包不在 `allowBuilds` 的允许清单内（`project-manager.ts:124-134`）。
6. 检查 `dsh.client.external` 的每个名字是否在目标版本的 `PLATFORM_MODULES` 内；不在则判定为浏览器半失效，不阻塞启动（`deepseek-harness/packages/client/modules/src/client/system.ts:205-211`）。
7. 检查插件是否带原生模块，以及其目标平台与 ABI 是否与打包 Node 一致（需实测，见第六节）。

## 五、desktop 合并进主仓库后不再需要人工的部分与仍需人工的部分

不再需要人工或 agent 介入的部分：

1. 版本同一性：Electron、dsh、私有 Host 由发布流水线强制同版本（`deepseek-harness/apps/desktop/scripts/package-target.ts:102-106`、`deepseek-harness/apps/desktop/scripts/prepare-seed.ts:51-56`、`deepseek-harness/apps/desktop/README.md:11`），运行时还有 `project-manager.ts:400-402` 与 `core-package-set.ts:86-92` 两道校验。
2. seed 与 Electron 同版本、seed 完整性、pnpm store 分片解压与索引合并：启动时自动完成（`project-manager.ts:397-409`、`231-251`、`seed-store.ts:214-270`）。
3. 已安装插件按名与精确版本从既有 store 离线恢复（`project-manager.ts:413-424`）。
4. desktop 本体的更新：`electron-updater` 单一发布单元，确认后自动下载、安装、重启（`update-coordinator.ts:52-94`，用户手册 `deepseek-harness/apps/desktop/README.md:167-169`）。
5. 激活成功后的目录替换与中断恢复（`project-manager.ts:519-549`、`342-363`）。

仍需人工或 agent 判断的部分：

1. 升级前对已安装插件做兼容预检（第四节），尤其是 pending 服务判据；这是当前唯一能把「升级后无法启动」提前拦下的动作。
2. 启动失败后的处置：没有自动回滚（`rollback/profile` 的用途见 1.3），需要在装回旧发布包与手工修 profile 之间做决定。
3. 本仓库 web profile 的 harness 与插件升级：副本验证与屏蔽不兼容插件的决定（`.agents/skills/dsh-gui-update/SKILL.md:39-52`、`48-51`）。
4. npm 发布状态的核对与重装（`src-tauri/src/update.rs:472-507`、`docs/dsh-gui/update-check.md:49-57`）。
5. 会话格式单向升级带来的备份与回滚决定（`docs/dsh-gui/2026-09-11-harness-upgrade-v0-1-5-rc-2.md:64`）。
6. 带构建脚本的依赖需要改上游的 `allowBuilds` 白名单（`project-manager.ts:124-134`）：预检只能发现该冲突，profile 侧无法解除，必须由上游源码接受该包后随新的 desktop 发布生效。

## 六、不确定项（需实测）

1. `DesktopHostProcess.start()` 无超时（`host-process.ts:99-155`）：一个永不 settle 的插件 `apply` 会让启动永久挂起。静态可判，但挂起时的界面与日志可观测性需实测。
2. pnpm 对 peer 范围冲突的处理：`workspaceFile()` 设了 `autoInstallPeers: false` 但没有设 `strict-peer-dependencies`（`project-manager.ts:106`、`124-134`），插件 peer 范围与新核心版本不符时是安装直接失败还是落到后续 pending，需实测。
3. 原生模块 ABI 不匹配在打包版上的具体症状（预期是 `apply` 内 `require` 抛错、fiber FAILED，即 2.2 类），需实测。
4. 浏览器半未命中模块表时主窗口与其余插件是否继续可用，需实测；本仓库只有 `dsh-pet` 的文字记录（`plugins/README.md:100-107`）。
5. 手工修 `$DSH_HOME/profiles/desktop/package.json` 的 `dsh.profile.bundles` 是否有效：代码上 `pluginRecords` 只读该字段（`project-manager.ts:274-285`、`413`），但 CLI 拒绝以该 profile 启动或做插件管理（`deepseek-harness/apps/cli/src/args.ts:69-70`），该修复方式未文档化，需实测。
6. 装回旧版发布包能否恢复可用：`electron-updater` 不提供降级（`update-coordinator.ts:26-31`），恢复依赖复用快速路径（`project-manager.ts:403-408`），需实测。
7. 对账期间无窗口期的时长与用户可感知程度：staging 安装加一次完整起停都没有进度界面，需实测。

## 参考

- [desktop 架构分析（T1）](2026-09-13-desktop-architecture.md) —— 进程模型、三类通道、Cordis 组合与 profile 布局
- [desktop API 与迁移分析（T2）](2026-09-13-desktop-api-and-migration.md) —— IPC、preload 与迁移路径
- [desktop 分析文档独立验证（T5）](2026-09-13-desktop-analysis-verification.md) —— 上述两份文档的逐条复核
- [Harness 升级记录：dsh-v0.1.2-rc.1 → dsh-v0.1.5-rc.2](2026-09-11-harness-upgrade-v0-1-5-rc-2.md) —— 服务面、slot 树与模块基线差集的既有分析模板
- [更新检查与 npm 发布状态](update-check.md) —— 更新判定与 npm 发布核对
- [升级验证副本](upgrade-staging-workspace.md) —— `.staging/dsh-gui` 的位置与维护
- `.agents/skills/dsh-gui-update/SKILL.md` —— 两阶段升级流程
- `deepseek-harness/apps/desktop/README.md` —— 种子安装六步、更新流程与已知限制
- `deepseek-harness/.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md` —— desktop 打包与更新的决策记录
