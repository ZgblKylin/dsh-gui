# Electron Desktop 本地构建、落位与 Profile 重定向调研

本文件记录把 `.staging/dsh-gui` 副本同步到当前版本，并回答三个 desktop 问题的完整过程与结论。布局契约见 [nested-clone-layout.md](nested-clone-layout.md)。

## 结论摘要

| 问题 | 结论 | 一条实测判据 |
|---|---|---|
| 能否本地编译基于 Electron 的 desktop 版本？ | **能** | `pnpm run build:official` 退出码 0（8.4 分钟），产出 `apps/desktop/lib/main.js`、`apps/desktop-host/lib/index.js` 与 `apps/web/dist/`；`electron.exe --version` 输出 `v44.0.0` |
| 能否把 desktop 安装到 dsh-gui 的 runtime 路径，即上层 `.staging`？ | **能，限目录形态** | `package:desktop:win:x64:unsigned -- --dir` 退出码 0，产物复制到 `.staging/desktop/`（0.99 GB、9819 个文件）后可直接启动并渲染窗口 |
| 能否把 desktop 的 profile 重定向到本地 `.dsh`？ | **能，但不能复用 `profiles/web`** | `DSH_HOME=.staging\.dsh` 启动后 `.staging\.dsh\profiles` 下 `web` 与 `desktop` 并存；本工程 `.dsh` 未出现 `profiles/desktop` |

「安装到 runtime 路径」的准确含义是**把 desktop 目录放到运行时根之下**，不是让它遵守运行时根契约。运行时根的契约条目是 `.dsh`、`.harness`、`.toolchain`、`.pnpm-store`、入口 exe 与 `run.cmd`；desktop 自带 Electron、内嵌 node/pnpm、`app.asar/dsh` 生产树与自己的 profile，不读取 `DSH_GUI_RUNTIME_ROOT`。让它真正接入该运行时语义的开关是 `DSH_HOME`，即第三个问题。

## 一、staging 副本重建

仓库根是 `D:\git\dsh-gui-home\dsh-gui`，运行时根是 `D:\git\dsh-gui-home`。`scripts/staging.mjs` 把副本放在 `<运行时根>/.staging/dsh-gui`，副本自身的运行时根就是 `.staging`。

仓库内旧布局遗留的 `.staging`（34 个条目、无 `.git`，只有零散 `lib` 与 `target/debug` 残骸）已删除。副本由 `npm run staging -- ensure` 在 `D:\git\dsh-gui-home\.staging\dsh-gui` 全新建出：HEAD 为 `38a07086c10cf8a2ae5e98f3bd7ffdc838a34301`，与仓库一致；`git submodule status --recursive` 共 14 行（10 个顶层加 `dsh-web-ui` 下的 4 个卫星仓库），无 `+`/`-` 前缀；`deepseek-harness` 检出于 `639ed015397290b3745d163aafe02ffee4aa3f84`（`dsh-v0.2.0-rc.2`）。`ensure` 耗时 460 秒，`sync` 17 秒。

副本自举构建 `npm run build -- --skip-exe` 退出码 0，把 `@deepseek-ai/dsh@0.2.0-rc.2` 装进 `.staging\.harness`，把插件与全局 agent 模板装进 `.staging\.dsh`。`--profile web --dump-config` 退出码 0，1319 行、306 条 entry id，无 `duplicate loader entry id`；以空闲端口 3090 启动副本 web 后端，`/` 返回 200 且页面含 `__DSH_BOOT__`。副本各目录体积为 `.harness` 451.3 MiB、`.toolchain` 27.2 MiB、`.pnpm-store` 2597.3 MiB、`.dsh` 392.8 MiB、`.cache` 150.6 MiB。

本次未构建 Tauri 入口 exe（`--skip-exe`），因此 `.staging\dsh-gui.exe` 不存在。`npm run staging -- status` 的 `entry exe: built` 是误报，它的判据同时匹配 `dsh-gui.exe` 与名为 `dsh-gui` 的副本目录。

