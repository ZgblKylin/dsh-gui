# Desktop 应用（Electron）

## 用途

`npm run build:desktop` 构建上游 `apps/desktop` 的 Electron 形态，把解包后的应用落位到运行时根的 `desktop/`，编译快捷方式 shim `<runtime-root>\dsh-gui-desktop.exe`，并把 `plugins/` 的安装脚本装到 desktop profile；`npm run desktop` 启动该应用。构建工作区与产物都位于运行时根，仓库内不产生依赖树与打包中间产物，布局契约见 [nested-clone-layout.md](nested-clone-layout.md)，低标签的继承与复制语义见 [windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md)。

Tauri 外壳（`dsh-gui.exe`）与 desktop 是两个并列的产品：外壳用系统 WebView 承载 DSH Web UI；desktop 以 Electron 运行，拥有独立的依赖树，并在 `DSH_HOME` 下使用自己的 `profiles/desktop`。

## 命令

### `npm run build:desktop`

该命令在 Windows 上依次执行：

1. 把 `.desktop\source` 同步到 `deepseek-harness` 子模块指针：检出缺失时以 `git clone --local --no-checkout` 建立并 `checkout --detach`；检出已存在且有未提交改动时中止并提示，否则检出到该 commit。已检出的 commit 记入 `.desktop\source-revision.json`。
2. 在 `.desktop\source` 内执行 `pnpm install --frozen-lockfile`；依赖树完整时跳过。
3. 在 `.desktop\source\apps\desktop\.env.windows` 缺失时生成免签名构建所需的最小包环境配置。
4. 在 `.desktop\source\apps\desktop\node_modules\electron` 内执行 `node install.js`，安装 Electron 二进制。
5. 在 `.desktop\source` 内执行 `pnpm run clean`，随后应用构建期源码补丁并执行 `pnpm run build:official`。
6. 执行 `pnpm run package:desktop:win:x64:unsigned -- --dir`；该打包链会再执行一次 `pnpm run build:official`，随后还原构建期源码补丁。
7. 把 `unsigned-artifacts\win-unpacked` 的内容落位到 `<runtime-root>\desktop`。
8. 编译 shim，产出 `<runtime-root>\dsh-gui-desktop.exe`。
9. 先用该 CLI 与本次构建出的兼容性判定清理 desktop profile 中当前 dsh 版本拒绝的直接依赖（各 wrapper 随后会重新安装自己的固定版本），再把 `plugins/<id>/install.mjs` 逐个安装到 desktop profile，目标目录是 `<runtime-root>\.dsh\profiles\desktop`；其中 `plugins/auto-update/install.mjs` 是 desktop-only 插件，非 desktop profile 只打印 skip 并退出 0（见下节）。

第 5 步的 `pnpm run clean` 来自上游 `scripts/clean.ts`：它按项目引用图删除各工程的构建输出，并删除 `packages/*/*` 下没有 `package.json`、只剩 `node_modules`、`lib` 这类已知残留的目录。tsdown 的 `vendor/*` 与 `packages/*/*` 成员只按目录匹配，检出又跨修订复用，因此这类目录仍会被当作工作区构建目标读入；其中的 `lib/types/index.js` 一旦引用当前修订已移除的导出，主机侧构建就以 `MISSING_EXPORT` 失败。目录含已知残留之外的条目时，清理报错中止，不做任何删除。

`npm run build:desktop` 的旗标：

- `--force-source`：删除并重建 `.desktop\source` 检出。
- `--force-install`：重装 `.desktop\source` 的依赖树。
- `--skip-shim`：跳过 shim 编译，保留运行时根上已有的 shim。
- `--skip-plugins`：跳过第 9 步的插件安装。
- `--plugins-only`：只执行第 9 步，复用已有的 `<runtime-root>\desktop`，用于插件集合变化后的重装；与 `--skip-plugins` 互斥。

`npm run build:desktop-plugins` 是该旗标的 npm 脚本别名，等价于 `npm run build:desktop -- --plugins-only`。

`npm run build` 不包含 desktop：该命令只处理 dsh 运行时、Tauri 入口 exe、插件与 agent preset。要一次构建两个目标，用 `npm run build:all`（等价于 `npm run build` 后接 `npm run build:desktop`；前一步失败即中止，不执行 desktop 构建）。

