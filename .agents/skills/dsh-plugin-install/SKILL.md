---
name: dsh-plugin-install
description: 安装 / 卸载 DSH 插件到 profile 的标准流程，涵盖 npm 包、git 源码、本地 tgz、目录等所有受管安装方式，以及源码编译安装（third_party + tsdown 构建 + pnpm pack）的要点与沙箱提权规则。使用 dsh plugin --profile <profile> add --help 作为权威安装方式列表。
whenToUse: 用户要求安装、卸载、更新某个 DSH 插件（如 dsh-better-sidebar、dsh-sidebar-qa、dsh-git-remotes），或询问插件怎么装、装到哪个 profile、源码插件如何编译安装时使用。
---

# 安装 DSH 插件

在 DSH Desktop 中，插件安装在 **profile** 下（`~/.dsh/profiles/<profile>/`）。当前机器有两个 profile：`desktop`（Desktop GUI 使用的 profile）和 `web`。安装/卸载一律通过 **dsh 受管安装器**（`dsh plugin`），它会转发给 profile 目录里的 pnpm，并维护 `plugin-install-recovery` 事务（recovery receipt + profile 快照 + bundle reconcile）。

## 权威安装方式列表

安装方式以 `dsh plugin --profile <profile> add --help` 为准。`dsh plugin add` 转发给 profile 内 pnpm 的 `pnpm add`，其支持的**来源类型**（usage 头部）：

```
dsh plugin --profile <profile> add <name>                # npm 包，默认 latest
dsh plugin --profile <profile> add <name>@<tag>          # npm 包，指定 tag
dsh plugin --profile <profile> add <name>@<version>      # npm 包，精确版本
dsh plugin --profile <profile> add <name>@<version range> # npm 包，版本范围
dsh plugin --profile <profile> add <git host>:<git user>/<repo name>  # GitHub 简写
dsh plugin --profile <profile> add <git repo url>        # git 仓库 URL（如 git+https://...）
dsh plugin --profile <profile> add <tarball file>        # 本地 tgz 文件（如 file:E:/.../x.tgz）
dsh plugin --profile <profile> add <tarball url>         # 远程 tarball URL
dsh plugin --profile <profile> add <dir>                 # 本地目录（会链接，通常不用于发布）
```

> 提示：`dsh plugin` 本身因 recovery 事务 pending 时无法运行（包括 `--help`）。此时可直接在 profile 目录跑
> `pnpm --dir ~/.dsh/profiles/<profile> add --help` 查看同样的用法。

## 安装流程（以 desktop profile 为例）

### 1. 确认包存在与元数据

```powershell
# 用工作区内的 npm cache（默认 cache 在沙箱下可能 EPERM）
$cache = 'E:\Git\dsh-plugins\.npm-tmp-cache'
npm view <pkg> --cache $cache --json
```

- 检查 `engines.node`（≥20 兼容 Desktop 内置 Node）、`dsh.bundle.patch`（bundle 型插件）、peerDependencies 是否与已装插件兼容（如 `dsh-better-sidebar ^0.12.0` 满足已有 0.13.1）。
- npm 上不存在的包名会 404——先 `npm search`，或向用户确认是否是 git 仓库。

### 2. 执行受管安装

```powershell
dsh plugin --profile desktop add <pkg>
```

- `dsh` 位于 `$env:APPDATA\DSH Desktop\host-commands\desktop\bin\dsh.cmd`。
- **必须提权**：dsh 启动时要 `chmod` Roaming 下的 `plugin-install-recovery` 目录，沙箱会拒绝（EPERM）。用 `sandbox_permissions: danger-full-access` 原命令重试一次。

### 3. 验证安装结果

```powershell
# profile package.json：依赖 + dsh.profile.bundles 应出现该包
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw
# node_modules 实际存在
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\<pkg>"
```

- 安装成功会留下 `phase: awaiting-restart` 的 recovery 事务（正常现象），**重启 Desktop 后自动 reconcile 清除**，bundle 层（`cordis.patch.yml`）才会在下次 Loader 组合中生效。

## 卸载

```powershell
dsh plugin --profile desktop remove <pkg>   # 需要同样的提权
```

- 从 `package.json` 依赖和 `dsh.profile.bundles` 移除，node_modules 删除。
- 同样留下 `awaiting-restart` 事务，重启后清除。

## 源码编译安装（git 仓库 / 非 npm 包）

### 为什么不用 `allowBuilds`