首次构建在 `plugins/plugin-market/install.mjs` 的 `dsh plugin add dshmarket@1.66.5` 处挂起 1354 秒。判据是 pnpm 已打印 `Done in 4.5s`、进程 CPU 冻结且无网络连接、`.dsh\profiles\web\package.json.lock` 的内容是本链自身 PID、`.pnpm-store` 无锁文件，因此判定为本链 pnpm 在退出阶段自挂，而非与其他任务争用。终止该进程后 dsh 自行清理锁与 `run.json`，重跑 48 秒通过，同一位置未再现。

## 二、Q1：本地编译 desktop

依赖安装用 `pnpm install --frozen-lockfile`：链接 1392 个包、写入 `node_modules\.modules.yaml`、`apps/desktop/node_modules` 就绪，`pnpm-lock.yaml` 未被回写。加 `--frozen-lockfile` 是硬要求，它保证不触碰 `deepseek-harness/` 的受版本管理文件。

`pnpm run build:official` 退出码 0，耗时 8.4 分钟。该命令内部已经包含 desktop 壳与其 Host 的编译，日志展开序列末段是 `pnpm --filter @deepseek-ai/dsh-desktop run bundle`，因此不需要单独再跑一次 `apps/desktop` 的 `build`。产物包括 `apps\desktop\lib\main.js`（478.70 KB）、`apps\desktop-host\lib\index.js`（13.50 KB）与 `apps\web\dist\`（347 个 client artifact）。

Electron 二进制不会被自动安装：仓库 `pnpm-workspace.yaml` 的 `allowBuilds` 不含 `electron`，其 postinstall 不执行。在 `apps\desktop\node_modules\electron` 内手动运行 `node install.js`（配合 `electron_config_cache` 与 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）后，`dist\electron.exe` 为 233.10 MB，`electron.exe --version` 输出 `v44.0.0`。

`lib\preload.cjs` 不是当前修订的构建产物。权威入口清单是 `apps/desktop/tsdown.config.ts:93` 的五个 preload（`preload-app`、`preload-welcome`、`preload-platform-account`、`preload-mandatory`、`preload-update-dialog`），运行期必需产物清单是 `apps/desktop/scripts/prepare-installed-update-application.ts:36` 的四项。仓库检出内确实存在一个同为 `lib\preload.cjs` 的文件，但它是 2026-09-12 留下、未跟踪且被 `.gitignore` 忽略的旧残留，副本内不存在。

## 三、Q2：落位到运行时根

打包入口是 `pnpm run package:desktop:win:x64:unsigned -- --dir`。`--unsigned` 只接受 `win-x64`，可与 `--dir` 同用；它让 `win.forceCodeSigning` 取 `!unsigned`（即 `false`），签名钩子为 `undefined`，`afterSign` 被跳过，产物落到 `unsigned-artifacts` 且名字带 `-unsigned` 后缀。因此本机在没有 EV 证书与 SafeNet 令牌的条件下也能产出 win-x64 产物。

产物位于 `apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\win-unpacked\`：整目录 0.99 GB、9819 个文件，入口 `DeepSeek Harness.exe` 为 233.14 MB，`Get-AuthenticodeSignature` 报 `NotSigned`，`unsigned-artifacts` 下没有 `-release.json`。用 `robocopy /E /MT:8` 整体复制到 `D:\git\dsh-gui-home\.staging\desktop`，1013.56 MB、0 个失败文件。

从落位目录启动成功：`list_windows` 得到 `DeepSeek Harness.exe (pid 26052) "DeepSeek Harness"` 且窗口在屏，截图有真实渲染，Host 在 19387 返回 200、35,578 字节的页面与 `assets/index-5SrrfWpU.js`。该资产在「本机构建的 `apps\web\dist\assets\`」「dev 实例 Host」「打包实例 Host」三处的字节内容一致，说明落位后的应用服务的确实是本次构建的客户端。资产大小为 633,282 字节；任务 scratch `.work/desktop-research/03-build.md` 三处写作 633,245，相差 37 字节，以复核重算值为准。

落位只新增 `desktop` 一个目录，与 `.dsh`、`.harness`、`.toolchain`、`.pnpm-store`、`dsh-gui`、`run.cmd` 均不同名。回滚方式是关闭进程后删除该目录；`npm run staging -- clean --yes` 不会清理它。安装器形态（NSIS）是 per-user 辅助式安装器，可用 `/S /D=<path>` 定向到 `.staging\desktop`，但它会额外写 HKCU 安装记录、卸载项与两个快捷方式，本次未采用。

## 四、Q3：profile 重定向

`DSH_HOME` 是唯一能改 profile 位置的开关。`apps/desktop/src/paths.ts:17` 以 `resolveDshHome()` 的返回值构造路径，两处调用都不传参，因此没有编译期第二入口；解析顺序是显式参数、`$DSH_HOME`（空白值视为未设置）、`homedir()/.dsh`。profile 名硬编码为 `desktop`，即 `<DSH_HOME>/profiles/desktop`，与 dsh-gui 的 `<运行时根>/.dsh/profiles/web` 同级但互不相通。

实测两种指向都成立。指向独立 home `D:\git\dsh-gui-home\.staging\.desktop-home` 时，该目录下出现 `profiles\desktop`、`sessions`、`storages`、`.credentials.yaml`、`.anonymous-user-id`。指向 `.staging\.dsh` 时，`profiles` 下 `web` 与 `desktop` 并存，互不覆盖；同时本工程 home `D:\git\dsh-gui-home\.dsh` 未出现 `profiles\desktop` 或 `dsh-runtimes`，即正在运行的 dsh-gui 未被污染。

边界有三条。desktop 只在 `profiles\desktop` 内从零初始化（`initProfile` 幂等，已存在的文件不覆盖），不能复用 `profiles/web` 的依赖与 `cordis.patch.yml`；同一 home 下能共享的是 `sessions`、`storages`、`.credentials.yaml`、settings 与 workspaces 这类产品数据，代价是两台实例成为并发写者；`DSH_HOME` 指向一个已有 `.credentials.yaml` 的 home 也仍会停在欢迎页，因为 `needsWelcome` 还取决于 Host 侧的登录态或 API key。

`dev` 态与打包态的默认 home 不同：dev 默认 `<APP_ROOT>/.desktop-build/development/home`，打包态默认 `~/.dsh`。`DSH_DESKTOP_USER_DATA_DIR` 与 `--user-data-dir` 只管 Electron 用户数据（单实例锁身份、浏览器数据、快捷键、崩溃报告），与 profile 无关，但它决定能否与另一实例并存。desktop Host 的端口硬编码为 19387，与 dsh-gui 的 3080 默认不冲突，也没有环境变量可覆盖。

## 五、发现的产品缺陷与阻塞点

| # | 现象 | 根因 | 规避方式 |
|---|---|---|---|
| 1 | 打包在 `prepare:packages` 阶段失败：`tar (child): Cannot connect to D: resolve failed` | `apps/desktop/scripts/prepare-package-set.ts:91` 把带盘符的绝对路径直接交给 `tar`，PATH 上的 Git GNU tar 1.35 按 POSIX 把 `D:` 解析为远端主机；`scripts/release/process.ts:69` 抛出该错误 | 把 `C:\WINDOWS\System32` 前置到 PATH，改用 Windows 内置 bsdtar 3.8.8，只改环境不改产品文件 |
| 2 | primary runtime 准备阶段进度近乎停滞 | `prepare-runtime.ts:63` 无条件调用 `preparePrimaryRuntime()`，产品脚本串行单流拉取 13 个锁定资产；本机对 GitHub release 资产实测约 20–36 KiB/s。首次测量用的 `curl.exe` 在该机上对多个上游（nodejs.org、npmmirror、GitHub）均返回零字节，而同一时段 Node `fetch` 能取得数据，因此 curl 不能作为本机的连通性与带宽判据 | 从镜像预置 15 个锁定资产到 `<cache>/<sha256>`，逐个按 `lock.json` 的 SHA-256 自验后由产品脚本复用 |
| 3 | 工具链探测通过但实跑失败 | `desktop-toolchain-preflight.ts:25-44` 故意用 `cwd` 加 basename 规避盘符问题，而 release 真实路径沿用绝对路径，探测与实跑不一致 | 同第 1 条 |
| 4 | 工作台窗口未渲染 | `main.ts:1199-1207` 的 `needsWelcome({loggedIn, hasApiKey})` 门控，本机没有可用登录态或 API key | 无；替代判据是 Host 服务的客户端字节与本地构建一致 |
| 5 | 打包请求 EV 签名四要素 | `win.forceCodeSigning` 取 `!unsigned`，仅签名路径为 `true` | 使用 `package:desktop:win:x64:unsigned` |
| 6 | `loadDesktopPackageEnvironment()` 报缺少 `.env.windows` | 该函数只读 `apps/desktop/.env.windows`，并剥离 ambient 同名单变量，因此无法用环境变量替代 | 复制 `.env.windows.example` 后填 `DSH_DESKTOP_APP_ID` 与所选部署的 mandatory-update origin；该文件被 `deepseek-harness/.gitignore:3` 忽略 |
| 7 | `dsh plugin add` 在副本自举构建中挂起 | 本链 pnpm 在打印 `Done in 4.5s` 后未退出，进程冻结且无网络连接 | 终止该进程、清理陈旧锁后重跑；同位置未再现 |
| 8 | `staging status` 报 `entry exe: built` | 判据同时匹配 `dsh-gui.exe` 与名为 `dsh-gui` 的副本目录 | 无；核对 `.staging\dsh-gui.exe` 是否存在 |

第 1、3 条互为对照：同一条链上探测通过、实跑失败，属于上游产品的真实缺陷，在 PATH 上只有 Git GNU tar 的 Windows 环境必然触发。第 2 条同时阻塞签名与免签名两条路径，「免签名」不等于「免联网」。

## 六、相对 2026-09-13 记录的失效结论

[2026-09-13-desktop-build.md](2026-09-13-desktop-build.md) 以 `dsh-v0.1.5-rc.2` 为基线，以下结论在当前修订不再成立。

| 旧结论 | 当前事实 |
|---|---|
| win-x64 不存在免除签名的打包路径 | 存在 `package:win:x64:unsigned`，`win.forceCodeSigning` 为 `!unsigned` |
| 配置加载时即要求签名四要素，缺任一项直接抛错 | 仅签名且非 prepare-only 路径如此；`--unsigned` 在 `desktop-package-environment.mjs` 提前返回 |
| 首次启动把种子 store 解压到 `$DSH_HOME\desktop\pnpm\store`，并出现 `seed/integrity.json` 缺失 | 运行时路径已无 seed 概念；核心包由签名运行时树 `app.asar/dsh` 提供，启动不跑 pnpm |
| 打包链包含 `prepare:seed` | 当前链在 `prepare:dsh` 之后直接进入 electron-builder |
| 未打包进程可用 `DSH_DESKTOP_NODE_BINARY`、`DSH_DESKTOP_SEED_DIR`、`DSH_DESKTOP_DEV_PROJECT_DIR` 指定资源 | 当前可用输入是 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR`、`DSH_DESKTOP_PNPM_ENTRY`、`DSH_DESKTOP_DSH_DIR`、`DSH_DESKTOP_USER_DATA_DIR` |
| 沙箱禁止管道 stdio 子进程，`tsx` 以 `spawn EPERM` 终止 | 属会话环境事实；在 `danger-full-access` 文件策略下未复现，`tsx` 正常进入构建 |
| `%LOCALAPPDATA%` 不可写故须重定向缓存 | 本机 `%LOCALAPPDATA%` 可写；重定向仍用于把证据收在 `.staging\.cache` 下 |

