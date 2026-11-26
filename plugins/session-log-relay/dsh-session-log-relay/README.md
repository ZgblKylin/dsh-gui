# session-log-relay

为使用非 DeepSeek 模型的会话补发会话日志。

## 用途

`@deepseek-ai/dsh-session-log-deepseek` 把会话日志贡献成请求体的顶层扩展字段 `dsh_session_log`，而读取并发送该字段的只有 DeepSeek 适配器。在 `dsh-session-log-deepseek` 开启的前提下，贡献器只在请求带 `sessionId` 且对应会话存活时挂载该字段；适配器在 HTTP 2xx 之后、读取 SSE 之前调用扩展项的 `accept()`，并以 `session-log-deepseek/delivery-accepted` 事件推进会话日志的接受水位。

会话使用非 DeepSeek 模型时，正常请求不经过该适配器，水位不前进。本插件按策略经 `ctx.llm.stream` 向配置的 DeepSeek 路由发起一次极小请求，让同一条上传路径把待上传的日志挂带上去。

## 依赖与加载

- 包 inject `llm` 与 `sessions`。除同包的 `./logic.js` 外不 import 任何模块，所需能力全部经 `ctx` 服务访问。
- 包不声明 `dsh.bundle.patch`，由 wrapper 的显式 mount 行（`id: session-log-relay`、`name: dsh-session-log-relay`）挂载成 Loader 条目。
- 两个触发点都用 `ctx.on()` 注册，随插件 effect 作用域卸载。

## 触发策略

### 每 N 步

插件监听 `agent/pre-step` waterfall，处理顺序固定：

1. 先 `await next()`，取得下游（含压缩策略）的决定；
2. 决定为 `reject`、`enabled` 关闭、步骤 provider 命中跳过规则、或会话被排除时，直接返回决定；
3. 通过后为该会话累计一次可补发步骤；计数是 `everySteps` 的整数倍时补发，否则返回决定；
4. 补发结束，返回原决定。

补发在 `next()` 之后执行：同一步内下游触发的请求先完成，本次补发才上传，避免两者并发重复上传同一段日志。代价是这一步的模型请求要等补发结束：补发流受 `timeoutMs` 约束，`model: 'auto'` 查询模型列表时另加该查询自身的耗时。

### 压缩前

阈值触发、溢出触发与手动 `/compact` 的压缩请求都经过 `purpose === 'compaction'` 的 `llm/stream`，并带会话 id。插件在把压缩请求交给下游之前补发一次；补发请求自身的 `purpose` 是 `session-log-relay`，与压缩请求不同，不会再次命中该触发点。

压缩请求的 provider 为空或命中 `skipProviders` 时不补发。

## 跳过规则

满足任一条件时不补发：

- `enabled` 为 `false`；
- 步骤或压缩请求的 provider 为空，或命中 `skipProviders`；默认列表里的 `deepseek-official` 与 `deepseek-account` 本身会随正常请求挂带 `dsh_session_log`；
- `includeSubagentSessions` 为 `false`，且 `agent/pre-step` 所属会话的 `header.origin === 'subagent'`；
- 同一会话已有补发在途；
- 距同一会话上次补发尝试不足 `minIntervalMs`。

## 配置

配置写在 profile 的 `cordis.patch.yml`，以按 id 定位的行覆盖 entry `session-log-relay` 的 `config:`：

```yaml
- id: session-log-relay
  config:
    everySteps: 5
    provider: deepseek-official
```

缺失或非法字段逐项回落到默认值，不会导致插件加载失败：布尔字段接受布尔值，数值字段接受正整数，字符串字段接受去掉首尾空白后的非空字符串，`skipProviders` 接受字符串数组。profile 的覆盖行替换整个 `config:` 值，其余字段由插件的默认值补齐。配置在插件加载时归一化，修改后需重载插件或重启 harness 生效。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；为 `false` 时两个触发点都不补发。 |
| `everySteps` | `10` | 每多少个可补发步骤补发一次；必须为正整数。 |
| `beforeCompaction` | `true` | 是否在压缩请求转发前补发。 |
| `provider` | `deepseek-account` | 补发请求使用的路由。 |
| `model` | `auto` | 每次补发向该路由查询当前模型列表并取第一位；列表更新后无需改配置；显式填模型 id 可固定。 |
| `maxTokens` | `1` | 补发请求的输出上限。 |
| `timeoutMs` | `15000` | 单次补发的超时上限，与触发点的取消信号取先到者。 |
| `minIntervalMs` | `3000` | 同一会话两次补发尝试之间的最小间隔。 |
| `skipProviders` | `['deepseek-official', 'deepseek-account']` | 命中这些 provider 的步骤或压缩请求不补发。 |
| `includeSubagentSessions` | `true` | 为 `false` 时步数触发跳过 subagent 会话。 |

