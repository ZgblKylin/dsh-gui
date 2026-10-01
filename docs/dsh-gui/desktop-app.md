# Desktop 应用（Electron）

## 用途

`npm run build:desktop` 构建上游 `apps/desktop` 的 Electron 形态，把解包后的应用落位到运行时根的 `desktop/`，并编译快捷方式 shim `<runtime-root>\dsh-gui-desktop.exe`；`npm run desktop` 启动该应用。构建工作区与产物都位于运行时根，仓库内不产生依赖树与打包中间产物，布局契约见 [nested-clone-layout.md](nested-clone-layout.md)，低标签的继承与复制语义见 [windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md)。

Tauri 外壳（`dsh-gui.exe`）与 desktop 是两个并列的产品：外壳用系统 WebView 承载 DSH Web UI；desktop 以 Electron 运行，拥有独立的依赖树，并在 `DSH_HOME` 下使用自己的 `profiles/desktop`。

## 命令

### `npm run build:desktop`

该命令在 Windows 上依次执行：

1. 把 `.desktop\source` 同步到 `deepseek-harness` 子模块指针：检出缺失时以 `git clone --local --no-checkout` 建立并 `checkout --detach`；检出已存在且有未提交改动时中止并提示，否则检出到该 commit。已检出的 commit 记入 `.desktop\source-revision.json`。
2. 在 `.desktop\source` 内执行 `pnpm install --frozen-lockfile`；依赖树完整时跳过。
3. 在 `.desktop\source\apps\desktop\.env.windows` 缺失时生成免签名构建所需的最小包环境配置。
4. 在 `.desktop\source\apps\desktop\node_modules\electron` 内执行 `node install.js`，安装 Electron 二进制。
5. 执行 `pnpm run build:official`。
6. 执行 `pnpm run package:desktop:win:x64:unsigned -- --dir`。
7. 把 `unsigned-artifacts\win-unpacked` 的内容落位到 `<runtime-root>\desktop`。
8. 编译 shim，产出 `<runtime-root>\dsh-gui-desktop.exe`。

`npm run build:desktop -- --force-source` 删除并重建检出，`npm run build:desktop -- --force-install` 重装依赖树，`npm run build:desktop -- --skip-shim` 跳过 shim 编译并保留运行时根上已有的 shim。

`npm run build` 不包含 desktop：该命令只处理 dsh 运行时、Tauri 入口 exe、插件与 agent preset。

### `npm run desktop`

该命令以 `DSH_HOME=<runtime-root>\.dsh` 启动 `<runtime-root>\desktop\DeepSeek Harness.exe`。

### shim 入口

`<runtime-root>\dsh-gui-desktop.exe` 是等价入口：双击它不弹出控制台，行为与 `npm run desktop` 一致。它优先执行 `<runtime-root>\run.cmd desktop`，`run.cmd` 不存在时在 `<runtime-root>\dsh-gui` 内执行 `npm run desktop`；启动失败时把一行诊断追加到 `<runtime-root>\.desktop\shim.log`。

该 exe 由 `npm run build:desktop` 的最后一步产出：crate 位于 `src-tauri/desktop-shim`，cargo target 取 `<runtime-root>\.desktop\shim-target`，编译结果复制到运行时根。

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

## 已知上游缺陷与规避

| 现象 | 根因 | 规避 |
|---|---|---|
| 打包在 `prepare:packages` 阶段失败，报 `tar (child): Cannot connect to D: resolve failed` | 上游把带盘符的绝对路径交给 `tar`，PATH 上的 Git GNU tar 按 POSIX 把盘符解析为远端主机 | 打包步骤把 `%SystemRoot%\System32` 前置到 `PATH`，让 Windows 内置 bsdtar 先于 Git 的 GNU tar 命中 |
| primary runtime 资产的下载速率极低 | 上游脚本串行单流拉取 GitHub release 资产，该通道慢 | 用镜像预置锁定资产供产品脚本按 SHA-256 自验后复用；这属于构建环境的准备，不是构建链的行为 |

## 未签名与 SmartScreen

`package:desktop:win:x64:unsigned` 的免签名目标只接受 `win-x64`，是没有签名证书与令牌时唯一可用的打包路径。产物落在 `unsigned-artifacts`，文件名带 `-unsigned` 后缀，`DeepSeek Harness.exe` 未数字签名。

位于 DSH 工作区内的副本带低完整性标签，会触发 SmartScreen 的「无法识别的应用」提示；把 `desktop/` 与 `dsh-gui-desktop.exe` 放在运行时根即让产物不带标签，见 [windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md)。

## 为什么构建工作区位于运行时根

会话工作区是仓库根；后端给工作区根写入一份带容器与对象继承标志的低完整性标签，工作区的每个后代都继承它。标签由目标父目录的可继承标签决定，复制不携带标签（见 [windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md)）。

若把检出、依赖安装与打包放在仓库内，`.desktop\source` 的依赖树、打包中间产物与最终 exe 都会继承低标签：exe 启动后整棵进程树降为低完整性，并出现环境临时根不可写、SmartScreen 提示等连锁结果；pnpm 的硬链接还会把标签沿共享文件对象外溢到 `.pnpm-store`。

把这些目录放在运行时根之下则相反：运行时根不属于任何会话工作区，落在其中的文件不带标签，产物可以直接运行。
