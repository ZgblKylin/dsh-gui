# plugins/routing-suite

[dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 的 git submodule
wrapper。上游仓库是一个**聚合套装**：injector（注入器）与 preset（路由预设）两个
组件随仓库统一演进；上游从 `21a7260`（flat-submodules 合并）起已把原本的两个
component submodule 扁平化为仓库内普通目录。本 wrapper 按套装 README 的安装链
把它们装进 dsh-gui 的仓库内 DSH home（`$DSH_HOME`，构建时固定为 `<repo>/.dsh`）。

## 安装范围

| 组件 | 上游 | 装配方式 |
| --- | --- | --- |
| `injector`（dsh-super-injector，v0.3.3） | [yjh051108/dsh-super-injector](https://github.com/yjh051108/dsh-super-injector) | 直接用套装官方装配链：缺 `lib/` 时由包自身的 `prepare` 钩子（`scripts/prepare.mjs`，tsdown 自包含打包）构建到 suite checkout（`node_modules/`、`lib/` 已在上游 gitignore），再走共享 `installPlugin`（`build: false`，内部即 `dsh plugin add link:<injector>`）：记录 `link:` 依赖 + 声明 `dsh.bundle.patch` 由 CLI reconcile 进 `dsh.profile.bundles`，bundle 层自挂载，entry id `dsh-super-injector`） |
| `preset`（dsh-router-standard 研发主线：`router-bootstrap` v34，CHANGELOG 顶 v1.27.0） | [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) | `router-standard` 与 `router-spec` 两个 preset 整目录平铺复制到 `$DSH_HOME/.agent-presets/<id>/`（对应套装 README 的手动安装步骤，组合经 `./router-bootstrap.mjs` 相对路径加载） |

> 版本号以套装仓库内容为准（`git -C plugins/routing-suite/dsh-routing-suite log -1`）；
> 组件内容随套装仓库统一演进，更新子模块指针后重跑安装即可。21a7260 起没有嵌套
> submodule，初始化不需要 `--recursive`。

## 目录

```text
plugins/routing-suite/
├─ install.mjs                     # 装配注入器 + 复制两个 preset
├─ README.md                       # 本说明
└─ dsh-routing-suite/              # 套装仓库（git submodule，21a7260 起为扁平仓库）
   ├─ injector/                    # dsh-super-injector（普通目录；lib/ 由上游 prepare 钩子就地构建，已 gitignore）
   └─ preset/
      ├─ router-standard/          # Router Standard (experimental) preset 源（v34）
      ├─ router-spec/              # Router Spec (experimental) preset 源
      └─ router-react/             # 上游新增实验预设；本 wrapper 不安装（与套装 README 一致）
```

## 安装

```powershell
# 1. 初始化套装 checkout（21a7260 起为扁平仓库，无嵌套 submodule）
git submodule update --init plugins/routing-suite/dsh-routing-suite

# 2. 安装（缺 lib 时先跑 upstream prepare 钩子 → add 注入器 → 复制两个 preset）
node plugins/routing-suite/install.mjs
# 或随全套插件一起：
npm run install:plugins
```

`install.mjs` 会被 `npm run build` / `npm run setup` / `npm run
install:plugins` 自动发现执行；重复执行幂等（`prepare` 已产出 lib 则跳过构建、
插件挂载按 entry id 去重、preset 目录覆盖复制）。

## 为什么这样装

- **上游已扁平化（21a7260）**：原套装内部两个 component submodule（injector /
  preset）已改为仓库内普通目录；dsh-gui 只记录套装这一个 submodule，初始化
  不再需要 `--recursive`。缺 checkout 时 install.mjs 会报错并给出
  `git submodule update --init` 命令。
- **注入器只保留最小构建**：`dsh plugin add <目录>` 只会记录 `link:` 依赖、
  不会触发目标的 `prepare`（pnpm 语义，实测验证），而全新 submodule checkout
  没有 `lib/`（构建产物不入库）。注入器 import 的 `cordis`、
  `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm` 等均未发布到 npm，本仓库里
  唯一能解析到它们的地方是 harness checkout——上游 `build.sh` 也是这个契约
  （要 `DSH_CHECKOUT`，把这些包 junction 链接进来）。所以 install.mjs 只在缺
  lib 时：先用 pinned pnpm 装 devDeps（`--ignore-scripts`，让构建完全走下面的
  prepare；`--auto-install-peers=false`，避免去 npm 拉私有 peer），再把上述
  直接 import 的包 junction 到 checkout 的（已 gitignore）node_modules（真实
  路径仍在 `deepseek-harness` 内，传递依赖全从 harness 树解析），最后跑**上游
  自己的 `prepare` 钩子**（`node scripts/prepare.mjs` → tsdown，宿主半把
  cordis/`@deepseek-ai/dsh-tools` 等全部打进 bundle，产物零外部依赖）。
  之后才走共享 `installPlugin`（`build: false`，等价 `dsh plugin add
  link:<injector>`）完成 link + store pin + bundle 自挂载。相比旧 wrapper
  删掉了：`.dsh` 下的构建副本、harness 的 tsc 编译、手动 tsdown、
  standard-schema 侧链接；`node_modules/`、`lib/` 已在 upstream gitignore，
  submodule 保持干净。
- **挂载来源**：注入器自带 `dsh.bundle.patch`（bundle 层自挂载，安装脚本不写
  `cordis.patch.yml`，避免双挂载）。
- **preset 整目录平铺复制**：组合通过 `./router-bootstrap.mjs` 相对路径加载
  本地插件，逐文件复制会丢文件；复制目标是 `preset/router-standard` 与
  `preset/router-spec`（21a7260 起已平铺，不复制 `preset` 整目录，DSH 也只扫
  `.agent-presets` 一级子目录），与套装 README 的手动步骤一致。
- **preset.yml 无需补丁**：上游 v0.3.0 已修复 description 里未加引号 `:`
  导致的 YAML 解析失败问题（suite #53）；旧版安装脚本的落地重新加引号补丁已
  删除，install.mjs 现在原样复制 upstream 文件。

## 生效与验证

1. **重启 dsh-gui**（插件集合与 bundles 变更在启动时生效）。
2. 注入器：新会话里问 agent `dev_plugin_status` → 应看到
   `dsh-super-injector` active；`dev_self_test` 一键回归 8 项。
3. preset：新建会话的 roster 中出现 `Router Standard (experimental)` 与
   `Router Spec (experimental)`，选择后首条消息按任务自动路由
   （spec 维护任务 / react 生成任务 / weak 模糊任务内路由）。

## 更新

- 上游套装更新后先审阅，再移动指针并初始化（21a7260 起无嵌套 submodule）：

  ```powershell
  git submodule update --remote plugins/routing-suite/dsh-routing-suite
  git submodule update --init plugins/routing-suite/dsh-routing-suite
  node plugins/routing-suite/install.mjs
  ```

- dsh-gui 的检查更新对话框列出该子模块（套装自身）；上游组件内容已随套装
  仓库提交（扁平化），更新后按上面命令同步然后重跑安装即可。
