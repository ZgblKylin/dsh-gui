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

1. **源即目录**：`presets/<id>/` 持有该预设的全部源文件
   （`agent.cordis.yml` + `preset.yml`），随 dsh-gui 仓库一起版本管理。
2. **自备安装脚本**：每个预设目录携带自己的 `install.mjs`，负责把源文件
   复制进 harness home（`.dsh/.agent-presets/<id>/`，幂等覆盖）。安装方式
   归预设自己所有——将来某个预设需要生成文件、合并补丁或做校验，只改它
   自己的脚本即可，不必动共享工具链。
3. **构建统一安装**：`npm run build`（以及 `npm run setup`）在安装完插件后
   扫描 `presets/*/install.mjs`，按目录名排序逐个执行
   （`scripts/dsh-gui.mjs` 的 `installPresets()`）。新增预设 = 新增一个
   目录 + 安装脚本，构建自动带上它，无需改任何 npm script。

```
presets/
├─ README.md            # 本说明
└─ review/
   ├─ agent.cordis.yml  # 组合：审阅型编码 Agent（persona 为 review 系统提示词）
   ├─ preset.yml        # 显示元数据（name: 审阅模式, description）
   └─ install.mjs       # 安装脚本：复制到 .dsh/.agent-presets/review/
```

## 约定

- **目录名 = preset id**，即运行期 roster 里的 id，也必须是合法路径段
  （小写字母/数字/连字符）。改名目录 = 改名预设，旧 id 会从 roster 消失。
- **安装脚本必须幂等**：重复执行结果一致（当前实现为覆盖复制）。
- **安装脚本必须仓库内自托管**：只写 `$DSH_HOME`（构建时传入、缺省为
  `<repo>/.dsh`），不碰系统全局位置。
- 预设源文件本身**不要依赖安装脚本的运行时变换**：`presets/<id>/` 下的
  `agent.cordis.yml` 应当是直接可挂载的组合；安装脚本只负责「落地」。

## 新增一个预设

```powershell
New-Item -ItemType Directory presets\my-agent
# 1. 编写 presets\my-agent\agent.cordis.yml（组合）与 preset.yml（可选元数据）
# 2. 复制 presets\review\install.mjs，把 PRESET_ID 改成 my-agent
# 3. 重新构建（或单独跑 npm run install:plugins 之外的 preset 安装）
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
