---
name: dsh-gui-preset-dev
description: 'Use when creating, changing, installing, or reviewing an agent preset in the dsh-gui repo, when writing a `presets/<id>/install.mjs`, when deciding between the versioned `presets/` source tree and the runtime profile patch layer, or when authoring or validating an `@deepseek-ai/dsh-agent-preset` declaration. Covers dsh-gui preset layout and install flow, then routes composition authoring to the deepseek-harness Creator mode, shipped preset declarations, and reference docs.'
whenToUse: 在 dsh-gui 仓库 `presets/` 下创建、修改、安装、审查 agent preset，写 `presets/<id>/install.mjs`，在版本化 `presets/` 源目录与运行期 profile patch 层之间取舍，或编写/校验 `@deepseek-ai/dsh-agent-preset` 声明时使用。组合写法问题交给 deepseek-harness 创造模式、随包 preset 声明与参考文档。
---

# dsh-gui preset 开发

本 skill 负责 dsh-gui 里的 agent preset（`presets/<id>/` + `install.mjs`）。
preset 声明里每行插件怎么写、哪些服务能进 preset，以 deepseek-harness 的「创造模式」
指导和官方 preset 契约文档为准；本 skill 把这些说明与范例汇总，并补上 dsh-gui
自己的交付规则。

## 0. 首要规则：源目录 + 安装脚本，不要直接写 profile patch

> **dsh-gui 的 preset 交付形态是版本化的 `presets/<id>/` 源目录，由该目录自带的
> `install.mjs` 把声明写入当前 profile 的 patch 层。不要把 `.dsh` 当创作目录，
> 不要直接编写并添加到 `.dsh` 里。**

- `.dsh/` 是 gitignored 运行期状态：换机器、重装或 `git clean` 都会丢。preset
  的持久事实必须留在 `presets/<id>/`。
- 安装脚本只写 `$DSH_HOME`（dsh-gui 构建固定传 `<runtime-root>/.dsh`），不写全局位置。
- 自 harness `dsh-v0.1.7-rc.2` 起 preset 是**声明式**的：注册表不扫描目录，也不接受
  preset 路径，一条 `@deepseek-ai/dsh-agent-preset` 行就是全部
  （[`packages/preset/agent-preset-registry/README.md`](../../../deepseek-harness/packages/preset/agent-preset-registry/README.md)）。
- 与插件 skill 相同：所有 preset 源码、配置、依赖自托管，不修改
  deepseek-harness 本体，不修改宿主组合来绕过 preset 限制。
- **不要覆盖随包声明行**（行 id 形如 `preset-standard`）。需要派生就整体复制
  它的 `config.plugins` 再改，自己的预设用不同的行 id 与 `config.id`。

## 1. deepseek-harness 的「创造模式」是什么

「创造模式」是随 `@deepseek-ai/dsh-web-app` bundle 发布的 `cordis` preset 声明：

- 声明真源：[`packages/bundle/web-app/presets/cordis.patch.yml`](../../../deepseek-harness/packages/bundle/web-app/presets/cordis.patch.yml) —— 一条 `insert` 行，行 id `preset-cordis`，`config.id` 为 `cordis`。
- 声明的字段契约（`id`、`plugins`、`name`、`description`、`order`）见
  [`packages/preset/agent-preset/README.md`](../../../deepseek-harness/packages/preset/agent-preset/README.md)。

它的组成 = `standard` 的全部能力 + 运行时检查与插件管理工具（`tool-cordis`、
`tool-plugin-manager`）+ 随包技能 + 与 `standard` 相同的 persona。persona 与技能
承载的创作规则是编写 preset 的起点：

1. **Harness 的一切能力都是 Cordis 插件行**，一条 preset 声明的 `config.plugins`
   就是一个 agent 单会话的插件组装列表。
2. **先分两个平面**：
   - HOST（宿主组合）：注册表本身、跨会话共享设施、持久化、sandbox/审批栈、
     模型路由、subagent 注册表与后端。进程级单例，**不放 preset**。
   - AGENT PRESET：一个会话贡献给这些注册表的东西——工具、persona、prompt
     段落、compaction 策略。per-session，放 preset。
