# Desktop 升级失败边界与 AI 预检清单独立验证（T13）

本文独立复核 `docs/dsh-gui/2026-09-13-desktop-upgrade-compatibility.md`（下称 T11）的失败边界结论与 AI 预检清单。这是本轮最关键的验证：复核不采信作者行号，启动审计、就绪判定、对账语义与预检输入都重新读代码或重跑检索。

## 验证范围与方法

被验证对象是 T11（201 行）。证据面是 pinned 子模块 `deepseek-harness/`（只读）、本仓库 `src-tauri/` 与 `plugins/`。

复核动作分四类：一是从头到尾读 `apps/desktop/src/main.ts`（397 行）确认调用顺序与错误处理；二是逐行读 `packages/boot/app-boot/src/index.ts:688-834` 的启动审计与 `boot()`，判定 pending 与 failed 的区别与豁免；三是沿「审计抛错 → boot 失败 → 无 ready → 壳侧拒绝 → 健康检查失败 → 对账抛错 → 进程退出」逐环取 file:line；四是核对预检清单里每个路径是否存在、行号是否落在声称的内容上，并判断「升级前可读」是否成立。

本次未运行 Electron，未构造不兼容插件做端到端复现，因此运行时表现仍属不可验证。

## 一、已复核通过

| 编号 | 主张 | 复核方法 | 证据 | 判定 |
|---|---|---|---|---|
| W1 | 每次启动在创建任何窗口之前先等待一次 profile 对账，且该调用无 `try` | 通读 `main.ts` | `main.ts:205-211` 在 `development === undefined` 时 `await manager.applyRelease(resources.seed, app.getVersion(), {...})`；`main.ts:212` 的 `host = await startHost()` 同样未包裹；窗口直到 `main.ts:362` 的 `createMainWindow()` 才创建；`main()` 内部没有对这两步的任何 catch | 通过 |
| W2 | 抛错时进入模块顶层 catch，弹原生错误框并以退出码 1 结束；没有「壳起窗、只让后端不可用」的降级分支 | 读 `main.ts:386-397` 与全文 | `main.ts:388` 为 `if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error) => {...})`；390 行 `console.error`；391-394 行可选写 `DSH_DESKTOP_DIAGNOSTIC_FILE`；395 行 `dialog.showErrorBox(..., messages.startupFailed, message)`；396 行 `app.exit(1)`。全文没有把 `main()` 的失败转成「无后端但有窗口」的分支 | 通过 |
| W3 | `dsh-app://app` 的 503 降级分支在启动失败路径上不可达 | 读 `main.ts:224-231` 与调用顺序 | 503 分支在 `main.ts:228-230`（`active === undefined` 时返回 `backend unavailable`），注册于 `main.ts:224`，位于 211-212 两步之后；两步任一抛错都会离开 `main()`，此时窗口尚未创建 | 通过 |
| W4 | Cordis 启动审计把 pending 与 failed 一律判为启动失败，唯一豁免是 `disabled` | 逐行读 `index.ts:688-755` | `assertEntriesLoaded`（688-694）先对「无 fiber 且未 disabled」的条目抛错；`assertEntriesActivated`（722-755）先调它，再遍历 `ctx.loader.entries()`：728 行 `if (fiber === undefined \|\| entry.disabled) continue`；730 行 ACTIVE 跳过；731-738 行 FAILED 先 `await fiber.await()` 取回原始错误再记失败；740-743 行 PENDING 记 `pending (waiting for services: ...)`；748-754 行只要失败集合非空就抛 `"N entries did not activate"` | 通过（这是本轮最关键的一条，逐行确认） |
| W5 | pending 与 failed 的区别只在诊断文本，不改变判定 | 对比两个分支 | 731-738 行把 failed 的原始 stack 拼进 `failures`，740-743 行把 pending 未满足的服务名拼进 `failures`；两者都只是 `failures.push(...)`，最终由 748-754 行统一抛错，没有任何分支对 pending 放行 | 通过 |
| W6 | `boot()` 在整棵树 settle 之后执行审计并把失败包装成启动错误 | 读 `index.ts:787-834` | 812 行 `await ctx.get('loader')?.await()`；813 行仅当 loader 服务已消失时提前 `return ctx`；814 行 `await assertEntriesActivated(ctx, binName)`；816-833 行 catch 中 `await ctx.fiber.dispose()` 后抛 `"${binName}: plugin tree failed to load: ..."` | 通过（整树提前返回这一条见 E5） |
| W7 | desktop Host 的就绪判定要求 `boot` 成功，失败走 `fatal` 而非挂起 | 读 `desktop-host/src/index.ts` | 289-296 行在 `runDesktopHost` 内 `await boot(...)`，其 rejection 使该函数不再返回；406-411 行的 `ready` 上报只在其后执行；580-586 行顶层 `main().catch` 发 `{ type: 'fatal', message }` 并设 `process.exitCode = 1` | 通过 |
| W8 | 壳侧在被拒绝或 `fatal` 时立即失败，`start()` 没有超时 | 读 `host-process.ts` | `start()`（99-155）只返回 `this.readyPromise`，其 reject 来源是 `fail()`（401-412）；`fatal` 消息经 388-399 的 `handleMessage` 调 `fail(new Error(message.message))`；子进程 exit 经 146-153 行调 `fail`；全过程没有任何计时器，带超时的只有 `stop()`（201-220，10 s 后 SIGTERM、再 5 s 后 SIGKILL、再 5 s 判失败） | 通过 |
| W9 | 非 `ready`/`fatal` 的子进程消息被判非法并杀子进程 | 读 `host-process.ts:32-43,137-144` | `isDesktopHostEvent` 只接受 `ready` 与 `fatal`；`child.on('message')` 在非法时 `fail` 并 `child.kill('SIGTERM')` | 通过 |
| W10 | 步骤 4 比较的是打包 seed 的 `desktop-release.json` 与 Electron 自身版本，不是旧 profile 与 seed | 读 `project-manager.ts:394-402` 与调用点 | `applyRelease(seedDir, electronVersion, hooks)` 中 398 行 `const target = releaseFile(seedDir)`，400-402 行 `if (target.version !== electronVersion) throw`；`main.ts:206` 传入的 `electronVersion` 是 `app.getVersion()` | 通过 |
| W11 | 复用快速路径比较三个已装版本与 seed 版本，不一致时不抛错而继续全量安装 | 读 `project-manager.ts:403-408` | 403-405 行同时要求 `releaseVersion() === target.version`、`dshVersion() === target.version`、`installedPackageVersion(DESKTOP_HOST_PACKAGE) === target.version`；命中则 406 行复验包集合并 407 行 `return false`；否则不抛错，继续 409 行之后 | 通过 |
| W12 | 插件恢复是离线、精确版本 | 读 `project-manager.ts:412-424` | 413 行从 active profile 读 `pluginRecords`；414 行 `copyMetadata(seedDir, stagingProfile)`；415 行 `install --offline --frozen-lockfile --trust-lockfile`；417-422 行 `add ...plugins.map(p => \`${p.name}@${p.version}\`)` 加 `--save-exact` 与 `--offline`；423 行回写 bundle 列表 | 通过（「逐个」措辞见 E6） |
| W13 | 首次安装路径没有插件恢复步骤 | 读 `project-manager.ts:425-428` | 该分支只 `copyMetadata(seedDir, stagingProfile)` 与 seed 离线安装 | 通过 |
| W14 | 步骤 2 至 8 失败时只删 staging、active profile 不变 | 读 `project-manager.ts:429-435` | 429 行 `hooks.healthCheck`、430 行 `activate` 都在同一个 `try` 内；432-435 行 catch 只 `removeOwnedDirectory(stagingProfile)` 后原样抛出 | 通过 |
| W15 | `rollback/profile` 只服务中断恢复，不是插件不兼容的自动回滚 | 读 `project-manager.ts:342-363`、`519-549`，并检索 `paths.rollback` 的全部使用点 | 357-360 行在 `profile` 缺失且 rollback 存在时反向搬移；544 行在 `activate` 失败分支把 rollback 搬回；没有第三处读取；也没有任何用 rollback 内旧版本启动后端的代码 | 通过 |
| W16 | 启动路径下 `activate` 的回滚不会让应用继续运行 | 读 `main.ts:205-211` 与 `project-manager.ts:542-548` | `applyRelease` 收到的是 `afterActivate: async () => {}`；activate 失败时 546 行调用该空实现后仍 `throw error`，异常继续到 `main()` 的最高层 | 通过 |
| W17 | 健康检查等价于「完整启动一次 staged 后端再停掉」，不检查浏览器 | 读 `main.ts:159-194` | `startHost`（159-163）只 `new DesktopHostProcess(...)` 加 `await next.start()`；`start()` 只在收到 `ready` 时 resolve（见 W8）；`healthCheck`（165-194）先停当前 host，再起停探针，启动路径下 `active` 为 `undefined` 故只走探针；186-193 行按「探测失败/重启失败」分别抛 `AggregateError` 或单个错误；全过程不加载 renderer | 通过 |
| W18 | host 组合必须提供 `connection`、`typertGateway`、`clientModules`，否则自抛错 | 读 `desktop-host/src/index.ts:298-304` | 三者在 298-300 行读取，301-304 行任一 `undefined` 即 `await ctx.fiber.dispose()` 后抛错 | 通过 |
| W19 | 请求级错误只失败单个请求，传输级错误才让子进程退出 | 读 `desktop-host/src/index.ts:361-367`、`451-455`、`489` | 361-367 行 catch 内 `writeResponse(encodeDesktopResponseError(...))`，进程继续；451-455 行 `failTransport` 发 `fatal` 并 `stop(1)`；489 行 `void run.catch(failTransport)` 只把 `controller.fetch` 的 rejection 接到它 | 通过 |
| W20 | `webServer` 的唯一生产提供者是 webserver 包，desktop 组合禁用了它 | 检索 `'webServer'` 全仓并区分生产注册与测试替身 | 唯一 `super(ctx, 'webServer')` 在 `packages/host/webserver/src/index.ts:144`（T11 原行号正确，三种方法的复核见第三节）；其余命中为测试的 `ctx.provide('webServer', ...)`、各插件的 `inject` 声明、`webserver/src/index.ts:24` 的服务类型映射与 `tool-cordis/api-catalog.ts:2809` 的目录条目 | 通过 |
| W21 | 顶层 `export const inject` 与 `apply` 内 `ctx.inject` 的后果不同 | 读审计遍历范围与两处实例 | 审计只遍历 `ctx.loader.entries()`（`index.ts:726`），插件内部 `ctx.inject` 产生的子 fiber 不是 Loader 条目，故不进入失败集合；`packages/client/AGENTS.md:91` 的记录为 "stays PENDING, with no timeout"；本仓库六处顶层声明路径与内容逐条核对通过（`plugins/remote/dsh-remote/src/index.ts:74`、`plugins/better-sidebar/DSH-better-sidebar/src/index.ts:83`、`plugins/better-sidebar/dsh-sidebar-qa/src/index.ts:83`、`plugins/dsh-web-ui/dsh-web-ui/packages/dsh-plugin-manager/src/index.ts:26`、`plugins/dsh-web-ui/dsh-web-ui/packages/dsh-web-settings/src/index.ts:54`、`plugins/deep-whale/dsh-deep-whale/skin-manager/src/index.ts:18`），`apply` 内声明的两处实例在 `plugins/ai-update/dsh-ai-update/src/index.ts:295` 与 `plugins/plugin-market/dsh-market/src/index.ts:60` | 通过 |
| W22 | CLI 路径同样经过审计，失败表现为 harness 退出 | 读两处调用与外壳错误串 | `apps/cli/src/profile-boot.ts:336` 调 `boot`（T11 原行号正确，见第三节）；审计抛错使该进程退出；本仓库外壳在 `src-tauri/src/main.rs:613-618` 报 `"harness exited before becoming ready (status {status})"` | 通过 |
| W23 | 浏览器模块表失败点在客户端要求阶段，只影响该插件 UI | 读 `client/system.ts` 与 `modules` 的两条路径 | `packages/client/modules/src/client/system.ts:205-211` 在模块表未命中时抛 `missed the module table`；`packages/client/modules/src/index.ts:423-455` 的 `orderByModuleGraph` 只拒绝自引用（442-446）与环（433-438），依赖名没有对应行时 447 行直接跳过；先例 `plugins/README.md:100-107` 与 `203-215` 记录 dsh-pet 客户端半因 `dsh-client-runtime` 被移除而 miss module table、宿主半兼容 | 通过 |
| W24 | 宿主半侧的客户端图校验确实在服务构造时同步执行，可导致启动失败 | 读 `modules/src/index.ts:559-568` 与三处 throw | 559-568 行激活期扫描当前 Loader 条目并 `flush`，失败即抛 `ClientPackageCompositionError`；抛错点 189（非对象 `dsh.client`）、193（`platform` 非字符串）、198（`immediately` 非布尔）、767（声明 `dsh.client` 但无 `./client` 导出）、892（产物缺失）、957（同一包多 Loader 源） | 通过 |
| W25 | 判定速查表 7 行逐行有代码或先例支撑 | 逐行回溯 | 行 1 → 审计 726-747（W4）；行 2 → `project-manager.ts:305-326` 的 `inspectPlugin`；行 3 → `plugins/README.md:69` 的 `duplicate loader entry id`；行 4 → `project-manager.ts:124-134` 的 `allowBuilds` 与 `README.md:179`；行 5 → `modules/src/index.ts:559-568`、`767`、`892`；行 6 → `client/system.ts:205-211`；行 7 → `desktop-host/src/index.ts:361-367` | 通过 |
| W26 | §3.1 两类无条件启动失败项与 §3.2 五项安全降级项 | 逐项回溯 | 插件类 6 条与 W4/W24/`project-manager.ts:253-326`/`plugins/README.md:69`/`desktop-host:298-304`/`allowBuilds` 对应；非插件类 6 条与 `project-manager.ts:397-399,400-402,415,425-428,519-549,645-682`、`release.ts:21-27`、`host-process.ts:99-155` 对应；安全降级项与 W19、`update-coordinator.ts:87-93`、`main.ts:306-312`、`project-manager.ts:451-454`、审计 728 行对应 | 通过（第 1 条的两种形态见 E2） |
| W27 | 更新链路（下载与安装）失败不改变 profile 状态 | 读 `update-coordinator.ts` 与 `main.ts` | 26-31 行构造时关闭自动下载与自动安装，默认启用条件为已打包且存在 `app-update.yml`；52-72 行检查失败只发布状态；74-93 行安装序列为 `downloadUpdate` → 发布 `ready` → `beforeRestart` → `quitAndInstall(false, true)`，整体包在 `try` 内，catch 只发布 `error`；`main.ts:214-222` 的 `beforeRestart` 只停 host；未触碰 profile、staging 或 journal | 通过（应用仍存活但后端已停这一细节见 E7） |
| W28 | 预检清单所列证据路径存在且「升级前可读」 | 逐项打开 | 已装插件清单位于 `.dsh/profiles/web/package.json:24-43` 的 `dsh.profile.bundles`；`packages/client/web/src/platform.ts:8-14` 的 `PLATFORM_MODULES`；`modules/src/index.ts:55-57,196` 的 `external` 声明；`packages/boot/app-boot/src/profile.ts:846-852` 的 `composeEntries`；`deepseek-harness/docs/config-catalog.md`、`docs/cordis-api/`、`docs/subsystems/slots.md` 均存在；`src-tauri/src/update.rs:30-55,337-357,472-507`（registry 查询脚本、`npm_installs_path`、`npm_update_check`）；`docs/dsh-gui/update-check.md:49-57`；`plugins/README.md:56-69,89-108,100-107,203-215`；`docs/dsh-gui/2026-09-11-harness-upgrade-v0-1-5-rc-2.md:64,66`；`.agents/skills/dsh-gui-update/SKILL.md` 第 3 节（39-52）；`apps/desktop/README.md:11,161,167-169,179`；`notes:21,86`；`packages/client/AGENTS.md:91`；`docs/subsystems/workspace.md:5`；`core-package-set.ts:86-92` | 通过（一行不可操作，见 E3） |
| W29 | 版本同一性的五处证据 | 读脚本与清单 | `scripts/package-target.ts:102-106` 要求 desktop 包版本等于仓库根包版本；`scripts/prepare-seed.ts:51-56` 要求 seed 版本来自同一对 manifest 且相等；`project-manager.ts:400-402` 运行时要求 seed 版本等于 Electron 版本；`core-package-set.ts:86-92` 要求 dsh 与 Host 的版本等于期望发布版本；`README.md:11` 与 `notes:86` 陈述同一发布单元 | 通过 |
| W30 | 失败可观测性与重复性 | 通读 `main.ts` 的退出路径并检索重试 | 无「已失败」标记写入（`pending.json` 只在 `activate` 的 520 行创建，步骤 2 至 8 不创建）；`main()` 每次进程启动只调用一次，代码中没有重试、退避或循环重新对账 | 通过 |

