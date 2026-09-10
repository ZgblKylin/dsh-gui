---
name: dsh-plugin-uninstall
description: 卸载 / 移除 DSH 插件的完整流程：从 profile 卸载、删除仓库侧来源（git submodule、wrapper 目录、install.mjs、包 node_modules）、清理 `.dsh` 各类残留（profile 依赖与 bundles、cordis.patch.yml 的 insert/禁用行、settings 配置段、插件状态目录与 storage、npm-installs 记录、preset 引用）以及 `.git/` 内部残留（index gitlink、config 的 submodule 段、modules 下的 module git dir 与空壳目录、悬空 gitfile），并附三方比对的孤儿检测脚本。强调「安装痕迹分散在多处，只删一半会留下悬空 submodule 段、孤儿 module git dir、悬空 patch 行或启动即 duplicate loader entry id 的残留」。
whenToUse: 用户要求卸载、移除、删除、彻底清理某个 DSH 插件（如 dsh-terminal、dsh-file-explorer、dsh-pet），需要连子模块登记与 `.git/` 内部状态一起清掉，或询问「插件删干净了吗」「为什么删了还在」「.git 里还有没有残留」「有没有孤儿 submodule 段」时使用。也适用于清理插件卸载后的残留配置与组合层脏数据。
---

# 卸载 DSH 插件

插件一旦装过，痕迹会散落在**三个地方**，缺一处就会留下悬空状态：

1. **profile 侧**（`.dsh/profiles/web/`）：依赖、bundles、node_modules、组合 patch 行；
2. **harness home 侧**（`.dsh/`）：插件配置段、状态目录、storage、注册表记录；
3. **仓库侧**（本仓库 `plugins/<id>/`）：wrapper 目录、`install.mjs`、git submodule 登记。

推荐顺序：**先从 profile 卸载**（此时包目录还在，`link:` 依赖能正常解绑）→ **再清
`.dsh` 残留** → **最后删仓库侧来源** → **引用自检与验证**。

安装侧（`dsh plugin add` 的权威方式列表、源码编译安装）见 `dsh-plugin-install` skill；
插件包本体怎么写见 `dsh-gui-plugin-dev` skill。

## 0. 先判定插件的安装形态

卸载路径取决于它是怎么进来的，先 `Test-Path` 几下再动手：

| 形态 | 判定依据 | 仓库侧要删 |
|---|---|---|
| npm 包 | profile `package.json` 里是版本号 | 无（除非本仓库有 wrapper） |
| 本地 tgz / 源码 tgz | profile 里是 `file:E:/.../<x>.tgz` | `third_party/<plugin>`、`*.tgz`（征求用户意见） |
| 本地目录 link | profile 里是 `link:E:/Git/dsh-gui/plugins/<id>/<pkg>` | `plugins/<id>/` 整个 wrapper |
| dsh-gui wrapper + submodule | 上一条 + `.gitmodules` 里有对应段 | wrapper 目录 + submodule 四处登记 |
| 市场安装（dshmarket） | 市场页装过，可能无 wrapper | 一般无；清 profile 与市场状态即可 |
| **遮蔽未安装** | wrapper 顶部有 `MASKED` 守卫，或 wrapper 用 `installNpmPlugin({ skip })`（如 `dsh-pet`） | 只有仓库侧 + 少数残留；**不要**强行 `dsh plugin remove` |

遮蔽插件的特征：`.dsh/profiles/web/package.json` 的依赖与 `dsh.profile.bundles`、
`node_modules/<pkg>` 三处都查不到它——确认这三处为空即可，卸载动作本身可以跳过。

## 1. 第 1 步：从 profile 卸载

```powershell
$env:DSH_HOME = '<repo>\.dsh'      # dsh-gui 一律自托管到仓库内 .dsh
node deepseek-harness/apps/cli/lib/bin.js plugin --profile web remove <package>
```

- `dsh plugin remove` 转发给 profile 目录里的 `pnpm remove`（`Usage: pnpm remove
  <pkg>[@<version>]`），移出 `package.json` 依赖与 `node_modules`；受管安装器同时把包
  从 `dsh.profile.bundles` 摘掉。
- **顺序很重要**：`link:` 依赖指向 `plugins/<id>/<pkg>`，先删源目录再卸载会让 pnpm
  面对悬空链接。先卸载，后删源码。
- 沙箱拦截（`EPERM` / 文件被占用）时按仓库根 AGENTS.md 用 `sandbox_permissions`
  申请提权重跑一次，不要改路径绕开。