3. **复制优先，永不改随部署发布的声明**。要改 `standard`/`minimal`/`cordis` 等，
   先复制 `config.plugins` 成新声明再改。直接编辑
   `packages/bundle/web-app/presets/` 会被升级覆盖，破坏 `cordis` 会让创造模式
   本身失效。
4. **动组合前加载 `editing-cordis-compositions` skill**。
5. 发布一个服务的行必须和消费它的行一起放进带 `isolate` realm 的 group 里，否则
   preset 挂载会被拒绝（见 3.3）。

创造模式随带的三个技能是权威指导，编写任何 preset 前先读：

- [`skills/editing-cordis-compositions/SKILL.md`](../../../deepseek-harness/packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md)
  —— 组合编辑、平面判断、realm 规则与挂载校验。
- [`skills/cordis-composition-reference/SKILL.md`](../../../deepseek-harness/packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md)
  —— Loader YAML 方言（`insert`、按 id 覆盖、`group`、`disabled`、`isolate`、`!!js`）与可安装包清单。
- [`skills/cordis-plugin-development/SKILL.md`](../../../deepseek-harness/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md)
  —— 在创造模式里临时探测/实验插件时的动态 Cordis 开发方法。

## 2. dsh-gui 工程特有的 preset 目录结构与安装方式

真源（先读）：

- 根目录 [`presets/README.md`](../../../presets/README.md) —— 声明式 preset 的源目录约定、落地目标与现有预设清单。
- [`scripts/dsh-gui.mjs`](../../../scripts/dsh-gui.mjs) —— `installPresets()` 的发现与执行逻辑。
- 当前仓库没有 `presets/<id>/` 实例（`presets/` 下只剩 `README.md`），也没有派生预设的脚本；Agent Teams 与 Auto review 是插件页开关管理的官方可选 bundle，不产生 preset 声明。

### 2.1 目录结构

```text
presets/
├─ README.md
├─ <id>/                            # 目录名建议与 config.id 一致
│  ├─ install.mjs                   # 必需：把声明写进当前 profile 的 patch 层
│  └─ <repo>/                       # 外置源形态：git submodule
└─ ...
```

当前实例：**没有**。`presets/` 下只有 `README.md`；新增预设时建目录 + 安装
脚本即可，`scripts/dsh-gui.mjs` 会自动发现。

两种来源与 `plugins/` 同构：

- **内嵌源**：声明与安装脚本 `presets/<id>/install.mjs` 同在源目录下，随
  dsh-gui 仓库版本管理。
- **外置源**：声明在第三方仓库里，该仓库以 git submodule 形式 clone 在
  `presets/<id>/` 下；更新先审阅上游变更，再
  `git submodule update --remote presets/<id>/<repo>`，dsh-gui 只跟踪 submodule
  指针。外置源的安装脚本若对上游源做 install-time 改写，更新 submodule 时必须
  同步更新该脚本。

### 2.2 安装脚本模式

`npm run build` / `npm run setup` 在装完插件后，扫描所有 `presets/*/install.mjs`
按目录名排序逐个执行，并传 `DSH_HOME=<runtime-root>/.dsh`。新增预设 = 新增目录 +
`install.mjs`，**不需要改任何 npm script**。注意：`npm run install:plugins`
只装插件，不会跑 preset 安装。

安装脚本做一件事：向当前 profile 的 patch 层
（`$DSH_HOME/profiles/web/cordis.patch.yml`）写一条 `insert` 行。声明形状：

```yaml
- insert:
    - id: preset-my-agent          # Loader 编辑地址（行 id），不要与随包 `preset-*` 相同
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: my-agent               # 会话保存的 preset 标识符，[a-z0-9][a-z0-9-]*
        name: 我的模式              # 可选，展示名称
        order: 101                 # 可选，列表排序
        plugins:                   # 该 agent 挂载的子插件行
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: 你是一个…
```

profile patch 在每一层 bundle 之后应用，因此写进它的声明永远排在随包声明之后，
按行 id 覆盖随包行也在这里生效。

幂等靠**标记块整体替换**：脚本只重写自己标记包围的那段文本，保留同一文件里的
其他内容，因此重复执行结果一致。

安装约定：

