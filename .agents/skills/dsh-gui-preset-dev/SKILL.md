---
name: dsh-gui-preset-dev
description: 'Use when creating, changing, installing, or reviewing an agent preset in the dsh-gui repo, when writing a `presets/<id>/install.mjs`, when deciding between the versioned `presets/` source tree and runtime `.dsh/.agent-presets`, or when authoring or validating an `agent.cordis.yml`. Covers dsh-gui preset layout and install flow, then routes composition authoring to the deepseek-harness Creator mode, shipped presets, and reference docs.'
whenToUse: 在 dsh-gui 仓库 `presets/` 下创建、修改、安装、审查 agent preset，写 `presets/<id>/install.mjs`，在版本化 `presets/` 源目录与运行期 `.dsh/.agent-presets` 之间取舍，或编写/校验 `agent.cordis.yml` 时使用。组合写法问题交给 deepseek-harness 创造模式、随包 preset 与参考文档。
---

# dsh-gui preset 开发

本 skill 负责 dsh-gui 里的 agent preset（`presets/<id>/` + `install.mjs`）。`agent.cordis.yml`
里每行插件怎么写、哪些服务能进 preset，以 deepseek-harness 的「创造模式」指导
和官方 preset 文档为准；本 skill 把这些说明与范例汇总，并补上 dsh-gui 自己的
交付规则。

## 0. 首要规则：源目录 + 安装脚本，不要直接写 `.dsh`

> **dsh-gui 的 preset 交付形态是版本化的 `presets/<id>/` 源目录，由该目录自带的
> `install.mjs` 安装到 `.dsh/.agent-presets/<id>/`。不要把 `.dsh` 当创作目录，
> 不要直接编写并添加到 `.dsh` 里。**

- `.dsh/` 是 gitignored 运行期状态：换机器、重装或 `git clean` 都会丢。preset
  的持久事实必须留在 `presets/<id>/`。
- 安装脚本只写 `$DSH_HOME`（dsh-gui 构建固定传 `<repo>/.dsh`），不写全局位置。
- 与插件 skill 相同：所有 preset 源码、配置、依赖自托管，不修改
  deepseek-harness 本体，不修改宿主组合来绕过 preset 限制。
- deepseek-harness「创造模式」允许在运行期用 `ctx.agentPresets.copy()` 把副本写到
  `$DSH_HOME/.agent-presets/<id>/` 进行实验；那只是**草稿区**。落到 dsh-gui
  交付时，必须把最终文件搬进 `presets/<id>/` 源目录并配 `install.mjs` 重新安装，
  而不是把 `.dsh` 里的副本当作源。

## 1. deepseek-harness 的「创造模式」是什么

「创造模式」是随 harness 发布的 `cordis` preset：

- 位置：[`apps/cli/config/agent-presets/cordis/`](../../../deepseek-harness/apps/cli/config/agent-presets/cordis)
- 元数据 [`preset.yml`](../../../deepseek-harness/apps/cli/config/agent-presets/cordis/preset.yml)：

  > 用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。

它的组成 = `standard` 全部能力 + 自指 Cordis 工具集 + 两个随包技能 + 一段专门
persona。persona 的说明是创作 preset 的起点：

1. **Harness 的一切能力都是 Cordis 插件行**，`agent.cordis.yml` 就是一个 agent
   单会话的插件组装文件。
2. **先分两个平面**：
   - HOST（宿主组合）：注册表本身、跨会话共享设施、持久化、sandbox/审批栈、
     模型路由、subagent 注册表与后端。进程级单例，**不放 preset**。
   - AGENT PRESET：一个会话贡献给这些注册表的东西——工具、persona、prompt
     段落、compaction 策略。per-session，放 preset。
3. **复制优先，永不改随部署发布的 preset**。要改 `standard`/`minimal`/`cordis` 等，
   先复制成新 preset 再改副本。直接编辑
   `apps/cli/config/agent-presets/` 会被升级覆盖，破坏 `cordis` 会让创造模式
   本身失效。
4. **动组合前加载 `editing-cordis-compositions` skill**。
5. 发布一个服务的行必须包在带 `isolate` realm 的 group 里，否则 preset 挂载
   会被拒绝（见 3.3）。

创造模式随带的两个技能是权威指导，编写任何 preset 前先读：

- [`skills/editing-cordis-compositions/SKILL.md`](../../../deepseek-harness/apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md)
  —— 组合编辑、平面判断、realm 规则、`standingKeyFor` 挂载校验。
