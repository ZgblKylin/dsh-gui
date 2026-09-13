# Electron Desktop 试用构建验证（T4）

本文独立复核 `docs/dsh-gui/2026-09-13-desktop-build.md`（下称 T3）的产物、失败结论与边界合规。复核不采信 builder 自述：每条主张都用 pwsh 重新取证据，包括重跑可复现的探针、读取 PE 版本信息、核对日志逐字内容、按绝对路径核对文件与大小，并复算 git 边界。

## 验证范围与方法

被验证对象是 T3（168 行）。证据面是副本 `E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness\`、构建缓存 `E:\Git\dsh-gui\.cache\`、本工程 `E:\Git\dsh-gui\` 与外层两个 git 仓库。

复核动作分四类：一是对报告列出的每个绝对路径取存在性、字节数与时间戳；二是重跑可由非交互方式验证的最小动作（`electron.exe` 版本、PE 版本信息、`require('electron')` 解析、管道 stdio 探针、electron-builder 配置 import）；三是逐字核对日志文件与报告的转录；四是执行报告未覆盖或与产物事实可能冲突的边界命令。

本次未重跑打包链，未运行 GUI 应用，未修改任何被验证文档与构建产物。

关键环境事实：本次会话的 `node` 为 v24.19.0，任务同时确认本会话审批提示禁用、本代理权限范围启动时固定。

## 一、已复核通过

| 编号 | 主张 | 复核方法 | 证据 | 判定 |
|---|---|---|---|---|
| P1 | 五个绝对路径与字节数 | 按路径取 `Get-Item` 的长度与 `LastWriteTime` | `apps\desktop\lib\main.js` 183,129 B（2026-09-13 06:49:36）；`lib\preload.cjs` 1,609 B；`lib\preload-app.cjs` 215 B；`node_modules\electron\dist\electron.exe` 244,440,576 B；`.cache\electron\76389d1...\electron-v44.0.0-win32-x64.zip` 157,455,369 B（06:47:07）。五项与报告表格逐项一致 | 通过 |
| P2 | `electron.exe --version` 输出 `v44.0.0` | 直接调用并用 `Start-Process -Wait` 复取，另读 PE 信息 | `Start-Process` 输出 `v44.0.0`；`(Get-Item electron.exe).VersionInfo` 的 `FileVersion` 与 `ProductVersion` 均为 `44.0.0`；文件头前两字节为 `4D 5A` | 通过（退出码未观测，见第三节 U4） |
| P3 | Electron 发行目录 73 个文件、365.9 MB、含 `path.txt` 与 `version` | 递归统计 `dist\` 并用 `Get-Content` 读两个标记文件 | 文件数 73；总字节 383,650,089（365.9 MiB）；`dist\version` 内容为 `44.0.0` | 通过（`path.txt` 的位置见 E4） |
| P4 | Electron 二进制安装完整可用 | `node -e` 以绝对路径加载 electron 包入口，观察其解析出的可执行文件路径 | 解析结果为 `...\node_modules\.pnpm\electron@44.0.0_supports-color@9.4.0\node_modules\electron\dist\electron.exe`；包根 `node_modules\electron\path.txt` 为 12 B，内容 `electron.exe` | 通过 |
| P5 | 三个壳脚本确由该次构建产生（可复现性抽查） | 把日志 05 的 tsdown 输出大小与产物的字节数逐一对上，并把产物 mtime 与日志 mtime 对齐 | 日志 05 记录 `lib\main.js 183.13 kB`、`lib\preload.cjs 1.61 kB`、`lib\preload-app.cjs 0.21 kB`，与 183,129 / 1,609 / 215 字节一一对应；三个文件 mtime 均为 06:49:36，与日志 05 的 06:49:36 一致；`lib\types\**` 56 个文件来自同次 `tsc -b` | 通过 |
| P6 | 失败点 A：沙箱禁止管道 stdio 子进程，`tsx` 于 esbuild 服务启动时 `spawn EPERM` | 读日志 06 逐字内容；独立写内联探针验证 `spawn` 的 stdio 差异；重跑 builder 自带的 `probe-spawn.cjs` | 日志 06 含 `Error: spawn EPERM`、`errno: -4048`、`esbuild\lib\main.js:2268:29` 与 `:2474:19` 两帧栈、`[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL]` 与 `Exit status 1`；我的内联探针 `spawn(process.execPath, ['-e','0'], { stdio: ['ignore','pipe','pipe'] })` 抛 `pipe  THROW EPERM`；重跑 `probe-spawn.cjs` 输出为 `pipe    THROW: EPERM spawn`、`child-ok`、`inherit exit: 0`、`ignore  exit: 0`，与报告第 74 至 77 行逐行一致 | 通过 |
| P7 | 失败点 B：`win-x64` 配置在加载时即要求 EV 签名四要素，`win.forceCodeSigning` 为 `true`，`--dir` 不豁免 | 分别以三组环境变量 import `electron-builder.config.mjs`；读 `windows-sign.mjs` 与 `package-target.ts` | 仅设 `DSH_DESKTOP_TARGET_PLATFORM=win32` 时抛 `DSH_DESKTOP_APP_ID must be set`（配置第 27 行先解析 appId）；再加 `DSH_DESKTOP_APP_ID` 后抛报告所载的 `DSH_DESKTOP_WINDOWS_CER_FILE must identify the public X.509 leaf certificate file`；`windows-sign.mjs:141-144` 在 `createWindowsTokenSigner` 构造体内立即调用 `resolveCertificateFile`、`resolveSignTool`、`resolveTokenIdentity`；`electron-builder.config.mjs:89` 为 `forceCodeSigning: true`；`package-target.ts:282` 的 `if (!invocation.directory) writeReleaseRecord(...)` 确认 `--dir` 不写记录；`package-target.ts:247-256` 把 `DSH_DESKTOP_TARGET_PLATFORM: target.platform`（win-x64 即 `win32`）放入 `targetEnv` 并传给第 281 行的 electron-builder | 通过（该设计级结论成立） |
| P8 | 三次 `pnpm run build` 尝试均以 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 失败 | 在三个日志中检索该错误码；核对报告引用的 pnpm 内部行号 | 日志 01、02、04 各命中该错误码 1 次；`pnpm.mjs` 第 187289 行为 `virtualStoreDirMaxLength: 120,`，第 146481 行为 `if (process.env.pnpm_config_verify_deps_before_run != null) {`，与报告第 18、20 行的引用逐字一致 | 通过 |
| P9 | 副本 `.modules.yaml` 记录 `virtualStoreDirMaxLength` 为 60、storeDir 指向副本 store | 读 `deepseek-harness\node_modules\.modules.yaml` | 第 3360 行 `"packageManager": "pnpm@11.7.0"`；第 3665 行 `"storeDir": "E:\\Git\\dsh-gui\\.staging\\dsh-gui\\.pnpm-store\\v11"`；第 3667 行 `"virtualStoreDirMaxLength": 60` | 通过 |
| P10 | 未产出解包应用目录与 builder 缓存 | 取 `Test-Path` 与递归计数 | `apps\desktop\.desktop-build` 不存在；`E:\Git\dsh-gui\.cache\electron-builder` 存在但递归项数为 0；`E:\Git\dsh-gui\.cache\electron\...zip` 存在且字节数匹配 | 通过 |
| P11 | 两个 `deepseek-harness` 仓库的构建前后 git 状态为空，副本检出于 `dsh-v0.1.5-rc.2` | 执行四条 git 命令并读副本 HEAD | `git -C E:\Git\dsh-gui\deepseek-harness status --porcelain` 与 `diff --stat` 均无输出；`git -C E:\Git\dsh-gui\.staging\dsh-gui\deepseek-harness status --porcelain` 与 `diff --stat` 均无输出；副本 HEAD 为 `fb2c4b9e698e30edb738bca4cf0618587db7d203`，`git describe --tags` 为 `dsh-v0.1.5-rc.2`，与报告第 16 行一致 | 通过（但 git 空状态不能证明未构建，见 E1） |
| P12 | 两次未打包启动的日志内容 | 读日志 08 与 09 逐字内容 | 日志 08 仅 `crashpad_client_win.cc:867] not connected`；日志 09 含 `FATAL:mojo\public\cpp\platform\platform_channel.cc:108] Check failed: . : 拒绝访问。 (0x5)` 与 `ENOENT ... electron\dist\resources\seed\integrity.json`，栈帧落到 `lib/main.js` 的 `verifySeedIntegrity` 与 `applyRelease`，与报告第 100、101 行一致 | 通过 |
| P13 | 「`%LOCALAPPDATA%` 不可写」这一缓存重定向前提 | 在该目录尝试创建文件 | 写入被拒：`UnauthorizedAccessException: Access to the path 'C:\Users\zgblc\AppData\Local\dsh-write-probe.tmp' is denied.` | 通过 |
| P14 | `checksums.json` 参与 Electron 归档校验 | 读 `apps\desktop\node_modules\electron\install.js` | 第 45 至 48 行把 `require('./checksums.json')` 作为 `checksums` 选项传入下载器；包内 `checksums.json` 为 7,212 B | 通过 |
| P15 | 打包成功后解包应用的位置 | 读 `desktop-build-paths.mjs` | 第 6 行 `BUILD_ROOT = join(APP_ROOT, '.desktop-build')`，第 40 行 `root = join(BUILD_ROOT, 'targets', target)`，第 44 行 `artifacts: join(root, 'artifacts')`，与报告第 132 行的 `apps\desktop\.desktop-build\targets\win-x64\artifacts\win-unpacked\` 一致 | 通过 |

## 二、有误或需修正

### E1（实质性，边界合规）报告关于「本工程未执行任何构建或安装」的陈述与文件系统证据矛盾

主张：`2026-09-13-desktop-build.md:16` 称「副本内每条命令都显式设置 `$env:DSH_HOME='E:\Git\dsh-gui\.staging\dsh-gui\.dsh'`。本工程 `E:\Git\dsh-gui\deepseek-harness\` 未执行任何构建或安装。」

复核方法：按绝对路径枚举本工程 `deepseek-harness` 的构建输出与时间戳，并与 T3 全部日志的时间戳对比；同时确认这些路径是否被 git 忽略（因为 `git status` 为空）。

证据：本工程 `deepseek-harness` 内存在今天 06:34 至 06:36 的构建产物。`apps\desktop\lib\main.js` 为 183,129 B、mtime 2026-09-13 06:35:33；`apps\desktop\lib\preload.cjs` 与 `preload-app.cjs` mtime 06:35:21；`apps\desktop\lib\tsconfig.tsbuildinfo` 与 `lib\types\**`（56 个文件）mtime 06:34:21；`apps\cli\lib` 有 30 个文件、最新 mtime 06:36:45；`apps\desktop\node_modules\electron` 存在（其中无 `dist`）。这些路径被子模块根 `.gitignore` 第 3、4、5 行的 `node_modules/`、`lib/`、`*.tsbuildinfo` 忽略，所以 `git status --porcelain` 为空不能证明未构建。T3 全部日志的最早时间为 06:45:19，因此这些产物早于 T3 记录的全部命令，无法断定由 T3 产生。

判定：不成立（该陈述作为对文件系统的描述为假；git 空状态是其唯一被引用的支撑，而该支撑不覆盖被忽略路径）。这同时说明任务要求「构建应只出现在 `.staging` 与 `.cache`」在文件系统层面未被满足。

修改建议：删除或限定该句。若这些产物不是本次 T3 流程产生，应改述为「本次记录的命令全部在副本内执行，副本两条 `deepseek-harness` 子模块的 git 状态为空；本工程子模块存在此前遗留的、被 `.gitignore` 排除的 `lib/` 与 `node_modules/` 构建残留，本次未清理、未使用」。若无法确定归属，应如实写为「本工程子模块内存在今天 06:34 至 06:36 的构建产物，归属未核实」。

### E2（低危，引用位置）`lib/` 的忽略规则出处

主张：`2026-09-13-desktop-build.md:41` 称「`apps/desktop` 根目录下的 `lib/` 由 `.gitignore` 第 4 行排除」。

复核方法：列出 `apps/desktop` 下的 `.gitignore`，并在子模块内查找包含 `lib/` 的忽略规则。

证据：`apps\desktop\.gitignore` 不存在；规则出自子模块根 `deepseek-harness\.gitignore` 第 4 行的 `lib/`（Git 的该模式匹配任意层级目录，因此覆盖 `apps/desktop/lib/`）。

判定：需修正（出处指错，结论方向正确）。

修改建议：改为「由 `deepseek-harness/.gitignore:4` 的 `lib/` 规则排除」。

### E3（低危，复现命令）配置 import 的复现命令缺少前置变量，原样重跑得到不同错误

主张：`2026-09-13-desktop-build.md:89` 给出 `node -e "import(...)"` 单行命令并声称输出 `CONFIG THROW: DSH_DESKTOP_WINDOWS_CER_FILE must identify the public X.509 leaf certificate file`。

复核方法：按第 89 行原样重跑，再逐项补齐变量重跑。

证据：只设 `DSH_DESKTOP_TARGET_PLATFORM=win32` 时实际输出 `CONFIG THROW: desktop release environment: DSH_DESKTOP_APP_ID must be set to a non-empty value`（`electron-builder.config.mjs:27` 先解析 appId）；补 `DSH_DESKTOP_APP_ID` 后才复现报告所载的 CER_FILE 错误；不设 `DSH_DESKTOP_TARGET_PLATFORM` 时则抛 `desktop auto-update: DOWNLOAD_TEST_ORIGIN must be set to a non-empty value`。

判定：需修正（结论成立，但贴出的复现命令不完整，读者原样执行会得到另一条错误）。

修改建议：在该命令前补 `$env:DSH_DESKTOP_APP_ID` 与 `$env:DOWNLOAD_TEST_ORIGIN`（后者的缺失在补齐平台变量后仍会拦截配置加载），或注明报告所贴输出是在这些变量已设置的会话中取得。

### E4（低危，位置）`path.txt` 不在 `dist\` 内

主张：`2026-09-13-desktop-build.md:38` 称 Electron 发行目录 `...\dist\`「含 `path.txt` 与 `version`」。

复核方法：分别对 `node_modules/electron/path.txt` 与 `node_modules/electron/dist/path.txt` 取 `Test-Path`。

证据：包根 `node_modules\electron\path.txt` 存在（12 B，内容 `electron.exe`）；`dist\path.txt` 不存在；`dist\` 内只有 `version`（内容 `44.0.0`）。

判定：需修正（位置写错，安装完整性本身成立，见 P4）。

修改建议：改为「`dist\` 含 `version`；包根另含 `path.txt`（12 B，`electron.exe`）」。

### E5（低危，建议）`.cache/` 未被忽略，本工程 git 状态非空

主张：报告未声称本工程 `E:\Git\dsh-gui` 干净，仅声称两个 `deepseek-harness` 子模块干净。

复核方法：执行外层的 `git status --porcelain` 并查 `.gitignore`。

证据：`git -C E:\Git\dsh-gui status --porcelain` 输出 `M  plugins/README.md`、`A  plugins/agent-team/README.md`、`A  plugins/agent-team/install.mjs`、`?? .cache/`，以及四份未跟踪的分析文档。根 `.gitignore` 只忽略 `.staging/`（第 15 行），未忽略 `.cache/`。外层暂存的 `plugins/agent-team/*` 属其他任务范围，不是构建产物。

判定：报告声称成立（两个子模块确实为空），但构建缓存落在未被忽略的 `.cache/`，存在误提交风险。

修改建议：在根 `.gitignore` 增加 `.cache/`，并在报告中说明外层仓库存在与本任务无关的暂存项。

## 三、无法验证

1. 各命令耗时（`pnpm run build` 2.4 s、Electron 安装 19.9 s、打包失败 2.6 s）：日志只提供文件写入时间点，无法独立计时。可核对的是顺序与相邻时间点：`electron.exe` 归档 mtime 06:47:07 与 `path.txt` mtime 06:47:12 相邻，三个 `lib` 产物 mtime 06:49:36 与日志 05 mtime 一致。
2. `electron.exe .` 的退出码 `-36861` 与「窗口创建后被终止」的观察：需要 GUI 会话，本次未复现；仅验证了日志 08 与 09 的内容与报告一致（P12）。
3. 打包链后续阶段与 electron-builder 内部行为：`build:official`、`release:pack`、`prepare:runtime`、`prepare:packages`、`prepare:seed` 与 `WinPackager` 的签名钩子调用均未运行。报告中「`--dir` 下 `WinPackager` 会对外壳可执行文件调用签名钩子」属 electron-builder 内部行为，本次只确认了配置层的强制要求（`forceCodeSigning: true` 与构造期校验），未确认钩子在 `--dir` 流程中的实际调用点。
4. 直接以 `& electron.exe --version` 调用时的退出码：pwsh 未回填 `$LASTEXITCODE`，`Start-Process -Wait` 返回的 `ExitCode` 也为空；版本输出本身已确认。
5. `electron_config_cache`、`ELECTRON_BUILDER_CACHE`、`ELECTRON_MIRROR` 三个变量在下载与缓存路径上的实际生效结果：本次只确认了 `%LOCALAPPDATA%` 不可写（P13）与包内 `checksums.json` 的用法（P14），未重新下载归档验证镜像与缓存命中。

## 四、总体判定

T3 的成功与失败分界与产物事实一致：编译产物与 Electron 二进制真实存在、字节数吻合、内容可用（`require('electron')` 可解析、PE 版本为 44.0.0、tsdown 日志大小逐项对上）；未产出可试用的解包应用，`.desktop-build` 与 builder 缓存的事实与报告一致。

两个独立阻塞点都成立。失败点 A 我用自己的探针复现了 `EPERM`，并重跑了 builder 的探针脚本得到相同输出；失败点 B 的四个环境变量要求在配置构造期即生效，`win.forceCodeSigning` 为 `true`，且 `package-target.ts` 确实把 `win32` 传给 electron-builder，因此「本主机没有免除签名的 `win-x64` 路径」这一设计级结论成立。报告对 pnpm 内部行号的两处引用逐字正确。

需要修正的是边界陈述 E1：报告称本工程 `deepseek-harness` 未执行任何构建或安装，但该 checkout 内存在今天 06:34 至 06:36 的 `lib/` 与 `lib/types/**` 构建产物，`git status` 为空只是因为这些路径被忽略。除 E1 外的四项均为低危引用或复现命令问题。

产物可用性结论：本次流程的可交付成果是 Electron 44 二进制与三个 Desktop 壳脚本（可加载级），没有可试用的解包应用；不打包的试用路径 `dev:desktop` 与 `start:desktop` 同样受失败点 A 限制，因此本会话无法完成试用。

是否建议放行：建议在修正 E1 的边界陈述后放行；E2 至 E4 一并改述更好，E5 建议补 `.gitignore` 条目。核心结论（未产出应用、两个独立阻塞点、命令与日志可复现）不需要改动。