### `npm run desktop`

该命令以 `DSH_HOME=<runtime-root>\.dsh` 启动 `<runtime-root>\desktop\DeepSeek Harness.exe`，并注入 `DSH_GUI_ROOT=<仓库根>`，让需要定位检出的插件（desktop 自动更新插件）无需从 `cwd` 向上查找。

### shim 入口

`<runtime-root>\dsh-gui-desktop.exe` 是等价入口：双击它不弹出控制台，行为与 `npm run desktop` 一致。它在 `<runtime-root>\dsh-gui` 内执行 `npm run desktop`；启动失败时把一行诊断追加到 `<runtime-root>\.desktop\shim.log`。

该 exe 由 `npm run build:desktop` 的第 8 步产出：crate 位于 `src-shim`，cargo target 取 `<runtime-root>\.desktop\shim-target`，编译结果复制到运行时根。

## desktop profile 与插件安装

第 9 步把 `plugins/<id>/install.mjs` 逐个安装到 desktop profile，目标目录是 `<runtime-root>\.dsh\profiles\desktop`。

安装脚本的 profile 范围由 wrapper 自己决定：`plugins/auto-update/install.mjs`（包 `dsh-auto-update`）是 desktop-only 插件，`DSH_PLUGIN_PROFILE` 不是 `desktop` 时只打印一行 skip 并退出 0，不写任何 profile，因此 `npm run install:plugins` 与 web profile 的组合都不受影响。它给 desktop 应用带来标题栏最右侧、窗口按键之前的「更新」入口与更新对话框（检测、就地 git 更新、更新日志、AI 更新），当前态见 [desktop-auto-update.md](desktop-auto-update.md)。

desktop profile 只能由 Desktop 自带的 CLI 管理，即 `<runtime-root>\desktop\resources\runtime\cli\bin\dsh.cmd`；普通 `dsh --profile desktop` 会被拒绝。profile 未初始化时该 CLI 同样拒绝并提示先启动一次 Desktop，因此第 9 步在 profile 缺失时以隐藏窗口启动一次落位的应用，等 profile 文件生成后结束该实例，再执行安装。

插件包操作要求 Desktop 处于关闭状态：第 9 步在执行安装前一律检测 `DeepSeek Harness.exe` 是否在运行，检测到即报错并提示先关闭。

安装脚本跑完后，第 9 步收尾核对 bundle 登记：对 desktop profile 的每个依赖，若其 `package.json` 声明了 `dsh.bundle.patch` 却不在 `dsh.profile.bundles` 中，就对该包执行 `dsh plugin remove` 再 `add`，复检仍缺失即报错。上游载体只在 `dsh plugin add` 改变依赖树时 reconcile bundles，依赖已记录时重复 `add` 是空操作，因此必须 remove 后重新 add，否则插件不会挂载。