## 二、有误或需修正

### E1（实质性）`disabled` 逃生舱在升级路径上不生效，与 §4.3 判据 1 和 §3.2 第 5 条的可操作建议冲突

主张：`2026-09-13-desktop-upgrade-compatibility.md:124` 称「某个插件行在 profile 里被置 `disabled`：审计跳过该条目（`index.ts:728`）。这是让已安装插件留在 profile 里且不阻塞启动的唯一机制」，`:155` 的可执行判据进一步写「若该插件的行能置 `disabled`，则降级为安全」。

复核方法：确认 `disabled` 来自哪一层、被审计时读的是哪个目录，再把升级路径下「被启动的 profile」追到具体目录。

证据：`disabled` 只能由补丁层给出（`packages/boot/app-boot/src/profile.ts:799-802` 读 `<profileDir>/cordis.patch.yml`），而 desktop Host 传给 `loadProfileDirectory` 的正是被启动的那个项目目录（`apps/desktop-host/src/index.ts:154`）。升级路径下被启动的是 staging：`project-manager.ts:412-424` 在 active profile 存在时先读插件清单（413），再 `copyMetadata(seedDir, stagingProfile)`（414），然后离线恢复插件并回写 bundle 列表（417-423）。`copyMetadata`（193-204）只复制 `DESKTOP_PROJECT_FILES`（39-45：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`desktop-release.json`、`desktop-packages.json`）与 `desktop-packages/` 目录，不含 `cordis.patch.yml`；`createSeedMetadata`（686-703）也不产出补丁层。健康检查探的正是 staging（`project-manager.ts:429` → `main.ts:165-194` → `startHost(stagingProfile)`）。因此写在 active profile 的 `cordis.patch.yml` 里的 `disabled` 行不会出现在被审计的 profile 中，升级后的第一次启动照样失败。T2 文档的 §五第 3 条已记录过同一事实（`copyMetadata` 不含 `cordis.patch.yml`，手工补丁层会在下一次插件事务后消失），T11 未引用。

