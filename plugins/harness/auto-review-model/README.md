# dsh-auto-review-model

把 Auto review 的审查请求改派到配置的 provider 与模型。

## 为什么需要它

Auto review 的审查请求沿用被审 agent 最新请求头里的 provider 与 model（`snapshotAutoReview`，见 `deepseek-harness/packages/experimental/auto-review/src/index.ts`），没有 reviewer 模型配置项。插件页的「自动授权审查」开关只决定是否启用审查，不决定审查由哪个模型执行。

于是审查开销与主对话共用同一条路由：无法给审查换用更便宜、更快的模型，也无法在主模型不适配审查所需格式时单独指定一条可用路由。

本插件是叠加在 Auto review 之上的可选覆盖层：它只改派审查请求，不启用审查，不改变审查策略，也不改变权限模型。

## 原理

auto-review 在 `tools/pre-execute` 阶段调用 `ctx.llm.stream` 发起审查请求。请求带 `purpose: 'auto-review'`，并由 `deepFreeze` 深层冻结（`classifyRisk`）。

`llm/stream` 是 Cordis waterfall（事件声明见 `deepseek-harness/packages/llm/llm/src/index.ts`）：每个 listener 收到请求与 `next` 续体，不调用 `next()` 就让整条链短路，其返回值成为最外层返回值。

本插件在链首（`prepend`）识别该 purpose，构造 `{ ...options, provider, model }` 替换请求，再调用 `ctx.llm.stream` 重新派发。替换请求重入 waterfall 时被 `WeakSet` 识别并直接 `next()`，因此一次审查只发生一次改派。provider 解析发生在 waterfall 之后，替换请求按新的 provider 选择适配器。

审查请求是冻结对象，禁止原地改写 `options.provider`：深层冻结的写入会抛错，下游也按同一对象读取 provider。改派必须构造替换对象。

## 配置

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `enabled` | 可选 | 自定义审查模型开关；缺省 `true`，只有与 `provider`、`model` 齐备时才改派 |
| `provider` | 与 `model` 成对 | 审查请求改派到的 provider 路由 |
| `model` | 与 `provider` 成对 | 该路由上用于审查的模型 id |
| `reasoningEffort` | 可选 | 审查请求的思考强度；省略时沿用目标路由默认值 |

四个字段全部声明为 Schemastery `volatile()` 字段，因此会投影成插件信息页的配置表单。

### 插件信息页

重启 dsh 后打开「插件 → 已安装 → `dsh-auto-review-model`」，页面描述与行之间出现「自动审查模型」卡片：

- **自定义审查模型开关**：开关打开表示 `enabled`、`provider`、`model` 三者齐备。首次打开且尚无路由时，自动选中模型目录第一组的第一个模型；这一步只填草稿，不落盘。
- **Provider / 模型下拉**：Provider 列表来自 `ctx.remote.session.modelCatalog()`；切换 provider 时 model 重置为该 provider 的第一个模型。
- **保存**：一次写入 `enabled`、`provider`、`model`，用表单读到的 revision 做写栅栏，Host 接受后即时生效，无需重启。
- **关闭开关后保存**写入 `enabled: false`，`provider` 与 `model` 原值保留；再次打开时恢复原路由。
- 模型目录加载失败时开关仍可切换，卡片显示错误与重试；没有可用路由时保存不可用。

界面写入的是 profile 的 Cordis patch（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`），**优先级高于包内 `cordis.patch.yml` 的默认值**。

### 关闭开关的语义

`enabled: false` 让插件不注册 `llm/stream` 监听，Auto review 回到默认表现：审查请求沿用被审 agent 当前使用的 provider 与模型。审查本身仍按 auto-review 的权限模式运行，本插件不参与是否启用审查的决定。

### 手工配置

出厂 `config` 在包内 `cordis.patch.yml` 的 `- insert:` 行，取值是本机示例路由（`opencode-go` / `deepseek-v4.1-flash`，与当前主模型一致，因此装上后默认行为不变）。

不走界面时，改配置有两条路径：

1. **不动仓库源码**：在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加一条按 id 覆盖的条目。patch 按 `id` 命中已有的行并逐键覆写，`config` 整体替换，所以 `provider` 与 `model` 都要写全：

```yaml
- id: auto-review-model
  config:
    provider: <provider>
    model: <model>