安装与 web profile 走同一套流水线 `scripts/plugin-install.mjs`，通过 `DSH_PLUGIN_PROFILE` 与 `DSH_PLUGIN_DSH_CLI` 切换目标 profile 与 CLI 载体；两个 profile 位于 `<runtime-root>\.dsh\profiles\` 下的不同目录，互不覆盖。

载体模式下该流水线不向 desktop profile 的 `pnpm-workspace.yaml` 写入 `storeDir`：载体自带 pnpm，其应用已按载体环境解析的 store 链接 profile 的 `node_modules`，写入仓库 store 会让 pnpm 以 `ERR_PNPM_UNEXPECTED_STORE` 拒绝该 profile。

## 路径契约

```
<runtime-root>/
├─ .desktop/
│  ├─ source/             deepseek-harness 的出仓检出（随子模块指针同步）
│  ├─ source-revision.json 已检出的 commit
│  ├─ shim-target/        shim crate 的 CARGO_TARGET_DIR
│  └─ shim.log            shim 启动失败时的诊断日志
├─ desktop/               解包后的 desktop 应用（入口 DeepSeek Harness.exe）
└─ dsh-gui-desktop.exe    快捷方式 shim：等价于 npm run desktop，不弹控制台
```

`.desktop\source` 是 deepseek-harness 的出仓检出：依赖安装、Electron 二进制与打包中间产物都写在该目录内，仓库内的 `deepseek-harness/` 子模块不被写入。

Electron 二进制与 electron-builder 工具集的下载缓存分别取运行时根的 `.cache\electron` 与 `.cache\electron-builder`，与 `.desktop\source` 一样由后续构建复用。

## 首次构建成本

首次构建需要建立出仓检出并安装依赖，磁盘占用约 2–3 GB（依赖树约 1.8 GB，落位产物约 1 GB），耗时在 30–60 分钟量级：依赖安装、整仓构建与解包打包各自需要数分钟到十余分钟，下载慢时更长；后续构建复用 `.desktop\source` 与其中已安装的依赖。

## 联网下载

构建必须联网下载以下内容，任何一项失败都会让构建中止：

- Electron 二进制。
- primary runtime 资产。
- electron-builder 工具集。
- `@deepseek-ai/libreoffice-kit-win32-x64`（约 71 MB）。它由 `prepare:dsh` 在安装生产树时经 pnpm 拉取，不属 primary runtime 的锁定资产；该包传输慢时 pnpm 会在重试耗尽后以 `desktop runtime: missing required LibreOffice engine win32-x64` 中止构建。

Electron 的安装脚本、`@electron/get` 与打包链的 primary runtime 下载都走 Node 的全局 `fetch`（undici），而它既不读 npm 的 `proxy` 配置，也不读 `HTTP_PROXY` / `HTTPS_PROXY`，除非 `NODE_USE_ENV_PROXY` 启用它的环境代理 agent。因此代理只写在 `.npmrc` 里时这些下载仍走直连，慢到超时就会以 `TimeoutError: The operation was aborted due to timeout` 中止 `prepare:primary-runtime`。

`scripts/dsh-gui.mjs` 在 `scripts/proxy-environment.mjs` 中解析代理，只对 `setup`、`build`、`rebuild`、`install`、`plugins`、`build-desktop` 这几个命令生效，解析结果写入子进程环境。取值顺序为：环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` / `ALL_PROXY` / `all_proxy` 中的第一个非空值，命中时只补设 `NODE_USE_ENV_PROXY=1`，不改动调用方给出的地址；环境变量没有命中且宿主为 Windows 时，读注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` 与 `ProxyServer`（接受 `host:port` 与 `http=` / `https=` 两种形式），设置 `HTTP_PROXY` / `HTTPS_PROXY` 及小写形式，并同样补设 `NODE_USE_ENV_PROXY=1`。日志打印 `download proxy: <地址> (<来源>)`，两处都没有代理时打印直连。`NODE_USE_ENV_PROXY` 自 Node 24.0.0 起支持，更早的 Node 忽略该变量。

`NO_PROXY` / `no_proxy` 始终并入 `localhost` / `127.0.0.1` / `::1`：打包链的 runtime smoke 会启动 Host 并访问 `127.0.0.1`，不能把回环流量交给代理。Windows 路径还并入系统的 `ProxyOverride`，并把其中的 `<local>` 展开成这三个回环主机。以下情形不做任何替换，下载保持直连：环境变量或 `ProxyServer` 只给出 `socks` 等非 HTTP 代理，`ProxyEnable` 不为 1，`ProxyOverride` 含 `*`，或注册表无法读取。

Electron 与 electron-builder 的下载镜像不硬编码，而是从 npm registry 推导：`scripts/desktop.mjs` 读取 `npm_config_registry`（`npm run` 会把解析后的 npm 配置导出给脚本），缺省时再读仓库根与用户目录的 `.npmrc`；当该 registry 的宿主是 npmmirror（含旧域名 `npm.taobao.org`）时，按 `${registry origin}/-/binary/<project>/` 取镜像 —— Electron 与 electron-builder 归档的 GitHub release 资产在同一镜像树下，构建日志会打印实际来源（`electron source:` / `electron-builder toolset source:`）。优先级为：`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 环境变量 → 同名 npm 配置（`electron_mirror` / `electron_builder_binaries_mirror`）→ registry 推导；设成空值即回到官方 GitHub release 宿主，registry 不是可识别镜像时不做任何替换。Electron 归档仍按 release 的 `SHASUMS256.txt` 校验。该推导只覆盖这两项：primary runtime 的 node/python/wheel 与 LibreOffice kit 不使用它。