判定：需修正（实质性，影响可执行建议）。失败边界结论本身不受影响；受影响的是「怎么补救」。在版本已一致（走 `project-manager.ts:403-408` 复用快速路径）的启动中，active profile 的补丁层确实有效，因为 `main.ts:212` 启动的就是 active profile；但升级后的第一次启动必然走全量对账，`disabled` 无法介入。

修改建议：把 §3.2 第 5 条与 §4.3 判据 1 改为「`disabled` 只在复用快速路径（版本已一致）的启动中有效：补丁层由被启动的 profile 目录提供（`profile.ts:799-802`），而升级路径下被启动的是由 seed 元数据加恢复插件重建的 staging，`copyMetadata` 不搬运 `cordis.patch.yml`（`project-manager.ts:39-45,193-204,414`）。升级后要保住启动，只能把该插件从 active profile 的 `dsh.profile.bundles` 中移除（该字段经 `pluginRecords` → `writeProfilePlugins` 传递到新 profile），即 §六第 5 条那条尚未验证的手工修复」。

### E2（中危）§3.2 第 1 条把「slot 键变化」与「组件渲染报错」判为安全降级，缺少所引证据

主张：`2026-09-13-desktop-upgrade-compatibility.md:120` 称「浏览器半不兼容：未知平台模块、slot 键变化、组件渲染报错。窗口照常打开，只有该插件 UI 失效」，证据只列 `client/system.ts:205-211` 与 `plugins/README.md:100-107`。