- [`skills/cordis-plugin-development/SKILL.md`](../../../deepseek-harness/apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md)
  —— 在创造模式里临时探测/实验插件时的动态 Cordis 开发方法。

## 2. dsh-gui 工程特有的 preset 目录结构与安装方式

真源（先读）：

- 根目录 [`presets/README.md`](../../../presets/README.md) —— dsh-gui preset 源目录约定。
- [`scripts/dsh-gui.mjs`](../../../scripts/dsh-gui.mjs) —— `installPresets()` 的发现与执行逻辑。
- 内嵌示例：[`presets/review/`](../../../presets/review)
- submodule 示例：[`presets/anchored-standard/`](../../../presets/anchored-standard)

### 2.1 目录结构

```text
presets/
├─ README.md
├─ <id>/                            # 目录名 = preset id = .agent-presets/<id>
│  ├─ install.mjs                   # 本 preset 自己的安装脚本（必需）
│  ├─ agent.cordis.yml              # 内嵌源形态：组合文件
│  ├─ preset.yml                    # 内嵌源形态：显示元数据（可选）
│  └─ <repo>/                       # 外置源形态：git submodule
│     └─ preset/
│        ├─ agent.cordis.yml
│        ├─ preset.yml
│        └─ ./local-plugin.mjs ...  # 组合里以相对路径引用的本地文件
└─ ...
```

当前实例：

| 目录 | 来源形态 | 安装脚本做什么 |
|---|---|---|
| `presets/review` | 内嵌源 | 逐文件覆盖复制到 `.dsh/.agent-presets/review/` |
| `presets/anchored-standard` | git submodule（`dsh-anchored-standard`） | 整目录 `preset/` 复制到 `.dsh/.agent-presets/anchored-standard/` |

两种来源与 `plugins/` 同构：

- **内嵌源**：组合、元数据直接随 dsh-gui 仓库版本管理。
- **外置源**：第三方/独立维护的 preset 以 git submodule 引入并 pin 到具体
  commit；更新先审阅上游再 `git submodule update --remote presets/<id>/<repo>`。

### 2.2 安装脚本模式

`npm run build` / `npm run setup` 在装完插件后，扫描所有 `presets/*/install.mjs`
按目录名排序逐个执行，并传 `DSH_HOME=<repo>/.dsh`。新增 preset = 新增目录 +
`install.mjs`，**不需要改任何 npm script**。注意：`npm run install:plugins`
只装插件，不会跑 preset 安装。

内嵌源最小模板（复制 `presets/review/install.mjs` 改 id 和文件列表即可）：

```js
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PRESET_ID = 'my-preset'
const FILES = ['agent.cordis.yml', 'preset.yml']

const dshHome = process.env.DSH_HOME ?? join(ROOT, '.dsh')
const target = join(dshHome, '.agent-presets', PRESET_ID)

mkdirSync(target, { recursive: true })
for (const file of FILES) {
  copyFileSync(join(HERE, file), join(target, file))
}
console.log(`installed agent preset '${PRESET_ID}' -> ${target}`)
```

外置源模板（复制 `presets/anchored-standard/install.mjs` 改 `SOURCE` 与
`PRESET_ID`）：**整目录复制**，因为 `agent.cordis.yml` 里的相对路径
（如 `name: ./tool-bootstrap.mjs`）相对 preset 安装目录解析，逐文件复制会丢
本地插件/技能/资源。实现上先 `rmSync(target)` 再 `cpSync(SOURCE, target)`
保证幂等且不会残留旧文件。

安装约定：

- **目录名 = preset id**，合法形式 `[a-z0-9][a-z0-9-]*`；改名目录等于改名 preset。
- **安装脚本必须幂等**，重复执行结果一致。
- **只写 `$DSH_HOME`**，缺省 `<repo>/.dsh`，不碰系统全局位置。
- 运行期 roster 每次读目录，新文件无需重启即可出现在列表；但已运行的会话
  不会自动切换 preset。
- `.dsh/.agent-presets/` 是安装产物，只读不提交、不手改；调试时看它，
  修复永远回到 `presets/<id>/`。

安装成功会输出：

```text
==> Install agent presets into the harness home
--- E:\Git\dsh-gui\presets\my-preset\install.mjs
installed agent preset 'my-preset' -> E:\Git\dsh-gui\.dsh\.agent-presets\my-preset
```

