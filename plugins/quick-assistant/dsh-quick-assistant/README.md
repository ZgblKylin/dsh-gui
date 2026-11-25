# dsh-quick-assistant

快捷助手：在系统任意位置用全局快捷键唤起一个浮层面板，输入内容后选择「回答此问题 / 文本翻译 / 内容总结 / 解释说明」，由 DSH 内置 LLM 模块直接作答，不产生会话记录。

## 组成

| 部件 | 位置 | 职责 |
|---|---|---|
| Host 半 | `src/index.ts` 等，构建为 `lib/index.js` | `/quick-assistant` HTTP 路由、设置读写、LLM 流式调用、原生助手进程生命周期 |
| 覆盖页 | `assets/overlay.html|css|js` | 浮层窗口页面：输入框、四项菜单、四个子面板、置顶与关闭 |
| 设置页 | `src/client/**`，构建为 `lib/client.js` | 设置面板「快捷助手」分区：快捷键、四模式模型、提示词模板、自动翻译语言 |
| 原生助手 | `src-tauri/src/quick_assistant/main.rs`（第二个 bin） | 全局快捷键、无边框置顶窗口、失焦隐藏、窗口尺寸 |

原生助手是独立进程 `dsh-quick-assistant[.exe]`，由 Host 半在启动时拉起：Electron 桌面与 Tauri 外壳都不需要改动主进程即可共用同一实现。Host 半把一次性 token 与页面地址通过命令行传给助手，助手的页面与轮询请求凭该 token 访问 `/quick-assistant` 路由。

## 安装范围

- `desktop` profile（Electron 桌面）：普通安装并挂载。
- `web` profile（Tauri 外壳与浏览器页面共用的 profile）：只安装依赖，挂载行写入 `<DSH_HOME>/gui/shell-overlays/quick-assistant.patch.yml`。Tauri 外壳启动 `dsh web` 时把这些 overlay 文件作为额外 `--patch` 层传入，因此插件只存在于外壳内；直接运行 `dsh web` 打开的浏览器页面不加载它。

## 依赖的 DSH 接口

- `ctx.webServer`（`webServer` 路由）：`/quick-assistant` 前缀下的页面、资源、SSE 与设置 API。
- `ctx.llm`：`listProviders` / `listModels` / `resolveModelInfo` 读取模型目录，`stream` 执行请求；请求带 `purpose: 'quick-assistant'`。
- `ctx.agentDefaultModel`（可选）：模式未单独配置模型时读取主模型。

路由绑定在环回地址上，设置类接口要求 Host 会话 Cookie 并只接受同源请求；覆盖页与助手通道在传输层声明为匿名（助手是独立 WebView2 进程，拿不到 Host 的 Cookie），使用每次启动生成的 token。

## 设置

设置文件为 `<DSH_HOME>/quick-assistant/settings.json`（原子写入，保留未知字段）。默认值：

| 项 | 默认值 |
|---|---|
| 快捷键 | `Ctrl+Alt+Space` |
| 回答此问题提示词 | `You are a helpful assistant, reply in {{systemLanguage}}: {{text}}` |
| 文本翻译提示词 | 见 `src/prompts.ts` 的默认模板 |
| 内容总结提示词 | `Summarize the following text in {{systemLanguage}}:\n\n{{text}}` |
| 解释说明提示词 | `Explain the following text in {{systemLanguage}}:\n\n{{text}}` |
| 自动翻译第一/第二语言 | `zh-cn` / `en-us` |
| 默认思考等级 | 回答此问题 `low`；文本翻译、内容总结、解释说明 `off` |

提示词占位符：`{{text}}`、`{{systemLanguage}}`、`{{sourceLanguage}}`、`{{targetLanguage}}`、`{{primaryLanguage}}`、`{{secondaryLanguage}}`。`{{systemLanguage}}` 是系统语言的英文名（如 `Simplified Chinese`），由宿主进程的 `Intl` 区域设置推出。源语言为「自动」时提示模型自行识别；目标语言为「自动」时提示模型从第一、第二语言中选择与原文不同的一种。

思考等级独立于「单独配置模型」开关：关闭开关时它作用在主模型上，开启时作用在所选 provider/model 上。可选项来自模型自身声明的等级；模型没有声明 `off` 时设置页仍提供「关闭思考（off）」，此时请求省略思考等级并提示「当前模型不提供该等级」，由模型自身默认行为决定（部分 provider 的模型无法关闭思考）。