- **`config.id` 即预设 id**，即运行期 roster 里的 id；目录名与它一致最省心，
  改名即改 id，旧 id 会从 roster 消失。
- **安装脚本必须幂等**：重复执行结果一致；重复的 preset id 会让声明加载失败，
  因此禁止追加重复行。
- **只写 `$DSH_HOME`**，缺省 `<runtime-root>/.dsh`，不碰系统全局位置。
- **不覆盖随包声明行**：随包行 id 形如 `preset-standard`，由官方 bundle 提供；
  需要派生就整体复制 `config.plugins` 再改。
- 声明在启动时激活，挂载失败在选择之前就出现在 roster 里；已运行的会话不会自动
  切换到新声明。
- `.dsh/` 是安装产物，只读不提交、不手改；调试时看它，修复永远回到 `presets/<id>/`。

安装成功会输出：

```text
==> Install agent presets into the harness home
--- E:\Git\dsh-gui\presets\my-agent\install.mjs
```

### 2.3 用户级 skill：走 global_template.agents（与 preset 区分）

preset 决定「一个 agent 有什么能力」，用户级 skill 决定「任意 agent 能按需加载
哪些指令」。二者交付位置不同，不要混：

| | preset | 用户级 skill |
|---|---|---|
| 仓库源 | `presets/<id>/` | `global_template.agents/skills/<name>/SKILL.md` |
| 安装目标 | profile patch 里的 preset 声明行（`$DSH_HOME/profiles/web/cordis.patch.yml`） | `.dsh/.agents/skills/<name>/` |
| 安装者 | `presets/<id>/install.mjs`（每个 preset 自带） | `scripts/dsh-gui.mjs` 的 `installGlobalTemplate()`（`setup` / `build` 都跑） |

- `global_template.agents/` 是整份 agent 配置模板（`docs/` 常驻文档 +
  `skills/` 用户级 skill），构建时把其中**缺失**的文件装到
  `$DSH_HOME/.agents/`。已存在的文件不覆盖，用户对已安装文档/skill 的修改
  因此能跨构建保留；要改内容就改 `global_template.agents/` 下的源文件，
  但已存在的安装副本需要用户自行删掉或同步。
- harness 只有在 `DSH_AGENTS_HOME` 指向该目录时才把它当 agents home 扫描：
  外壳 `src-tauri/src/main.rs` 启动 harness 时已 pin
  `DSH_AGENTS_HOME=<runtime-root>/.dsh/.agents`（`skill-filesystem` 的 `agentsHome`
  缺省是 `$DSH_AGENTS_HOME` 或 `~/.agents`）。
- skill 因此以 source `user-agents`（rank 500）被发现，对所有 workspace 生效；
  skill 的 frontmatter（`name`/`description`/`whenToUse`/`user-invocable`）与
  写作规范见 [`packages/skill/skill-filesystem/README.md`](../../../deepseek-harness/packages/skill/skill-filesystem/README.md)。

## 3. 编写 preset 声明的技术要点

### 3.1 preset 的最小形态

一条 preset 就是一条 `@deepseek-ai/dsh-agent-preset` 行，没有独立文件：

- `config.plugins` 是该 agent 挂载的子插件行列表，**顶层不能带兄弟键**；显示
  元数据与排序都在 `config` 里。
- 行 `id` 是 Loader 编辑地址，`config.id` 是会话保存的 preset 标识符，两者不要
  混用；子插件行可以省略行 id，由 Loader 分配。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `id` | 必填 | 稳定的 preset 标识符 |
| `plugins` | 必填 | 子插件行列表 |
| `name` | 未设置 | 展示名称 |
| `description` | 未设置 | 展示说明 |
| `order` | 未设置 | 列表排序 |

字段契约见 [`packages/preset/agent-preset/README.md`](../../../deepseek-harness/packages/preset/agent-preset/README.md)。

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
宿主服务的工具行可以裸放。用 `cordis_inspect_list` 加 `cordis_inspect_query` 的
`Service` 查询、或挂载报错来确认，而不是猜包名。

### 3.3 isolate realm 规则（最容易踩的坑）