仍然成立的是 Electron 44.0.0 的版本，以及 `electron_config_cache` 只对 dev 路径生效（打包路径把 Electron 解析到 `.desktop-build/downloads`）。

## 七、复现步骤

```powershell
# 1. 重建副本（在本工程仓库根执行）
npm run staging -- ensure
npm run staging -- sync

# 2. 副本自举
cd D:\git\dsh-gui-home\.staging\dsh-gui
$env:DSH_HOME = 'D:\git\dsh-gui-home\.staging\.dsh'
npm run build -- --skip-exe

# 3. desktop 依赖与二进制
cd D:\git\dsh-gui-home\.staging\dsh-gui\deepseek-harness
$env:DSH_HOME = 'D:\git\dsh-gui-home\.staging\.dsh'
$env:electron_config_cache = 'D:\git\dsh-gui-home\.staging\.cache\electron'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
pnpm install --frozen-lockfile --store-dir 'D:\git\dsh-gui-home\.staging\.pnpm-store'
pnpm run build:official
cd apps\desktop\node_modules\electron; node install.js; cd ..\..\..\..
.\apps\desktop\node_modules\electron\dist\electron.exe --version

# 4. 解包打包（先准备 apps\desktop\.env.windows，并把 System32 前置到 PATH）
$env:PATH = "$env:SystemRoot\System32;$env:PATH"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
pnpm run package:desktop:win:x64:unsigned -- --dir

# 5. 落位与启动
robocopy 'apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\win-unpacked' 'D:\git\dsh-gui-home\.staging\desktop' /E
$env:DSH_HOME = 'D:\git\dsh-gui-home\.staging\.desktop-home'
& 'D:\git\dsh-gui-home\.staging\desktop\DeepSeek Harness.exe' "--user-data-dir=D:\git\dsh-gui-home\.staging\.desktop-home\electron-user-data"
```

