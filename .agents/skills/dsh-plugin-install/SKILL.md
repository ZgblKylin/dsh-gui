---
name: dsh-plugin-install
description: 安装 / 卸载 DSH 插件到 profile 的标准流程，涵盖 npm 包、git 源码、本地 tgz、目录等所有受管安装方式，以及源码编译安装（third_party + tsdown 构建 + pnpm pack）的要点与沙箱提权规则。使用 dsh plugin --profile <profile> add --help 作为权威安装方式列表。dsh-gui 仓库内一律自托管（DSH_HOME=<repo>/.dsh，web profile），不装系统全局。
whenToUse: 用户要求安装、卸载、更新某个 DSH 插件（如 dsh-better-sidebar、dsh-sidebar-qa、dsh-git-remotes），或询问插件怎么装、装到哪个 profile、源码插件如何编译安装时使用。
---

# 安装 DSH 插件

插件安装在 **profile** 下。**dsh-gui 仓库环境一律自托管**：`DSH_HOME` 指向仓库内
`.dsh`（web profile 在 `.dsh/profiles/web/`），不要使用系统全局安装
（AGENTS.md「自托管」规则）。只有无 dsh-gui 环境、仅把本仓库当插件清单时，
才用系统全局 `.dsh`（`~/.dsh`），此时按「无 dsh-gui 环境」小节处理。

安装/卸载一律通过 **dsh 受管安装器**（`dsh plugin`），它转发给 profile 目录里的
pnpm，并负责 `dsh.bundle.patch` 的 bundle reconcile（把包追加进
`dsh.profile.bundles`）。

## 权威安装方式列表

安装方式以 `dsh plugin --profile <profile> add --help` 为准。`dsh plugin add`
转发给 profile 内 pnpm 的 `pnpm add`，其支持的**来源类型**（usage 头部）：

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

> 提示：`dsh plugin` 本身无法运行（包括 `--help`）时，可直接在 profile 目录跑
> `pnpm --dir .dsh/profiles/web add --help` 查看同样的用法。

## 安装流程（dsh-gui 仓库自托管，以 web profile 为例）

dsh CLI 位于 `deepseek-harness/apps/cli/lib/bin.js`（构建产物，先跑过一次
`npm run setup`）；pnpm 用仓库固定的 `.toolchain/`（见 `scripts/toolchain.mjs`，
走 `PATH` 前缀）。仓库内插件安装由共享流水线
`scripts/plugin-install.mjs` 完成（`npm run install:plugins` / `npm run build`），
下面命令是它调用的等价形式，也适用于手工/一次性安装：

```powershell
# 从仓库根目录
$env:DSH_HOME = 'E:\Git\dsh-gui\.dsh'
node deepseek-harness/apps/cli/lib/bin.js plugin --profile web add <spec>
```

### 1. 确认包存在与元数据

```powershell
# 用工作区内的 npm cache（默认 cache 在沙箱下可能 EPERM）
$cache = 'E:\Git\dsh-plugins\.npm-tmp-cache'
npm view <pkg> --cache $cache --json
```

- 检查 `engines.node`（兼容仓库内置 Node LTS）、`dsh.bundle.patch`（bundle 型
  插件，指向包内真实存在的 `cordis.patch.yml`）、`files` 白名单是否含 patch 文件、
  peerDependencies 是否与已装插件兼容。
- npm 上不存在的包名会 404——先 `npm search`，或向用户确认是否是 git 仓库。

### 2. 执行受管安装

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui\.dsh'
node deepseek-harness/apps/cli/lib/bin.js plugin --profile web add <spec>
```

- 声明了 `dsh.bundle` 的包会被自动追加进 `dsh.profile.bundles`，其 bundle patch
  自行插入 Loader entry；未声明的包只作为普通依赖（CLI 打印一次性警告）。
- **沙箱拦截**：构建、安装等操作可能被 dsh 沙箱拦截（EPERM 等）。被拦截时
  **不要用非标手段绕过**，通过工具以 `sandbox_permissions`（通常
  `danger-full-access`）向用户申请提权后原命令重试一次；审批被拒则如实报告并
  换合规手段（如降低并发重试）。

### 3. 验证安装结果

```powershell
# profile package.json：依赖 + dsh.profile.bundles 应出现该包
Get-Content ".dsh\profiles\web\package.json" -Raw
# node_modules 实际存在
Test-Path ".dsh\profiles\web\node_modules\<pkg>"
# 组合层验证：Loader 树无重复 entry、无加载错误
$env:DSH_HOME = 'E:\Git\dsh-gui\.dsh'
node deepseek-harness/apps/cli/lib/bin.js --profile web --dump-config
```

- `dsh.bundle.patch` 声明的包在下次启动时以 bundle 层进入 Loader 组合（重启
  dsh-gui / harness 生效）。

## 卸载

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui\.dsh'
node deepseek-harness/apps/cli/lib/bin.js plugin --profile web remove <pkg>
```

