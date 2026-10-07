# Desktop 构建：Electron 下载失败定位与后续烟测阻塞

本文件记录 `npm run build:desktop` 在 2026-10-08 凌晨连续失败时定位到的两个原因与验证结果。运行时根为 `D:\git\dsh-gui-home`，仓库根为 `D:\git\dsh-gui-home\dsh-gui`，构建工作区为 `<运行时根>\.desktop\source`，打包证据在 `apps\desktop\.desktop-build\packaging-runs\<时间戳>-<随机>\`。

## 结论摘要

| 现象 | 根因 | 处理与结果 |
|---|---|---|
| `prepare:runtime` 的 `download:electron` 报 `TypeError: fetch failed`，内层为 `read ECONNRESET` 或 `Connect Timeout Error (attempted addresses: 185.199.108–111.133:443)` | 打包链固定从 GitHub release 取 Electron，本机到该通道的连接被重置或超时；打包用的下载缓存 `.desktop-build\downloads` 为空，必然走网络 | 导出 `ELECTRON_MIRROR` 并把已按 SHA-256 验证的 `electron-v44.0.0-win32-x64.zip` 预置进打包缓存；复跑后 `download:electron` 16–17 s 通过 |
| `prepare:primary-runtime` 报 `ConnectTimeoutError (151.101.x.x:443)` | 上游按 `lock.json` 串行单流拉取 15 个锁定资产（nodejs.org、GitHub 的 python-build-standalone、PyPI 的 13 个 wheel），本机对 nodejs.org 与 PyPI 的 Fastly 地址不可达或超时 | 按 `lock.json` 的 SHA-256 预置全部 15 个资产到 `<cache>\<sha256>`（镜像来源：npmmirror 的 node / python-build-standalone 目录、清华 PyPI），复跑后该阶段 2 分 33 秒通过 |
| 上述两项通过后，`prepare:dsh` 的 `runtime:smoke` 失败：`docx conversion failed: LibreOffice conversion failed`（`code: 'timeout'`） | 烟测走 `officeToPdf` 服务，其默认预算为 60 s（`packages/document/office-to-pdf/src/index.ts:82` 的 `timeoutMs` 默认值 `60_000`）；打包树里首次 docx 转换未在该预算内完成 | **未解决**。同一 kit 0.1.5 在打包树外用 CLI 转换同一 fixture 为冷启 23 s、热启 12 s，均产出合法 PDF，说明引擎与资产可用，缺口在烟测预算与时机 |

第 1、2 条的规避方式与 [2026-09-30-desktop-local-build.md](2026-09-30-desktop-local-build.md) 第五节第 2 条一致：本机对境外下载通道的可用性是问题本身，镜像预置锁定资产是环境准备，不是构建链行为。

## 一、原始失败的确切位置

`packaging-runs\2026-10-07T15-20-57.414Z-1jVAcS\events.jsonl` 给出完整阶段序列：

- `run build:official`、`release:pack`（dsh / vendor / landlock）全部 `code: 0`；
- 第 24–27 行：`run prepare:runtime` → `download:electron` 在 27.2 s 后 `success:false`，错误正是 `TypeError: fetch failed / read ECONNRESET`；
- 之后 `run prepare:runtime` 以 `code: 1` 结束，`windows-package` 上报 `run prepare:runtime failed`。

同目录 15:05 与 14:51 两次运行分别是 `Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)` 与 `attempted addresses: 185.199.111.133:443, 185.199.108–110.133:443`。即整段会话都卡在同一处下载，而不是构建或打包逻辑。

`@electron/get` 5.1.0 用 Node 内置 `fetch`（undici）下载，默认基址 `https://github.com/electron/electron/releases/download/`，缓存布局为 `<cacheRoot>\<sha256(dirname(url))>\<文件名>`；本链把 `cacheRoot` 固定为 `.desktop-build\downloads`，而该目录此前不存在，因此每次构建都要重新下载 157,455,369 B 的归档。

## 二、判据：通道不可达，而镜像可用

同一时段用产品同款 Node `fetch` 实测：

