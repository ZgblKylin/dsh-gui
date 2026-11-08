# desktop 远端会话大图的右键菜单与复制图片

## 结论摘要

- Electron 不提供 Chromium 的默认右键菜单：菜单必须由应用在主进程用 `Menu.popup()` 构建。desktop 主进程只在主窗口上装了一个 `context-menu` 处理器，且只处理可编辑控件与选区文本；租约 guest 的 session 没有任何菜单处理器，因此远端标签里右键图片没有任何反应。
- Tauri 外壳的远端连接标签是 WebView2 子 webview，未禁用 WebView2 默认菜单，其原生菜单自带「复制图片」，所以两条链路的表现不同。
- 修复落在 `plugins/desktop-tabs/dsh-desktop-tabs` 的 client 半：应用文档接收 guest 的 `context-menu` 事件，显示自绘菜单，并在应用文档写系统剪贴板。guest 会话拒绝一切权限，不能直接写图；应用文档是 `dsh-app://app` 的 secure context，其 session 放行非媒体权限，点击菜单项也给它焦点与用户激活。
- 端到端验证：临时 `url` 标签加载含 96×64 PNG 的本机静态页，在图片上右键出现「复制图片」，点击后系统剪贴板得到 96×64 位图，像素与源图一致；非图片区域右键不弹菜单，`Esc` 关闭菜单。

## 一、根因

- Electron 自身不绘制 Chromium 的默认菜单。`deepseek-harness/apps/desktop/src/main.ts` 的 `webContents.on('context-menu', …)` 只挂在主窗口上，且只在 `isEditable` 或存在选区文本时构建菜单项，没有 `mediaType === 'image'` 分支。
- 远端标签的 `<webview>` guest 由外壳的租约通道创建（`deepseek-harness/apps/desktop/src/browser-guests.ts`），主进程没有给 guest 装 `context-menu` 处理器，页面里也没有自绘菜单，因此右键既不出原生菜单，也不出页内菜单。
- Tauri 外壳（`src-tauri/src/views.rs`）用 WebView2 承载连接标签，WebView2 的默认菜单对图片提供「复制图片」，因此同一操作在 Tauri 侧本来可用。

## 二、机制

`src/client/image-menu.ts` 与 `src/client/view.ts` 共同完成一条 guest → 应用文档的转接链路：

- **触发**：`view.ts` 给每个 guest 的 `<webview>` 元素监听 `context-menu` 事件。事件参数为 `params`，含 `x`、`y`（guest 视口坐标）、`mediaType` 与 `srcURL`。只有 `mediaType === 'image'` 时才打开菜单；菜单坐标取 guest 的 `getBoundingClientRect().left/top` 加 `params.x/y`，并夹取到窗口内。
- **菜单**：应用文档里一个 `role="menu"` 的 `position: fixed` 容器，唯一菜单项为 `role="menuitem"` 的「复制图片」按钮。打开时聚焦菜单项；再次右键重开；`Esc`、菜单外 `pointerdown`、窗口 `blur`/`resize`/`scroll`、切换/隐藏/刷新/关闭标签、图层 dispose 都会关闭菜单。关闭后焦点交还当前 guest，被替换（generation 失效）的 guest 不弹菜单。
- **取图**：打开菜单时向 guest 求值取图脚本（`webview.executeJavaScript`，与通知、剪贴板转接同一通道）。脚本用 `document.elementFromPoint(x, y)` 向上找 `IMG`，找不到时按 `currentSrc`/`src` 匹配 `document.images`；按 `naturalWidth`/`naturalHeight` 画到 canvas 后 `toDataURL('image/png')`。canvas 被跨源污染或找不到元素时，用 `fetch(srcURL, { credentials: 'include' })` 取回 blob，经 `Image` + canvas 重编码为 PNG。只有 `data:image/png;base64,` 前缀的结果会被接受。
- **写剪贴板**：guest 会话的权限处理器一律拒绝，`navigator.clipboard.write` 在 guest 内不可用，且 guest 没有可注入的 preload。应用文档解码 data URL 得到 `image/png` Blob，再以 `new ClipboardItem({ 'image/png': blob })` 交给 `navigator.clipboard.write`。
- **失败反馈**：guest 没取到图（元素找不到、求值失败、返回非 PNG）时菜单项显示「无法读取图片」并禁用；剪贴板写入失败（无 `ClipboardItem`、解码失败、权限拒绝）时显示「复制失败，请重试」，1.5 s 后恢复为可重试的「复制图片」；成功则关闭菜单。

## 三、验证

- 包内测试：`pnpm run test` 全绿，`tests/image-menu.spec.ts` 覆盖取图脚本参数拼接与回退、PNG 校验、`ClipboardItem` 写入、菜单定位与夹取、复制成功、取图失败与写入失败文案、`Esc`/菜单外点击/窗口事件关闭、重开与 dispose 的监听清理，以及视图层 `context-menu` 接线、非图片忽略、stale guest、切换/隐藏/dispose 关闭菜单。
- 端到端：在 desktop profile 的 `desktop-tabs.json` 临时加入 `url` 标签指向本机静态页（一张 96×64、含黄色区块的 PNG），重启 desktop 应用加载新构建的 `lib/client.js`。右键图片出现菜单「复制图片」；点击后系统剪贴板得到 96×64 位图，像素 (15,15) 为 (240,220,40)、(0,0) 为 (18,52,86)，与源图一致；在非图片区域右键不弹菜单，`Esc` 关闭菜单，复制成功后菜单自动关闭。
- 验证完成后关闭测试标签（标签列表写回配置文件）并结束临时静态服务。

## 四、边界

- 只处理 `mediaType === 'image'`。图片以外的右键（文本、链接、可编辑控件）在远端标签里仍没有菜单，这是 desktop 外壳的既有行为，不在本次范围。
- 「复制图片」写入的是 canvas 重编码得到的 PNG 位图：动图只复制当前帧，EXIF 与色彩配置等原始格式信息丢失（透明通道保留），超大图受 Chromium 的 canvas 尺寸上限约束。
- 取图依赖 guest 页面里的图片元素或可访问的源地址：`elementFromPoint` 与 `document.images` 都未命中、且 `fetch(srcURL)` 因跨源无 CORS 失败时，菜单显示「无法读取图片」。harness 的大图预览使用同源或 `blob:` 地址，可用。
- 本机标签（应用主文档）的图片右键仍走上游 desktop 的行为，没有「复制图片」菜单；本文件只覆盖远端标签的 guest。

## 五、涉及文件

- `plugins/desktop-tabs/dsh-desktop-tabs/src/client/image-menu.ts`：guest 取图脚本、data URL 写剪贴板、应用文档菜单与生命周期。
- `plugins/desktop-tabs/dsh-desktop-tabs/src/client/view.ts`：guest `context-menu` 监听、菜单打开与关闭时机、焦点交还。
- `plugins/desktop-tabs/dsh-desktop-tabs/src/client/styles.ts`：菜单样式。
- `plugins/desktop-tabs/dsh-desktop-tabs/tests/image-menu.spec.ts`：行为测试。
- `plugins/desktop-tabs/dsh-desktop-tabs/README.md`：「远端图片右键菜单（复制图片）」小节与已知限制。
