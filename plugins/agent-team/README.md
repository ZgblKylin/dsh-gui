# plugins/agent-team

安装官方实验性 **Agent Teams**，并落地与它配套的 Team-aware agent preset。

这是本仓库唯一一个 **没有本地插件包** 的 wrapper：`install.mjs` 只做两件事——把两个官方 npm bundle 装进 web profile，再按上游 preset 生成派生 preset。

## 用途

官方 Agent Teams 默认关闭（随附 profile 都不引用它），且它的组合与官方 preset 存在一处**错配**：

- 实验 bundle 的 `cordis.patch.yml` 在**顶层**禁用 continuable-child 控制工具、并把 `subagent` 降为 `one-shot`；
- 但 `dsh-web-app` 早已在顶层裁掉这些行，真正提供 delegation 工具的是 **preset**（`standard` / `cordis` / `ptc` 各自在 `delegation` 组里挂回 `tool-subagent-control` 且 `backgroundMode: continuable`）；
- 顶层 patch 够不到 preset 行，于是出现：**模型的 `send_message` 被 Agent Teams 的 scoped 版本遮蔽（只认 Team roster 成员名），而 `subagent` 仍在创建 continuable 子级** —— 父 agent 无法再寻址这种子 agent。

本 wrapper 的派生 preset 把这条缝补上：委派改为 `one-shot`，控制工具交给 Agent Teams。

