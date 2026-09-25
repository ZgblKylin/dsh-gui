# presets/

Agent preset（代理预设）的**源目录**：以 git 管理、以安装脚本落地的预设仓库。
这是 dsh-gui 的「预设即代码」设计模式，与 `plugins/` 的插件模式对应。

## 设计模式

自 harness `dsh-v0.1.7-rc.2` 起，agent preset 是**声明式**的：不再有独立的发现
目录，而是一条 `@deepseek-ai/dsh-agent-preset` 行——

```yaml
- id: preset-my-agent          # Loader 编辑地址（行 id）
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: my-agent               # 会话保存的 preset 标识符
    name: 我的模式              # 可选，展示名称
    order: 101                 # 可选，列表排序
    plugins: [...]             # 该 agent 挂载的子插件行
```

`config.id` 是会话记录的 preset 标识符，`config.plugins` 是这一个 agent 组合的
Cordis 行列表。旧版按 `.dsh/.agent-presets/<id>/`（目录名即 id，外加
`agent.cordis.yml` 与 `preset.yml`）发现预设的方式已随该版本移除；随包预设现在由
`@deepseek-ai/dsh-web-app` bundle 的 `presets/*.patch.yml` 声明（`dsh.bundle.patch`
自该版本起是列表）。

`.dsh/` 整体 gitignored——它是运行期状态，不应当直接手改，否则换机器/重装就丢了。

所以本目录把预设做成**可复现的源**：

1. **源即目录**：`presets/` 下除本说明外，每个 `presets/<id>/` 目录即一个预设的
   源，持有该预设的安装脚本与声明。源有两种形态：
   - **内嵌源**：声明与安装脚本 `presets/<id>/install.mjs` 同在源目录下，随
     dsh-gui 仓库版本管理；
   - **外置源**：声明在第三方仓库里，该仓库以 git submodule 形式 clone 在
     `presets/<id>/` 下，更新走 `git submodule update --remote`，dsh-gui 只跟踪
     submodule 指针。
2. **自备安装脚本**：每个预设目录携带自己的 `install.mjs`，负责把声明落地到
   **当前 profile 的 patch 层**（`$DSH_HOME/profiles/web/cordis.patch.yml`），即写
   一条 `@deepseek-ai/dsh-agent-preset` insert 行。落地目标从旧版的
   `.dsh/.agent-presets/<id>/` 目录变成了 profile patch 里的声明行：profile patch
   在每一层 bundle 之后应用，因此用户预设永远排在随包声明之后。安装方式归预设
   自己所有，将来某个预设需要生成文件、合并补丁或做校验，只改它自己的脚本即可，
   不必动共享工具链。
   参考实现见 [`plugins/harness/agent-team.mjs`](../plugins/harness/agent-team.mjs)
   的 `writeDerivedDeclarations()`：它以标记块（marker block）整体重写自己写入的
   行，保留用户在同一文件里的其他内容。
3. **构建统一安装**：`npm run build`（以及 `npm run setup`）在安装完插件后扫描
   `presets/*/install.mjs`，按目录名排序逐个执行（`scripts/dsh-gui.mjs` 的
   `installPresets()`）。新增预设 = 新增一个目录 + 安装脚本，构建自动带上它，无需
   改任何 npm script。

## 约定

- **`config.id` = preset id**，即运行期 roster 里的 id（`[a-z0-9][a-z0-9-]*`）。
  目录名与它一致最省心；改名即改 id，旧 id 会从 roster 消失。
- **安装脚本必须幂等**：重复执行结果一致。写 profile patch 时以标记块整体替换，
  不要追加重复行——重复的 preset id 会让声明加载失败。
- **安装脚本必须仓库内自托管**：只写 `$DSH_HOME`（构建时传入、缺省为
  `<repo>/.dsh`），不碰系统全局位置。
- **不要覆盖随包声明行**：随包 preset 的行 id 形如 `preset-standard`，由官方 bundle
  提供。自己的预设用不同的行 id 与 `config.id`；需要派生（例如 Team 版）就整体
  复制 `config.plugins` 再改，见 `agent-team.mjs`。
- **外置源走 submodule**：第三方维护的预设以 git submodule 引入并 pin 到具体
  commit；更新先审阅上游变更再
  `git submodule update --remote presets/<id>/<repo>`；外置源安装脚本若对上游源做
  install-time patch，更新 submodule 时必须同步更新该 patch 脚本。

## 新增一个预设

```powershell
New-Item -ItemType Directory presets\my-agent
# 1. 编写 presets\my-agent\install.mjs：向 $DSH_HOME\profiles\web\cordis.patch.yml
#    写入一条 '@deepseek-ai/dsh-agent-preset' insert 行（标记块，幂等替换）；
#    config.plugins 即该 agent 的组合行列表，可从随包声明复制后修改，例如
#      <DSH_HOME>\profiles\node_modules\@deepseek-ai\dsh-web-app\presets\standard.patch.yml
# 2. 重新构建（preset 安装是 build/setup 的一步）
npm run build -- --skip-harness --skip-exe
```

构建输出中会出现：

```
==> Install agent presets into the harness home
--- E:\Git\dsh-gui\presets\my-agent\install.mjs
```

重启 dsh-gui 后新预设出现在 roster 中（preset 定义会提前激活，因此加载失败在选择
之前就能看到）。

## 现有预设

本仓库当前没有预设实例：`presets/` 下只有本说明，新增按上一节的步骤进行。
`plugins/harness/agent-team.mjs` 会自行派生 `standard-team` / `ptc-team` 两条声明
到 profile patch，那属于插件安装的一部分，不走本目录。

预设里若需要面向用户的指令或提示词（例如 `/review`），做成用户级 skill：源文件放
`global_template.agents/skills/<name>/SKILL.md`，构建安装到 `.dsh/.agents/`
（见 [`AGENTS.md`](../AGENTS.md) 的目录结构一节）。