| 目标 | 结果 |
|---|---|
| `https://github.com/electron/electron/releases/download/v44.0.0/electron-v44.0.0-win32-x64.zip`（HEAD） | 失败：`Connect Timeout Error (attempted addresses: 185.199.111.133:443, 185.199.110.133:443, 185.199.108.133:443, timeout: 10000ms)`，19.2 s |
| 同上，`SHASUMS256.txt`（GET，3 次） | 1 次超时（18.9 s），2 次 200 且各约 19.7 s；该校验和文件不被缓存（`cacheMode: Bypass`），因此即使归档命中缓存也仍要联网 |
| `https://npmmirror.com/mirrors/electron/44.0.0/electron-v44.0.0-win32-x64.zip` | 200，`content-length` 157,455,369 |
| `https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip` | 失败：`Connect Timeout Error (104.16.213.131:443 等)` |
| `https://registry.npmmirror.com/-/binary/node/v24.21.0/node-v24.21.0-win-x64.zip` | 200，37,618,919 B，落地 20 s |
| `https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz` | 200，21,980,728 B，18.9 s（不稳定通道，时好时坏） |
| `https://files.pythonhosted.org/.../numpy-2.3.5-cp312-cp312-win_amd64.whl` | 200，12,782,922 B；随后构建里的同类请求又报 `ConnectTimeoutError (151.101.x.x:443)` |
| 清华 PyPI `https://pypi.tuna.tsinghua.edu.cn/simple/...` | 单个 6.89 MB wheel 0.7 s（约 10 MB/s）；阿里云 PyPI 同文件 12.1 s（约 0.57 MB/s） |

注意 `curl.exe` 在本机不可用作连通性判据（schannel `SEC_E_NO_CREDENTIALS`），同类结论在 2026-09-30 的文档里已记录过一次。

## 三、已实施的预置与复跑证据

1. **Electron**：把运行时根已有的、与镜像 `SHASUMS256.txt` 逐字节一致的归档（SHA-256 `e61aa3bcea8152bc0730abd015e47c032d778a0ef10e2a1c78ba3c4ea47942f9`，157,455,369 B）复制到打包缓存的**两个键**下：`16cfa46e…`（GitHub URL 派生）与 `76389d15…`（`https://npmmirror.com/mirrors/electron/v44.0.0` 派生）。前者让不设 `ELECTRON_MIRROR` 的运行也能命中归档，后者让镜像运行命中。
2. **primary runtime 的 15 个锁定资产**：按 `scripts/primary-runtime/lock.json` 的 `sha256` 写入 `.desktop-build\downloads\<sha256>`（node 1、python 1、wheel 13）。缺失的先从镜像按文件名取（清华 PyPI / npmmirror 的 `-/binary/node/`、`-/binary/python-build-standalone/`），逐个用 `lock.json` 的 SHA-256 自验后写入；产品脚本 `downloadPrimaryRuntimeAsset()` 本就按同一路径读取，命中即不发请求。
3. **构建命令**：`$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` 后 `npm run build:desktop`。本次任务随后把这份环境准备收进脚本，且不硬编码镜像：`scripts/desktop.mjs` 从 npm registry 推导镜像（识别 npmmirror / `npm.taobao.org` 宿主，取 `${registry origin}/-/binary/<project>/`），优先级为 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 环境变量 → `electron_mirror` / `electron_builder_binaries_mirror` npm 配置 → registry 推导。它覆盖 dev 侧 `node install.js`、打包链 `prepare:runtime` 的 `@electron/get` 下载与 electron-builder 工具集下载，并把实际来源打印到构建日志。验证见第七节。

复跑两次的阶段序列（`packaging-runs\2026-10-07T16-19-18.071Z-4LMqhc`、`2026-10-07T16-46-36.920Z-B7g4DO`）：

