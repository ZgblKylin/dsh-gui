# 更新日志（更新日志弹窗）与一次性 node 脚本的退出约定

## 功能

更新对话框每行只要落后于远端就有「更新日志」按钮，用于预览本次更新会带来的
变更。tag 目标优先读取 **官方 GitHub Release 说明**，并且覆盖本次更新引入的
**全部** Release，而不只是更新目标那一个：候选范围按 git 可达性判定——「可以从
更新目标到达、但不能从本地 HEAD 到达」的 tag（`git tag --merged <目标>
--no-merged <HEAD>`）再加上目标 tag 本身，也就是这次更新引入的 tag；例如本地停在
`v0.3.14`、目标是 `v0.3.22` 时会列出 8 个版本（`v0.3.15` → `v0.3.22`）。请求走
GitHub 的分页 Release 列表接口（`/releases?per_page=100`，最多 3 页，取齐候选
tag 即提前停止），按 `published_at` **时间逆序**渲染，每个版本一节
（`## <tag> · <名称>` + 发布日期 + 正文），节间用 `---` 分隔；没有正文的
Release 仍然保留版本标题并标注「（该 Release 没有正文）」，范围内没有任何
Release 的 tag 会在文末以引用块列出，标题栏也会写明「N 个 tag 无 Release」。

可达性判定的两点已知取舍：

- **会漏**：squash / rebase 合并进主分支的分支上的 tag 不在可达范围内，因此不会
  列出——这类版本的说明需要人工去 GitHub 看；
- **可能多**：在本次新增提交上打的非版本 tag（如 nightly / build tag）也在候选
  范围内，没有对应 Release 时会出现在文末的「没有对应的 GitHub Release」列表里。
  dsh-gui 自己这套仓库的 tag 都是版本号，因此实际只会列出真正缺 Release 的版本。
  另外 GitHub 对未认证请求不返回 draft Release，只有 draft 的 tag 也会被算作缺
  Release。

提交目标、非 GitHub 远端、范围内没有 Release、或所有 Release 都没有正文时，改由
dsh AI 在「本地 HEAD → 更新目标」的提交区间上汇总（见
`src-tauri/src/changelog.rs` 的 `prepare` / `finish`）。AI 路径优先走运行中
harness 的 raw-LLM 路由（dsh-ai-update 插件的 `/dsh-gui-api/changelog`，不建
Agent/Session），不可用时回退到一次性 headless 运行（会话存储重定向到临时目录，
用完删除）。单个版本的更新保留原有的
`GitHub Release「<名称>（<tag>）」官方说明（发布于 …）` 标题格式。

## 标题里的 Release 页链接

`prepare` 的 Release 查询一旦**真的取到** Release（`ReleaseLookup::Found`，
含「有 Release 但都没有正文」这种落到 AI 汇总的分支），返回的
`UpdateChangelog` 就带上 `releaseUrl`；前端（`ui/app.js` 的
`renderChangelogTitle`）据此把弹窗标题里的**模块名**渲染成链接，其余
（`· 更新日志`）保持纯文本，标题整体文本不变。

- 链接目标是仓库的 **Releases 列表页**
  `https://github.com/<owner>/<repo>/releases`，即 `releases_page_url` 用
  `origin` 解析出的 `owner/repo` 拼成；**不是** `/releases/tag/<tag>` 子页面——
  一次更新可能跨多个 Release，落到具体 tag 会把读者带进单个版本。
- 触发条件是「检索到 GitHub Release」：`Absent`（范围内没有 Release）、
  `NotGithub`（origin 非 GitHub）、`Failed`（接口失败）以及「当前提交已与更新
  目标一致」这几种情况都不附带链接，标题保持纯文本。
- AI 汇总路径同样继承该链接（`SummaryRequest.release_url`）：Release 存在但没正文
  时，正文由 AI 生成、标题仍可点进 Releases 页。
- 点击行为：标题行不可选中（外壳全局 `user-select: none`），因此**普通单击**就经
  `open_external` 交给系统浏览器；Ctrl/Cmd+点击由 document 级捕获监听器处理，
  本地处理器在带修饰键时直接放行，避免同一次点击开两个标签页。正文里的链接仍保
  持原有的「Ctrl+点击打开」约定。
- 线协议由 `#[serde(rename_all = "camelCase")]` 定名：Rust 的 `release_url`
  序列化为 `releaseUrl`（`None` → `null`），有测试
  `changelog_serializes_the_release_page_under_the_frontend_field_name` 钉住。

## 曾出现的故障：已写出的结果被误判为获取失败

（Windows）点「更新日志」时，tag 目标会显示

```
GitHub Release 获取失败（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
file src\win\async.c, line 94），不影响本次汇总
```

脚本写在 stdout 上的那份 JSON 被丢弃了：`release_notes` 先检查 `output.success`，
子进程被 libuv 断言中止（退出码非零）后它从未去解析 stdout。被丢掉的既可能是
`{ok:true,…}` 的 Release 正文（于是本可秒出的官方说明退化到较慢的 AI 汇总），
也可能是 `{ok:false,status:404}` 这个「该 tag 没有 Release」的结论——后者正是
用户看到的那条：本该显示「没有对应的 GitHub Release」，却把断言文本当成网络
错误显示出来。

## 根因

`RELEASE_FETCH_SCRIPT` 与 `NPM_FETCH_SCRIPT` 都曾以
`console.log(...)` + `process.exit(0)` 结束。`process.exit()` 会立刻销毁
Environment，而 `fetch`（undici）的连接池此时仍持有待处理的 async 句柄；libuv
在 Windows 上对已在关闭中的 handle 调用 `uv_async_send` 即触发

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