## 安装内容

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team-profile@0.1.6-alpha.1` | web profile | Team 领域服务 + Remote 方法 + 九个 scoped 模型工具 |
| `@deepseek-ai/dsh-experimental-agent-team-web-profile@0.1.6-alpha.1` | web profile | 浏览器 roster 与任务板面板 |
| `<id>-team`，每个含 delegation 行且不挂进程级工具集的官方 preset 各一个 | `<DSH_HOME>/.agent-presets/` | 由官方同名 preset 生成的 Team-aware 组合。当前为 `standard-team` / `ptc-team`；官方 `cordis` 不派生，原因见「派生 preset 的规则」 |

两个 npm 包都声明 `dsh.bundle.patch`，因此 `dsh plugin add` 会自动把它们 reconcile 进
`dsh.profile.bundles`，由各自的 bundle 层挂载；**本脚本不写 `cordis.patch.yml` insert**（手工插入会 `duplicate loader entry id`）。

版本必须精确 pin：两个包的 npm `latest` 当前仍指向 `0.1.5-alpha.2`，与本仓库 pinned 的
`dsh-v0.1.6-alpha.1` 对应的是 `alpha` 上的 `0.1.6-alpha.1`，不写版本号会装错。二者都是
prerelease，这也是它们进不了 Community Market 的原因。

## 派生 preset 的规则

`install.mjs` 读取**安装树里的官方 composition**，只改四处锚点，其余逐字节保留：

1. `tool-subagent-control` 与 `tool-subagent-list-agents` 两行加 `disabled: true`；
2. 两处 `backgroundMode: continuable` 改为 `one-shot`。

**哪些 preset 会被派生是"发现"出来的，不是列出来的。** 脚本遍历官方 preset 根，凡是含 delegation 行的就生成一个 `<id>-team` 兄弟目录，所以上游新增 preset 会在下次安装时自动带上兄弟；上游删除 preset、或某 preset 不再满足派生条件时，其兄弟会被清理——清理只针对带本脚本 `generatedBy` 标记的目录，且只在**本轮至少成功派生一个 preset** 时才运行，以免查找失败时清空 roster。

**挂进程级工具集的 preset 不派生。** 官方 `cordis`（创造模式）挂 `@deepseek-ai/dsh-tool-cordis`，它把 `Service` / `Event` / `Builtin` / `Tool` 四个 Host inspect provider 注册进进程级注册表 `ctx.cordisInspect`：注册表按 id 唯一，且该工具集没有"复用已有注册"的配置；而 preset 的 standing mount 在进程内**常驻不回收**（`agent-presets` 每个 preset 只组一份，整棵树卸载时才释放）。所以含这个工具集的两份 composition 无法在同一进程内共存——后挂的那份会在 `tool-cordis` 行上失败，报 `Host Cordis inspect provider "Service" is already registered`，外层是 `failed to apply loader entry tool-cordis (@deepseek-ai/dsh-tool-cordis)`。

`cordis-team` 正是这种组合，因此脚本跳过它，并把上一轮可能已生成的目录当作 stale 清理掉——roster 里留一个"可选但挂不上"的 preset，比不生成它更糟。

`ptc` 同样适用：PTC 只改 **presentation**（`tool-presentation: mode: ptc`），工具注册表与
`view()` 不变，而 SDK 正是从同一个 `view().visible` 投影出来的，所以 patch 生效方式与
native 完全一致，Team 工具也会照常出现在 `run_code` 的 `dsh.*` 里。

`minimal` 没有 delegation 行，被检测后直接跳过——不给它平白加上原本没有的能力。

派生文件里**官方自己的注释按原样保留**，因此像 "This preset keeps fork continuable" 这种陈述
模式的行描述的是派生前的行为；生成文件的来源头里带一条同样的说明。

派生结果按"真实挂载"验证过：在 web profile 里让两个 agent 分别加入 `standard` 与
`standard-team`，读到的 `subagent` 描述分别是 "runs in the background by default, immediately
returns a durable subagent id"（continuable）与 "waits for the result by default … return a job
id"（one-shot），Team 工具在两者中都在。

**为什么是生成副本而不是 `cordis:include`。** 用 include + `patches` 表达同样的差异只需要几行，
但嵌套的 `cordis:include` 是**普通 `Include`**，而 Loader 会把树回写到它读取的文件
（`Include.write()` → `this.filename`）。只有 preset 自己的树抑制了这一点
（`agent-presets/src/mount.ts` 把 `PresetTree.write()` 覆盖为 no-op）；嵌套 include 会把**官方
composition 文件**改写成垂死树的内容——注释里描述的正是"会话结束即截断为 `[]`"。生成副本保留了
"只跟上游差异"的好处（只重写四个锚点，上游增删工具行自动带过来），同时绝不把官方文件当作写入目标。

若上游重构了这四个锚点，`install.mjs` **报错退出**而不是静默放过——静默的后果正是本 wrapper
要修的那个缺陷。

## 使用

```powershell
npm run install:plugins        # 或 npm run build
```

重启后在新会话里选择带 `+ Agent Teams` 后缀的预设（目录名为 `<id>-team`，显示名取官方名加后缀）。

**派生 preset 必须与两个 Team bundle 成对使用**：只落 preset 不装 bundle，会让 `subagent`
变成 one-shot 却没有任何 Team 工具，那是纯粹的能力退化。preset 在会话开跑后即锁定，因此要在
**新会话开始前**选。

## 已知限制

- **只为派生 preset 修复**。官方 `standard` / `cordis` / `ptc` 本身仍是原样，在那些 preset 下
  Agent Teams 的错配依旧存在（Team 工具会遮蔽三个控制工具，而 `subagent` 仍是 continuable）。
  要让所有会话都一致，需要把某个 `*-team` preset 设为默认（`agentPresets.default`），本 wrapper 不做这件事。
- **创造模式无法 Team 化**。`cordis` 挂的 Cordis 工具集注册进程级 inspect provider，一个进程只能挂一份，
  因此它没有 `-team` 兄弟（见「派生 preset 的规则」）。这不是本 wrapper 能补的缝：只要该进程里已经坐过官方
  `cordis`——选过创造模式会话、跑过 AI 更新（`dsh-ai-update` 会为空白会话自动 `agentPresets.select` 到
  `cordis`）、甚至冷读过历史创造模式会话的技能目录——含同一工具集的其它 preset 就挂不上，反之亦然。
  要换用另一方，需要重启 DSH 进程。
- **依赖上游文件形状**。四个锚点由 `install.mjs` 在安装时校验，上游重构会让安装**失败**而不是降级；
  届时需要更新脚本中的锚点常量。
- **生成副本位于 `.agent-presets/`，由安装脚本拥有**：每次安装都会覆盖，不要手改，改脚本。
- **`run_in_background` 仍然存在**。`one-shot` 只改变默认值（前台）与执行分支：显式
  `run_in_background: true` 会变成一次性后台 job（需要 `jobs` 服务，`ptc` 已含 `tool-jobs`）。
  若希望彻底不暴露该参数，可在锚点补丁里追加 `enableRunInBackground: false`。
- **上游仍在孵化**。两个包公开发布但不承诺稳定性，promotion 时 npm 名会去掉 `experimental-`。

## 卸载

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-agent-team-web-profile
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-agent-team-profile
Get-ChildItem <DSH_HOME>\.agent-presets -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'preset.yml') } |
  Where-Object { Select-String -Quiet -Path (Join-Path $_.FullName 'preset.yml') -Pattern 'generatedBy: plugins/agent-team' } |
  Remove-Item -Recurse -Force
```

`dsh plugin remove` 会把对应 bundle 从 `dsh.profile.bundles` 移除；派生 preset 目录带
`generatedBy` 标记，按标记删除即可，不必逐个点名。

## 约束

- `DSH_HOME` 缺省 `<repo>/.dsh`，只写该目录；**从不写官方 preset 安装目录**。
- 幂等：重复执行结果一致（npm 安装由 `dsh plugin add` 去重，派生 preset 每次重新生成）。
- 依赖 `scripts/plugin-install.mjs` 的共享流水线；两个 npm 包经 `installNpmPlugin` 安装。