复核方法：核对所引证据覆盖的范围，并读客户端 slot 规则对声明冲突的处置。

证据：`client/system.ts:205-211` 只覆盖「请求了模块表里没有的裸模块」；`plugins/README.md:100-107` 与 `203-215` 记录的是 dsh-pet 的同一类失败。slot 声明冲突的处置写在 `packages/client/AGENTS.md` 的 slot 规则里（声明了未声明的 slot 或重复声明同一 slot 会 "fail at load"），属于客户端加载期失败，页面是否继续渲染静态不可判；组件渲染期抛错是否被错误边界隔离也没有代码或文档证据。

判定：需修正（证据不足的降级判定）。未知平台模块一项成立；另外两项应降级为需实测。

修改建议：把该条拆成两项：「未知平台模块 → 已有先例，窗口照常打开、该插件 UI 失效」与「slot 键变化、组件渲染报错 → 需实测（`packages/client/AGENTS.md` 的 slot 规则显示声明冲突在加载期即失败，页面存活与否静态不可判）」。

### E3（中危）§4.2 把 `cordis_inspect_*` 当作获取目标版本服务面的手段

主张：`2026-09-13-desktop-upgrade-compatibility.md:141` 称「目标版本的服务面先用 `cordis_inspect_list` 发现 Provider，再用 `cordis_inspect_query` 查询 `Service.listService`、`Event.listEvents`」。