## 成本

`dsh_session_log` 是请求体的顶层扩展字段：适配器把扩展字段与基础请求体合并后发送，该字段不在 `messages`、`system` 或 `tools` 内，不产生输入 token。

补发请求本身包含一条短 user 文本，输出上限为 `maxTokens`（默认 1），单次约 10 个 token；即使没有待上传事件，请求本身仍会发出。有待上传事件时，每次补发携带一段日志，段长上限由 `dsh-session-log-deepseek` 的 `maxBytes` 决定（默认 8 MiB）；待上传事件多于一段时，由后续触发继续推进水位。

`model` 为 `auto` 时，模型由该路由模型列表的第一位解析；模型 token 开销与具体模型无关（一条短文本加至多一个输出 token）。若列表第一位不是最便宜的模型，可显式固定 `model`。

## 失败语义

- 补发期间的所有错误（路由未注册、凭据缺失、超时、取消等）都在插件内消化，只记录日志，不向主流程抛出；被触发的步骤或压缩请求照常进行。
- 同一错误键只打印一次，日志前缀为 `[session-log-relay]`；错误键优先取 `error.code`，没有时取错误消息。
- 会话日志的接受水位只在 HTTP 2xx 之后推进。补发失败时水位不前进，日志保留，下一次触发重传同一段。
- 本地节流记录尝试时间，失败后同一会话在 `minIntervalMs` 内不会重试。

## 验证方法

1. 将会话切到非 DeepSeek 模型，并把 `everySteps` 设为 `1`，或执行一次 `/compact`。
2. 宿主日志中失败会带 `[session-log-relay]` 前缀；成功时没有该前缀的输出。
3. 成功后可检查会话 JSONL：新增 `session-log-deepseek/delivery-accepted` 事件，其 `throughSeq` 前移。
4. 若日志提示路由或凭据问题，先确认 `provider` 路由已注册且有可用的 DeepSeek 凭据。

## 已知限制

- 步数计数保存在进程内 `WeakMap`，重启后归零；恢复会话时按新的会话对象重新计数。
- 单次补发最多上传 `maxBytes` 一段（默认 8 MiB）；单条事件本身超过该上限时，水位停在该事件，日志无法继续推进。
- 需要可用的 DeepSeek 凭据与已注册的 `provider` 路由；否则补发只会失败并记录日志。
- `auto` 依赖路由返回非空模型列表；列表为空或查询失败时补发失败并告警，水位不前进。
- 插件不检查 `dsh-session-log-deepseek` 是否开启；该扩展关闭或未安装时，补发请求照常发出，但不携带日志。
- `includeSubagentSessions` 只约束步数触发；压缩前的补发对所有存活会话生效。
- 步数触发在 `agent/pre-step` 的 `next()` 之后执行，被触发的步骤要等待补发完成：补发流受 `timeoutMs` 约束，`model: 'auto'` 查询模型列表时另加该查询自身的耗时。
- 插件不保存持久状态：步数计数、节流时间与告警去重都只在内存中。

## 安装与卸载

本仓库通过 `plugins/session-log-relay/install.mjs` 调用共享安装流水线安装本包：

```powershell
npm run install:plugins
```

卸载步骤：

1. 从 profile 移除依赖：`dsh plugin --profile <profile> remove dsh-session-log-relay`；
2. 删除 profile `cordis.patch.yml` 中 `id: session-log-relay` 的 insert 行；
3. 删除 `plugins/session-log-relay/` 目录；
4. 插件不写持久状态，无需额外清理。
