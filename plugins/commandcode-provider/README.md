# plugins/commandcode-provider

[Mars-Sea/dsh-commandcode-provider](https://github.com/Mars-Sea/dsh-commandcode-provider)
（npm 包名 `@mars-sea/dsh-commandcode-provider`）的 wrapper：DeepSeek Harness
的非官方 **Command Code** LLM provider 插件，注册 `commandcode` provider 路由
（Loader entry `llm-commandcode`），带 Models 页卡片、实时模型目录、套餐感知的
模型选择、推理强度、图片输入、联网搜索承载与多账户轮换。

来源形态：**git submodule（整仓库，仅作源码参考）+ npm 安装**。子模块 pin 到
tag `v0.12.0`，安装走 npm 受管安装器 `installNpmPlugin`，精确版本
`@mars-sea/dsh-commandcode-provider@0.12.0`；本 wrapper **不构建、不 link** 本地
checkout。

## 目录

```text
plugins/commandcode-provider/
├─ install.mjs                              # npm 安装 0.12.0（bundle 自挂载）
├─ README.md                                # 本说明
└─ dsh-commandcode-provider/                # Mars-Sea/dsh-commandcode-provider（git submodule，pin v0.12.0）
   ├─ package.json                          # dsh.bundle.patch 指向 ./cordis.patch.yml
   ├─ cordis.patch.yml                      # bundle 层：insert id llm-commandcode
   ├─ src/ lib/ locale/ assets/ …            # 源码与预构建产物（仅源码参考）
   └─ docs/                                 # 上游文档
```

## 为什么是 npm 精确版本

- 上游把 npm 发布包作为常规安装路径（README「安装」一节），子模块 checkout 只是
  版本来源与源码参考，与本仓库 `dsh-pet`、`dsh-web-ui`、`plugin-market`、
  `deep-whale` 的形态一致。
- 固定 **精确版本**（而非 `@latest`）：pinned pnpm 11.7 的 supply-chain
  `minimumReleaseAge`（1440 分钟）会把发布不足 24h 的版本挡在 `@latest` 之外并
  **静默回退到上一版**，命令照样成功；`0.12.0` 发布于 2026-09-29T02:14Z，正好落在
  该窗口内（pnpm 已把它写入 profile 的 `minimumReleaseAgeExclude`）。精确 pin 同时
  让版本与子模块 tag 对齐。
- 包声明了 `dsh.bundle.patch`，于是 `dsh plugin add` 把它 reconcile 进
  `dsh.profile.bundles`，由包自己的 `cordis.patch.yml` 挂载 entry——本 wrapper
  **不写** `cordis.patch.yml` insert（手写会双挂载）。

## 兼容性状态

上游 0.12.0 只针对 **dsh 0.2.0-rc.1** 维护：其 `@deepseek-ai/dsh-*` peer 全部为
`^0.2.0-rc.1`，`dsh.compatibility.dshReleases` 也只记录该版本，`engines.dsh` 同为
`^0.2.0-rc.1`。本仓库 pin 的 harness 为 **dsh-v0.2.0-rc.2**，按 semver 优先级满足
`^0.2.0-rc.1`，因此 app-boot 的准入闸门接纳该包，**无需**精确版本例外
（`exempt`）。已实测安装通过：

- `dsh plugin add` 成功，profile 依赖写入 `0.12.0`，bundles 追加
  `@mars-sea/dsh-commandcode-provider`；
- `dsh --profile web --dump-config` 退出码 0，组合层出现该 bundle 的
  `- id: llm-commandcode` 行（含默认 `config.apiKeyEnv: COMMANDCODE_API_KEY`），
  无重复 entry id、无加载错误、无跳过 bundle 报告。

> 更早的插件版本与本运行时**不配套**：0.11.17 是 dsh 0.1.7 线的最后一版，0.11.11
> 对应 0.1.2–0.1.6，0.9.1 对应 0.5.0 线。要跟着运行时走，应移动子模块指针 + 改
> `install.mjs` 的精确版本，而不是回退版本号。

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
`streamIdleTimeoutMs`（默认 300s）、`accounts` / `activeAccount` /
`modelAccountRules`（多账户轮换）、`visibleModels`、`zdr`（零数据保留，默认关）、
`showSidebarQuota`（侧边栏额度卡片，默认关）、`offloadSeenImagesForCache`
（默认关）。**联网搜索默认开启**：web 能力存在时插件把 `commandcode` 选为
`web_search` 后端，关闭开关会还回原后端。

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

子模块缺失时：

```powershell
git submodule update --init plugins/commandcode-provider/dsh-commandcode-provider
```

## 更新

1. 审阅上游变更后移动子模块指针，例如
   `git submodule update --remote plugins/commandcode-provider/dsh-commandcode-provider`
   （或 `git -C plugins/commandcode-provider/dsh-commandcode-provider checkout <tag>`）；
2. 把 `install.mjs` 的 `packageSpec` 改为与之对应的精确 npm 版本（上游 CHANGELOG
   与 npm `dist-tags.latest` 对齐）；
3. 重跑本 wrapper；若目标版本仍落在 pnpm 的 24h 年龄窗口内，精确 pin 即可绕过。

若新版把某个 `@deepseek-ai/dsh-*` peer 提到本运行时之上（例如 `^0.2.0-rc.2`），
准入闸门会拒绝安装：此时要么留给旧版本、要么按 `plugins/README.md` 的例外流程传入
`exempt` 理由。

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
- 插件仅面向其配对的 dsh 版本维护，跨版本升级需要上游跟进。
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

凭据库与 `~/.commandcode/auth.json` 中的 key 不受影响。彻底移除（子模块、wrapper、
`.dsh` 与 `.git/` 内残留）按 `dsh-plugin-uninstall` skill 的清单执行。