复核方法：读这两个工具的实现与描述，确认它们查询的对象。

证据：两个工具确实存在（`packages/extensions/tool-cordis/src/index.ts:44-45` 与 `63-64`）；`cordis_inspect_list` 的返回是 `ctx.cordisInspect.list()`（56-58 行），描述为 "List every Cordis Inspect Provider **currently known to the Host**"；`cordis_inspect_query` 描述为 "Run a read-only query explicitly declared by an Inspect Provider ... **Host queries run locally**"（65-74 行）。两者都作用于正在运行的那个 Host，即升级前预检所在的旧版本；升级前拿不到目标版本的服务面，除非以目标版本启动一个会话。T11 自己在 §4.1 给出过正确路线（「目标版本的服务面就是 harness 仓库该 tag 的源码」），§4.2 最后一行也承认现有 AI 流程的输入只是模块名、路径与版本。

判定：需修正（不可操作的输入项）。这不是硬错误，但该行会让预检执行者去找一个在旧运行时里无法回答的工具。

修改建议：把该行的工具部分改为「以目标 tag 的源码为证据：在目标修订上检索 `super(ctx, '<service>')` 与 `ctx.provide('<service>'` 得到 Provider 集合，配合该 tag 的 `cordis.patch.yml` 行集合得到启用面」，并注明 `cordis_inspect_*` 只在会话本身运行目标版本时才可用（例如在副本中以目标版本启动后）。