- 卸载后插件集合变更**重启 dsh-gui / harness 才生效**。

## 2. 第 2 步：清 `.dsh` 残留（逐项核对）

`.dsh/` 整体 gitignored，清理运行期状态**不需要提交**，但漏项会有实际后果。

| 位置 | 残留内容 | 后果 / 处理 |
|---|---|---|
| `.dsh/profiles/web/package.json` | `dependencies` 的 `link:`/版本项；`dsh.profile.bundles` 条目 | bundle 残留 → 启动时按顺序应用补丁层，包已删则加载失败 |
| `.dsh/profiles/web/cordis.patch.yml` | 安装器写的 `- insert:` 行；遮蔽期留下的注释块；`- id: <entry>` + `disabled:` 之类的定向覆盖 | **同 id 的 insert 残留 → 下次启动 `duplicate loader entry id` 直接失败**（最常被漏） |
| `.dsh/profiles/web/node_modules/<pkg>` | 包目录 | bundle 型或曾手工 `npm i` 时可能残留，删 |
| `.dsh/profiles/web/.dsh-module-fallback/node_modules/<pkg>` | 客户端模块回退镜像里的同一包 | 独立的 node_modules 树，容易漏；确认无该包 |
| `.dsh/profiles/web/pnpm-workspace.yaml` | `minimumReleaseAgeExclude` 里该包的 pin、`allowBuilds` 里该包的构建开关 | 只是陈旧条目，不致命；顺手清 |
| `.dsh/profiles/web/pnpm-lock.yaml` | 锁文件条目 | 下次 pnpm 运行自动重算，无需手改 |
| `.dsh/cordis.patch.yml` | harness home 级 patch 层（皮肤类插件在这里写 `- id: ui-skin-*` + `disabled:`） | 插件删了仍留着 id 定向行 → 悬空覆盖。若该段由被删插件生成（文件里常带 `auto-generated` 标记），整段连同注释一起清；若仍由在装的插件管理，交给它自己维护 |
| `.dsh/settings.yaml` | 插件配置命名空间（顶层键即插件 id：`pet:`、`dsh-better-sidebar:`、`sidebarqa:`、`task-board:`、`llm-deepseek:`、`llm-pi-ai:` …） | 陈旧配置段，插件已删则永远读不到；确认无其他消费者后删 |
| `.dsh/<plugin-id>/` | 插件状态（`dsh-pet/` 的 `main-config.json`+`memory.json`、`task-board/` 的 ledger/scheduler、`llm-deepseek/files-v3.json`、`pet-install/` 安装日志…） | 插件私有数据；确认不再需要后删 |
| `.dsh/plugins/<id>/` | wrapper 自己的运行期状态目录（如 `deep-whale/maid-atelier`） | 与插件 id 同名，删插件时一并删 |
| `.dsh/storages/` | storage domain 落盘（`<domain>.json` 或目录） | 插件自建 domain 的持久数据，按 domain 判断 |
| `.dsh/skills/<name>`、`.dsh/AGENTS.md` | 插件附带的技能目录、插件追加的用户级指令段 | 插件作者可能写在这两处，删插件时检查一次 |
| `.dsh/gui/npm-installs.json` | `installNpmPlugin` 记录的 npm 包名数组（桌面壳 update checker 读它判定「npm 安装 vs 源码安装」） | 不删则永远为已删包查版本，清掉该包名 |
| `.dsh/gui/pending-updates.json` | 更新检查缓存，含 `path`/`current`/`latest` 行 | 每次检查按 `.gitmodules` 重建，**会自动消失**，一般无需手工清 |
| `.dsh/profiles/web/.dsh-market/state.json` | 市场状态（`disabled`、`groups`、`groupOrder`、`region`） | 插件在市场里被禁用/分组过时，清对应 id |
| `.dsh/.agent-presets/<id>/agent.cordis.yml` | agent preset 里引用该插件包名的行 | **preset 会挂载失败**（见 4.3），必须同步改或删 preset |

## 3. 第 3 步：删除仓库侧来源

### 3.1 内嵌插件

删掉 `plugins/<id>/` 整个 wrapper 目录即可——`install.mjs` 与插件包都在里面。

### 3.2 submodule 插件：四处登记都要清

`.gitmodules`、索引、`.git/config`、`.git/modules` 是**四个独立位置**，`git rm` 只动前两个：

