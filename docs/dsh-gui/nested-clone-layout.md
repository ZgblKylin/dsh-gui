# 嵌套克隆布局与迁移计划

本文给出 dsh-gui 的目标目录布局、由它引出的两个根路径契约、需要修改的代码点、验证清单与权限还原步骤。背景见 [windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md)。

## 目标布局

运行时根与代码仓库分离：仓库位于运行时根之下的一层子目录，DSH 会打标的工作区就是该子目录。

```
<runtime-root>/
├─ dsh-gui.exe            入口 exe，由 build 产出后拷到此处，不带低标签
├─ .dsh/                  DSH home：会话、profile、storage、凭据、GUI 日志
├─ .harness/              npm 运行时的 dsh CLI 安装目录
├─ .toolchain/            pinned pnpm
├─ .pnpm-store/           shared pnpm store
├─ .cache/                构建缓存
├─ .staging/dsh-gui/      升级验证副本
├─ .desktop/              desktop 构建工作区：出仓的 deepseek-harness 检出、已检出 commit 与 shim 的 cargo target
├─ run.cmd                转发脚本：等价于在仓库内执行 npm run
├─ desktop/               解包后的 desktop 应用，入口 DeepSeek Harness.exe
├─ dsh-gui-desktop.exe    desktop 快捷方式 shim，等价于 npm run desktop
└─ dsh-gui/               git 仓库根，也是 DSH 工作区
   ├─ .git/  deepseek-harness/  plugins/  presets/  src-tauri/  scripts/  docs/
   └─ src-tauri/target/    cargo 构建目录
```

路由器根之外的目录不含低标签，因此其中的可执行文件与 DSH home 都保持中等完整性；仓库内只有源码、子模块与构建目录，被低标签覆盖的代价限于源码。

## 两个根

引入两个彼此独立的根，取代此前单一的「仓库根」。

| 名称 | 内容 | 解析顺序 |
|---|---|---|
| 仓库根 | `harness.json`、`deepseek-harness/`、`plugins/`、`presets/`、`src-tauri/`、`scripts/` | `DSH_GUI_ROOT` → 从 exe 所在目录向上查找 `harness.json` 与 `src-tauri/tauri.conf.json` → exe 同级的 `dsh-gui/` 子目录 |
| 运行时根 | `.dsh/`、`.harness/`、`.toolchain/`、`.pnpm-store/`、`.cache/`、`.staging/`、`.desktop/`、`desktop/`、入口 exe 与 desktop shim | `DSH_GUI_RUNTIME_ROOT` → 若父目录含 `.dsh` 或 `.harness` 则取父目录 → 仓库根本身 |

第三种解析结果保留了对既有单目录布局的兼容：仓库根同时充当运行时根。

外壳把 `DSH_GUI_ROOT` 注入 harness 进程，需要定位仓库的插件（例如远程连接插件的仓库发现）由此获得权威路径，不再依赖从 `cwd` 向上查找。

## 需要修改的代码点

### Rust 外壳

| 文件 | 修改 |
|---|---|
| `src-tauri/src/main.rs` | `repo_root()` 增加 `DSH_GUI_ROOT` 与嵌套约定两种来源；新增运行时根解析；`ShellState` 记录运行时根；`spawn_harness()` 以运行时根拼 `.dsh`、日志目录与 `DSH_HOME`，并注入 `DSH_GUI_ROOT`；`webview_data_dir()`、`log_status()`、`dsh_log()` 改用运行时根 |
| `src-tauri/src/harness.rs` | `resolve()` 接收两个根：`harness.json`、子模块版本、源码运行时的 bin 与 cwd 取仓库根；npm 安装目录默认 `<运行时根>/.harness` |
| `src-tauri/src/logging.rs` | `gui.log` 目录改用运行时根 |
| `src-tauri/src/dialog_sizes.rs` | `dialog-sizes.json` 路径改用运行时根 |
| `src-tauri/src/changelog.rs` | headless 回退运行时注入的 `DSH_HOME` 改用运行时根 |
| `src-tauri/src/update.rs` | `update.mjs`、`npm-installs.json`、注册表目录与 `DSH_HOME` 改用运行时根 |

### Node 脚本

| 文件 | 修改 |
|---|---|
| `scripts/toolchain.mjs` | 新增 `RUNTIME_ROOT`；`WEB_HOME`、`TOOLCHAIN`、`STORE` 与入口 exe 路径基于运行时根；`ROOT`、`HARNESS`、`PLUGINS`、`GLOBAL_AGENTS_TEMPLATE` 保持仓库根 |
| `scripts/harness-runtime.mjs` | `resolveHarnessRuntime()` / `requireHarnessRuntime()` 接收仓库根与运行时根两个参数；`DSH_HARNESS_INSTALL_DIR` 仍可覆盖，默认值相对运行时根 |
| `scripts/dsh-gui.mjs` | `buildExe()` 把 exe 拷到运行时根；`runApp()` 先找运行时根的 exe，并注入 `DSH_GUI_ROOT` 与 `DSH_HOME`；`makeShortcut()` 的目标与工作目录取运行时根；`smokeComposition()` 与 `harnessNpmRuntime()` 传入两个根 |
| `scripts/harness.mjs` | 传入两个根；`DSH_HOME` 取运行时根的 `.dsh` |
| `scripts/plugin-install.mjs` | 核对 `ROOT`、`WEB_HOME` 的使用并传入两个根 |
| `scripts/staging.mjs` | 副本位置改到运行时根的 `.staging/dsh-gui`，否则副本自身的入口 exe 与运行时目录会落在工作区内 |
| 新增 `run.cmd` | 运行时根下的转发脚本：接收 npm 脚本名与附加参数，等价于在仓库内执行 `npm run <脚本> -- <参数>` |

