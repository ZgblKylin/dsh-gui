# 官方模型 API 的 Session Log 上传机制与插件补发可行性（2026-11-26）

> 状态：只读研究结论，未改动代码与 profile。
> 基线：DSH `0.2.3-alpha.2`（revision `4b399c39a6`），源码位于运行时根的 `.desktop/source`。

## 结论

「在使用官方模型 API 时上传 Session Log」由三个包组合而成，不存在独立的上传服务：`@deepseek-ai/dsh-deepseek-llm-api-extensions` 提供请求体扩展注册表，`@deepseek-ai/dsh-session-log-deepseek` 贡献 `dsh_session_log` 字段并在 HTTP 2xx 后写入接受水位，`@deepseek-ai/dsh-llm-deepseek` 的 Messages 适配器把字段展开进请求体、发送请求并执行接受事务。

适用范围由「谁消费注册表」决定，与端点地址无关。`deepseek-official` 与 `deepseek-account` 两条路由使用同一个适配器实现（`registerDeepSeekProvider`），都会带上字段；`llm-pi-ai` 及其下的第三方模型不消费注册表。把 `baseURL` 指向第三方网关时，字段仍会发给该网关（`docs/deepseek-llm-api-wire-extensions.md:7,160`）。

因此把日志注入到当前使用的其他模型请求里不可行：请求既不到 DeepSeek，字段也不会被 DeepSeek 收到，只可能被另一家服务收到。可行的是另外向 DeepSeek 发一个请求，把日志挂上去。DSH 为这种用法提供了公开服务：`ctx.deepseekAuth` 的文档写明插件可以自己发请求并自己表述失败（`packages/account/deepseek-auth/README.md:28`），并负责按凭据种类返回 endpoint 与请求头（`:44-53`）。

两条落地路径如下，均要求存在可用的 DeepSeek 凭据，并且服务端是否接受「非对话请求携带日志」需要实测。

## 1. 请求链

```
Agent 循环 → ctx.llm.stream({provider: deepseek-official|deepseek-account, sessionId, purpose})
           → DeepSeekAdapter.stream()
           → serialize(options)                     # 基础 body
           → deepseekLlmApiExtensions.prepare({body, sessionId, purpose, signal})
               └ dsh_session_log：折叠水位 → 按 maxBytes 取连续后缀 → {value, accept}
           → JSON.stringify({...body, ...fields}) → POST {messagesApiRoot(baseURL)}/messages
           → HTTP 2xx → await accept() → session.append('session-log-deepseek/delivery-accepted')
           → 消费 SSE
```

基础 body 先序列化，扩展字段后准备；两者在 HTTP 请求体里是顶层同级成员（`packages/llm/llm-deepseek/src/adapter.ts:127-142`）。接受事务发生在 HTTP 2xx 之后、读取 SSE 之前（`:175`）。

## 2. 注册表与适配器

注册表是 `ctx.deepseekLlmApiExtensions`，`register(field, provider)` 以 effect 作用域登记单一顶层字段，空名、首尾空白与重复注册同步抛错（`packages/llm/deepseek-llm-api-extensions/src/index.ts:81-101`）。贡献对象的形状是 `{ prepare(request) => { value, accept?() } | undefined }`，`request` 携带不可变基础 body、`sessionId`、`purpose` 与取消信号（`src/types.ts:19-48`）。

`prepare()` 并发调用全部字段提供方，对返回值做结构化克隆与深冻结，返回 `{ fields, accept }`；单个字段准备失败只省略该字段并首次告警，不影响其余字段；唯一的 reject 来源是请求取消（`index.ts:111-141`）。`accept` 幂等，用 `Promise.allSettled` 聚合（`:41-48,136-140`）。

适配器把 `fields` 与基础 body 做顶层展开后序列化（`packages/llm/llm-deepseek/src/request-extensions.ts:42`）。三种失败语义：字段名与基础字段冲突使请求失败（`:36-39`）；合并体序列化失败则只发基础 body、不执行接受，贡献方下次重发（`:43-48`）；接受失败只告警，不使模型请求失败（`:49-58`、`src/host.ts:70-75`）。

