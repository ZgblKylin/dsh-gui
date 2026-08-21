# GUI window-frame interactions

The shell window is frameless (`decorations: false`) so the harness web UI can
sit directly below the custom title bar. Tauri v2 does not expose Windows
Window Controls Overlay for this case, so the missing native frame behaviours
are restored with small Win32 bridges:

| Interaction | Implementation |
| --- | --- |
| Windows 11 Snap Layouts on maximize-button hover | [`tauri-plugin-snap-layout`](https://github.com/Hyph-M/tauri-plugin-snap-layout) places an invisible native `HTMAXBUTTON` hit-test child over `#btn-max`. The OS shows its own Snap Layouts flyout; the plugin also forwards maximize/restore clicks. |
| Top-border double-click vertically fills/restores the window | `src-tauri/src/native_window.rs` adds `CS_DBLCLKS` to Tauri's `TAURI_DRAG_RESIZE_BORDERS` child and forwards `WM_NCLBUTTONDBLCLK` (`HTTOP`/`HTBOTTOM`) to the parent. The parent's default WndProc performs the native vertical-fill action, including its native double-click toggle and drag-to-restore behaviour. |
| Title-bar double-click toggles maximize/restore | Handled in `ui/app.js`; window dragging is deferred until pointer movement/short hold so the first click of a double-click does not enter the Win32 modal move loop. |
| Top-left app icon opens the window-control menu | The icon is drawn by `ui/index.html` (`ui/window-icon.png`) and invokes `show_window_menu`, which pops up a native menu with Restore/Move/Size/Minimize/Maximize/Close items. Predefined menu items act on the window HWND; Restore/Move/Size are handled in `main.rs`. |

Only the Snap Layouts feature is Windows 11-specific. On Windows 10 and other
platforms the plugin is a no-op and the HTML maximize button remains the
fallback.