```powershell
# 1) 编辑 .gitmodules，删掉 [submodule "<name>"] 整段后暂存
#    <name> 是段名，通常等于 plugins/<id>/<package>（也可能是简名，如 plugins/terminal/dsh-terminal）
git add .gitmodules

# 2) 先删 .git/config 的段，再移除索引里的 gitlink
git config --local --remove-section 'submodule.<name>'
git update-index --force-remove plugins/<id>/<package>

# 3) 删除 wrapper 目录（install.mjs + checkout；独立 clone 的 checkout 自带 .git）
Remove-Item -Recurse -Force plugins/<id>

# 4) 删 checkout 的 module git dir（准确路径见该 checkout 内 .git 文件里的 gitdir:）
Remove-Item -Recurse -Force .git/modules/<name>
```

注意点：

- **`.git/modules/<name>` 里的 `<name>` 是 `.gitmodules` 的「段名」，不一定等于 `path`**：
  段名 `dsh-terminal` + path `plugins/terminal/dsh-terminal` 时，git dir 是
  `.git/modules/dsh-terminal`。**最可靠的定位方式是读 checkout 内的 `.git` 文件**
  （内容形如 `gitdir: ../../../.git/modules/<name>`），不要凭 path 猜。
- 删完 module git dir 后检查 `.git/modules` 下是否留下**空壳父目录**（如
  `.git/modules/plugins/<id>/`），一并删掉。
- **`.git/config` 的 `submodule.<name>` 段不会随 `.gitmodules` 自动消失**，必须显式
  `--remove-section`；本仓库出现过 `routing-suite`、`anchored-standard` 两个悬空项，
  都是漏了这一步。
- `update-index --force-remove` 只删索引条目、不动工作区；`.gitmodules` 有未暂存改动时
  它也比 `git rm --cached` 稳。
- 有些 checkout 是**独立 clone**（目录内 `.git` 是真目录），此时没有 `.git/modules/<name>`，
  第 4 步跳过。
- **本仓库沙箱下 `git submodule deinit` / `git submodule status` 会失败**
  （`sh.exe: *** fatal error - CreateFileMapping ... Win32 error 5`），照上面的手工
  等价步骤做，不要指望 `git submodule deinit` 收尾。
- `.git/` 内部残留不止上面四处，完整清单与检测脚本见 **3.4**。

### 3.3 node_modules（若有）

- `plugins/<id>/<package>/node_modules/`：源码构建留下的 dev 依赖，不随 git 走；删 wrapper
  目录时已一并删除，若 wrapper 保留则单独删。
- profile 与 module-fallback 的 `node_modules/<pkg>`：见第 2 步表格。
- 删除前确认**没有别的插件 `link:` 到同一包目录**——`link:` 指向共享目录，误删会连带弄坏
  其他插件。

### 3.4 `.git/` 内部残留与孤儿检测

`.git/` 是本地状态、不受版本控制：清理**不需要提交**，但漏了会让仓库元数据不一致（悬空
submodule 段、指向已删目录的 gitlink、孤儿 module git dir）。可能留下残留的位置：

| `.git/` 内部位置 | 残留形态 | 清理 |
|---|---|---|
| `index` | 指向已删目录的 gitlink（mode `160000`） | `git update-index --force-remove <path>` |
| `config` | `[submodule "<name>"]` 段（`url`/`active`/`branch`/`update`） | `git config --local --remove-section 'submodule.<name>'` |
| `modules/<name>/` | 整个 module git dir（`HEAD`/`config`/`refs`/`logs`/`objects`）；**key 是段名，不是 path** | `Remove-Item -Recurse -Force .git/modules/<name>` |
| `modules/**` | 删掉 module git dir 后留下的空壳父目录 | `Remove-Item` 空目录 |
| `info/exclude` | 曾手工为插件目录加的忽略行（少见） | 编辑该文件删行 |
| `packed-refs` / `refs/**` | 正常不会出现插件相关条目；排查时一并搜一次 | 一般无需处理 |

定位 module git dir 的**唯一可靠方式**是读 checkout 里的 `.git` 文件：

```powershell
Get-Content plugins/<id>/<package>/.git -Raw      # gitdir: ../../../.git/modules/<name>
```

三方比对检测脚本（在仓库根执行，每段都**应当无输出**）：