设置文档版本为 2：加载版本 1 的 settings.json 时，未被编辑过的默认提示词会替换为新默认值，用户改过的提示词保持不变。

## 回答渲染

- 「回答此问题」「内容总结」「解释说明」的回复按 Markdown 渲染（标题、段落、粗斜体、删除线、行内代码、围栏代码块、有序/无序列表、引用、分隔线、表格（支持 `:--`/`:-:`/`--:` 列对齐）、http(s) 链接），由 `assets/markdown.js` 自包含实现，所有文本以 `textContent` 写入，模型输出无法注入 HTML。
- 模型思考时，回复区域顶部显示一行「思考中」文本，随思维链流式更新并保持最新内容可见；正文第一个字符到达时移除该行。
- 每块模型回复（回答气泡、总结/解释结果、翻译译文）右上角有复制按钮，点击复制该块的原始 Markdown 文本（翻译复制译文纯文本），图标短暂变为对勾；结果为空时按钮隐藏。
- 退出子面板（返回、Esc、切换到其他模式）会立即中断在途的模型请求，并清空该子面板的回复内容：「回答此问题」的对话历史被丢弃，下次进入从头开始；「内容总结」「解释说明」的结果清空；「文本翻译」只清空译文，原文与源/目标语言选择保留。
- 关闭面板（关闭按钮、快捷键、失焦自动隐藏）只是隐藏窗口，不会清空内容，也不会中断在途请求：下次打开回到原界面，期间生成的回复继续流式写入，已完成或仍在生成的结果都会保留。

## 联网工具（回答此问题 / 解释说明）

这两个模式会把 `web_search`、`web_fetch` 两个工具声明给模型，模型自行决定是否联网；执行走 DSH 的 `ctx.web` 能力 seam（与内置 `web_search` / `web_fetch` 工具同一实现），不新增任何 provider 配置。

- 搜索与抓取结果作为工具消息回填给模型，提示词要求以 Markdown 链接标注来源。
- 每次调用工具时，回复区顶部的状态行显示「联网搜索：<查询词>」或「读取网页：<URL>」，正文开始后消失；模型在调用工具前输出的说明性文字会被丢弃（SSE `reset`），只保留最终回答。
- 每次请求最多 3 轮工具调用，超过后不再提供工具、直接让模型作答；单次搜索最多 8 条结果，单次抓取最多 20000 字符。
- `ctx.web` 不存在、搜索 provider 未就绪或模型/适配器不支持工具时，自动退回纯文本回答（首轮无输出时重试一次不带工具的请求），功能不受影响。
- 工具调用与模型请求共用同一个中止信号：关闭子面板、页面卸载都会同时取消搜索/抓取。

## 运行产物

| 路径 | 内容 |
|---|---|
| `<runtime-root>/dsh-quick-assistant[.exe]` | 原生助手（由 `npm run build` 或 `npm run build:desktop` 构建并落位） |
| `<DSH_HOME>/quick-assistant/settings.json` | 设置 |
| `<DSH_HOME>/gui/quick-assistant.log` | 助手诊断日志（启动、退出、快捷键注册失败） |
| `<DSH_HOME>/gui/quick-assistant-webview/` | 助手窗口的 WebView2 数据目录（覆盖页的 localStorage 状态保存在此） |
| `<DSH_HOME>/gui/shell-overlays/quick-assistant.patch.yml` | Tauri 外壳专用的挂载层 |

## 已知限制

- 全局快捷键只在 Windows 实现；其他平台助手进程仍可启动，但不会注册快捷键。
- 同一时间只应有一个助手进程持有快捷键：同时打开 Electron 桌面与 Tauri 外壳时，后注册的一方会报告快捷键已被占用。
- Electron 桌面的插件安装要求应用处于关闭状态（其 CLI 管理 `desktop` profile 的限制）。
- 助手找不到可执行文件时插件其余功能仍可用，`/api/health` 与设置页会给出原因。
- 部分 DeepSeek 模型的回复偶尔会把原生 DSML 工具标记（`<|DSML| calls>` …）当正文返回。这是 provider 侧已知的解析遗漏，与工具声明无关；当前不做本地解析，排查记录见 `docs/design.md` 的「遗留问题」。