### 已撤回：原 E4（行号偏一）

原 E4 判定 T11 「系统性行号偏一，至少十处」。经三种独立方法复核，该判定不成立：T11 给出的行号全部正确，偏差来自我此前的 PowerShell 行号标注写法。完整复核证据与偏移来源见第三节。

### E5（低危，精确性）「唯一豁免」的表述未涵盖 `boot()` 的整体绕过路径

主张：`2026-09-13-desktop-upgrade-compatibility.md:76` 称审计中「唯一被跳过的是 `disabled` 条目（728）」。

复核方法：读 `boot()` 全文找审计的调用条件。

证据：入口级豁免确实只有 `disabled`（`index.ts:728` 与 689）；但 `boot()` 在 `index.ts:813` 还有一条整体路径：`if (ctx.get('loader') === undefined) return ctx`，即某个 surface 在启动中处置掉整棵树时直接返回，不调用审计。

判定：需修正（限定缺失）。桌面场景下这条路径的触发条件（有 surface 主动 dispose 整树）不常见，但「唯一」的表述不严格。

修改建议：改为「入口级豁免只有 `disabled`；此外 `boot()` 在 loader 服务已消失时整体跳过审计（`index.ts:812-813`），该路径对应启动期间整树被处置的情形」。

### E6（低危，措辞）§1.2 步骤 7 的「逐个恢复」与代码不符

主张：`2026-09-13-desktop-upgrade-compatibility.md:45` 称「有插件时按 `name@version --save-exact --offline` 逐个恢复（417-422）」。

复核方法：读 `project-manager.ts:416-424` 的 pnpm 调用次数。

证据：417-422 行是单次 `runPnpm(projectDir, ['add', ...plugins.map(...), '--save-exact', '--offline'])`，所有插件规格在同一命令内传入，不是每个插件一次调用。

判定：需修正（措辞）。「逐个」易被读成逐次调用。

修改建议：改为「一次调用批量传入全部 `name@version` 规格」。

### E7（低危，细节缺失）§1.1 未点明安装失败时后端已被停掉

主张：`2026-09-13-desktop-upgrade-compatibility.md:31` 称安装阶段「任何一步抛错都只发布 `error` 状态，当前应用继续运行」。

复核方法：读 `update-coordinator.ts:74-93` 的步骤顺序与 `main.ts:214-222` 的 `beforeRestart`。

证据：85 行的 `quitAndInstall` 之前，84 行已 `await this.beforeRestart()`，而该实现（`main.ts:216-221`）把 `host` 置为 `undefined` 并停掉子进程。若 `quitAndInstall` 抛错，catch 只发布 `error`，应用存活但 `dsh-app://app` 只回 503（`main.ts:228-230`）直到重启。

判定：需修正（补充说明）。T11 在 §2.4 与 §3.2 第 4 条描述的正是这种降级态，只是 §1.1 未与之呼应。

修改建议：在该句后补「此时 dsh 子进程已被 `beforeRestart` 停掉，应用以 503 应答直到重启」。

### E8（低危，清单不完整）§5「仍需人工」清单缺一项

主张：`2026-09-13-desktop-upgrade-compatibility.md:173-179` 列出五项仍需人工或 agent 判断的部分。

复核方法：把 §2.1、§3.1、§4.3 提到的失败源与清单对照。

证据：`allowBuilds` 白名单写死在 `project-manager.ts:124-134`（T11 在 §2.1 已说明「插件无法在安装时扩充」），因此当某个必须的插件带构建脚本时，解决办法是改上游源码或让上游接受该包，这不是「预检」能覆盖的判断项，清单里没有。

判定：需修正（清单不完整）。

修改建议：在「仍需人工」清单补一项「带构建脚本的依赖需要修改上游 `allowBuilds` 白名单（`project-manager.ts:124-134`）；预检只能发现该冲突，不能在 profile 侧解除」。

## 三、撤回记录：原 E4（T11 的行号并不偏一）

原 E4 判定 T11 「系统性行号偏一，至少十处」。三种独立方法（read 工具带行号、grep 工具、`Get-Content` 后按 1-based 索引取行）逐条复核后，该判定不成立：**T11 给出的行号全部正确，偏差来自我此前复核命令里的 PowerShell 行号标注写法。**