请求头由适配器组装：`user-agent`、`x-deepseek-harness-user-id`、`x-deepseek-harness-session-id`，`purpose` 为 `compaction` 时额外加 `x-deepseek-harness-compact`，凭据头来自 `ctx.deepseekAuth`（`adapter.ts:152-161`、`src/host.ts:57`、`docs/deepseek-llm-api-wire-extensions.md:24-31`）。

端点由 `messagesApiRoot(baseURL)` 补 `/v1` 后拼 `/messages`（`src/messages-api.ts:14-16`、`adapter.ts:150`）。`baseURL` 只校验 http(s)、无内嵌凭据、无 query 与 fragment，没有 host 白名单或官方域名判断（`src/config.ts:335-339`）。

## 3. 贡献器

贡献器在构造函数里注册 `dsh_session_log`（`packages/session/session-log-deepseek/src/index.ts:196-262`），同时以 `ctx.sessionLogDeepSeek` 暴露 `registerExclusion()`（`:273-280`）。`enabled` 每次请求现读（`:198`）。

省略字段的判定依次为：功能关闭、请求无 `sessionId`、`ctx.sessions.get()` 找不到存活会话、命中任一排除谓词、首个待发事件已超过 `maxBytes` 或无法序列化（`:198-209,233-247`）。

水位从 durable 日志折叠：只接受 `sessionFormatVersion` 与当前会话格式代数相同、且 `sessionId` 与请求会话相同的 `session-log-deepseek/delivery-accepted` 记录，取其中最大的 `throughSeq`（`:151-185`）。fork 会话继承的父水位因 id 不同被忽略，因此子会话从序列零开始上传继承前缀（`docs/deepseek-llm-api-wire-extensions.md:154`）。进程内用 `WeakMap` 缓存扫描位点，重启与 HMR 后从零重建（`:64-69,183`）。

事件按 raw JSON 基元翻译：公共字段为 `seq`、`time`、`data` 与可选 `ignorable`；surface 事件带 `surfaceOp`，替换区间用数字 `startSeq` 与 `endSeq`；除 assistant 外的 surface 事件可带数字 `sourceEventSeqs`；未知但 `ignorable` 的记录原样透传元数据（`:90-129`）。

`maxBytes`（默认 8 MiB）按完整序列化字段的 UTF-8 字节计算，只截取连续后缀，不跳过中间事件；首个待发事件单独超限时省略整个字段、水位不前移，并对同一阻塞事件只告警一次（`:220-247`）。积压由后续被接受的请求逐段排空（`docs/deepseek-llm-api-wire-extensions.md:113`）。

`accept` 向同一会话追加 `session-log-deepseek/delivery-accepted`，携带 `sessionId`、`sessionFormatVersion` 与上传的 `throughSeq`（`:252-259`）。该事件本身属于下一段待发后缀。2xx 之后、水位落盘之前进程丢失会重放已接受区间，方向是至少一次，只产生重复、不产生序列空洞（`:258`、`docs/deepseek-llm-api-wire-extensions.md:156`）。

配置为 `enabled`（默认 `true`）与 `maxBytes`（默认 8 MiB）（`src/index.ts:47-62`）。Web 开关「在使用官方模型 API 时上传 Session Log」通过 `configForms.get('session-log-deepseek')` 注册到通用设置页，写入走 settings 的 volatile 表单通道，不重建插件 fiber（`packages/client/ui-settings-session-log/src/client/index.ts:29-37`、`src/client/upload-preference.ts:30-44`、`src/client/locales.ts:3,11`）。

## 4. 其他模型为何拿不到字段

`llm-pi-ai` 不导入注册表，其适配器测试明确断言请求体不含 `dsh_session_log` 与 `dsh_plugin_packages`（`packages/llm/llm-pi-ai/tests/adapter.spec.ts:192-193`，`docs/deepseek-llm-api-wire-extensions.md:5`）。`packages/llm` 内也没有通用的请求体扩展点，唯一注入位置是 `DeepSeekAdapterOptions.prepareExtensions`，属于 DeepSeek 适配器实现细节（`packages/llm/llm-deepseek/src/types.ts:148-149`）。

