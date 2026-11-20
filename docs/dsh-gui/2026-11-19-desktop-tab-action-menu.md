# desktop 标签操作菜单与远程重启

desktop 壳的标签条在每个远端标签行尾提供 `⋯` 操作菜单，菜单包含带图标的刷新（`⟳`）、重启（`⟲`）与断开（`✕`）三项；菜单触发器与关闭按钮在前台标签上固定显示，在后台标签上随悬停或键盘聚焦显示。行为契约以插件 [README](../../plugins/desktop-tabs/dsh-desktop-tabs/README.md) 的「交互」与「远程连接生命周期」两节为准，本文件记录设计依据与验证结果。

## 设计决定

**菜单挂在应用文档，而不是标签条内部。** 标签条位于 Windows 标题栏带内（`position: fixed`，`z-index` 2147483001），没有自己的布局容器；菜单若作为标签行的绝对定位子元素会被标签条的 `overflow: hidden` 裁切。菜单因此追加到 `document.body`，固定定位在触发器下方，并在视口内夹取；层级高于远端视图层，低于桌面外壳的强制提示层。

**可见性由 CSS 的 `visibility` 控制，而不是 `display`。** 按钮组在后台标签上隐藏但不移出布局，避免悬停时标签宽度跳变；`visibility: hidden` 同时让隐藏的按钮不进入 tab 序。前台标签通过行上的 `data-dsh-desktop-tab-active` 固定显示按钮组，后台标签通过 `:hover`、`:focus-within` 与菜单打开标记显示。

**每个动作带图标。** 刷新、重启、断开分别使用 `⟳`、`⟲`、`✕`；图标标记为 `aria-hidden`，按钮的可访问名仍是中文标签，图标与标签由 flex 间距分开。

**重启在 host 半执行，客户端只负责进度占位。** 重启需要先关闭远端 dsh 再重新拉起，涉及本机 ssh/wsl 子进程、远端 tmux 会话与连接状态记录，放在客户端会跨层复制连接生命周期。host 半提供 `POST /desktop-tabs/api/connections/<id>/restart` 路由：SSH/WSL 连接由连接管理器先断开本地隧道、对远端执行 `tmux kill-session -t dsh-gui`，再走正常的 `up` 流程；`remote` 连接由 remote-tab supervisor 停止本机子后端后重新 spawn。客户端在请求期间显示该标签的空白占位页并轮询连接日志，成功后加载返回的新 URL。

**`down` 与 `dispose` 只断本地侧。** 重启是唯一会向远端发送停止命令的动作；关闭标签、刷新（对 SSH/WSL）与退出应用都不触碰远端 tmux 会话。

**`url` 标签的重启项禁用。** 这类标签只指向固定地址，没有由本应用管理的远端进程；菜单保持三项同形，禁用项通过 `title` 说明原因。刷新只卸载并重新加载同一地址。

## 实现位置

| 位置 | 内容 |
|---|---|
| `src/client/tab-menu.ts` | 菜单 DOM、带图标的三个动作、视口定位与夹取、方向键/`Home`/`End` 导航、`Esc` 焦点归还、失焦/滚动/窗口变化关闭 |
| `src/client/tabs.ts` | 行尾按钮组、菜单接线、`restartTab` 的占位页与日志轮询、动作可用性 |
| `src/client/styles.ts` | 前台固定/后台悬停显示、菜单与禁用项样式 |
| `src/client/api.ts` | `restartConnection` 客户端调用 |
| `src/remote/index.ts` | `restart` 动作路由与 remote-tab 分派 |
| `src/remote/session.ts` | SSH/WSL 重启：本地清理、远端 kill、继续 `up` 的连接日志 |
| `src/remote-tab/supervisor.ts`、`routes.ts` | remote-tab 重启：停止子后端后重新 spawn |

## 验证

包目录内构建与全部行为测试：

```
pnpm run build
pnpm run test
```

覆盖范围：

| 测试 | 覆盖 |
|---|---|
| `tests/tab-menu.spec.ts` | 三项与图标渲染、禁用项、选中前关闭、触发器自身点击不误关、外部指针/`Esc`/滚动关闭、方向键与 `Home`/`End`、重新打开只保留一个根、`dispose` |
| `tests/remote.test.mjs` | 重启顺序（本地清理 → 远端 kill → 重新连接）、`/restart` 路由分派、未知 id 返回 502 且不发起连接 |
| `tests/remote-tab-supervisor.spec.ts` | 重启停止旧子进程并 spawn 新子进程、状态回到 `up` |
| `tests/remote-tab-routes.spec.ts` | bridge 的 `restart` 解析保存行并分派、非 remote id 拒绝、路由返回新 URL |

运行中的桌面应用通过 `link:` 安装使用本仓库的包，重新构建 `lib/` 后需要重启应用才会加载新的 host 与 browser 半；人工 UI 验收在重启后执行。

## 已知限制

- 重启关闭的是共享的 `dsh-gui` tmux 会话：同一远端主机或 WSL 发行版上的其他标签、Tauri 外壳与 `dsh-remote` 都会失去后端，需要各自刷新或重启。菜单与 README 都按此语义描述。
- `url`/`port` 标签没有可管理的远端进程，重启项禁用；刷新只重新加载地址。
- 菜单依赖 `document.body` 与应用文档的固定定位层；普通 `dsh web` 页面不渲染标签条，因此不会出现该菜单。
