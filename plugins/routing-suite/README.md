# plugins/routing-suite

[dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 的 git submodule
wrapper。上游仓库是一个**聚合套装**：自身聚合三个分别 pin 到具体 commit 的
component submodule（injector / mode-boost / preset），本 wrapper 把它们安装进
dsh-gui 的仓库内 DSH home（`$DSH_HOME`，构建时固定为 `<repo>/.dsh`）。

## 安装范围

| 组件 | 上游 | 装配方式 |
| --- | --- | --- |
| `injector`（dsh-super-injector，v0.3.3） | [yjh051108/dsh-super-injector](https://github.com/yjh051108/dsh-super-injector) | 复制到 `$DSH_HOME/plugins/routing-suite/dsh-super-injector` 后用 harness checkout 构建（junction 链接 + tsc + tsdown 自包含打包），再 `link:` 进 web profile；声明 `dsh.bundle.patch`，由 bundle 层自挂载（entry id `dsh-super-injector`） |
| `mode-boost`（dsh-mode-boost，v0.1.0） | [yjh051108/dsh-mode-boost](https://github.com/yjh051108/dsh-mode-boost) | 上游预构建 `lib/` 原样 `link:` 进 web profile（安装脚本只做 `node --check` 校验）；无 bundle patch，wrapper 显式挂载为 entry id `mode-boost` |
| `preset`（dsh-router-standard，v0.2.0） | [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) | `router-standard` 与 `router-spec` 两个 preset 整目录复制到 `$DSH_HOME/.agent-presets/<id>/` |

> 版本号以套装 submodule 指针为准（`git -C plugins/routing-suite/dsh-routing-suite
> submodule status`）；三个组件独立演进，更新套装指针后需重新初始化嵌套
> submodule 并重跑安装。

## 目录

```text
plugins/routing-suite/
├─ install.mjs                     # 构建 + 安装 + 挂载两个插件，复制两个 preset
├─ README.md                       # 本说明
└─ dsh-routing-suite/              # 套装仓库（git submodule，含三个嵌套 submodule）
   ├─ injector/                    # dsh-super-injector（源码，lib/ 由 install.mjs 构建）
   ├─ mode-boost/                  # dsh-mode-boost（预构建 lib/）
   └─ preset/
      └─ preset/
         ├─ router-standard/       # Router Standard (experimental) preset 源
         └─ router-spec/           # Router Spec (experimental) preset 源
```

## 安装

```powershell
# 1. 初始化套装 checkout 及其三个嵌套 submodule（必须带 --recursive）
git submodule update --init --recursive plugins/routing-suite/dsh-routing-suite

# 2. 安装（构建注入器 → link 两个插件 → 复制 preset）
node plugins/routing-suite/install.mjs
# 或随全套插件一起：
npm run install:plugins
```

`install.mjs` 会被 `npm run build` / `npm run setup` / `npm run
install:plugins` 自动发现执行；重复执行幂等（注入器构建副本整体替换、插件挂载按
entry id 去重、preset 目录覆盖复制）。

## 为什么这样装

- **嵌套 submodule 需要 `--recursive`**：套装只被记录为 dsh-gui 的一个
  submodule；其内部三个组件是套装自己的 submodule，普通
  `git submodule update --init` 不会拉取它们。缺 checkout 时 install.mjs 会
  报错并给出上面的 `--recursive` 命令。
- **注入器复制到 `.dsh` 再构建**：构建会在包目录里生成
  `node_modules/`、`lib/` 与 pnpm lockfile，复制构建保证上游 checkout
  保持 pristine（本仓库“UPSTREAM IS NEVER MODIFIED”约定）。构建镜像上游
  `scripts/build.sh`（把 harness checkout 里的 cordis/cosmokit/schemastery/
  dsh-tools/dsh-system-prompt/cordis-plugin-loader 用 junction 链接进
  node_modules，再用 harness 的 tsc 编译），随后跑上游 `build:client`
  （tsdown），产出自包含的 `lib/index.js` + `lib/client.js`（官方
  `link:` 装配不安装 peer 依赖，未打包的产物会解析不到
  `@deepseek-ai/dsh-tools` 等）。
- **mode-boost 不构建**：上游以预构建 `lib/` 发行，其 `build` 脚本只是校验
  + 打 tgz；wrapper 直接做等价的 `node --check` 校验。
- **挂载来源不同**：注入器自带 `dsh.bundle.patch`（bundle 层自挂载，共享
  安装器不写 cordis.patch.yml，避免双挂载）；mode-boost 无 bundle patch，由
  wrapper 传显式 `mount: { id: 'mode-boost', name: '@dsh-external/dsh-mode-boost' }`。
  scoped 包名以 `@` 开头不是合法 YAML 普通标量，共享安装器写入时会加单引号
  （`scripts/plugin-install.mjs`），重复安装解析时再剥掉引号保持幂等。
- **preset 整目录复制**：组合通过 `./router-bootstrap-v1.mjs` 相对路径加载
  本地插件，逐文件复制会丢文件；复制目标是 `router-standard` 与
  `router-spec` 各自的目录名（即 roster 里的 preset id）。
- **preset.yml 落地补丁**：上游 preset.yml 的 description 里带未加引号的
  `: `（如 `RL-interface restoration: one-sentence...`），js-yaml / yaml@2
  都会解析失败，roster 会退化成裸 preset id。install.mjs 只对安装副本重写
  为带单引号的 YAML 标量（内容不变、幂等），不修改上游。

## 生效与验证

1. **重启 dsh-gui**（插件集合与 bundles 变更在启动时生效）。
2. 注入器：新会话里问 agent `dev_plugin_status` → 应看到
   `dsh-super-injector` active；`dev_self_test` 一键回归 8 项。
3. mode-boost：活动日志写入 `$DSH_HOME/mode-boost-activity.jsonl`
   （best-effort，不写全局位置）。
4. preset：新建会话的 roster 中出现 `Router Standard (experimental)` 与
   `Router Spec (experimental)`，选择后首条消息按任务自动路由
   （spec 维护任务 / react 生成任务 / weak 模糊任务内路由）。

## 更新

- 上游套装更新后先审阅，再移动指针并重初始化嵌套 submodule：

  ```powershell
  git submodule update --remote plugins/routing-suite/dsh-routing-suite
  git submodule update --init --recursive plugins/routing-suite/dsh-routing-suite
  node plugins/routing-suite/install.mjs
  ```

- dsh-gui 的检查更新对话框只列出顶层 submodule（套装自身）；套装内部三个
  组件的新指针要随套装仓库提交，更新后按上面命令同步，然后重跑安装。