第 4 步的 `.env.windows` 至少需要 `DSH_DESKTOP_APP_ID`（反向域名）、`DSH_DESKTOP_AUTO_UPDATE_ENV=test`、`DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN`（无路径与查询的 HTTPS origin），以及 `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG` 中非空的 `allowedAuthOrigins`；`DSH_DESKTOP_NPM_REGISTRY` 可指向镜像以加速 `prepare:dsh`。

## 八、未决与遗留

1. 工作台窗口未渲染。dev 与打包两种形态都停在欢迎页，本机缺少可用登录态，因此「真实会话界面」没有取得截图。
2. `pnpm install --frozen-lockfile` 的真实退出码未回收，成功判据是 `.modules.yaml` 写入、1392 个包目录与后续构建跑通。
3. 镜像预置 primary runtime 资产是本次的环境绕过手段，不是受支持流程；正式构建应让 `preparePrimaryRuntime()` 自行下载。
4. NSIS 安装器形态与 portable 目标均未实跑；本配置的 Windows 目标只有 `nsis`，portable 需要改配置。
5. `plugins/??@deepseek-ai/dsh-client-modules/client.js` 多模块端点未复验，一次 404 来自探针未还原 HTML 实体。
6. 本次未构建 Tauri 入口 exe，`.staging\dsh-gui.exe` 不存在；副本若要作为可运行的 dsh-gui 使用，需由用户在停止运行中的实例后执行 `npm run build`。