偏移来源是「先打印再自增」的写法。我此前用 `ForEach-Object -Begin {$i=N} -Process {"{0}: {1}" -f $i, $_; $i++}` 逐行打印，`$i` 在打印之后才自增，于是每一行的标签都比真实行号少 1；改为先 `$i++` 再打印（或用 `Select-String` 的 `LineNumber`）即恢复真实行号。在同一文件上两种写法对照可复现这 1 行位移：正确写法输出 `143: constructor(...)`、`144: super(ctx, 'webServer')`、`145: const resolved = ...`，错误写法输出 `142: constructor(...)`、`143: super(ctx, 'webServer')`、`144: const resolved = ...`。

复核证据（三种方法的结论完全一致，全部指向 T11 的原行号）。

| 引用 | read 工具带行号 | grep 工具 | `Get-Content` 1-based 索引断言 | 结论 |
|---|---|---|---|---|
| `packages/host/webserver/src/index.ts:144` | `144: super(ctx, 'webServer')` | `Line 144` | line 144 match=True | T11 正确 |
| `src-tauri/ui/app.js:2123` | `2123: const AI_UPDATE_SKILL = "/dsh-gui-update";` | `Line 2123` | line 2123 match=True | T11 正确 |
| `src-tauri/ui/app.js:2129` | `2129: const HARNESS_MODULE_NOTE = ...` | `Line 2129` | line 2129 match=True | T11 正确 |
| `src-tauri/ui/app.js:2135` | `2135: const AI_UPDATE_WORKSPACE_NOTE = ...` | `Line 2135` | line 2135 match=True | T11 正确 |
| `.agents/skills/dsh-gui-update/SKILL.md:45` | `45: 3. 分析该版本的影响：...` | `Line 45` | line 45 match=True | T11 正确 |
| `.agents/skills/dsh-gui-update/SKILL.md:48` | `48: 6. 屏蔽确认与新版不兼容...` | `Line 48` | line 48 match=True | T11 正确 |
| `deepseek-harness/apps/cli/src/profile-boot.ts:336` | `336: const ctx = await boot(NAME, rootConfig, ...)` | `Line 336` | line 336 match=True | T11 正确 |
| `packages/client/AGENTS.md:91` | `91: Unsatisfied / stays PENDING, with no timeout / throws on the spot` | `Line 91` | line 91 match=True | T11 正确 |
| `docs/tool-catalog.md:410` | `410: Run a read-only query ... For Slots.listSubTree ...` | `Line 410` | line 410 match=True | T11 正确 |
| `notes:86` | `86: Electron update uses one \`electron-updater\` release stream ...` | `Line 86` | line 86 match=True | T11 正确 |
| `docs/dsh-gui/2026-09-11-harness-upgrade-v0-1-5-rc-2.md:64` | `64: **会话数据格式为单向升级。** ...` | `Line 64` | line 64 match=True | T11 正确 |
| 同上 `:66` | `66: **Node 版本下限提高到 24.2。** ...` | `Line 66` | line 66 match=True | T11 正确 |
| `src-tauri/src/main.rs:615` | `615: "harness exited before becoming ready (status {status}); ..."` | `Line 615` | line 615 match=True | T11 正确 |

T11 对 SKILL.md 的步骤编号映射同样正确：第 3 节第 3 步在第 45 行，第 4 至 6 步在第 46 至 51 行；第 6 步的标题在第 48 行，其子项延伸到第 51 行。

本节结论：不要按原 E4 的建议把这些行号改成减 1 的值，那样每处引用都会落到目标行的上一行。原 E4 撤回后，第二节的实际条目为 7 条（E1、E2、E3、E5、E6、E7、E8），其中实质性 1 条、中危 2 条、低危 4 条。

同一轮审计也发现我自己的文档里存在同源偏移，已按 read 工具与 grep 工具的结果逐处改正：W21 的 `packages/client/AGENTS.md:90` 改为 `:91`；W22 的 `src-tauri/src/main.rs:612-617` 改为 `613-618`；W23 的自引用区间 `440-444` 改为 `442-446`、环区间 `431-437` 改为 `433-438`、跳过行 `446` 改为 `447`；W25 与 W26 的 `plugins/README.md:68` 改为 `:69`；W28 的 `.dsh/profiles/web/package.json:21-43` 改为 `24-43`、`profile.ts:845-852` 改为 `846-852`、`update-check.md:48-56` 改为 `49-57`、`2026-09-11-harness-upgrade-v0-1-5-rc-2.md:63,65` 改为 `64,66`、`SKILL.md` 第 3 节 `38-51` 改为 `39-52`、`notes:21,85` 改为 `21,86`、`core-package-set.ts:85-90` 改为 `86-92`；W29 的 `core-package-set.ts:85-90` 与 `notes:85` 同步改为 `86-92` 与 `86`；W30 的证据文件名 `main.rs` 改为 `main.ts`；E3 的 `tool-cordis` 描述区间 `65-73` 改为 `65-74`。这些位置只涉及证据坐标，不改动任何结论。

