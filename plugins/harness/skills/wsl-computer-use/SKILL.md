---
name: wsl-computer-use
description: WSL 下 computer-use（cua-driver native）的可用前提、验证方法与限制说明：WSLg 为何不可用、需要 Xvfb 虚拟桌面、a11y 元素树如何开启、哪些能力可用。
whenToUse: 在 WSL 中运行 dsh、使用 computer-use（cua）操作 Linux GUI 应用，或排查 cua 在 WSL 下窗口枚举为空、截图失败时使用。
---

# WSL 下 computer-use 的可用前提与限制

## 为什么不能直接用 WSLg

WSLg 的 `DISPLAY=:0` 可以连接，但 cua-driver 的 Linux 后端在其中两项核心能力上不可用：

- **窗口枚举为空**。WSLg 的 Weston 自带 XWM，已经占用窗口管理器位置，其 `_NET_SUPPORTED` 只声明 7 个原子，不包含 `_NET_CLIENT_LIST`。cua 枚举窗口依赖该属性，因此 `list_windows` 始终返回空数组。
- **全屏截图失败**。Xwayland 的 root window 没有可读 framebuffer，`get_desktop_state` 对 root 做 `XGetImage` 返回 `BadMatch`。

由于 Weston 占用了窗口管理器位置，在 `:0` 上再启动 openbox 会报「已经有窗口管理器运行在屏幕 0」。因此 computer-use 需要独立的 Xvfb 虚拟桌面。

cua-driver 官方验证的 Linux 环境是 Xvfb/Openbox、Xorg、GNOME、KDE 6 与 Sway；WSLg 不在支持矩阵内。Xvfb 与 openbox 的组合与官方 CI 环境一致。

## 虚拟桌面

computer-use 需要 Xvfb 与 openbox 提供的 systemd user service。虚拟桌面未安装时，`get_desktop_state` 与 `list_windows` 不可用；安装方法由 dsh-gui 安装流程的终端提示给出，本 skill 不重复。

## 验证 computer-use

dsh 已使用虚拟桌面（`DISPLAY=:<编号>`）时，依次检查：

- `get_desktop_state` 返回虚拟桌面的分辨率截图；
- `list_windows` 返回窗口列表（空桌面时为空数组，此时 `get_desktop_state` 仍应成功）；
- 在虚拟桌面启动应用后，`list_windows` 与该应用的 `get_window_state` 能发现并截图窗口。

## 元素树与 a11y

cua 的窗口元素树来自 AT-SPI。Chromium 系应用需要 `--force-renderer-accessibility` 启动参数才会暴露 accessibility 树，例如：

```bash
chromium --ozone-platform=x11 --force-renderer-accessibility --user-data-dir=/tmp/profile about:blank
```

元素树的 role、名称与 actions 可用于定位。注意当前 dsh 的 cua 工具层只投影元素的索引与文本，不包含 `element_token` 与 `snapshot_id`，因此 `click` 无法直接按元素点击，只能使用坐标；SDK 层（`@trycua/cua-driver` 的 `click` 配合 `ClickPosition.Element`）可以使用 `element_token` 完成元素点击。

网页操作不需要走 computer-use：browser-use（Playwright MCP）提供页面级元素定位，见 `wsl-edge-browser-use`。

## 已知限制

- **虚拟桌面不可见**。用户看不到虚拟显示上的窗口，agent 通过截图观察。dsh 内启动的 GUI 应用都会落在该显示上；手动使用的 GUI 应用仍应使用 `DISPLAY=:0`（WSLg）。
- **分辨率固定**。修改 `xvfb.service` 的 `-screen` 参数后重启该 service。
- **cua 的 Linux 支持范围有限**。WSLg 不在官方验证矩阵内，以上配置只恢复窗口枚举与截图，应用级行为仍可能与其支持的桌面环境存在差异。
- **输入注入依赖 XTEST**。Xvfb 提供 XTEST 扩展，点击与键盘操作可用；若遇到投递失败，先确认应用窗口处于可交互状态。
