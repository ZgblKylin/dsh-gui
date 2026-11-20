# plugins/commandcode-provider

[Mars-Sea/dsh-commandcode-provider](https://github.com/Mars-Sea/dsh-commandcode-provider)
（npm 包名 `@mars-sea/dsh-commandcode-provider`）的 wrapper：DeepSeek Harness
的非官方 **Command Code** LLM provider 插件，注册 `commandcode` provider 路由
（Loader entry `llm-commandcode`），带 Models 页卡片、实时模型目录、套餐感知的
模型选择、推理强度、图片输入、联网搜索承载与多账户轮换。

来源形态：**npm 发布包**。安装走 npm 受管安装器 `installNpmPlugin`，spec 为
`@mars-sea/dsh-commandcode-provider@latest`：安装时解析 registry 的 latest 精确
版本，已装同一版本时跳过；本 wrapper 不构建、不 link 本地源码。

## 目录

```text
plugins/commandcode-provider/
├─ install.mjs                              # npm 安装（registry latest，bundle 自挂载）
└─ README.md                                # 本说明
```

## 为什么是 npm 发布包

- 上游把 npm 发布包作为常规安装路径（README「安装」一节），与本仓库 `dsh-pet`、
  `dsh-web-ui`、`plugin-market`、`deep-whale` 等 npm 型 wrapper 的形态一致。
- 安装目标是 registry 的 `latest`：`installNpmPlugin` 先把该 tag 解析成精确版本再
  交给 pnpm，因此不受 pnpm 11 的 `minimumReleaseAge`（1440 分钟）对 `@latest`
  的静默回退影响——不会装着上一版却返回成功，也不需要仓库内维护版本号。
- 包声明了 `dsh.bundle.patch`，于是 `dsh plugin add` 把它 reconcile 进
  `dsh.profile.bundles`，由包自己的 `cordis.patch.yml` 挂载 entry——本 wrapper
  **不写** `cordis.patch.yml` insert（手写会双挂载）。

## 兼容性状态

上游用双通道析取区间声明引擎：`engines.dsh` 为 `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0`，`dsh.compatibility.dsh` 与 15 个 `@deepseek-ai/dsh-*` peer 采用同一区间。第一段接纳 0.2.1 线从 rc.2 起的每个 RC；第二段接纳 0.2.2 线从 alpha.2 起的预发布，`0.2.2-rc.5` 落在其中。上界写成 `<0.2.2-0` / `<0.2.3-0`，因此排除 0.2.2 的正式版与 0.2.3 及以后。`dsh.compatibility.dshReleases` 记录经过完整引擎矩阵验证的版本，仅作「验证于」展示。

本仓库 pin 的 harness 是 **dsh-v0.2.2-rc.5**，落在第二段内（`0.2.2-alpha.2 <= 0.2.2-rc.5 < 0.2.3-0`）。准入闸门先读 `engines.dsh` 并只按它判定，因此闸门**自行接纳**该包，`install.mjs` 不需要 `exempt`。

安装后应满足：

- `dsh plugin add` 成功，profile 依赖写入解析出的精确版本，bundles 保留 `@mars-sea/dsh-commandcode-provider`，`compatibility.json` **不含**该包的例外记录（无需例外）；
- 组合层仍是单行 `- id: llm-commandcode`（含默认 `config.apiKeyEnv: COMMANDCODE_API_KEY`），无重复 entry id、无跳过 bundle 报告。

> 更早的插件线与本运行时**不配套**（分别对应不同的 dsh 线）；要跟随运行时，应保持 `latest` 安装，而不是回退到旧版本号。

## 默认配置

bundle 层写入的 entry 自带一项配置（上游 `cordis.patch.yml`）：

```yaml
- id: llm-commandcode
  name: '@mars-sea/dsh-commandcode-provider'
  config:
    apiKeyEnv: COMMANDCODE_API_KEY
```

其余配置都在插件自己的设置页或 `$DSH_HOME/settings.yaml` 的 `llm-commandcode:`
段（改后即时生效，无需重启）：`apiBase`、`workingDir`、`requestTimeoutMs` /
`streamIdleTimeoutMs`（默认 300s）、`contextWindow` / `contextWindowOverrides`
（0.13.1 起可选）、`accounts` / `activeAccount` / `modelAccountRules`（多账户轮换）、
`visibleModels`、`zdr`（零数据保留，默认关）、`showSidebarQuota`（侧边栏额度卡片，
默认关）、`offloadSeenImagesForCache`（默认关）。**联网搜索默认开启**：web 能力存在
时插件把 `commandcode` 选为 `web_search` 后端，关闭开关会还回原后端。

API key 解析顺序：组合配置里的字面量 `apiKey` → 设置页/浏览器登录写入的凭据 →
`COMMANDCODE_API_KEY` 环境变量 → 官方 CLI 的 `~/.commandcode/auth.json`。

## 安装

```powershell
# 自托管（运行时根 = E:\Git\dsh-gui-home）
node plugins/commandcode-provider/install.mjs
```

`$DSH_HOME` 缺省由共享流水线 pin 到运行时根的 `.dsh`，脚本也接受显式覆盖；不会写
系统全局位置。整个插件组仍走 `npm run install:plugins` / `npm run build`（按目录名
字典序，本 wrapper 排在 `commandcode-provider`）；安装产物都在 gitignored 的 `.dsh/`。

## 更新

1. 重跑本 wrapper（`node plugins/commandcode-provider/install.mjs`）或执行下一次
   构建：安装时解析 registry 的 latest 精确版本，与已装版本不同才重新安装；
2. 重启 dsh-gui / harness 生效。

上游的区间声明同时覆盖 0.2.1 线从 rc.2 起的每个 RC 与 0.2.2 线从 alpha.2 起的预发布（含 `0.2.2-rc.5`），因此安装 latest 不需要改动兼容字段；目标运行时落在区间外时，准入闸门会拒绝安装并让构建以包名失败，此时临时固定一个兼容版本，或按 `plugins/README.md` 的例外流程传入理由。另注意 `engines.node` 为 `>=24.9`（与 dsh 0.2.2 引擎的下限一致），在 Node 22/23 上安装会报 `EBADENGINE`。

## 验证

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui-home\.dsh'
# profile 依赖与 bundles
(Get-Content .dsh/profiles/web/package.json -Raw | ConvertFrom-Json).dsh.profile.bundles
# 组合层（退出码 0，且含 id llm-commandcode）
node ..\.harness\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config
```

重启 dsh-gui / harness 后生效：**设置 → Command Code** 填 key，**设置 → Models**
出现 **Command Code** 卡片，模型选择器在 `commandcode` 下列出实时目录。

## 已知限制

- **非官方集成**：需要自己的 Command Code 账号与 key，并遵守其服务条款；与
  Command Code, Inc. 无关。
- 插件仅面向其配对的 dsh 版本维护，跨版本升级需要上游跟进；包声明 `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0`，接纳 pinned 的 0.2.2-rc.5，因此**无需**精确版本例外；`engines.node` 为 `>=24.9`，与 harness 的下限一致。
- 图片输入受模型能力限制（仅 Vision 模型），且含图片的会话切到纯文本模型会被 dsh
  拒绝；不支持 `stop` 序列。
- 浏览器内登录依赖 Host 与浏览器同机（回环回调）；远程 Host 请手动粘贴 key。
- 与 dsh-gui **无耦合**：插件只用 harness 的公开 manifest 约定（`dsh.bundle`、
  `dsh.client`）与 Cordis 服务/seam，可在只装 `deepseek-harness` 的环境用
  `dsh plugin add` 直接加载；本 wrapper 只负责构建期的安装与挂载。

## 卸载

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui-home\.dsh'
node ..\.harness\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile web remove '@mars-sea/dsh-commandcode-provider'
```

凭据库与 `~/.commandcode/auth.json` 中的 key 不受影响。彻底移除（wrapper 目录、
profile 依赖与 `.dsh` 运行期残留）按 `dsh-plugin-uninstall` skill 的清单执行。
