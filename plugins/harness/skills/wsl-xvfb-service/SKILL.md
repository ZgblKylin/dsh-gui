---
name: wsl-xvfb-service
description: 一次性安装 skill：检测 WSL 的真实环境（二进制路径、可用显示编号、分辨率、已有 service），为 computer-use 生成并启用 Xvfb 与 openbox 的 systemd user service，并把 dsh 的显示环境切到该虚拟桌面。
whenToUse: WSL 下 computer-use 缺少 Xvfb/openbox 虚拟桌面，或需要修复、重装这两个 systemd user service 时使用；完成后不需要重复执行。
---

# 为 computer-use 安装 Xvfb 虚拟桌面

这是一次性安装 skill，不随 `plugins/harness/` 的其他内容安装到 dsh home。它指导 agent 先用检测命令确认真实环境，再生成 service 文件，避免把二进制路径、显示编号或分辨率写死。

## 何时需要

dsh 的 computer-use（cua-driver native）在 WSL 下需要 Xvfb 虚拟桌面：WSLg 的 Weston 占用窗口管理器且不维护 `_NET_CLIENT_LIST`，Xwayland 的 root window 不可截图，因此 cua 无法枚举窗口或截取全屏。

当 `wsl-workarounds` 安装流程提示缺少 `xvfb.service` 或 `openbox.service` 时，执行本流程。

## 检测

逐项执行，记录结果；后面的生成步骤只使用检测得到的值。

1. 确认在 WSL 内运行：

   ```bash
   grep -qi microsoft /proc/version && echo WSL || echo not-WSL
   test -d /mnt/wslg && echo WSLg-present || echo WSLg-absent
   ```

2. 确认二进制已安装；缺失时按发行版安装 `xorg-server-xvfb` 与 `openbox`（Arch）或 `xvfb` 与 `openbox`（Debian/Ubuntu）：

   ```bash
   command -v Xvfb
   command -v openbox
   ```

3. 检查现有 service 与运行状态，避免重复生成：

   ```bash
   ls -la ~/.config/systemd/user/xvfb.service ~/.config/systemd/user/openbox.service 2>/dev/null
   systemctl --user is-active xvfb.service openbox.service 2>/dev/null
   pgrep -a Xvfb
   pgrep -x openbox
   ```

4. 选择显示编号：优先 `:99`，若已被其他 Xvfb 占用则改用 `:98`、`:97` 等。用 `xdpyinfo` 判断某个编号是否可用：

   ```bash
   for d in 99 98 97; do
     DISPLAY=:$d timeout 2 xdpyinfo >/dev/null 2>&1 && echo ":$d in-use" || echo ":$d free"
   done
   ```

5. 参考分辨率：WSLg 可用时读取其物理尺寸作为默认值，否则使用 1920×1080：

   ```bash
   DISPLAY=:0 timeout 2 xdpyinfo 2>/dev/null | grep dimensions
   ```

6. 定位 dsh 的 systemd user unit（后续需要把 `DISPLAY` 指到虚拟桌面）：

   ```bash
   systemctl --user list-units --type=service --all | grep -i dsh
   ```

## 生成 service

用检测结果替换下方占位符：

- `<DISPLAY_NUM>`：第 4 步选中的编号；
- `<RESOLUTION>`：第 5 步得到的尺寸，格式 `<宽>x<高>`；
- `<XVFB>`：`command -v Xvfb` 的绝对路径；
- `<OPENBOX>`：`command -v openbox` 的绝对路径。

`~/.config/systemd/user/xvfb.service`：

```ini
[Unit]
Description=Virtual X server (Xvfb :<DISPLAY_NUM>) for headless desktop automation (cua-driver)
After=network.target

[Service]
Type=simple
ExecStart=<XVFB> :<DISPLAY_NUM> -screen 0 <RESOLUTION>x24 -ac -nolisten tcp
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/openbox.service`：

```ini
[Unit]
Description=Openbox window manager on Xvfb :<DISPLAY_NUM> (EWMH for cua-driver)
After=xvfb.service
Requires=xvfb.service

[Service]
Environment=DISPLAY=:<DISPLAY_NUM>
ExecStart=<OPENBOX>
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
```

不要写成等待 `/tmp/.X11-unix/X<DISPLAY_NUM>` 文件出现的健康检查：xorg-server 21.1 的 Xvfb 使用 abstract socket，该文件不会出现，等待会超时并把 unit 拖成 failed。openbox 的 `Restart=on-failure` 会重试到 X server 就绪。

## 启用与验证

```bash
systemctl --user daemon-reload
systemctl --user enable --now xvfb.service openbox.service
systemctl --user is-active xvfb.service openbox.service
DISPLAY=:<DISPLAY_NUM> xdpyinfo | grep dimensions
```

确认 openbox 已建立 EWMH 客户端列表（有窗口时 `nitems` 大于 0）：

```bash
DISPLAY=:<DISPLAY_NUM> python3 - <<'PY'
import ctypes, ctypes.util
x11 = ctypes.CDLL(ctypes.util.find_library('X11'))
x11.XOpenDisplay.restype = ctypes.c_void_p; x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
dpy = x11.XOpenDisplay(b':<DISPLAY_NUM>')
x11.XDefaultRootWindow.restype = ctypes.c_ulong; x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
root = x11.XDefaultRootWindow(dpy)
x11.XInternAtom.restype = ctypes.c_ulong; x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XGetWindowProperty.restype = ctypes.c_int
x11.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
    ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong))]
atom = x11.XInternAtom(dpy, b'_NET_CLIENT_LIST', 0)
t = ctypes.c_ulong(); f = ctypes.c_int(); n = ctypes.c_ulong(); a = ctypes.c_ulong(); p = ctypes.POINTER(ctypes.c_ulong)()
x11.XGetWindowProperty(dpy, root, atom, 0, 64, 0, 0, ctypes.byref(t), ctypes.byref(f),
    ctypes.byref(n), ctypes.byref(a), ctypes.byref(p))
print('_NET_CLIENT_LIST nitems:', n.value)
PY
```

## 切换 dsh 的显示环境

把第 6 步定位到的 dsh unit 中 `Environment=DISPLAY=:0` 改为 `Environment=DISPLAY=:<DISPLAY_NUM>`，并注释或删除 `WAYLAND_DISPLAY`，避免 cua 尝试未实现的 Wayland 后端：

```bash
systemctl --user daemon-reload
systemctl --user restart <dsh 的 service 名>
```

重启会断开当前 dsh 会话的 Web 连接，刷新页面即可恢复。

## 验证 computer-use

重启 dsh 后：

- `get_desktop_state` 返回 `<RESOLUTION>` 截图；
- `list_windows` 返回窗口列表（空桌面时为空数组）；
- 在虚拟桌面启动一个应用（例如 `DISPLAY=:<DISPLAY_NUM> chromium --ozone-platform=x11 --force-renderer-accessibility --user-data-dir=/tmp/cua-probe about:blank &`）后，`list_windows` 与 `get_window_state` 应能发现并截图该窗口。

## 注意

- 虚拟桌面不可见，用户手动使用的 GUI 应用仍应使用 `DISPLAY=:0`（WSLg）。
- 修改分辨率只需调整 `xvfb.service` 的 `-screen` 参数并重启该 service。
- 已存在的 service 文件不要直接覆盖：先 `systemctl --user cat` 对照，确认差异后再更新。
