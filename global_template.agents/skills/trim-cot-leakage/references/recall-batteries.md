# 探针清单

[泄漏类型](../SKILL.md#泄漏类型)的检索探针。每条命中都需要语义判断：探针按设计会过度匹配，也天然会漏判；每轮清理都会发现没有探针能命中的案例，所以要把它们与不依赖探针的通读配合使用。

## 调用规则

- 工程把 agent 文档放在以点开头的目录里时（如 `.agents/`），加 `--hidden`；ripgrep 默认跳过这类目录，这里正是最大的漏搜风险。
- 排除项必须放在最后，否则更靠后的包含模式会把它们重新纳入：该工程的第三方 vendored 目录、`node_modules/`、生成产物与录制快照，以及本技能自身目录（它引用泄漏措辞作为校准材料）。排除清单由项目布局决定，不要照抄某个仓库的路径。
- 命令里的 `...` 是占位符，这里填入要搜索的路径和该项目的排除 glob；照抄前先替换它，否则 ripgrep 会把 `...` 当成路径并报错。
- `--hidden` 只放开隐藏项，ignore 规则仍会让 ripgrep 跳过 `.git/`；需要连 `.git/` 一起搜索时用 `--no-ignore-vcs`，`--glob '!.git/**'` 只是显式排除，与默认跳过等价。
- 自然语言行加 `-i`，让句首大写也能命中（「This PR adds…」「Probably fine…」）；匹配代码模式的第一行保持大小写敏感，`-i` 会让 `\bT\d\b`、`\bP-I\b` 变成噪声。
- 匹配完整词组。`\bthis PR\b` 要命中「this PR adds」，但不能命中「this project」「this process」「this provider」。
- 零命中在命中过已知正例之前什么都不能证明；噪声模式在拒绝过近似负例之前同样什么都不能证明。两者都校准过，才能相信一次检索结果。
- 语言策略按项目定。单语项目检索混入正文的异语言残留；多语项目检索对照语言与未同步的片段。不要假设对侧的文件名（例如 `*.zh.md`），语言对与命名由项目配置。
- 正文与代码分开探。注释和 JSDoc 里同样会出现变更叙述，但它们的语法与 Markdown 不同，要分别跑 Markdown 与代码注释两组探针。
- 反向残留难用模式命中（中文段落里夹着英文短语，形态太散），改为对照两侧新增内容判断，或直接通读。

## 英文探针

```sh
rg -n --hidden '\(decision \d|\(audit [A-Z]\d|design §|plan §|design ledger|\(B ruling|\bP-I\b|\bW\d\b|\bT\d\b' ...
rg -n --hidden -i '\bthis PR\b|\bthis branch\b|\bthis stack\b|\blater PRs?\b|\bprevious commits?\b|\bthis commit\b' ...
rg -n --hidden -i '\bused to\b|\bno longer\b|\bpreviously\b|\bthe old\b|\bwas renamed\b|\bwas moved\b' ...
rg -n --hidden -i '\bv1\b|this cut|\bcut \d|\btoday\b|\bfor now\b|roadmap' ...
rg -n --hidden -i 'rejected in review|review round|reviewer|as of v\d' ...
rg -n --hidden -i 'probably |should be enough|should suffice|it simply|is safe —|is safe --' ...
rg -n --hidden '§\d' ...
```

## 中文探针

```sh
# 中文正文里的变更叙述与评审叙述。
rg -n --hidden '评审|上一?轮|旧版|老的|不再|以前|本版|本次改动|遗留' --glob '*.md' ...

# 英文正文里混入的中文工作碎片。
rg -n --hidden '设计稿|私有|(^|[^a-zA-Z])端([^a-zA-Z]|$)' --glob '*.md' ...
```

## 代码注释探针

```sh
# 代码注释与 JSDoc 里的英文变更叙述、评审视角与试探语。
rg -n --hidden -i '(^[[:space:]]*(//|/\*|\*)|//|/\*)[^\r\n]*\b(used to|no longer|previously|this PR|this branch|for now|rejected in review|reviewer)\b' --glob '*.{ts,tsx,js,jsx,mjs,cjs}' ...

# 代码注释与 JSDoc 里的中文变更叙述与评审叙述。
rg -n --hidden '(^[[:space:]]*(//|/\*|\*)|//|/\*)[^\r\n]*(评审|上一?轮|旧版|老的|不再|以前|本版|本次改动|遗留)' --glob '*.{ts,tsx,js,jsx,mjs,cjs,css}' ...

# Python 注释与 docstring 的同一组模式（英文与中文）。
rg -n --hidden -i '#[^\r\n]*\b(used to|no longer|previously|this PR|for now|rejected in review)\b' --glob '*.py' ...
rg -n --hidden '#[^\r\n]*(评审|上一?轮|旧版|老的|不再|以前|本版|本次改动|遗留)' --glob '*.py' ...
```

## 已知误报族

清理时逐条判断并保留；它们会再次出现：

- **工具性的 used to。**「the key used to sign requests」是工具性用法，不是时间性；时间性形式前面有主语状态（「colors used to come from…」）。
- **运行期的旧/新。**「旧连接排空后新连接才接受请求」指交接中的存活对象，不是仓库状态。
- **流程文档里的「本 PR」**。讲 PR 流程的文档（PR 模板、流程说明）合法地提到 PR；禁令针对的是文档采用某个 PR 对代码的视角。
- **作为协议或路径段的 v1。**`/v1/chat` 端点与线格式名是标识符，不是版本戳。
- **有归属文档的 §N**。外部标准（RFC 9110 §10.1.5）和拥有自己章节编号的提交文档可以按章节引用。
- **对照性的 actually 与名词性 wait**。普通英文，不是试探语；没有提交行探它们，只有扩展更宽的试探语模式时才会浮现。
- **运行期的 today 与录制时间戳**。提问当前日期或测试取当前日期的用法是自然时间，不是仓库版本戳；录制的 CLI 输出保留其原始口吻。会到达模型或用户的措辞，任何改动前仍然要满足行为证据规则。
- **版本化产物语境里的「本版本」**。它可能是「this release」的正当译法；被禁的是作为裸版本戳、对应「this cut」的「本版」。
- **备选方案小节**。设计文档里「否决」出现在备选方案这一文体槽位时是获准的归属处，不是评审编排。
- **运行时时序词「之前」「之后」。**「提交之前」「排空之后」描述运行期时序，不是仓库变更史；有主语状态对照的「以前」「不再」才是变更叙述。
- **作为存活概念的「旧版」**。同时存在的旧版协议报文、旧版接口属于运行期并存概念，不是仓库历史。
- **中文的「遗留」。**「遗留问题」「历史遗留」是常见技术用语，本身不构成评审叙述；要看上下文里是否在复述一次清理或评审过程。
