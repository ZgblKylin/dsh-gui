# dsh-review（/review 内置指令插件）

dsh-gui 内置的 `/review` 斜杠指令插件。仓库内自托管，位于
`plugins/review/dsh-review`（wrapper 为 `plugins/review/`），无第三方上游。

在任意会话中把参考 [opencode](https://github.com/sst/opencode) review 模式
提示词编写的审查指令作为一次性上下文注入当前 agent，随后以用户身份提交
审查请求；无参数时默认审查全部未提交改动，也支持 commit / branch / PR URL
或 PR 号等目标。功能细节见 `plugins/review/dsh-review/README.md`。

## 集成方式

该插件是 **prebuilt host-only** 形态：

1. **无 `build` 脚本**：`lib/index.js` 为纯 ESM，直接随仓库分发；
   `plugins/review/install.mjs` 委托 `scripts/plugin-install.mjs` 跳过
   `pnpm install` + `pnpm run build`。
2. **自带 `dsh.bundle.patch`**（包内 `cordis.patch.yml`，插入
   `id: review, name: dsh-review`）：`dsh plugin add` 的 reconcile 逻辑把包
   追加进 profile 的 `dsh.profile.bundles`，该 bundle layer 自行把 entry
   插进 host 组合；install 脚本对声明了 `dsh.bundle.patch` 的插件不再写
   `cordis.patch.yml` insert（否则会重复挂载）。
3. **运行期零 harness 运行时 import**：profile 的 `node_modules` 不安装
   `@deepseek-ai/*`，插件只用 `node:crypto`；命令注册表与 `Agent` 均通过
   Cordis context 注入，消息对象直接构造为 JSON 可序列化值。

安装/更新流程（全部仓库内自托管）：

```powershell
npm run install:plugins
```

重启 `dsh-gui` 后生效（插件集变更在 boot 时加载）。

## 验证

```powershell
# 单元冒烟：插件导出形状、/review 的消息顺序与 help 行为
node plugins\review\dsh-review\test\review.test.mjs

# 1. 组合树中 entry 恰好出现一次
node deepseek-harness\apps\cli\lib\bin.js --profile web --dump-config | Select-String 'dsh-review'

# 2. 运行时启动冒烟（另起临时实例，端口避开正在运行的 3080）
$env:DSH_HOME = (Get-Location).Path + '\.dsh'
node deepseek-harness\apps\cli\lib\bin.js --profile web --port 3199
Invoke-WebRequest 'http://127.0.0.1:3199/'
```

## 已知约束

- `/review` 不更换当前会话的 agent 或工具目录；审查指令只在本次请求中生效。
- 指令文本内嵌在插件中（`lib/index.js` 的 `REVIEW_INSTRUCTIONS`）；opencode
  上游 review 提示词的更新不会自动同步，需手动同步。