## 九、独立复核

静态结论与 staging 重建结果由 `verifier` 逐条独立复核，结论见任务 scratch `.work/desktop-research/05-verification-static.md`（已清理）。复核指出的问题集中在引用精度与措辞边界，不改变上表结论。

| 编号 | 问题 | 处理 |
|---|---|---|
| D5 | 「0.2.0-rc.2 无 `lib/preload.cjs`」在文件层不成立（仓库检出内有旧残留） | 本文改述为「不是当前构建的产物」，并说明该残留的来源与忽略状态 |
| D7 | 「本工程仓库根未被写入」字面不成立（本次新增两份被忽略的文档） | 本文改述为「受版本管理文件未改、仓库根无运行期产物」 |
| D3/D4 | `01-pipeline.md` 两处 `package.json` 路径缺 `apps/desktop/` 前缀 | 本文不引用该两处行号 |
| D6 | `00-staging-sync.md` 前后状态描述互斥（重建前与自举后两个时点） | 本文只采用自举后的时点 |
| D8 | `02-profile.md` 一处 grep 证据句不实 | 实质结论经复核成立，本文只用结论 |

实跑结论的独立复核见同文件的「实跑复核」一节，三个问题均通过，其中 Q2 由复核者用独立 home 与新 `--user-data-dir` 重新启动一次确认：4 秒后 19387 开始监听，`list_windows` 得到 616×709 的窗口，截图 SHA-256 与任务执行的两次截图逐字节相同；Host 资产的落盘哈希与本轮构建产物一致。复核者另用 `Get-FileHash` 重算了 `.desktop-build\downloads` 下 15 个资产，全部与文件名哈希匹配。缺陷 1（tar）被独立复现：Git GNU tar 1.35 退出码 2，System32 的 bsdtar 3.8.8 退出码 0。