注册表在 base bundle 中与两个贡献者一起装配，桌面 profile 未覆盖（`packages/bundle/base/cordis.patch.yml:37-44,85-86`）。因此默认组合下，`enabled` 为真，官方路由的每一次请求（含压缩、会话标题、Auto review 等携带 `sessionId` 的辅助调用）都在增量上传。

## 5. 可行方案

共同前提：存在可用的 DeepSeek 凭据（API key 或账号登录），并且该会话的日志值得上传。两个方案都复用贡献器的水位与事件翻译，不重新实现协议。

### 5.1 方案 A：借道官方路由的辅助调用

对 `deepseek-official` 或 `deepseek-account` 路由发起一次极小的模型调用，`sessionId` 与自定义 `purpose` 照常传入，扩展字段由适配器自动挂载并在 2xx 后接受。压缩与会话标题已经在用这条路径（`packages/compaction/compaction-basic/src/summarizer.ts:157-161`、`packages/session/session-title-llm/src/index.ts:269-270`）。

```ts
// 示意，未实现
declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap { 'session-log-relay': true }
}

for await (const chunk of ctx.llm.stream({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'log relay' }] }],
  maxTokens: 1,
  sessionId: session.id,
  purpose: 'session-log-relay',
})) break
```

优点是代码量最小，凭据、请求头、端点、接受事务全部由适配器负责。代价是请求会经过 `llm/stream` 瀑布事件的全部监听方、模型解析、重试策略与 token 计量（`packages/llm/llm/src/index.ts:78`），并占用 DeepSeek 侧的正常请求配额。

### 5.2 方案 B：旁路 Messages 请求

自行准备字段与请求，但复用注册表与凭据服务：

1. 调用 `ctx.deepseekLlmApiExtensions.prepare({ body, sessionId, purpose, signal })`。字段不存在即表示没有待发日志，直接结束，不产生网络请求。
2. 调用 `ctx.deepseekAuth.authorize({ consumer, accepts, billing, route, destination })` 取得 endpoint 与凭据头。
3. 以最小 Messages 请求体加 `fields` 顶层展开后 POST 到 Messages 端点。
4. HTTP 2xx 后调用 `prepared.accept()` 推进水位；其余结果丢弃，下次重试。

```ts
// 示意，未实现
const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'log relay' }] }
const prepared = await ctx.deepseekLlmApiExtensions.prepare({
  body, sessionId: session.id, purpose: 'session-log-relay', signal,
})
if (prepared.fields.dsh_session_log === undefined) return
const auth = await ctx.deepseekAuth.authorize({
  consumer: 'session-log-relay', accepts: ['api-key', 'account'], billing: 'auto',
  route, destination: { url: `${origin}/anthropic/v1/messages` },
}, signal)
if (auth === undefined) return
const response = await fetch(auth.endpoint, {
  method: 'POST', signal, redirect: 'error',
  headers: {
    ...auth.headers, ...attributionHeaders(), 'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-deepseek-harness-user-id': getOrCreateAnonymousUserId(),
    'x-deepseek-harness-session-id': session.id,
  },
  body: JSON.stringify({ ...body, ...prepared.fields }),
})
if (response.ok) await prepared.accept()
```

`ctx.deepseekAuth` 的 `billing` 决定凭据种类与顺序：`auto` 在会话模型路由为 `deepseek-account` 时优先账号登录、为 `deepseek-official` 时用 API key、其他路由按 API key 再账号登录（`packages/account/deepseek-auth/README.md:55-63`）。`destination` 可用相对路径或同源绝对 URL，凭据不会发给其他 origin（`:67`）。账号登录的授权还带 `revoked` 信号，可并入请求取消（`:69`）。

方案 B 不经过 `ctx.llm`，不触发 `llm/stream` 监听方、模型解析、重试与 token 计量，失败面更窄；代价是自行构造请求与自行表述错误。推荐方案 B。

### 5.3 对比

