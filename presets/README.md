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

1. **源即目录**：`presets/<id>/` 持有该预设的安装脚本与源。源有两种形态：
   - **内嵌源**（如 `review`）：组合与元数据直接存放在 `presets/<id>/`
     下，随 dsh-gui 仓库版本管理；
   - **外置源**（如 `anchored-standard`）：组合与元数据在第三方仓库里，
     该仓库以 git submodule 形式 clone 在 `presets/<id>/` 下
     （如 `dsh-anchored-standard/`），更新走
     `git submodule update --remote`，dsh-gui 只跟踪 submodule 指针。
2. **自备安装脚本**：每个预设目录携带自己的 `install.mjs`，负责把源文件
   复制进 harness home（`.dsh/.agent-presets/<id>/`，幂等覆盖）。安装方式
   归预设自己所有——内嵌源逐文件复制，外置源从 submodule 检出目录整目录
   复制（组合里的 `./tool-bootstrap.mjs` 相对路径要求整目录落地）——将来
   某个预设需要生成文件、合并补丁或做校验，只改它自己的脚本即可，不必动
   共享工具链。例如 `anchored-standard` 在整目录复制后还会做两个幂等的
   落地补丁：检测 Windows 与 `rg`，把对应的最小提示注入第二轮
   `instruction-hint` 消息；并把晋升后的 resident 目录中的 shell 换成
   standard 模式的平台 shell（Windows 用 `pwsh`，其他平台用 `bash`）。
3. **构建统一安装**：`npm run build`（以及 `npm run setup`）在安装完插件后
   扫描 `presets/*/install.mjs`，按目录名排序逐个执行
   （`scripts/dsh-gui.mjs` 的 `installPresets()`）。新增预设 = 新增一个
   目录 + 安装脚本，构建自动带上它，无需改任何 npm script。

```
presets/
├─ README.md                       # 本说明
├─ review/                         # 内嵌源：审阅型编码 Agent
│  ├─ agent.cordis.yml             #   组合（persona 为 review 系统提示词）
│  ├─ preset.yml                   #   显示元数据（name: 审阅模式）
│  └─ install.mjs                  #   逐文件复制到 .dsh/.agent-presets/review/
└─ anchored-standard/              # 外置源：两阶段锚定标准模式（实验）
   ├─ install.mjs                  #   整目录复制 + Windows/rg 环境提示与晋升 shell 补丁
   └─ dsh-anchored-standard/       #   git submodule（xiaobright/dsh-anchored-standard）
      └─ preset/                   #   agent.cordis.yml + preset.yml + tool-bootstrap.mjs
```

## 约定

- **目录名 = preset id**，即运行期 roster 里的 id，也必须是合法路径段
  （小写字母/数字/连字符）。改名目录 = 改名预设，旧 id 会从 roster 消失。
- **安装脚本必须幂等**：重复执行结果一致（当前实现为覆盖复制 + 幂等落地补丁）。
- **安装脚本必须仓库内自托管**：只写 `$DSH_HOME`（构建时传入、缺省为
  `<repo>/.dsh`），不碰系统全局位置。
- 预设源文件本身**必须保持直接可挂载**：源（内嵌文件或 submodule 检出）里的
  `agent.cordis.yml` 不依赖安装脚本的运行时变换即可工作；安装脚本可以在落地后
  追加幂等的落地补丁（如 `anchored-standard` 注入 Windows/rg 提示与晋升 shell），但源
  脱离补丁仍应可挂载。
- **外置源走 submodule**：第三方维护的预设以 git submodule 引入并 pin 到
  具体 commit；更新先审阅上游变更再
  `git submodule update --remote presets/<id>/<repo>`。
  其中 `anchored-standard/install.mjs` 对上游源有 install-time patch，更新
  `dsh-anchored-standard` 时必须同步更新该 patch 脚本。

## 新增一个预设

```powershell
New-Item -ItemType Directory presets\my-agent
# 1. 编写 presets\my-agent\agent.cordis.yml（组合）与 preset.yml（可选元数据）
# 2. 复制 presets\review\install.mjs，把 PRESET_ID 改成 my-agent
#    外置源：clone/submodule 上游仓库到 presets\my-agent\ 下，
#    复制 presets\anchored-standard\install.mjs 并改 SOURCE/PRESET_ID
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

| id | 名称 | 说明 |
| --- | --- | --- |
| `review` | 审阅模式 | 审查型编码 Agent：参照 opencode 的 review 系统提示词，先注入审查提示词再接收用户请求，并用用户所用的语言回复 |
| `anchored-standard` | Anchored Standard (experimental) | 两阶段预设：首次请求仅 `bash`/`str_replace_editor`（Minimal 对齐 prompt），首个持久 `tool/call` 或 `assistant/message` 后开放 minimal resident 工具集（standard 模式平台 shell + 发现工具），Windows 晋升后从 `custom-bash` 切换为 `pwsh`，其余经 `dev_tool_search` 按需解锁；安装脚本会注入 Windows/rg 第二轮提示与晋升 shell；源来自 submodule [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) |