## 3. 编写 agent.cordis.yml 的技术要点

### 3.1 preset 的最小形态

一个 preset 是一个目录：

- `agent.cordis.yml`（必需）：**顶层就是一个 YAML 插件行列表**。不能带兄弟
  键，所以显示元数据必须放独立文件。
- `preset.yml`（可选，但交付 preset 时应写）：只承载显示文本，示例：

```yaml
name: 我的预设
description: 这个 preset 做什么、与 standard 的差异是什么。
```

`id` 永远等于目录名，`trust` 由发现根决定（dsh-gui 安装的 user root 即
`.dsh/.agent-presets`），这两个字段不能也不要在 `preset.yml` 里写。

### 3.2 先判断行属于哪个平面

| 问题 | 答案 |
|---|---|
| 注册表本身（`tools`/`systemPrompt`/`agents`/`agent-loop`/`sessions`） | HOST，不进 preset |
| 跨会话设施（persistence、session query、storage、settings、credentials、telemetry） | HOST |
| sandbox、审批、权限栈，模型路由，subagent 注册表及 spawn/fork 后端 | HOST |
| 本会话可见的工具行（如 `tool-bash`、`tool-fs`、`tool-web`） | preset |
| 本会话 persona、prompt 段落、compaction 策略 | preset |
| 一个服务在 agent 平面之外还有消费者（如 `subagents` 被 api-proxy 查询） | 该服务留在 HOST；preset 只贡献消费它的工具 |

经验判据：**一个行发布服务吗？** 发布服务的行不能在 preset 里裸放；只消费
宿主服务的工具行可以裸放。用 `cordis_inspect what:"services"` 或挂载报错来
确认，而不是猜包名。

### 3.3 isolate realm 规则（最容易踩的坑）

preset 里凡是要发布服务的行，必须和所有消费它的行一起放进一个
`cordis:group`，并带 `isolate` realm。裸放会把服务注册到进程全局：第二个
会话挂载同一 preset 时冲突，`dsh-agent-presets` 直接拒绝挂载。

`isolate: true` 表示该 entry 的私有 realm：在 standing-mount 模型下就是“这个
preset 自己的实例”，与全局和其他 preset 隔开。字符串 label 只是共享 realm
标识，**不会池化实例**，第二次注册同名服务仍会抛错——preset 需要的是 `true`。

来自随包 `standard` 的范例（workflow 服务由 preset 拥有，provider 与消费工具
同一 group）：

```yaml
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      config:
        provider: spawn

    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'
```

反例：把 `tool-workflow` 放在 group 外，它会解析到宿主未填充的注册表并永远
不激活；把宿主能力（`tool-bash`、`tool-jobs`、`tool-goal` 这类只消费不发布的
行）错误包进 realm，也会让它们解析不到宿主服务。

### 3.4 官方 minimal 范例（复制起点）

随包 [`minimal` preset](../../../deepseek-harness/apps/cli/config/agent-presets/minimal/agent.cordis.yml)
是最小的可运行 preset。其核心是 persona + 一个私有 PTY realm + 一个私有
filesystem realm：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false

- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'

    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config:
        timeoutMs: 300000

    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      config:
        timeoutMs: 300000

- id: filesystem
  name: cordis:group
  group: true
  isolate:
    fs: true
  config:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
      config:
        cwd: !!js process.env.DSH_CWD ?? process.cwd()

    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