## 四、无法验证

1. 插件的 `apply` 永不 settle 导致启动永久挂起：静态可判（W8 的无超时结论成立），但挂起时的界面表现、日志可观测性与用户可感知程度需要实跑。
2. pnpm 对 peer 范围冲突的处理：`project-manager.ts:106` 设了 `autoInstallPeers: false` 但未设 `strict-peer-dependencies`，插件 peer 范围与新核心版本不符时是安装直接失败还是落到后续 pending，静态不可判。
3. 原生模块 ABI 不匹配在打包版上的具体症状（预期是 `apply` 内 `require` 抛错、fiber FAILED，即启动失败类），需实跑。
4. 浏览器半未命中模块表时主窗口与其余插件是否继续可用：T11 引用的 `dsh-pet` 只有文字记录，没有复现结果；本次同样无法复现（见 E2）。
5. 手工修 `dsh.profile.bundles` 是否真的能让升级后的启动成功：代码路径支持（`pluginRecords` 只读该字段，413 行），但本次没有实跑，也无法验证 CLI 是否会以别的方式介入。
6. 装回旧版发布包能否恢复可用：`electron-updater` 不提供降级（`update-coordinator.ts:26-31`），但旧版发布包在用户机器上的可用性取决于复用快速路径与旧 profile 是否仍完整，需实跑。
7. 对账期间无窗口期的时长与进度可见性：staging 安装加一次完整起停都没有进度界面，需实跑。
8. 以目标版本启动的会话中 `cordis_inspect_*` 能否给出与静态源码检索一致的服务面：本次只核对了工具语义（E3），未运行目标版本。

## 五、总体判定

T11 的失败边界结论成立，本轮最关键的一环经逐行确认：`packages/boot/app-boot/src/index.ts:722-755` 确实把 pending 与 failed 都计入失败集合并在集合非空时抛错，两者只在诊断文本上有区别（pending 列未满足的服务名，failed 带原始 stack），入口级豁免只有 `disabled`（728）。这条结论沿链路逐环闭合：`boot()` 调用审计（814）并在失败时抛 `plugin tree failed to load`（816-833）→ desktop Host 的 `ready` 不再发出（406-411）并上报 `fatal` 与退出码 1（580-586）→ 壳侧 `start()` 的 promise 被 `fail()` 拒绝且没有超时（`host-process.ts:99-155`）→ 健康检查失败（`main.ts:165-194`）→ `applyRelease` 抛错并删除 staging（`project-manager.ts:429-435`）→ `main()` 在创建窗口前退出，弹错误框并以 1 结束（`main.ts:205-212,388-397`）。没有「壳起窗、只让后端不可用」的降级分支，503 分支在启动路径上不可达。

**失败边界最终判定：确认「宿主半 pending 或 failed 的插件会导致应用无法启动，且每次启动重复失败」。** 另有两条并列结论同样成立：其一，`apply` 永不 settle 时不是失败退出而是永久挂起（无超时，无窗口无提示）；其二，浏览器半失败不阻塞启动，只让该插件 UI 失效（`client/system.ts:205-211`）。`project-manager.ts:400-402` 的比较对象确实是「seed 的 release 文件 vs Electron 版本」，旧 profile 过期的处理在 403-408 的复用快速路径与 412-424 的离线恢复，T11 的更正正确。

发现有 1 处实质性需修正：`disabled` 逃生舱在升级路径上不生效（E1，因为受审计的 staging 由 seed 元数据加恢复插件重建，`copyMetadata` 不搬运 `cordis.patch.yml`），这条会影响文档给出的补救建议；另有 2 处中危（slot 键变化与渲染报错被当作安全降级但无证据、`cordis_inspect_*` 无法在旧运行时查询目标版本服务面）与 4 处低危（`boot()` 整体绕过路径未提、单次批量恢复被写成「逐个」、安装失败时后端已停的细节、`allowBuilds` 未列入人工清单）。原 E4「系统性行号偏一」经三种方法复核后撤回：T11 的行号全部正确，偏移来自我此前复核命令里「先打印再自增」的写法（见第三节），不受该撤回影响的是 E1、E2、E3、E5、E6、E7、E8。

是否建议放行：失败边界结论与判据清单可以直接采用，建议放行；但可操作建议部分需要按 E1 修正后再落到用户侧，否则升级失败后按文档去改 `disabled` 会无效。E2 与 E3 建议一并修正。