```

2. **改本仓库源码**：编辑 `plugins/harness/auto-review-model/cordis.patch.yml` 里的 `config`。包以 `link:` 安装，bundle patch 在启动时读取，下次启动生效。

按 id 覆盖不会重复挂载；**不要**用 `- insert:` 再插一条 `id: auto-review-model` 的行，那会让 Loader 因重复 entry id 报错。

字段在插件加载时校验：`provider` 与 `model` 不成对、为空或类型错误时抛 `TypeError`，该 loader 条目启动失败。`reasoningEffort` 单独出现同样视为配置错误。

`reasoningEffort` 必须是目标路由为审查所用模型声明的取值。路由不接受该取值时，审查请求以 provider 错误结束，被审调用按 auto-review 的 fail-closed 规则失败，而不是放行。

未配置 `provider` 与 `model` 或 `enabled: false` 时插件直接放行，Auto review 继续使用 agent 当前模型，日志打一行说明。监听本身始终注册：字段是 volatile 引用，插件信息页保存后由下一次审查读取新值，无需重载该 entry。

### 成本

审查请求每次受支持工具调用产生一次，不缓存、不重试、不压缩，也没有单独的输出预算。改用更便宜或更快的模型可以降低这部分开销，分类质量随目标模型能力变化：需要更保守的判断时选能力更强的模型，需要更省时选更便宜的模型。

## 已实现的边界

- 只改派 `purpose: 'auto-review'` 的请求。主对话、标题生成与其他辅助调用不受影响。
- 外层 `run_code` 调用本来不进入审查；PTC `tools.*` inner call 仍逐个审查，其审查请求同样带该 purpose，因此同样被改派。
- 审查策略仍由 auto-review 的固定 `REVIEW_POLICY` 决定。本插件不改变风险分级、不改变 fail-closed 行为，也不改变拒绝后的审批流程。
- 审查请求的 `sessionId` 与 `purpose` 原样保留，provider 侧的会话路由与 prompt 缓存键仍指向被审会话。
- 与同样拦截 `llm/stream` 的 `dsh-opencode-session` 共存：后者只给缺少 `sessionId` 的 OpenCode 请求补 id，而审查请求本身已带 `sessionId`。

## Harness 升级检查清单

本插件依赖三条 harness 内部约定。升级 `deepseek-harness` 之后，请在仓库根逐条执行下列检查；任何一条不成立，都必须先调整本插件或将其停用，再让新 harness 投入运行。

1. 审查请求仍带 `purpose: 'auto-review'` 标签：

```powershell
rg -n "purpose: 'auto-review'" deepseek-harness/packages/experimental/auto-review/src/index.ts
```

命中 `classifyRisk` 中的一行即符合。标签改名或去掉时，同步改 `index.js` 的 `AUTO_REVIEW_PURPOSE`。

2. `llm/stream` 仍是 waterfall，listener 不调用 `next()` 时短路整条链：

```powershell
rg -n -A 12 "waterfall\(\.\.\.args" deepseek-harness/vendor/cordis/src/events.ts
```

确认 `dispatch()` 在没有下一个 listener 时调用内层行为，listener 的返回值即最外层返回值。

3. provider 解析仍发生在 waterfall 之后：

```powershell
rg -n -A 8 "streamWithRegistration\(" deepseek-harness/packages/llm/llm/src/index.ts
```

确认 `stream()` 经 `ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))` 派发，且 `adapterStream` 用 `options.provider` 选择适配器。

4. 上游尚未提供 reviewer 模型配置：

```powershell
rg -n "export const Config|export interface Config" deepseek-harness/packages/experimental/auto-review/src/index.ts
rg -n "已知限制" -A 10 deepseek-harness/packages/experimental/auto-review/README.zh.md
```

上游一旦提供 reviewer 模型配置，就改用官方配置并卸载本插件。

5. 客户端配置卡片的三处契约仍然成立：

```powershell
rg -n "plugins.bundle.config" deepseek-harness/packages/client/ui-plugin-manager/src/client/slot-contract.ts
rg -n "entry.options.id as SettingsNamespace" deepseek-harness/packages/settings/settings/src/index.ts
rg -n "modelCatalog" deepseek-harness/packages/client/ui-settings-subagent/src/client/subagent-model-selection-card-controller.ts
```

- `plugins.bundle.config` 仍以 bundle 的 **npm 包名**作为贡献 key（本包用 `dsh-auto-review-model`）。
- settings 表单的 namespace 仍是 **profile entry id**（本包用 `auto-review-model`），来自 `describe()` 的 `entry.options.id`；它和包名不是同一个值，`src/client/index.tsx` 分别以 `BUNDLE_PACKAGE` 与 `ENTRY_ID` 表达。
- 模型目录仍由 `ctx.remote.session.modelCatalog()` 返回 `{ ok, value: { groups, failures } }`。

任一处改名，配置卡片会静默不出现或列不出路由，需要同步改 `src/client/index.tsx`、`src/client/card-controller.ts` 与 `src/client/card-controller.test.mjs`。

## 安装与挂载

包位于 `plugins/harness/auto-review-model/`，由 `plugins/harness/auto-review-model.mjs` 安装，`plugins/harness/install.mjs` 会加载该 installer。

```powershell
npm run install:plugins
# 或只装本插件
node plugins/harness/auto-review-model.mjs
```

以上写入 `web` profile。**Desktop 应用使用 `desktop` profile，而该 profile 由 Electron 应用独占管理**：只能用应用自带的 CLI 安装，并且要先完全退出应用。

```powershell
# 1. 完全退出 DeepSeek Harness（桌面应用）
# 2. 用应用自带 CLI 装进 desktop profile
$env:DSH_HOME = '<runtime-root>/.dsh'
& '<应用安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'link:<仓库根>\plugins\harness\auto-review-model'
```

`npm run build:desktop` 走同一条通道，也会把本插件装进 desktop profile。**不要**手动设 `DSH_PLUGIN_PROFILE=desktop` 运行本 installer：共享流水线此时会使用仓库自己的 CLI，被 desktop profile 的保留规则拒绝，并在失败前向该 profile 的 `pnpm-workspace.yaml` 写入仓库级 `storeDir`（与应用的 `E:\.pnpm-store` 冲突，需要手工删除那一行才能恢复）。

包声明 `dsh.bundle.patch`：`dsh plugin add` 把它写入 profile 的 `dsh.profile.bundles`，bundle 层自挂载 entry `auto-review-model`，不写手工 insert。安装后重启 dsh，并确认 profile 的 `dsh.profile.bundles` 含 `dsh-auto-review-model`。

客户端半需要构建产物 `lib/client.js`（不入库）：

```powershell
pnpm --dir plugins/harness/auto-review-model install --store-dir E:/Git/dsh-gui-home/.pnpm-store
pnpm --dir plugins/harness/auto-review-model run build
```

`npm run install:plugins` 会为声明了 `build` 脚本的 in-tree 包自动执行同样的构建。

验收：重启后在插件页打开 `dsh-auto-review-model` 详情，描述与行之间应出现「自动审查模型」配置卡片；卡片能列出 provider 与模型、切换开关、保存后仍在。卡片不出现时先确认 Host 服务了 `auto-review-model` 这个 settings namespace，再按升级检查清单第 5 条核对 slot key 与 namespace。

## 验证

```powershell
node --test plugins/harness/auto-review-model/tests/plugin.test.mjs
node --test plugins/harness/auto-review-model/src/client/card-controller.test.mjs
```

Host 用例覆盖改派、非审查请求放行、未配置与关闭时的纯直通、冻结请求不被原地改写、只重入一次、非法配置抛错，以及 Config schema 四个 volatile 字段。客户端用例覆盖目录加载成功与失败、打开开关自动选首个路由、provider 切换重置 model、保存发出的 mutate 操作、关闭开关保留路由，以及无路由时拒绝保存。

测试通过 `tests/support/module-hook.mjs` 把 `@deepseek-ai/schemastery` 解析到本机 DSH 安装（`DSH_SCHEMASTERY_PATH` 可覆盖）；DSH 运行时由 profile resolver 完成同样的 peer 解析。

## 卸载

```powershell
dsh plugin --profile web remove dsh-auto-review-model
```

重启后生效。卸载本插件不等于关闭 Auto review：审查仍按当前设置继续，只是回到使用 agent 自身模型。要同时关闭审查，请在插件页关掉「自动授权审查」开关。若要从本仓库的安装流水线中整体去掉本插件，删除 `plugins/harness/install.mjs` 里的 `import './auto-review-model.mjs'` 行。

## 相关文档

- [plugins/harness/README.md](../README.md)：本插件所属 wrapper 的说明。
- [plugins/README.md](../../README.md)：本仓库插件目录与安装流水线。
- [auto-review 包说明](../../../deepseek-harness/packages/experimental/auto-review/README.zh.md)：官方 Auto review 的机制与限制。
- [llm/stream 事件声明](../../../deepseek-harness/packages/llm/llm/src/index.ts)：本插件拦截的事件。