```

`persistent-shell` 和 `filesystem` 都发布了 agent 自有服务，因此各带
`isolate: true`；persona 不发布服务，可以裸放。

### 3.5 包名与相对路径如何解析

- 行里的**包名**（`@deepseek-ai/dsh-*`）从宿主组合的模块环境解析，不从
  preset 目录解析。所以本地 preset 放在 `$DSH_HOME` 下也能 import harness 包。
- 行里的**相对路径**（`./tool-bootstrap.mjs`）从 preset 自己的目录解析。
  这就是 dsh-gui 外置源安装脚本必须整目录复制的原因。
- 绝对路径保持原位置，挂载时会转成 `file:` URL。

### 3.6 复制优先与校验

在 dsh/harness 运行期（创造模式）创作时：

1. `ctx.agentPresets.copy(from, id, name?)` 是唯一创作写入：整目录复制、校验
   id、拒绝已占用 id、拒绝覆盖随包 preset、失败回滚、重写副本 `preset.yml`
   （保留 description，去掉来源 name/order）。首选从 `standard` 复制。
2. 复制之后再用文件工具编辑副本时，默认 `workspace-write` sandbox 会拒绝写
   preset 根（会话工作区外）：重试一次并申请 sandbox 升级，且把多次写入合并
   成一次 heredoc，避免反复升级。
3. 最终校验用 `ctx.agentPresets.standingKeyFor(id)`：它真实挂载一次 preset
   子树（不启动 agent），能拒绝包解析失败、配置非法、行未激活、服务裸进全局
   realm 四类错误。roster 的 `broken` 只是“文件能否解析”的形状检查，不能替代
   挂载校验。
4. 校验通过后请用户开一个新会话确认实际工具表。

在 dsh-gui 仓库里，上述“副本”对应 `presets/<id>/` 源目录：可以直接编辑源文件
（它们本就是版本化源），然后跑 `npm run build` 安装，再开新会话确认。不要把
`ctx.agentPresets.copy()` 产生的 `.dsh` 副本当交付。

### 3.7 不要放进 preset 的东西

- `agent-loop`：宿主注册唯一 agent factory，第二个会抛错。
- 注册表自身（tools/systemPrompt/agents/sessions）：不能 per-session。
- session persistence：必须留宿主，否则会话列表碎片化。
- sandbox/审批/权限边界：preset 的权限恰好等于它引用的插件；让 preset 自行
  放宽隔离等于解除隔离。

## 4. dsh-gui 内新增一个 preset 的完整流程

1. **确认设计**：读 3.2 判断平面；能用 `standard`/`minimal` 复制的就复制。
2. **先实验**（可选）：用创造模式 `copy()` 生成运行时草稿，改到
   `standingKeyFor(id)` 通过。
3. **落到源目录**：把最终 `agent.cordis.yml`、`preset.yml`、相对路径引用的
   本地插件/资源放进 `presets/<id>/`；外置源加 submodule。
4. **写 `install.mjs`**：内嵌源照 `presets/review/install.mjs`，外置源照
   `presets/anchored-standard/install.mjs`；保持幂等、只写 `$DSH_HOME`。
5. **构建安装**：`npm run build -- --skip-harness --skip-exe`（首次没构建过
   harness 则 `npm run setup`），确认输出 `installed agent preset '<id>'`。
6. **验证**：重启/新开会话选新 preset，确认工具表与 persona；有条件的在
   创造模式里用 `standingKeyFor` 做最终挂载校验。
7. **文档与提交**：更新 `presets/README.md` 的现有 preset 表；外置源提交
   submodule 指针；Conventional Commits；不提交 `.dsh/`。

## 5. 参考地图

**dsh-gui 侧**

- [`presets/README.md`](../../../presets/README.md) —— dsh-gui preset 源目录与安装约定。
- [`presets/review/`](../../../presets/review) —— 内嵌源 + 逐文件安装范例。
- [`presets/anchored-standard/`](../../../presets/anchored-standard) —— 外置 submodule + 整目录安装范例。
- [`scripts/dsh-gui.mjs`](../../../scripts/dsh-gui.mjs) —— 构建时安装 preset 的入口。
- [`.agents/skills/dsh-gui-plugin-dev/SKILL.md`](../../../.agents/skills/dsh-gui-plugin-dev/SKILL.md) —— 插件开发 skill；preset 常引用插件行。

**deepseek-harness 侧**

- [`apps/cli/config/agent-presets/`](../../../deepseek-harness/apps/cli/config/agent-presets) —— 随包 `standard`/`code`/`minimal`/`cordis` 全部真源与注释。
- [`packages/preset/agent-presets/README.md`](../../../deepseek-harness/packages/preset/agent-presets/README.md) —— preset 发现、挂载、copy、realm 拒绝、路径解析、元数据完整契约。
- [`packages/preset/README.md`](../../../deepseek-harness/packages/preset/README.md) —— preset 包族与宿主/agent 平面总览。
- [`apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md`](../../../deepseek-harness/apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md) —— 创造模式组合编辑权威 skill。
- [`apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md`](../../../deepseek-harness/apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md) —— 创造模式动态插件实验权威 skill。
- [`docs/cordis-primer.md`](../../../deepseek-harness/docs/cordis-primer.md) —— Cordis 插件/服务/事件/realm 基础。
