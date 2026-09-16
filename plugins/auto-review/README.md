# plugins/auto-review

安装官方实验性的 **Auto review** 层：为 Web profile 的当前会话权限选择器添加带
`EXP` 角标的 `Auto review` 选项。

这是本仓库一个 **没有本地插件包** 的 wrapper：`install.mjs` 只把官方 npm 包装进
web profile。该包声明 `dsh.bundle.patch`，因此 `dsh plugin add` 会自动把它
reconcile 进 `dsh.profile.bundles`，由 bundle 层自行挂载（Loader entry id
`auto-review`)；本脚本不写 `cordis.patch.yml` insert（手工插入会
`duplicate loader entry id`）。

## 用途

每次原生工具调用、以及每个已开始的 PTC `tools.*` inner call 在 body 执行前，都由
与当前 agent 相同的 provider/model 发起一次额外的 review 请求。审查通过后调用按
Full access 执行（复用未改变的 `danger-full-access + never` 旋钮），拒绝则 body
绝不执行。外层 `run_code` transport 与 PTC 程序内直接 Node 效果不在审查范围内。

审查按动作的实际效果分类：普通项目内操作与精确清理本会话创建的对象属于
`low`，直接允许；不可逆删除既有对象、生产操作、外部写入与安全控制变更属于
`medium`，需要当前 human 或直接父级明确授权动作、目标与范围；跨信任边界泄露
敏感信息属于 `high`，始终拒绝。效果不明确、授权冲突未解决、响应不合法与技术失败
都按拒绝处理（fail closed）。

## 安装内容

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-auto-review@0.1.6-alpha.1` | web profile | 逐调用 LLM 授权审查层 |

版本必须精确 pin：`0.1.6-alpha.1` 与本仓库 pinned 的 `dsh-v0.1.6-alpha.1`
运行时配套，包的 peerDependencies 全部指向 `^0.1.6-alpha.1`。该版本是
prerelease，因此进不了 Community Market。

## 使用

```powershell
npm run install:plugins        # 或 npm run build
```

重启后，在当前会话的权限选择器（composer 旁的「访问模式」菜单，或 `/permission`
slash 选择器）中选择带 `EXP` 角标的 `Auto review`，在确认对话框中勾选
「我已了解这些风险，并愿意继续」后点「启用 Auto review」。直接键入
`/permission auto` 也构成明确同意，不弹确认框。

通用设置行与新会话默认值都不提供 Auto；Auto 是仅限当前会话的选项。被拒绝的调用
以普通工具卡片呈现：折叠行标识 Auto review，展开显示 body 未执行与可选理由。

## 已知限制

- **实验功能，需显式安装**。不安装本层时，默认 Web 只有仅可查看、工作区内修改、
  完全权限三种模式；本层只增加当前会话选项，不能成为默认预设。
- **不是确定性安全边界**。每次受支持调用额外产生一次模型请求并增加延迟，模型
  分类可能误放行或误拒绝；不提供豁免、缓存 grant、人工 fallback、可配置策略或
  重试，重复调用也重新审查。
- **卸载语义**。卸载时存活 Auto 会话被迁移到 Full access；重装只恢复选项，不把
  存活会话切回 Auto，持久为 `auto` 的会话需要显式重新打开。

详细机制见官方包源码
`deepseek-harness/packages/experimental/auto-review/README.zh.md` 与设计文档
`deepseek-harness/.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md`。

## 卸载

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
```

`dsh plugin remove` 会把对应 bundle 从 `dsh.profile.bundles` 移除。若想从本仓库
安装流水线中整体去掉该插件，删除本 wrapper 目录即可。

## 约束

- `DSH_HOME` 缺省 `<repo>/.dsh`，只写该目录。
- 幂等：重复执行结果一致（`dsh plugin add` 去重，bundle reconcile 幂等）。
- 依赖 `scripts/plugin-install.mjs` 的共享流水线，经 `installNpmPlugin` 安装。