```
run build:official                        140 s / 118 s     code 0
run release:pack --family dsh             342 s / 378 s     code 0
--dir apps/desktop-host pack / vendor / landlock            code 0
run prepare:runtime
  download:electron                        16 s  / 16 s     code 0   ← 原失败点
  extract:electron                         15 s  /  5 s
  prepare:cli                               2 s  /  6 s
  prepare:primary-runtime                 153 s  / 161 s     code 0   ← 原第二处联网点
run prepare:packages                       13 s
run prepare:dsh → runtime:smoke            fails（见下）
```

第三次复跑 `2026-10-07T17-28-14.761Z-iZ0vdl`（不设 `ELECTRON_MIRROR`，镜像由第七节的 registry 推导得到）同样通过：`download:electron` 16 s、`extract:electron` 5 s、`prepare:primary-runtime` 220 s、`prepare:packages` 19 s、`prepare:dsh` 的 lockfile/install/materialize 全部 `code 0`，随后 `runtime:smoke` 在 72 s 处以同一 docx 超时失败。

## 四、未决阻塞：烟测里的 docx 转换超时

`runtime:smoke` 启动打包好的 Host，请求 `/desktop-smoke-office/{docx,xlsx,pptx}` 各转换一次，再走技能 CLI 路径；每次转换的预算是 `officeToPdf` 服务的 `timeoutMs` 默认 60 s。三次复跑（16-19、16-46、17-28 三组运行目录）都在同一处失败，阶段耗时 72–73 s（≈ Host 就绪 + 首次 docx 转换的 60 s 预算用尽）：

```
desktop runtime: docx conversion failed: OfficeToPdfError: LibreOffice conversion failed.
  code: 'timeout'
  [cause]: ConversionError: LibreOffice conversion timed out.
    at .../@deepseek-ai/libreoffice-kit/lib/index.js:1958
```

对照实验（同一台机、同一 kit 版本、同一 fixture）：

| 方式 | 结果 |
|---|---|
| 用打包外的 kit 0.1.5 CLI：`node <kit>\lib\cli.js convert --input input.docx --output out.pdf` | 第一次 23 s，第二次 12 s，均产出 17,488 B 的合法 PDF（`{"backend":"native","missingFonts":["Courier"]}`） |
| 打包树内（烟测）同一转换 | 60 s 预算内未完成，三次复跑一致 |

因此这不是下载或资产问题：引擎可跑通。差异点是打包树里的 kit 目录是每次构建新落盘的、且转换发生在 Electron Host 进程内，首次触碰 71 MB 引擎（含 Windows 上的 junction 与私有 profile 初始化）很可能是主要开销，而 60 s 预算偏紧。本机 Windows Defender 实时保护与防病毒均为关闭状态（`Get-MpComputerStatus`：`RealTimeProtectionEnabled: False`、`AntivirusEnabled: False`），故排除 Defender 首扫这一解释。既有记录（2026-09-30，`0.2.0-rc.2`）在同一台机上通过了这一烟测，说明该预算至少曾经过得了。

可尝试的方向：

1. 再次重跑（单次约 20 分钟，烟测是否通过仍取决于机器状态；下载与资产已不再联网）。
2. 确认是否存在第三方杀毒 / EDR 对新建目录的首次执行做扫描；Defender 自身已关闭，故不是 Defender 排除项问题。
3. 上游侧把 `officeToPdf.timeoutMs` 或烟测预算调高；本仓库不编辑 `deepseek-harness` 子模块与 `.desktop\source`（后者随子模块指针同步，改动会被覆盖）。

## 五、复现与复核要点

```powershell
# 已预置资产后，只需在仓库根执行
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm run build:desktop

# 检查预置结果
Get-ChildItem 'D:\git\dsh-gui-home\.desktop\source\apps\desktop\.desktop-build\downloads' -Recurse -File |
  Select-Object Name, Length
```

复核口径：`.desktop-build\downloads` 下应看到 2 个 Electron 归档（各 157,455,369 B，位于两组 64 位十六进制目录中）与 15 个以 SHA-256 命名的资产文件；`targets\win-x64\runtime\primary-runtime\runtime.json` 应列出 `node 24.21.0`、`pnpm 11.7.0`、`python 3.12.14` 与 13 个 Python 包。

## 六、遗留