preset 里凡是要发布服务的行，必须和所有消费它的行一起放进一个
`cordis:group`，并带 `isolate`。裸放会把服务注册到进程全局：第二个会话挂载同一
preset 时冲突，`@deepseek-ai/dsh-agent-preset-registry` 直接拒绝挂载。

`isolate` 把服务名映射到 `true` 或 realm label：`true` 是该 entry 的私有 realm，
在 standing-mount 模型下就是「这个 preset 自己的实例」，与全局和其他 preset 隔开。
字符串 label 只是共享 realm 标识，**不会池化实例**，第二次注册同名服务仍会抛错
——preset 需要的是把该服务映射到 `true`。

来自随包
[`standard` 声明](../../../deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml)
的范例（workflow 服务由 preset 拥有，provider 与消费工具同一 group）：

```yaml
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: workflow-ptc
      name: '@deepseek-ai/dsh-workflow-ptc'
      config:
        provider: spawn

    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'
```

反例：把 `tool-workflow` 放在 group 外，它会解析到宿主未填充的注册表并永远
不激活；把宿主能力（`tool-bash`、`tool-jobs`、`tool-goal` 这类只消费不发布的
行）错误包进 realm，也会让它们解析不到宿主服务。

### 3.4 官方 minimal 范例（复制起点）

随包 [`minimal` 声明](../../../deepseek-harness/packages/bundle/web-app/presets/minimal.patch.yml)
是最小的可运行 preset。其核心是 persona + 一个私有 PTY realm：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful software engineer assistant.
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
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 300000

    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 300000
