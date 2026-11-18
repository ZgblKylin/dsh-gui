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

路由绑定在环回地址上，设置类接口只接受同源请求；覆盖页与助手通道使用每次启动生成的 token。

## 设置

设置文件为 `<DSH_HOME>/quick-assistant/settings.json`（原子写入，保留未知字段）。默认值：

| 项 | 默认值 |
|---|---|
| 快捷键 | `Ctrl+Alt+Space` |
| 回答此问题提示词 | `{{text}}` |
| 文本翻译提示词 | 见 `src/prompts.ts` 的默认模板 |
| 内容总结提示词 | `帮我总结一下这段话\n\n{{text}}` |
| 解释说明提示词 | `帮我解释一下这个概念\n\n{{text}}` |
| 自动翻译第一/第二语言 | `zh-cn` / `en-us` |

提示词占位符：`{{text}}`、`{{sourceLanguage}}`、`{{targetLanguage}}`、`{{primaryLanguage}}`、`{{secondaryLanguage}}`。源语言为「自动」时提示模型自行识别；目标语言为「自动」时提示模型从第一、第二语言中选择与原文不同的一种。

每个模式可以单独指定 provider / model / 思考等级；关闭「单独配置模型」时跟随主模型。

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