| 维度 | 方案 A | 方案 B |
| --- | --- | --- |
| 代码量 | 最小 | 中，需要构造 HTTP 请求 |
| 复用范围 | 凭据、请求头、端点、接受事务 | 注册表字段与接受事务、凭据与端点 |
| 对 LLM 运行时的副作用 | 经过 `llm/stream` 监听方、重试、计量 | 无 |
| 失败可见性 | 混在模型请求失败中 | 插件自述，可独立重试 |
| 配额占用 | 一次普通模型请求 | 一次普通模型请求 |

### 5.4 触发、水位与开关

方案 B 的 `prepare()` 是纯进程内调用，字段为空即无待发日志，因此可以安全地「每轮结束先探测、有货才发」。触发点可选 `session/event`（按 `turn/end` 之类事件去抖）或定时器；并发与官方请求之间由水位折叠保证不回退，重复方向仍是最少一次。

内置开关天然生效：`enabled: false` 时贡献器返回 `undefined`，任何方案都拿不到字段。因此补发插件不应当绕过该开关，只需在自身设置里披露「使用其他模型时同样会向 DeepSeek 发送会话内容」，并默认关闭。

## 6. 风险与未验证项

服务端接受性是唯一无法从客户端代码证明的环节。字段挂在 Messages 请求上，官方适配器总是发送 `stream: true` 与 `accept: text/event-stream`；补发请求若用 `stream: false` 或提前取消响应体，服务端是否仍在受理时记录日志，需要实测。

计费与配额：扩展字段不在 `messages` 内，不产生模型输入 token；但补发请求本身是真实模型请求，会产生一次极小的输入输出计费并占用速率配额。官方请求已经顺带完成上传时，补发不应再发，水位探测可避免。

隐私与开关语义：字段可能包含工作目录、系统提示词快照、用户与 Assistant 内容、内嵌 assistant 流、失败 attempt、工具参数与结果、压缩摘要、反馈以及插件事件（`docs/deepseek-llm-api-wire-extensions.md:160`）。内置开关的文案只承诺官方模型 API 场景，补发功能必须单独披露与授权。

重复与时钟：至少一次语义在补发路径上不变；同一会话同时有官方请求与补发请求时，水位折叠按最大值前进，不产生空洞，但可能重复上传同一区间。

体积：单请求字段上限 8 MiB，积压靠连续请求排空；补发不应提高该上限，否则可能与服务端请求体积限制冲突。

可用性：补发依赖 DeepSeek 凭据与对应路由已装配；仅使用其他模型且未配置任何 DeepSeek 凭据时，方案只能报错跳过。

## 7. 实测计划

1. 在测试 profile 装配一个最小补发插件，只对当前会话执行一次方案 B 的请求，`stream` 先与官方一致。
2. 用已知内容构造一次会话，确认请求返回 2xx 后本地追加了 `delivery-accepted`，且下一次 `prepare()` 的 `afterSeq` 前进。
3. 在 DeepSeek 侧确认该会话日志可见；若不可见，改为读取完整 SSE 后再结束请求，重复验证。
4. 验证 `enabled: false`、无凭据、非 2xx 三条失败路径都不推进水位。

## 8. 涉及文件

- `docs/deepseek-llm-api-wire-extensions.md`（字段、请求头、接受语义的权威说明）
- `packages/llm/deepseek-llm-api-extensions/src/index.ts`、`src/types.ts`（注册表）
- `packages/session/session-log-deepseek/src/index.ts`、`src/types.ts`（贡献器）
- `packages/llm/llm-deepseek/src/adapter.ts`、`request-extensions.ts`、`messages-api.ts`、`config.ts`、`host.ts`（Messages 适配器）
- `packages/account/deepseek-auth/README.md`（插件调用 DeepSeek API 的凭据服务）
- `packages/client/ui-settings-session-log/src/client/`（设置开关）
- `packages/compaction/compaction-basic/src/summarizer.ts`、`packages/session/session-title-llm/src/index.ts`（携带 `sessionId` 的辅助调用先例）
- `packages/bundle/base/cordis.patch.yml`（默认装配）
