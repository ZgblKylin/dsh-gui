# Electron Desktop 试用构建记录（win-x64）

## 结论摘要

在副本 `E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\` 中，Electron 二进制与 Desktop 壳的编译已完成并经过验证；完整的 `win-x64` 打包链（`package:desktop:win:x64:dir`）未能完成，因此没有产出可试用的解包应用目录。

成功/失败分界如下。

- 成功：Electron 44 二进制下载并安装（`electron.exe --version` 输出 `v44.0.0`）；`apps/desktop` 的 `tsc -b && tsdown` 编译通过，产出 `lib/main.js`、`lib/preload.cjs`、`lib/preload-app.cjs`；编译后的壳可由 Electron 加载并创建窗口。
- 失败：打包链在本环境的两个独立阻塞点上无法推进。其一，dsh 沙箱禁止管道 stdio 子进程，`tsx` 所依赖的 esbuild 服务进程无法启动，打包脚本与整仓构建脚本都在启动阶段以 `spawn EPERM` 终止；其二，`win-x64` 的 electron-builder 配置在加载时即要求 Windows EV 签名四要素，缺任一项直接抛错。

两个阻塞点相互独立：即使放开沙箱，缺少 EV 证书与 SafeNet 令牌仍无法产出应用；即使提供签名要素，沙箱仍会拦住 `tsx`。

T3 之后，Lead 在放开沙箱的会话中用 dev 模式成功启动了未打包的 Electron desktop，判据与命令见「dev 模式试用链路」一节。可试用的形态是 dev 模式的未打包进程，不是打包应用。

## 环境与前置事实

构建目标是副本 `E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\`，检出于 `dsh-v0.1.5-rc.2`（`fb2c4b9e698e30edb738bca4cf0618587db7d203`）。本次记录的命令全部在副本内执行，副本内每条命令都显式设置 `$env:DSH_HOME='E:\Git\dsh-gui\.staging\dsh-gui\.dsh'`。本工程子模块 `E:\Git\dsh-gui\deepseek-harness\` 内存在归属未核实、被 `.gitignore` 忽略的构建残留：`apps/desktop/lib`（`main.js` 183,129 B 于 06:35:33、`lib/types/**` 于 06:34:21）与 `apps/cli/lib`（最新 06:36:45），时间戳早于本任务全部日志（最早 06:45:19）；这些路径由 `deepseek-harness/.gitignore` 第 3 至 5 行的 `node_modules/`、`lib/`、`*.tsbuildinfo` 排除，因此该子模块 `git status --porcelain` 为空不能证明未构建。

副本内 `pnpm` 由 corepack 依据副本 manifest 的 `packageManager` 字段解析为 `11.7.0`；PATH 上另有 `11.24.0`。副本 `node_modules/.modules.yaml` 由 11.24.0 写入，其中 `virtualStoreDirMaxLength` 为 `60`，而 11.7.0 的内置默认值为 `120`（`dist/pnpm.mjs` 第 187289 行）。同时 `pnpm store path` 在本机解析为 `E:\Git\dsh-gui\.pnpm-store\v11`，与 `.modules.yaml` 记录的 `E:\Git\dsh-gui\.staging\dsh-gui\.pnpm-store\v11` 不同。11.7.0 的预运行依赖检查据此判定依赖不同步并触发 `pnpm install`，该安装又在 `validateModules` 阶段要求清空 `node_modules`，最终因无 TTY 中止并报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。

解决方式是关闭 pnpm 的预运行依赖检查：`pnpm` 11.7.0 不读取 `npm_config_*` 形式的自身设置（实测 `npm_config_verify_deps_before_run` 与 `npm_config_store_dir` 均被忽略），只对 `verify_deps_before_run` 识别 `pnpm_config_*` 形式（`dist/pnpm.mjs` 第 146481 行）。因此每条 `pnpm` 调用需要 `$env:pnpm_config_verify_deps_before_run='warn'`；其它设置须用 `--config.<key>=<value>` 命令行参数。

缓存必须重定向到工作区，因为 `%LOCALAPPDATA%` 不可写。

- `electron_config_cache`：`apps/desktop/node_modules/electron/install.js` 直接以此变量作为 `cacheRoot`；不设置时 `@electron/get` 回退到 `envPaths('electron').cache`，即 `%LOCALAPPDATA%\electron-cache`。
- `ELECTRON_BUILDER_CACHE`：`app-builder-lib/out/util/electronGet.js` 的 `getCacheDirectory()` 在该变量为带根路径时直接采用它。
- `ELECTRON_MIRROR`：`@electron/get` 的 `mirrorVar()` 读取该变量覆盖下载基址，实测 `https://npmmirror.com/mirrors/electron/` 可用。

`apps/desktop/electron-builder.config.mjs` 在加载时必须满足：`DSH_DESKTOP_APP_ID` 为反向域名标识；`DSH_DESKTOP_AUTO_UPDATE_ENV` 缺省为 `test`；`test` 部署要求 `DOWNLOAD_TEST_ORIGIN` 为不含路径、凭据、查询与片段的绝对 HTTPS origin。

本机另有一个既存残留会拦住 dev 模式的准备步骤。`native/landlock-run` 未纳入版本控制（副本与本工程子模块内 `git ls-files native/landlock-run` 均为空），磁盘上只有 `packages/entry`，其内容只有被忽略的 `lib/` 与 `node_modules/`。副本与本工程子模块的 `node_modules\.pnpm\node_modules\@deepseek-ai\` 下都曾出现指向 `native\landlock-run\packages\linux-arm64` 与 `linux-x64` 的符号链接，而这两个源目录不存在，属悬空链接（`pnpm-lock.yaml` 未引用这两个名字）；副本内的两个已由 Lead 删除，本工程子模块内的两个仍在，本报告未处理。`apps/desktop/scripts/development-project.ts` 的 `mirrorDependencyLinks()`（第 65 至 79 行）遍历该目录并对每一项调用 `linkDirectory()`，后者在第 62 行执行 `symlinkSync(realpathSync(source), ...)`；对悬空链接调用 `realpathSync` 实测抛 `ENOENT: no such file or directory, stat '...node-addon-landlock-run-linux-x64'`。修复方式为删除悬空链接或重装依赖。

绕过 pnpm 包装还出于第二条理由：`pnpm run start:desktop` 会先经预运行依赖检查，而本机 `.modules.yaml` 与 corepack 选定的 pnpm 版本不一致（见上），该检查会要求重建 `node_modules`。因此在放开沙箱的会话中直接以 `node --import tsx/esm scripts/dev.ts` 启动，绕开 pnpm 包装与依赖检查；本次未复现 `pnpm run start:desktop` 自身在该残留上的失败。

## 构建产物

| 产物 | 绝对路径 | 大小 | 验证 |
|---|---|---|---|
| 壳主进程 | `E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\apps\desktop\lib\main.js` | 183,129 B | `tsdown` 产出，Electron 可加载 |
| 预加载脚本 | `E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\apps\desktop\lib\preload.cjs` | 1,609 B | `tsdown` 产出 |
| 应用预加载脚本 | `E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\apps\desktop\lib\preload-app.cjs` | 215 B | `tsdown` 产出 |
| Electron 可执行文件 | `E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\apps\desktop\node_modules\electron\dist\electron.exe` | 244,440,576 B | `--version` 输出 `v44.0.0` |
| Electron 发行目录 | `...\apps\desktop\node_modules\electron\dist\` | 73 个文件，365.9 MB | 含 `version`（内容 `44.0.0`）；`path.txt` 不在 `dist\` 内，位于包根 `...\apps\desktop\node_modules\electron\path.txt`（12 B，内容 `electron.exe`） |
| Electron 归档缓存 | `E:\Git\dsh-gui\.cache\electron\76389d15b269019e43353bf137187ec06b91653d738a8aa4d2d48ee3fada8b95\electron-v44.0.0-win32-x64.zip` | 157,455,369 B | 经 `checksums.json` 校验后解压 |

`apps/desktop` 下没有 `.gitignore`；`lib/` 由 `deepseek-harness/.gitignore:4` 的 `lib/` 规则排除，该模式匹配任意层级目录，副本仓库状态不受编译影响。

## 逐条命令与结果

全部命令在副本目录内执行，日志保存在 `E:\Git\dsh-gui\.cache\desktop-build\logs\`。

| 命令（工作目录） | 退出码 | 耗时 | 结果 |
|---|---|---|---|
| `pnpm run build`（`apps/desktop`） | 0 | 2.4 s | `tsc -b` 与 `tsdown` 均成功，产出 `lib/main.js`、`lib/preload*.cjs` |
| `node install.js`（`apps/desktop/node_modules/electron`） | 0 | 19.9 s | 经 npmmirror 下载 157,455,369 B 归档，解压到 `dist/`，并在包根写入 `path.txt` |
| `electron.exe --version` | 0 | < 1 s | 输出 `v44.0.0` |
| `pnpm run package:desktop:win:x64:dir`（副本根） | 1 | 2.6 s | `tsx scripts/package-target.ts win-x64 --dir` 在 esbuild 服务启动时 `spawn EPERM` |
| `pnpm run dev:desktop`（副本根） | 1 | 约 2 s | `tsx scripts/dev.ts` 同样在 esbuild 服务启动时 `spawn EPERM` |
| `electron.exe .`（`apps/desktop`） | -36861 | 立即退出 | 仅记录 crashpad `not connected`，未创建可用窗口 |
| `electron.exe . --user-data-dir=<工作区>` | 手动终止 | 窗口创建后被终止 | 日志记录 mojo 平台通道拒绝访问与缺失 `seed/integrity.json` |

`pnpm run package:desktop:win:x64:dir` 的关键失败日志如下。

```
$ tsx scripts/package-target.ts win-x64 --dir
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:458:11)
    at ensureServiceIsRunning (...\node_modules\.pnpm\esbuild@0.28.1\node_modules\esbuild\lib\main.js:2268:29)
    at startSyncServiceWorker (...\esbuild\lib\main.js:2474:19)
```

此前三次 `pnpm run build` 尝试（分别设置 `npm_config_verify_deps_before_run`、`npm_config_store_dir`、以及两者）都以 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 在 2.6 s 至 3.2 s 内失败；改用 `pnpm_config_verify_deps_before_run=warn` 后同一命令成功，并打印 `[WARN] Your node_modules are out of sync with your lockfile. The value of the enableGlobalVirtualStore setting has changed`。

## 失败点 A：沙箱禁止管道 stdio 子进程

`tsx` 通过 esbuild 的 JavaScript API 转译脚本，该 API 在模块加载时以管道 stdio 启动 esbuild 服务进程；沙箱拒绝该 `spawn` 并抛 `EPERM`（`errno -4048`）。最小对照探针（`E:\Git\dsh-gui\.cache\desktop-build\probe-spawn.cjs`）结果如下。

```
pipe    THROW: EPERM spawn
child-ok
inherit exit: 0
ignore  exit: 0
```

因此以 `tsx` 为入口的命令全部不可用，覆盖 `package:desktop*`、`dev:desktop`、`start:desktop` 以及打包链内部的 `build:official`、`release:pack`、`prepare:runtime`、`prepare:packages`、`prepare:seed`。esbuild 的可执行文件形式不受影响，仅 JavaScript API 与依赖它的 `tsx` 受影响。

本会话的审批提示被禁用，且本代理的权限范围在启动时固定，无法通过 `sandbox_permissions` 申请提权，因此该阻塞点在本会话内无法解除。

## 失败点 B：win-x64 打包强制 EV 签名

`apps/desktop/electron-builder.config.mjs` 在 `DSH_DESKTOP_TARGET_PLATFORM=win32` 时调用 `createWindowsTokenSigner()`，而该函数在构造配置时即校验签名输入（`scripts/windows-sign.mjs` 第 142 至 145 行），配置中 `win.forceCodeSigning` 为 `true`。缺少 EV 签名要素时配置加载直接抛错，复现如下。

```powershell
$env:DSH_DESKTOP_APP_ID = 'com.deepseek.dsh.desktop.trial'
$env:DSH_DESKTOP_TARGET_PLATFORM = 'win32'
$env:DSH_DESKTOP_TARGET_ARCH = 'x64'
$env:DSH_DESKTOP_AUTO_UPDATE_ENV = 'test'
$env:DOWNLOAD_TEST_ORIGIN = 'https://desktop-updates.example.com'
node -e "import('file:///E:/Git/dsh-gui/.staging/dsh-gui/deepseek-harness/apps/desktop/electron-builder.config.mjs').then(()=>console.log('CONFIG OK')).catch(e=>console.log('CONFIG THROW:',e.message))"
CONFIG THROW: DSH_DESKTOP_WINDOWS_CER_FILE must identify the public X.509 leaf certificate file
```

`DSH_DESKTOP_APP_ID` 与 `DOWNLOAD_TEST_ORIGIN` 是这条复现命令的前置变量：缺少前者会先得到 `desktop release environment: DSH_DESKTOP_APP_ID must be set to a non-empty value`，缺少后者会得到 `desktop auto-update: DOWNLOAD_TEST_ORIGIN must be set to a non-empty value`（配置先解析 appId，再解析更新来源）。

`--dir` 不写 release 记录，但同样要经过该配置，并且 WinPackager 会对外壳可执行文件调用签名钩子。四个输入为 `DSH_DESKTOP_WINDOWS_CER_FILE`、`DSH_DESKTOP_WINDOWS_SIGNTOOL`、`DSH_DESKTOP_WINDOWS_KEY_CONTAINER`、`DSH_DESKTOP_WINDOWS_TOKEN_PIN`。在此主机上不存在免除签名的 `win-x64` 打包路径，`package:desktop:dir` 的主机目标同样是 `win-x64`，行为一致。

## 试运行观察

未打包启动（`electron.exe .`）可创建窗口，`lib/main.js` 与 Electron 二进制本身工作正常；失败发生在资源解析与进程间通道上。

```
[73112:FATAL:mojo\public\cpp\platform\platform_channel.cc:108] Check failed: . : 拒绝访问。 (0x5)
Error: ENOENT: no such file or directory, open '...\node_modules\electron\dist\resources\seed\integrity.json'
```

第一条是沙箱拒绝 Chromium 的 mojo 平台通道创建（命名管道），与失败点 A 同源，意味着即使补齐资源，渲染进程与主进程也无法建立通道。第二条是未打包进程按 `process.resourcesPath` 解析 `seed/`，而打包资源从未准备，属于预期缺失。观察完成后仅终止了路径位于副本内的 Electron 进程，无残留进程。

## dev 模式试用链路（Lead 复核）

沙箱放开后，Lead 在副本 `apps/desktop` 内成功启动了 Electron desktop；本节的判据由报告作者独立核对。

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui\.staging\dsh-gui\.dsh'
$env:electron_config_cache = 'E:\Git\dsh-gui\.cache\electron'
Set-Location 'E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\apps\desktop'
node --import tsx/esm scripts/dev.ts --skip-build
```

前置条件已核对：副本 `apps\desktop\lib\main.js`（T3 产出，06:49:36）与 `apps\desktop-host\lib\index.js`（23,608 B，01:11:08）都存在，`--skip-build` 跳过 `dev.ts` 第 86 至 89 行的两处 `pnpm run build`；不带该参数时 `runPackageScript()` 要求 `npm_execpath`（第 48 至 54 行），直接以 `node` 启动会先报 `desktop development: invoke this launcher through pnpm run dev:desktop or start:desktop`。此外必须先删除「环境与前置事实」一节所述的两个悬空链接。

启动成功的判据：`Get-Process electron` 有 5 个进程，主进程 pid 29960，`MainWindowTitle` 为 `DSH 本地构建`，启动时间 16:11:38，观察时间 16:18:25 时仍在运行。该标题来自客户端 locale，证据链为 `packages/client/ui-layout/src/client/DocumentTitle.tsx:24` 以 `productTitle` 写入 `document.title`、`AppFrame.tsx:192` 取 `process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')`、`packages/client/locale/src/locales/zh.ts:31` 定义 `'brand.localBuild': 'DSH 本地构建'`，因此窗口标题说明 renderer 已加载真实 Web 客户端。

`dev.ts` 向 Electron 注入 `DSH_HOME`（取自命令环境）、`DSH_DESKTOP_DEV_PROJECT_DIR`（`.desktop-build\development\project`）、`DSH_DESKTOP_HOST_INSPECT_PORT=9230`、`DSH_DESKTOP_NODE_BINARY=process.execPath`、`DSH_DESKTOP_OPEN_DEVTOOLS=1` 与 `ELECTRON_ENABLE_LOGGING=1`，并以 `--inspect=127.0.0.1:9229`、`--remote-debugging-port=9222`、`--user-data-dir=<.desktop-build\development\electron-user-data>` 启动（第 56 至 82 行）；日志中的 `desktop development: DSH_HOME=...` 与 `desktop development: inspectors main=9229, renderer=9222, host=9230` 是第 74 至 75 行的输出。`--inspect=127.0.0.1:9229` 是 dev.ts 显式传给 Electron 的主进程 inspector 端口；Lead 观察到的 9229 端口占用告警不影响启动与功能，观察到的进程、窗口与标题均正常。不需要自动打开 DevTools 窗口时可设 `DSH_DESKTOP_OPEN_DEVTOOLS=0`（`main.ts:364`）。

dev 模式的边界已核对：`development !== undefined` 时不执行 `manager.applyRelease()`（`main.ts:205-211`），因此不读取打包 seed，上节 `seed/integrity.json` 的缺失在此路径上不出现；插件安装、移除与更新被拒绝，报 `dsh desktop: plugin package changes require a packaged application`（`main.ts:233-238`），插件菜单项显示为「桌面插件…（打包应用中可用）」（`main.ts:332`，文案在 `src/locale.ts:46`）。

隔离性：`DSH_HOME` 指向副本 `.dsh`，不设时回退到 `.desktop-build\development\home`（`dev.ts:63`）；Electron 用户数据固定在 `.desktop-build\development\electron-user-data`（`dev.ts:64`）；临时项目在 `.desktop-build\development\project`，由 `prepareDevelopmentProject()` 以链接指向副本工作区。以上路径都不写本工程 `E:\Git\dsh-gui\.dsh`，不影响本工程正在运行的实例。

停止方式：关闭主窗口会触发 `window-all-closed` 退出（`main.ts:373-375`），或结束该主进程（pid 29960）及其 4 个子进程。该实例由 Lead 的后台任务持有，在本次核对时（16:18:25）仍在运行。

## 未完成项与后续试用步骤

未完成项为 `apps/desktop/scripts/package-target.ts` 中 electron-builder 之前的全部阶段（整仓 `build:official`、`release:pack`、Desktop Host 与 Landlock 打包、`prepare:runtime`、`prepare:packages`、`prepare:seed`）以及 electron-builder 阶段本身；`apps/desktop/.desktop-build/` 下只有 dev 模式建立的 `development\`，打包目标目录 `targets\` 与共享下载目录 `downloads\` 未创建，`E:\Git\dsh-gui\.cache\electron-builder\` 为空。

本次可试用的形态是 dev 模式的未打包 Electron 进程（加载真实 Web 客户端），不是打包应用。`win-x64` 打包必须提供 Windows EV 签名四要素，这是设计级阻塞，与沙箱无关；`--dir` 不写 release 记录，但同样要经过该配置。

在具备以下条件的宿主上按顺序执行即可继续试用。

1. 解除沙箱对管道 stdio 子进程的限制（或在允许提权的会话中以 `danger-full-access` 运行），使 `tsx` 可用。
2. 提供 Windows EV 签名的四个输入，或改用非 Windows 目标与对应签名环境。
3. 在副本根目录执行下列命令，预计 20 至 60 分钟，首次运行会额外下载约 150 MB 的 Electron 归档与 Node.js 24.17.0 归档。

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui\.staging\dsh-gui\.dsh'
$env:pnpm_config_verify_deps_before_run = 'warn'
$env:electron_config_cache = 'E:\Git\dsh-gui\.cache\electron'
$env:ELECTRON_BUILDER_CACHE = 'E:\Git\dsh-gui\.cache\electron-builder'
$env:DSH_DESKTOP_APP_ID = 'com.deepseek.dsh.desktop.trial'
$env:DSH_DESKTOP_AUTO_UPDATE_ENV = 'test'
$env:DOWNLOAD_TEST_ORIGIN = 'https://desktop-updates.example.com'
$env:DSH_DESKTOP_WINDOWS_CER_FILE = 'C:\path\to\server.cer'
$env:DSH_DESKTOP_WINDOWS_SIGNTOOL = 'C:\path\to\signtool.exe'
$env:DSH_DESKTOP_WINDOWS_KEY_CONTAINER = '<SafeNet 私钥容器名>'
$env:DSH_DESKTOP_WINDOWS_TOKEN_PIN = '<SafeNet 令牌口令>'
Set-Location 'E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness'
pnpm run package:desktop:win:x64:dir
```

打包成功后，解包应用位于 `apps/desktop\.desktop-build\targets\win-x64\artifacts\win-unpacked\`，启动入口为其中的 `DeepSeek Harness.exe`；首次启动会先把种子 store 解压到 `$DSH_HOME\desktop\pnpm\store`，再安装可写 profile。中断在准备阶段时可单独执行 `pnpm run prepare:desktop` 检查已准备资源，该命令是诊断停止点，不产出应用。

不打包的试用路径是 `pnpm run dev:desktop`（构建 Host、client、web 前端并启动 Electron 壳）与 `pnpm run start:desktop`（不重新构建，重建临时项目后启动已有产物）。两者同样由 `tsx` 启动，受失败点 A 限制。未打包的 Electron 进程可用 `DSH_DESKTOP_NODE_BINARY`、`DSH_DESKTOP_PNPM_ENTRY`、`DSH_DESKTOP_SEED_DIR`、`DSH_DESKTOP_DEV_PROJECT_DIR` 指定资源；打包后的应用忽略这四个变量。

## 复现命令汇总

Electron 二进制安装（在沙箱受限环境下同样可完成）。

```powershell
$env:electron_config_cache = 'E:\Git\dsh-gui\.cache\electron'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
Set-Location 'E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\apps\desktop\node_modules\electron'
node install.js
```

Desktop 壳编译。

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui\.staging\dsh-gui\.dsh'
$env:pnpm_config_verify_deps_before_run = 'warn'
Set-Location 'E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\apps\desktop'
pnpm run build
```

Electron 二进制冒烟。

```powershell
& 'E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\apps\desktop\node_modules\electron\dist\electron.exe' --version
```

## 证据文件

- 命令日志：`E:\Git\dsh-gui\.cache\desktop-build\logs\01-build-desktop.log`、`02-build-desktop-storepinned.log`、`04-build-desktop-noverify.log`、`05-build-desktop-warn.log`、`06-package-desktop-win-x64-dir.log`、`07-dev-desktop.log`、`08-electron-shell-launch.log`、`09-electron-shell-launch-userdata.log`
- 沙箱 stdio 探针：`E:\Git\dsh-gui\.cache\desktop-build\probe-spawn.cjs`
- Electron 归档缓存：`E:\Git\dsh-gui\.cache\electron\76389d15b269019e43353bf137187ec06b91653d738a8aa4d2d48ee3fada8b95\electron-v44.0.0-win32-x64.zip`

构建前后 `git -C E:\Git\dsh-gui\deepseek-harness status --porcelain` 与 `git -C E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness status --porcelain` 均无输出，副本内未修改源码，未执行 `git add` 或 `git commit`；本工程子模块内位于被忽略路径上的构建残留见「环境与前置事实」一节，该空状态不足以证明本工程子模块未被构建。

外层仓库 `E:\Git\dsh-gui` 的根 `.gitignore` 已由 Lead 在第 16 至 17 行的说明段之后、第 18 行加入 `.cache/` 规则，`git check-ignore -v .cache/electron` 现返回 `.gitignore:18:.cache/`，`git -C E:\Git\dsh-gui status --porcelain` 不再列出 `?? .cache/`（本次修改该文件的是 Lead，本报告未改动 `.gitignore`）。该状态中仍有与本任务无关的 `M plugins/README.md`、`plugins/agent-team/` 暂存项与四份未跟踪分析文档。