- 从 `package.json` 依赖和 `dsh.profile.bundles` 移除，node_modules 删除。
- 卸载后若 profile 的 `cordis.patch.yml` 里还留有该包的 `disabled` / insert 残留
  （曾手工维护过时），应一并清理，避免 `duplicate loader entry id` 启动失败。

## 源码编译安装（git 仓库 / 非 npm 包）

### 为什么不用 `allowBuilds`

git 源码依赖（`pnpm add git+https://...`）需要执行 `prepare` 构建脚本，pnpm 用
profile 的 `allowBuilds` 白名单拦截：

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ... needs to execute build scripts but is not in the "allowBuilds" allowlist.
```

错误信息会建议在 `pnpm-workspace.yaml` 加 `allowBuilds: <pkg>@git+...#<commit>: true`。
**但 key 绑定精确 commit hash，后续更新要改，维护不便**。优先采用下面的"构建后
tgz"方案：受管安装器接受本地 tgz 并写入 `file:` 依赖。

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

# 5) 受管安装 tgz（从仓库根目录，自托管）
$env:DSH_HOME = 'E:\Git\dsh-gui\.dsh'
node deepseek-harness/apps/cli/lib/bin.js plugin --profile web add "E:\Git\dsh-plugins\third_party\<plugin>-<version>.tgz"
# package.json 会写入 file:E:/.../<plugin>-<version>.tgz
```

### 沙箱要点（重要）

- **命令被沙箱拦截时**：通过工具以 `sandbox_permissions`（通常
  `danger-full-access`）申请提权重跑；审批被拒不要反复尝试绕过，改用合规替代路径。
- **pnpm install 的 prepare 脚本**在受限沙箱下会 `spawn EPERM`。若提权被拒，
  改为：依赖装好后**直接用 `node node_modules/tsdown/dist/run.mjs` 构建**
  （不经过 pnpm lifecycle，node 直接执行不被 spawn 拦截）。
- `pnpm pack` 会触发 `prepare`（tsdown），但因为是 node 直跑所以通常能成功。
- 用户对提权审批有最终决定权。

### 卸载源码安装的插件

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui\.dsh'
node deepseek-harness/apps/cli/lib/bin.js plugin --profile web remove <pkg>
```

- 之后 `third_party/<plugin>` 源码目录与 `.tgz` 是否保留，征求用户意见；`*.tgz`
  已被外层 `.gitignore` 排除，不会入库。

## 无 dsh-gui 环境（系统全局安装）

仅当不在 dsh-gui 仓库里、把仓库当作插件清单时，使用系统全局 `.dsh`：

```powershell
dsh plugin --profile web add <pkg>        # 用 PATH 上的 dsh（或桌面壳宿主命令）
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json" -Raw
```

其余方式列表、源码编译安装、沙箱规则与自托管一致，只是把 `DSH_HOME` 换成系统
全局位置、dsh 换成宿主提供的命令。

## 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `duplicate loader entry id: <id>` 启动失败 | 同一 entry 被 bundle 层和 profile 手工 patch 重复插入 | 删除 profile `cordis.patch.yml` 里的手工 insert（bundle 型插件自挂载）；或卸载插件后清理残留行 |
| `EPERM ... _cacache` | npm 默认 cache 被沙箱拦 | 用 `--cache <workspace 内目录>` |
| `spawn EPERM`（pnpm lifecycle） | 受限沙箱下子进程受限 | 用 `node <tsdown dist>/run.mjs` 直接构建；或申请提权 |
| `[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED]` | git 依赖需构建但不在 allowBuilds | 不要加 allowBuilds（commit 绑定）；走构建后 tgz 方案 |
| `dsh: pnpm failed in profile directory` | 安装器内部 pnpm 失败 | 看前面完整输出定位（peer 警告通常可忽略） |
| `ERR_PNPM_UNEXPECTED_STORE` | 普通终端与桌面壳环境 home 变量不同 | 仓库共享流水线已写 `.dsh/profiles/web/pnpm-workspace.yaml` 的 `storeDir` 固定 store；手工安装时保持同一 `DSH_HOME` |

## 检查清单

- [ ] 用 `npm view` 确认包存在、版本、bundle 声明、`files` 含 `cordis.patch.yml`、peer 兼容
- [ ] 仓库内一律自托管：`$env:DSH_HOME = <repo>\.dsh`，走 `deepseek-harness/apps/cli/lib/bin.js plugin --profile web add`
- [ ] 验证 `package.json` 依赖 + bundles + node_modules
- [ ] bundle 型插件无需手工改 `cordis.patch.yml`；手工维护过的旧行要清理
- [ ] git 源码插件：third_party 克隆 → 本地构建 → `pnpm pack` → tgz 受管安装
- [ ] 沙箱拦截时申请提权（`sandbox_permissions`）重跑，不绕过
- [ ] 告知用户重启 dsh-gui / harness 使 bundle 生效