```powershell
# 0) 从 .gitmodules 取（段名, path）
$mods = @(); $cur = $null
foreach ($line in Get-Content .gitmodules) {
  if ($line -match '^\[submodule "(.*)"\]') { $cur = $Matches[1]; $mods += [pscustomobject]@{ name = $cur; path = $null } }
  elseif ($line -match '^\s*path\s*=\s*(.+)$' -and $cur) { $mods[-1].path = $Matches[1].Trim() }
}
$names = @($mods | ForEach-Object { $_.name } | Sort-Object -Unique)

# 1) .git/config 悬空段：config 有、.gitmodules 没有
$cfg = @(git config --local --list | Select-String '^submodule\.' |
  ForEach-Object { ($_ -split '=')[0] -replace '^submodule\.','' -replace '\.(url|active|branch|update)$','' } |
  Sort-Object -Unique)
Compare-Object $cfg $names | Where-Object SideIndicator -eq '<='

# 2) .git/modules 孤儿模块目录（判定见下方注意点）
$base = Join-Path (Get-Location) '.git\modules'
Get-ChildItem $base -Directory -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { (Test-Path (Join-Path $_.FullName 'HEAD') -PathType Leaf) -and (Test-Path (Join-Path $_.FullName 'config') -PathType Leaf) } |
  ForEach-Object { $_.FullName.Substring($base.Length).TrimStart('\') -replace '\\','/' } |
  Where-Object { $d = $_; -not (@($names | Where-Object { $_ -eq $d }).Count) }

# 3) checkout 内 gitfile 是否悬空（指向已删的 module git dir）
foreach ($m in $mods) {
  $gf = Join-Path $m.path '.git'
  if (Test-Path -LiteralPath $gf -PathType Leaf) {
    $target = ((Get-Content -LiteralPath $gf -Raw).Trim() -replace '^gitdir:\s*','')
    if (-not (Test-Path -LiteralPath ([System.IO.Path]::GetFullPath((Join-Path $m.path $target))))) { "DANGLING: $($m.path) -> $target" }
  }
}
```

注意点：

- **别用「目录里有 `HEAD`」判定模块目录**：`.git/modules/**/logs/` 与 `refs/remotes/**`
  里也有名为 `HEAD` 的文件（reflog、remote HEAD），会造出一堆假孤儿。必须 **`HEAD` 与
  `config` 两个文件同时存在**才是一个 module git dir。
- **独立 clone 的 checkout 没有 `.git/modules` 条目**（它的 `.git` 就是检出目录里的真目录），
  比对时不要当成「缺失」——只要确认它随 wrapper 目录一起被删掉即可。
- module git dir 的 `config` 若带 `core.worktree` 指向已删目录，同样属残留；正常 submodule
  不带它（`git config --local --list | Select-String 'core\.worktree'` 应为空）。
- 清完 `.git/` 内部后仍要跑 `git status`，确认索引与工作区符合预期（沙箱下
  `git submodule status` 不可用，见 3.2）。

## 4. 重点残留详解（第 2 步展开）

### 4.1 cordis.patch.yml 的两类残留

`.dsh/profiles/web/cordis.yml` 本身是空的 `[]`：组合由 `dsh.profile.bundles` 各层 +
`cordis.patch.yml` + `--patch` overlay 叠加而成，**所以脏数据只会留在 patch 文件里**。

- `- insert:` 行：旧版安装器为无 bundle 声明的包手工插入的 entry。插件删了但仍留着该行
  → 启动报 `duplicate loader entry id`（若 bundle 层还在插）或模块解析失败（若包已删）。
- 定向覆盖行（`- id: <entry>` + `disabled: true/false` 等）：皮肤/开关类插件常写。插件删了
  仍是悬空 id，按需清整段。
- 遮蔽期留下的注释块（`# - insert: ...`）：插件已彻底移除后没有保留价值，一并删。

### 4.2 settings.yaml

`.dsh/settings.yaml` 的**顶层键就是插件设置命名空间**（`pet:`、`dsh-better-sidebar:`、
`sidebarqa:`、`task-board:` …）。插件删除后这些段变成死配置；删前确认没有别的插件或用户
脚本在读同一命名空间。

### 4.3 preset 引用（容易连带弄坏别的功能）

agent preset 的组合文件会直接引用插件包名：

```yaml
- id: my-tool
  name: dsh-my-plugin        # 或 '@scope/dsh-my-plugin'
```

被引用的插件包解析不到时，**该 preset 挂载失败**，用它的会话起不来。删插件前先搜：

```powershell
git grep -n 'dsh-<name>' -- presets/          # 仓库源
Select-String -Path .dsh/.agent-presets/*/agent.cordis.yml -Pattern 'dsh-<name>'   # 已安装副本
```

两处都要处理：改行或连同 preset 一起移除（preset 的移除另见 `dsh-gui-preset-dev` 与
`presets/README.md`）。

### 4.4 市场与桌面壳记录

