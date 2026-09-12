# presets/

Agent preset（代理预设）的**源目录**：以 git 管理、以安装脚本落地的预设仓库。
这是 dsh-gui 的「预设即代码」设计模式，与 `plugins/` 的插件模式对应。

## 设计模式

harness 在运行期从 harness home 的 `.agent-presets/<id>/` 发现预设（见
`deepseek-harness/packages/preset/agent-presets`）：**目录名即 preset id**
（`[a-z0-9][a-z0-9-]*`），目录内是组合文件 `agent.cordis.yml`（必需，Agent
平面组合）和 `preset.yml`（可选，显示元数据 `name` / `description` /
`order`）。但 `.dsh/` 整体 gitignored——它是运行期状态，不应当直接手改，
否则换机器/重装就丢了。

所以本目录把预设做成**可复现的源**：

1. **源即目录**：`presets/` 下除本说明外，每个 `presets/<id>/` 目录即一个
   预设的源，持有该预设的安装脚本与组合。源有两种形态：
   - **内嵌源**：组合 `presets/<id>/agent.cordis.yml`、可选元数据
     `presets/<id>/preset.yml` 与安装脚本 `presets/<id>/install.mjs` 同在
     源目录下，逐文件复制即可落地，随 dsh-gui 仓库版本管理；
   - **外置源**：组合与元数据在第三方仓库里，该仓库以 git submodule 形式
     clone 在 `presets/<id>/` 下，更新走
     `git submodule update --remote`，dsh-gui 只跟踪 submodule 指针。
2. **自备安装脚本**：每个预设目录携带自己的 `install.mjs`，负责把源文件
   复制进 harness home（`.dsh/.agent-presets/<id>/`，幂等覆盖）。安装方式
   归预设自己所有——内嵌源逐文件复制，外置源从 submodule 检出目录整目录
   复制（组合里的 `./tool-bootstrap.mjs` 相对路径要求整目录落地）——将来
   某个预设需要生成文件、合并补丁或做校验，只改它自己的脚本即可，不必动
   共享工具链。
3. **构建统一安装**：`npm run build`（以及 `npm run setup`）在安装完插件后
   扫描 `presets/*/install.mjs`，按目录名排序逐个执行
   （`scripts/dsh-gui.mjs` 的 `installPresets()`）。新增预设 = 新增一个
   目录 + 安装脚本，构建自动带上它，无需改任何 npm script。

## 约定

- **目录名 = preset id**，即运行期 roster 里的 id，也必须是合法路径段
  （小写字母/数字/连字符）。改名目录 = 改名预设，旧 id 会从 roster 消失。
- **安装脚本必须幂等**：重复执行结果一致（覆盖复制与落地补丁都必须可重复执行）。
- **安装脚本必须仓库内自托管**：只写 `$DSH_HOME`（构建时传入、缺省为
  `<repo>/.dsh`），不碰系统全局位置。
- 预设源文件本身**必须保持直接可挂载**：源（内嵌文件或 submodule 检出）里的
  `agent.cordis.yml` 不依赖安装脚本的运行时变换即可工作；安装脚本可以在落地后
  追加幂等的落地补丁，但源脱离补丁仍应可挂载。
- **外置源走 submodule**：第三方维护的预设以 git submodule 引入并 pin 到
  具体 commit；更新先审阅上游变更再
  `git submodule update --remote presets/<id>/<repo>`；外置源安装脚本若对
  上游源做 install-time patch，更新 submodule 时必须同步更新该 patch 脚本。

## 新增一个预设

```powershell
New-Item -ItemType Directory presets\my-agent
# 1. 编写 presets\my-agent\agent.cordis.yml（组合）与 preset.yml（可选元数据）
# 2. 编写 presets\my-agent\install.mjs：内嵌源逐文件复制到
#    .dsh\.agent-presets\my-agent\；外置源先把上游仓库
#    clone/submodule 到 presets\my-agent\ 下，再整目录复制
#    （组合里的相对路径要求整目录落地）
# 3. 重新构建（preset 安装是 build/setup 的一步）
npm run build -- --skip-harness --skip-exe
```

构建输出中会出现：

```
==> Install agent presets into the harness home
--- E:\Git\dsh-gui\presets\my-agent\install.mjs
installed agent preset 'my-agent' -> E:\Git\dsh-gui\.dsh\.agent-presets\my-agent
```

重启 dsh-gui 后新预设出现在 roster 中（预设发现每次读取目录，无需重启
即可看到新文件，但已运行的会话不会自动切换）。

## 现有预设

本仓库当前没有预设实例：`presets/` 下只有本说明，新增按上一节的步骤进行。

预设里若需要面向用户的指令或提示词（例如 `/review`），做成用户级 skill：源文件
放 `global_template.agents/skills/<name>/SKILL.md`，构建安装到 `.dsh/.agents/`
（见 [`AGENTS.md`](../AGENTS.md) 的目录结构一节）。