## 已知上游缺陷与规避

| 现象 | 根因 | 规避 |
|---|---|---|
| 打包在 `prepare:packages` 阶段失败，报 `tar (child): Cannot connect to D: resolve failed` | 上游把带盘符的绝对路径交给 `tar`，PATH 上的 Git GNU tar 按 POSIX 把盘符解析为远端主机 | 打包步骤把 `%SystemRoot%\System32` 前置到 `PATH`，让 Windows 内置 bsdtar 先于 Git 的 GNU tar 命中 |
| primary runtime 资产的下载速率极低 | 上游脚本串行单流拉取 GitHub release 资产，该通道慢；这些下载走 Node 全局 `fetch`，不设置 `NODE_USE_ENV_PROXY` 时任何代理都不生效 | 构建链解析代理并启用 `NODE_USE_ENV_PROXY`，让下载走系统代理（见「联网下载」）；通道仍慢时可用镜像预置锁定资产供产品脚本按 SHA-256 自验后复用 |
| 发布 DevTools 时 `rename` 报 `EPERM`，Host bundle 失败 | 上游 `packages/experimental/inspector/scripts/build-devtools.ts` 用目录 `rename` 发布 `lib/devtools`；Windows 在刚写完的目录尚未完全释放时拒绝该重命名，脚本不重试 | 构建链对该上游脚本应用构建期补丁，发布改为带退避重试的 `rename`，重试耗尽后回退到递归复制（见「构建期源码补丁」） |

## 构建期源码补丁

`npm run build:desktop` 在 `pnpm run clean` 之后应用构建期源码补丁，在打包步骤结束之后用 `git checkout` 还原。补丁只改 `.desktop\source` 检出内的上游文件，不写入 `deepseek-harness/` 子模块；检出的未提交改动因此只存在于构建期间。

补丁由 `scripts/desktop.mjs` 的 `SOURCE_PATCHES` 定义：每项给出检出内的相对路径与一组「锚点、替换」对，锚点必须是上游文件中的完整单行且恰好出现一次。锚点缺失或出现多次时，构建以指名该锚点的错误中止，不写入半份改动。补丁覆盖第 5 步的构建与打包链内的再次构建，打包结束后无论成败都还原。

`syncSource` 的脏检出检查对补丁文件例外：未提交改动全部是补丁文件时，构建先还原它们再继续；存在其他改动时仍按原规则中止。该例外只用于恢复上一次构建中断留下的状态。

当前补丁针对 DevTools 的发布步骤：`rename` 对 `EPERM`、`EACCES` 与 `EBUSY` 逐次退避重试，重试耗尽后改用递归复制。升级 `deepseek-harness` 后若锚点失配，按新文件内容更新 `SOURCE_PATCHES`。

## 未签名与 SmartScreen

`package:desktop:win:x64:unsigned` 的免签名目标只接受 `win-x64`，是没有签名证书与令牌时唯一可用的打包路径。产物落在 `unsigned-artifacts`，文件名带 `-unsigned` 后缀，`DeepSeek Harness.exe` 未数字签名。

位于 DSH 工作区内的副本带低完整性标签，会触发 SmartScreen 的「无法识别的应用」提示；把 `desktop/` 与 `dsh-gui-desktop.exe` 放在运行时根即让产物不带标签，见 [windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md)。

## 为什么构建工作区位于运行时根

会话工作区是仓库根；后端给工作区根写入一份带容器与对象继承标志的低完整性标签，工作区的每个后代都继承它。标签由目标父目录的可继承标签决定，复制不携带标签（见 [windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md)）。

若把检出、依赖安装与打包放在仓库内，`.desktop\source` 的依赖树、打包中间产物与最终 exe 都会继承低标签：exe 启动后整棵进程树降为低完整性，并出现环境临时根不可写、SmartScreen 提示等连锁结果；pnpm 的硬链接还会把标签沿共享文件对象外溢到 `.pnpm-store`。

把这些目录放在运行时根之下则相反：运行时根不属于任何会话工作区，落在其中的文件不带标签，产物可以直接运行。