复现条件与结果（Node v24.19.0，stdout/stderr 重定向到文件，与 Rust 侧
`run_node_captured` 的 stdio 形态一致）。这是**竞态**，与传输路径和时序有关，
并非每次必现；因此下面同时给出两轮独立测量的口径：

- 旧脚本 + 真实 `api.github.com` 的 404 / 403（限流）：本机 6/6 次、独立复核
  21/21 次断言中止（退出码 `0xC0000409`），而 stdout 上是完整 JSON；
- 旧脚本 + HTTPS 200：独立复核在 `registry.npmjs.org` 上 9/10 次中止，但在
  `api.github.com` 的一个 200 样本上 6/6 次未复现——触发因素不是状态码本身；
- 旧 npm 脚本 + 含 404 包的批次（`semver` + 不存在的包）：本机 6 次中 5 次、
  独立复核 16/20 次中止；纯已发布或纯 404 的批次未复现；
- 旧脚本 + 连接被拒 / DNS 失败（`fetch` reject 分支）、纯 HTTP 本地 fixture：
  不触发——正因是竞态，这条 bug 才时而出现时而消失。

## 约定（两个脚本均已按此实现）

- **不得调用 `process.exit()`**。结果用
  `writeSync(1, JSON.stringify(...) + '\n')` 写出：stdout 是文件句柄时写入是同步
  的，保证在进程结束前落盘，不需要靠 `process.exit` 冲刷；
- 无论 200、404 还是其他状态码，响应体都要读完（`response.json()`）或取消
  （`response.body?.cancel()`），不留半读的连接；
- 脚本不再显式退出，事件循环自然排空后进程结束。实测新脚本约 60 次调用覆盖
  200 / 404 / 403 / 连接被拒 / DNS 失败：全部退出码 0、stderr 为空、stdout 为
  完整单行 JSON，用时 0.2–1s，远低于 Rust 侧 45s（Release）与 60s（npm）超时；
- **Rust 侧解析以 stdout 的 JSON 行为准**：即使子进程退出码非零，只要 stdout
  上有可解析的结果就采用（`parse_release_capture`、`emitted_npm_json`），
  只有没有可用结果时才回落到退出码与 stderr 诊断。这样即使将来子进程再出现
  别的退出竞态，也不会把一份完整答案丢掉。

## 回归保护

- `changelog.rs`：`embedded_release_script_never_calls_process_exit`、
  `release_capture_prefers_the_emitted_line_over_a_crashed_child`、
  `release_capture_lists_every_release_newest_first`、
  `release_capture_maps_status_and_network_answers`、
  `release_capture_reports_the_crash_when_nothing_was_emitted`、
  `release_range_tags_covers_every_tag_the_update_brings_in`、
  `release_subtitle_and_body_cover_a_multi_release_update`、
  `releases_page_url_points_at_the_release_list_not_a_tag_subpage`、
  `changelog_serializes_the_release_page_under_the_frontend_field_name`；
- `update.rs`：`embedded_npm_script_never_calls_process_exit`、
  `npm_answer_is_used_even_when_the_child_aborted`。

## 多 Release 逻辑的实测

用真实数据端到端跑过 `prepare`（当时 `plugins/dsh-web-ui/dsh-web-ui` 本地停在
`v0.3.14`、远端最新 tag `v0.3.22`）：输出 8 节、标题为
`GitHub Release 官方说明 · 8 个版本（v0.3.15 → v0.3.22，最新在上）`，
发布日期严格递减（2026-09-13 → 2026-09-05），正文长度 5850/11829/… 字符；把该
文档再喂给 `ui/app.js` 的 `renderChangelogMarkdown`（从源码切片、原样加载）得到
8 个 `<h2>`、日期 `<em>`、正文列表与引用块均正常。脚本侧的边界情况同样实测：
单个 tag → 1 个 Release；真实 tag + 不存在的 tag → `missing` 只含后者；只有不
存在的 tag / 空候选列表 → 0 个 Release，Rust 侧落到「没有对应的 GitHub
Release」备注；分页未取齐（超过 3 页）时不把剩余 tag 报成「没有 Release」，而是
`partial` / 「无法确定」并交回 AI 汇总兜底。注意 404 的语义随接口改变：列表接口
只有仓库不可访问（私有、改名、删除）才返回 404，因此现在按获取失败处理；旧脚本
用的 `/releases/tags/<tag>` 里 404 才表示「该 tag 没有 Release」。已知既有行为：
Release 正文里的原生 HTML（例如 dsh-web-ui 用的 `<details>` 英文镜像）会被转义为
文本显示，这与本次改动无关。

## 弹窗提示文本可选中

外壳 `body` 全局 `user-select: none`，更新日志弹窗里只有正文
（`.changelog-body`）重新允许选中，导致出处说明与失败文本无法拖选复制。
`src-tauri/ui/titlebar.css` 现为 `.changelog-sub`（出处说明，含
「GitHub Release 获取失败（…）」这类备注）与 `.changelog-loading`（加载中与
获取失败文本）显式设置 `user-select: text` / `-webkit-user-select: text` 并配
`cursor: text`。弹窗内「复制」按钮仍只复制正文源码，出错时可直接拖选提示行。

## 相关文件

- `src-tauri/src/changelog.rs` —— Release 查询、`releases_page_url`、AI 汇总、
  `run_node_captured`
- `src-tauri/src/update.rs` —— npm 版本核对脚本与 `emitted_npm_json`
- `src-tauri/ui/app.js` —— `openChangelog`：加载态、副标题与错误文本渲染；
  `renderChangelogTitle`：标题里的 Release 页链接
- `src-tauri/ui/titlebar.css` —— `.changelog-sub` / `.changelog-loading` 可选中文案；
  `.changelog-dialog h2 a` 标题链接样式
- `docs/dsh-gui/update-check.md` —— 更新检查与 npm 发布状态