```

`persistent-shell` 发布了 agent 自有服务，因此带 `isolate: { terminals: true }`；
persona 不发布服务，可以裸放。Windows 上同一 group 里另有 `terminal-pwsh` 与
`persistent-pwsh` 两行顶替上述 bash 行（`shellDialect: pwsh`）。

### 3.5 包名与路径如何解析

- 行里的**包名**（`@deepseek-ai/dsh-*`）从宿主组合的模块环境解析，不从
  `presets/` 源目录解析，所以 preset 声明可以引用 harness 包与已安装的插件包。
- **插入行的相对路径锚定在 patch 文件所在目录**：`insert` 里的 `./x.mjs` 与
  `../x.mjs` 会被解析成相对 patch 文件目录的 `file:` URL，绝对路径原样转换
  （[`packages/boot/app-boot/tests/user-patches.spec.ts`](../../../deepseek-harness/packages/boot/app-boot/tests/user-patches.spec.ts)）。
  声明写进 `$DSH_HOME/profiles/web/cordis.patch.yml` 后，相对路径的立足点是
  **profile 目录**，不是 `presets/<id>/`——`presets/` 源目录里的相对路径不会
  自动生效。
- 按 id 覆盖既有行时，`name` 不做锚定、保持字面值。
- 需要随 preset 分发的本地脚本或资源，由安装脚本落到 profile 目录（或其他可解析
  位置），或在行内用 `!!js` 求值出绝对路径：随包 `cordis` 声明就用 `!!js` 从
  `@deepseek-ai/dsh-agent-preset/package.json` 解出自己的 `skills/` 目录。

### 3.6 复制优先与校验

1. **复制优先**：从随包声明复制 `config.plugins` 再改，不要覆盖随包行。源可以是
   子模块里的 `packages/bundle/web-app/presets/standard.patch.yml`，也可以是安装后的
   `<DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`。
2. **新建或覆盖都是 patch 层操作**：插入一行 `@deepseek-ai/dsh-agent-preset`，或按
   该行的 id 写覆盖。profile patch 在每一层 bundle 之后应用，因此 profile patch
   里的同 id 覆盖生效；`plugin_manager` 在被更高优先级层覆盖时回答 `overridden`。
3. **校验靠挂载审计**：注册表在挂载时审计导入失败、缺失服务与泄漏到全局的服务，
   任一类都会拒绝挂载；挂载失败对该声明是终局，只禁用它的新绑定，已有 Agent 保留
   它们已经使用的组合
   （[`packages/preset/agent-preset-registry/README.md`](../../../deepseek-harness/packages/preset/agent-preset-registry/README.md)）。
4. **在 dsh-gui 里的校验顺序**：写 `install.mjs` → 构建安装 → 重启 dsh-gui →
   新开会话选该 preset，确认工具表与 persona。声明在启动时激活，挂载失败在选择
   之前就出现在 roster 里，据此回改 `config.plugins`。
5. Web 端的 preset 页面只读（`View configuration` 把声明渲染成 YAML，失败时定位到
   出错行），创作走创造模式：它在对话里编写 bundle 并用 `plugin_manager` 安装
   （[`packages/client/ui-agent-preset/README.md`](../../../deepseek-harness/packages/client/ui-agent-preset/README.md)）。
   在创造模式里得到的最终 `config.plugins` 要抄回 `presets/<id>/install.mjs`。

### 3.7 不要放进 preset 的东西

- `agent-loop`：宿主注册唯一 agent factory，第二个会抛错。
- 注册表自身（tools/systemPrompt/agents/sessions）：不能 per-session。
- session persistence：必须留宿主，否则会话列表碎片化。
- sandbox/审批/权限边界：preset 的权限恰好等于它引用的插件；让 preset 自行
  放宽隔离等于解除隔离。

## 4. dsh-gui 内新增一个 preset 的完整流程

1. **确认设计**：读 3.2 判断平面；能从 `standard`/`minimal` 复制 `config.plugins`
   的就复制。
2. **落到源目录**：建 `presets/<id>/`，外置源加 submodule；把声明内容与安装脚本
   放进去。
3. **写 `install.mjs`**：按 2.2 的标记块模式，向
   `$DSH_HOME/profiles/web/cordis.patch.yml` 写入自己的 `insert` 行；保持幂等、
   只写 `$DSH_HOME`、不覆盖随包行。
4. **构建安装**：`npm run build -- --skip-harness --skip-exe`（首次没构建过
   harness 则 `npm run setup`），确认构建输出里出现该 `install.mjs` 的执行日志。
5. **验证**：重启 dsh-gui 后新开会话选新 preset，确认工具表与 persona；挂载失败
   会在选择之前显示在 roster 里。
6. **文档与提交**：更新 `presets/README.md` 的现有预设清单；外置源提交
   submodule 指针；Conventional Commits；不提交 `.dsh/`。

## 5. 参考地图

**dsh-gui 侧**

- [`presets/README.md`](../../../presets/README.md) —— preset 源目录、落地目标与现有预设清单。
- [`scripts/dsh-gui.mjs`](../../../scripts/dsh-gui.mjs) —— 构建时安装 preset 与
  global_template.agents 的入口（`installPresets()` / `installGlobalTemplate()`）。
- [`global_template.agents/`](../../../global_template.agents) —— 用户级 skill 与
  常驻文档的源目录（安装到 `.dsh/.agents/`，见 2.3）。
- [`.agents/skills/dsh-gui-plugin-dev/SKILL.md`](../../../.agents/skills/dsh-gui-plugin-dev/SKILL.md) —— 插件开发 skill；preset 常引用插件行。

**deepseek-harness 侧**

- [`packages/bundle/web-app/presets/`](../../../deepseek-harness/packages/bundle/web-app/presets) —— 随包 `standard`/`ptc`/`minimal`/`cordis` 声明的真源与注释。
- [`packages/preset/agent-preset/README.md`](../../../deepseek-harness/packages/preset/agent-preset/README.md) —— 声明字段与注册接口契约。
- [`packages/preset/agent-preset-registry/README.md`](../../../deepseek-harness/packages/preset/agent-preset-registry/README.md) —— 注册、代际、挂载审计与泄漏拒绝。
- [`packages/preset/README.md`](../../../deepseek-harness/packages/preset/README.md) —— preset 包族与宿主/agent 平面总览。
- [`packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md`](../../../deepseek-harness/packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md) —— 创造模式组合编辑权威 skill。
- [`packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md`](../../../deepseek-harness/packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md) —— Loader YAML 方言与可安装包清单。
- [`packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md`](../../../deepseek-harness/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md) —— 创造模式动态插件实验权威 skill。
- [`docs/cordis-primer.md`](../../../deepseek-harness/docs/cordis-primer.md) —— Cordis 插件/服务/事件/realm 基础。