### 插件与文档

| 目标 | 修改 |
|---|---|
| `plugins/remote/dsh-remote/src/index.ts` | `discover()` 优先读取 `DSH_GUI_ROOT`，其次保留现有的向上查找 |
| `AGENTS.md` | 目录结构段改为运行时根与仓库根两个根 |
| `docs/dsh-gui/harness-runtime.md`、`docs/dsh-gui/upgrade-staging-workspace.md` | 契约与副本位置 |
| `.agents/skills/dsh-gui-update`、`dsh-gui-plugin-dev`、`dsh-gui-preset-dev`、`dsh-plugin-install` | 路径约定与副本位置 |
| 本文与 [windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md) | 新增 |

## 硬约束

- **运行时根禁止作为 DSH 工作区。** 会话工作区取仓库根；以外层目录建立工作区会让 `.dsh`、`.harness` 与入口 exe 重新进入打标范围，[windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md) 描述的全部症状随即复现。
- **仓库内不放 `node_modules`。** pnpm 以硬链接把 store 文件链接进 `node_modules`，硬链接共享同一个文件对象；仓库内的别名被打标时，store 中的同一对象连同其在别处的别名一并变为低标签。
- **desktop 的构建工作区与产物都位于运行时根。** `.desktop/`、`desktop/` 与 `dsh-gui-desktop.exe` 都在运行时根之下，仓库内不产生依赖树与打包中间产物。低标签按目标父目录的可继承标签继承，在工作区内构建会让产物与 pnpm 硬链接共享的文件对象带上低标签，见 [desktop-app.md](desktop-app.md)。
- **`npm run build` 由运行时根一侧执行。** 构建写入运行时根下的 `.harness`、`.toolchain`、`.pnpm-store` 与入口 exe；在仓库内以受限会话执行时这些写入位于工作区之外，需要按沙箱策略申请提权。

## 验证清单

1. 在仓库内执行 `npm run build`，确认入口 exe 生成于运行时根，且 `icacls <运行时根>\dsh-gui.exe` 不显示 `Mandatory Label`。
2. 直接启动入口 exe，确认 `.dsh/gui/harness.log` 不出现 `1 entry did not activate` 与 `dsh-spill` 相关错误。
3. 在新会话中调用 `pwsh`、`grep`、`glob`，确认三者可用。
4. 确认 `icacls <运行时根>` 与 `icacls <运行时根>\.harness` 不显示 `Mandatory Label`，而 `icacls <仓库根>` 显示 `Low Mandatory Level:(OI)(CI)(NW)`。
5. 以仓库根为工作区执行 `git status`、`git fetch`，确认无需提权。
6. 在远程连接界面建立一条连接并保存凭据，确认凭据写入 `<运行时根>\.dsh\gui\credentials\`。

## 回滚

改动集中在上述文件内，回滚即还原这些文件。运行时根下由新布局新增的目录（`.harness`、`.toolchain`、`.pnpm-store`、入口 exe、`.staging`）可以删除；既有单目录布局在两种根解析都退化为同一目录时仍可启动。

## 迁移步骤

1. 在运行时根一侧执行完整的 `npm run build`，产出入口 exe、`.harness`、`.toolchain`、`.pnpm-store` 与 profile。
2. 重跑插件安装（`npm run install:plugins`）。profile 里的本地插件以绝对 `link:` 记录，形如 `dsh-remote = link:<旧检出>/plugins/remote/dsh-remote`；检出移动到 `<runtime-root>/dsh-gui/` 之后这些链接仍指向旧路径，必须重装才会指向新检出。
3. 运行时根**发生位移**时（例如把一个单目录检出改成嵌套布局，或移动 `.staging`），profile 的依赖树仍按旧位置链接，pnpm 会以 `ERR_PNPM_UNEXPECTED_STORE` 拒绝按新 store 重链。此时先删除 `<DSH_HOME>/profiles/web/node_modules` 与同目录的锁文件，再重跑安装。运行时根本身没有位移时（原有运行时目录已在目标位置）不需要这一步。
4. 关闭 dsh-gui，执行下节的权限还原。
5. 以 `<runtime-root>/dsh-gui` 建立新的会话工作区，按验证清单逐项确认。

## 根目录权限还原

在关闭 dsh-gui、且不再以该目录为工作区之后执行：

```powershell
# 还原根目录自身的低标签
sudo icacls "<root>" /setintegritylevel Medium
# 递归还原已继承标签的子项（构建产物、.dsh、.harness 等）
sudo icacls "<root>" /setintegritylevel "(OI)(CI)Medium" /T /C
```

`icacls` 写 SACL 需要 `SeSecurityPrivilege`，普通未提权账户没有该权限，因此必须提权执行。该后端此前写入工作区根的允许 ACE 与 `FILE_DELETE_CHILD` 拒绝 ACE 不会被这条命令撤销，它们在标签还原后不再影响功能。