git 源码依赖（`pnpm add git+https://...`）需要执行 `prepare` 构建脚本，pnpm 用 profile 的 `allowBuilds` 白名单拦截：

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ... needs to execute build scripts but is not in the "allowBuilds" allowlist.
```

错误信息会建议在 `pnpm-workspace.yaml` 加 `allowBuilds: <pkg>@git+...#<commit>: true`。**但 key 绑定精确 commit hash，后续更新要改，维护不便**。优先采用下面的"构建后 tgz"方案，与仓库内 `dsh-cache-hit-precision` 的 `file:` 模式一致。

### 推荐流程：third_party 克隆 → 本地构建 → pack → 受管安装

```powershell
# 1) 克隆源码到 third_party（保留 .git 便于以后 git pull 更新）
git clone --depth 1 <git-url> third_party/<plugin>

# 2) 装依赖（在源码目录内）
cd third_party/<plugin>
pnpm install --no-frozen-lockfile
# 注意：install 的 prepare 生命周期脚本若被沙箱 spawn EPERM 拦截，可先完成依赖安装再单独构建

# 3) 本地构建（直接跑本地 tsdown CLI，避免 pnpm lifecycle 触发 spawn 拦截）
node node_modules/tsdown/dist/run.mjs
# 产物通常在 lib/（host index.js + client bundle，参考 tsdown.config.ts）
# 注意 pwsh 的 workdir 参数可能不生效——先 Set-Location 到源码目录再执行

# 4) 打 tgz（files 白名单控制内容，应含 lib/、cordis.patch.yml、README 等）
pnpm pack --pack-destination <父目录>
# 产出 <plugin>-<version>.tgz

# 5) 受管安装 tgz（需提权，理由同上）
dsh plugin --profile desktop add "E:\Git\dsh-plugins\third_party\<plugin>-<version>.tgz"
# package.json 会写入 file:E:/.../<plugin>-<version>.tgz（与 dsh-cache-hit-precision 一致）
```

### 沙箱要点（重要）

- **dsh 命令必须提权**：recovery 目录 chmod + profile 文件写入，`danger-full-access`。
- **pnpm install 的 prepare 脚本**在受限沙箱下会 `spawn EPERM`（pnpm 经 Desktop Electron 包装器执行）。若用户拒绝提权，改为：依赖装好后**直接用 `node node_modules/tsdown/dist/run.mjs` 构建**（不经过 pnpm lifecycle，node 直接执行不被 spawn 拦截）。
- `pnpm pack` 会触发 `prepare`（tsdown），但因为是 node 直跑所以通常能成功。
- 用户对提权审批有最终决定权；拒绝后不要反复尝试绕过，改用合规替代路径。

### 卸载源码安装的插件

```powershell
dsh plugin --profile desktop remove <pkg>   # 与 npm 包相同
```

- 之后 `third_party/<plugin>` 源码目录与 `.tgz` 是否保留，征求用户意见；`*.tgz` 已被外层 `.gitignore` 排除，不会入库。

## 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `another plugin install recovery transaction is pending` | 上一次安装/卸载留下的 `awaiting-restart` 事务未 reconcile | 重启 Desktop 自动清除；或确认事务创建者后等待重启 |
| `EPERM chmod plugin-install-recovery` | 沙箱拒绝 Roaming 写入 | 提权重跑 dsh 命令 |
| `EPERM ... _cacache` | npm 默认 cache 被沙箱拦 | 用 `--cache <workspace 内目录>` |
| `spawn EPERM`（pnpm lifecycle） | Electron 包装器下子进程受限 | 用 `node <tsdown dist>/run.mjs` 直接构建 |
| `[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED]` | git 依赖需构建但不在 allowBuilds | 不要加 allowBuilds（commit 绑定）；走构建后 tgz 方案 |
| `dsh: pnpm failed in profile directory` | 安装器内部 pnpm 失败 | 看前面完整输出定位（peer 警告通常可忽略） |

## 检查清单

- [ ] 用 `npm view` 确认包存在、版本、bundle 声明、peer 兼容
- [ ] 走 `dsh plugin --profile <profile> add` 受管安装（提权）
- [ ] 验证 `package.json` 依赖 + bundles + node_modules
- [ ] git 源码插件：third_party 克隆 → 本地构建 → `pnpm pack` → tgz 受管安装
- [ ] 告知用户重启 Desktop 使 bundle 生效