- `.dsh/profiles/web/.dsh-market/state.json`：市场禁用/分组状态。
- `.dsh/gui/npm-installs.json`：npm 安装的包名集合，update checker 靠它判断是否有 npm 发布
  可升级；删插件时清掉对应包名。
- `.dsh/gui/pending-updates.json`：按 `.gitmodules` 重建，自动收敛，不必手改。

## 5. 第 4 步：引用自检

源码删完后全仓库搜一遍，别把已删插件的名字留在文档、断言和提示词里：

```powershell
git grep -n '<package-name>'    # 包名，如 dsh-terminal
git grep -n '<id>'              # wrapper id / entry id
```

已知会被波及的固定引用点：

- `src-tauri/src/update.rs` 的 `parses_this_repo_submodules` 断言 `.gitmodules` 里存在某个
  子模块——删的正是它时，改断言为仍在的子模块；`windows_console_launcher_*` 用插件 id 做
  示例字符串时也顺手换掉。
- `src-tauri/ui/app.js`、`plugins/ai-update/dsh-ai-update/docs/README.md` 的提示词会点名具体
  插件举例（如 `MASKED` 守卫的范例）；举例对象被删就换例子。
- `README.md`、`plugins/README.md` 的插件清单，`docs/plugins/<name>.md` 专文，
  `.agents/skills/` 中以该插件举例的段落。
- `.dsh/**` 属运行期状态，不在 `git grep` 范围内，按第 2 步的表单独核对。

## 6. 验证清单

- [ ] `.git/config` 的 submodule 段集合 == `.gitmodules` 段集合，无悬空项（3.4 脚本第 1 段）。
- [ ] `.git/modules` 无孤儿 module git dir、无空壳父目录；checkout 的 `.git` gitfile 不悬空
      （3.4 脚本第 2、3 段）。
- [ ] 索引里没有指向已删目录的 gitlink（`git ls-files --stage | Select-String 160000`）。
- [ ] 被删插件若曾是 standalone clone，其检出目录里的 `.git` 真目录已随 wrapper 一并删除。
- [ ] `git status` 符合预期：wrapper 目录与包内容为删除，`.gitmodules` 为修改；`.dsh/`
      不出现（gitignored）。
- [ ] profile 三处一致：`package.json` 依赖、`dsh.profile.bundles`、`node_modules/<pkg>`
      都无该包；`cordis.patch.yml` 无同 id 的 insert 或定向行。
- [ ] 组合可加载：`node deepseek-harness/apps/cli/lib/bin.js --profile web --dump-config`
      无 `duplicate loader entry id`、无模块解析错误。
- [ ] 重启 dsh-gui / harness 后：插件面板/设置页不再出现该插件项，会话列表与 preset roster
      中不再引用它，无 FAILED fiber。
- [ ] 文档/测试/提示词自检无残留（第 5 步）。

## 7. 实战记录（本仓库已发生的案例）

| 案例 | 形态 | 实际做法与踩到的点 |
|---|---|---|
| dsh-terminal / dsh-file-explorer | wrapper + submodule，且已用 `MASKED` 遮蔽 | profile 侧本来就干净（只有 `cordis.patch.yml` 一个注释块）；仓库侧按 3.2 四清；`update.rs` 断言、`app.js` 与 ai-update 提示词里以它们为 `MASKED` 范例的段落一并改掉 |
| anchored-standard | preset + submodule（另一类是 preset 而非插件） | `.gitmodules` 与索引已先删，但 `.git/config` 段留着 → 悬空；`.dsh/.agent-presets/<id>/` 与 `presets/<id>/` 两侧目录都要删 |
| dsh-routing-suite | 早已移除的插件 | 只在 `.git/config` 留下悬空 `submodule.*` 段，印证 3.2 的注意点 |

推论：**卸载后固定回头看三样东西**——`.git/config` 的 submodule 段、`cordis.patch.yml`
的 insert 行、插件在 `.dsh` 下的状态/配置目录；再加上 `.git/modules` 的 module git dir 与
wrapper 目录里的独立 `.git`，就是完整的「五处」。

`.git/` 内部全量核对（对上述四个案例复查过）：`.git/config` 段集合与 `.gitmodules` 段集合
一致，`.git/modules` 下 8 个 module git dir 全部对应在册子模块、无孤儿、无空壳父目录；
`plugins/review/dsh-review` 与 `plugins/dsh-web-ui/dsh-web-ui` 是独立 clone（本就没有 module
条目，`.git` 随检出目录删除即可）；四个已删模块在 `.git/config`、`.git/info/exclude`、
`.git/packed-refs` 与 `.git` 下的目录名中均已无痕。