1. 本文写作时 `npm run build:desktop` 仍未整链跑通，卡在第四节；前三节的修复分别被两次复跑独立观察通过。
2. 资产预置（Electron 归档、primary runtime 的 15 个锁定资产）是环境准备，不是受支持流程；Electron 与 electron-builder 的镜像来源自本次改动后由 registry 推导（第七节），primary runtime 的 node/python/wheel 上游没有对应开关，仍只能靠预置缓存复用。
3. 烟测失败只在 `runtime:smoke` 出现一次位置固定的超时，未取得「延长预算后通过」的直接证据，因此根因表述保留为推测。

## 七、脚本内镜像推导的验证

第三节第 3 条的改动落在 `scripts/desktop.mjs`：`DOWNLOAD_SOURCES` 描述两项工具，`readNpmrcValue()` / `npmRegistry()` 解析 registry，`registryBinaryMirror()` 由 registry 推导镜像，`downloadMirror()` / `downloadMirrorEnv()` / `downloadSourceLabel()` 负责优先级与注入；`ensureElectron()`（dev 侧 `node install.js`）与 `packageDesktop()`（打包链）两处都注入并把来源打印到构建日志。脚本内没有任何镜像宿主字面量。

| # | 环节 | 判据 |
|---|---|---|
| 1 | 语法与模块加载 | `node --check scripts/desktop.mjs`、`node --check scripts/dsh-gui.mjs` 退出码 0；`import('scripts/desktop.mjs')` 正常导出 `buildDesktop`、`runDesktop` |
| 2 | registry 的来源 | 实测 `npm run` 把解析后的配置导出给脚本：用户 `.npmrc`（`registry=https://registry.npmmirror.com`）下脚本内 `npm_config_registry` 即该值；显式设 `npm_config_registry=https://registry.example.test/` 时输出该值。脚本缺省再读仓库根与用户目录 `.npmrc` 的 `registry` 键（`readNpmrcValue()`），使 `node scripts/dsh-gui.mjs build-desktop` 同样生效；该文件回退分支未实跑，只做静态核对 |
| 3 | 推导规则与镜像可用性 | 仅当宿主匹配 `npmmirror.com` / `npm.taobao.org` 时取 `${registry origin}/-/binary/<project>/`，其它 registry 不替换。镜像树实测：`/-/binary/electron/v44.0.0/SHASUMS256.txt` 200、6,740 B；`/-/binary/electron/v44.0.0/electron-v44.0.0-win32-x64.zip` 200、157,455,369 B；`/-/binary/electron-builder-binaries/icons@1.1.0/icons-bundle.tar.gz` 200、3,143,719 B；`winCodeSign-2.6.0/winCodeSign-2.6.0.7z` 200、5,635,384 B |
| 4 | 真实运行的来源 | 不设 `ELECTRON_MIRROR` 的 `npm run build:desktop` 打印 `electron source: https://registry.npmmirror.com/-/binary/electron/` 与 `electron-builder toolset source: https://registry.npmmirror.com/-/binary/electron-builder-binaries/` |
| 5 | 变量进入真正的下载进程 | `toolchain.mjs:45` 的 `run()` 为 `{ ...process.env, ...options.env }`；pnpm 转发实测（`ELECTRON_MIRROR=probe-value` 下 `pnpm exec node -e …` 输出 `probe-value`）；`package-target.ts:410-416` 的 `downloadEnv` 只剥离签名与上传凭据，`prepare:runtime` 用的正是它（:470） |
| 6 | 优先级与退出通道 | 环境变量 → `electron_mirror` / `electron_builder_binaries_mirror` npm 配置 → registry 推导；设空值即回到官方 GitHub release 宿主 |

优先级与空值语义、registry 识别范围由源码表达，未加自动化测试：`test:scripts`（`node --test scripts/plugin-install.test.mjs`）不覆盖 `scripts/desktop.mjs`，本次也未新增测试文件。改动同时更新了 `scripts/dsh-gui.mjs` 的 `build-desktop` 帮助文本与 [desktop-app.md](desktop-app.md) 的「联网下载」一节。