复核推翻了一条结论的强度：本机对 GitHub release 资产的通道**并非不可用，而是极慢**。用产品同款 Node `fetch` 实测两次分别为 25 秒得 489,146 字节、50 秒得 1,817,121 字节；此前的「零字节」只在 `curl.exe` 上出现，而同一时段 curl 对 nodejs.org 与 npmmirror 也返回零字节。本文已按此修正第 5 节的表述。另有 3 处数字需以复核为准：Host 客户端资产为 633,282 字节、`.pnpm` 包目录计数存在多种口径、`apps/web/dist` 的 196 个文件与构建记录的 347 个 client artifact 是两个不同统计。

复核过程中发生过一次工作区外误写入：`verifier` 把 PowerShell 只读自动变量 `$home` 用作变量名，赋值失败导致 `DSH_HOME` 落到 `C:\Users\zgblc`，desktop 因此在用户目录根部新建了 `profiles`、`sessions`、`storages`、`.credentials.yaml`、`.anonymous-user-id`。这五项已按创建时间取证后由 Lead 删除，用户全局 `C:\Users\zgblc\.dsh` 未受影响；该次启动的窗口证据不计入 Q2 判据。

主 `.dsh` 的 mtime 变动由 Harness 自身的图片读取工具写入内容寻址附件库（`attachments\v1\objects\5ef9d88e…`）引起，与 desktop 无关：副本 `apps\desktop\src` 内没有 `attachments` 引用，且复核者读取同一截图时工具自报的规范化路径正是该对象。

## 十、任务分工与产出

| 任务 | 承担者 | 产出 |
|---|---|---|
| 副本重建与自举构建 | `staging-sync` | `00-staging-sync.md` |
| desktop 构建链与安装器语义 | `desktop-pipeline` | `01-pipeline.md`、`04-install-layout.md` |
| profile 与 `DSH_HOME` 解析 | `desktop-profile` | `02-profile.md` |
| desktop 实跑（编译、启动、落位） | `desktop-builder` | `03-build.md` |
| 独立复核 | `verifier` | `05-verification-static.md` |

上述产出文件全部位于任务期间的任务 scratch `.work/desktop-research/`（被 `.gitignore` 排除、不进入版本管理，任务收尾后已清理）。本工程仓库根在任务期间未执行任何构建或安装：`git status --porcelain` 仅剩任务开始前既有的 `docs/dsh-gui/remote-ssh-broker-in-shell.md` 一处改动。
