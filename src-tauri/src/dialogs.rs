//! Dedicated native dialog windows.
//!
//! The connection/update/about dialogs used to be DOM overlays inside the
//! shell page. After the webview conversion every connection tab is a native
//! child webview layered **above** the shell document, so the only way to
//! make those overlays visible was to hide the harness webview — leaving a
//! black content area behind the dialogs.
//!
//! These dialogs now open as **system-native windows** (`WebviewWindow`) with
//! the standard OS title bar and border: they float above the main window and
//! the harness tab webviews stay visible the whole time.
//!
//! Important: creating a `WebviewWindow` *during a Tauri IPC command* while
//! the `unstable` feature (required for the child tab webviews) is enabled
//! hits a known tauri bug ([tauri#10011]) — the new window renders white and
//! the app hangs. To sidestep it, the dialog windows are **pre-created
//! hidden** in `setup` (before any child webview exists) and `open_dialog`
//! only shows/focuses them. Closing hides them again, so they are reused.
//!
//! [tauri#10011]: https://github.com/tauri-apps/tauri/issues/10011

use tauri::{Emitter, Manager, WebviewUrl};

use crate::dialog_sizes;
use crate::views;

/// Dialog kinds (window labels are `<DIALOG_LABEL_PREFIX><kind>`). The
/// changelog was an overlay inside the update window; it is now its own
/// window kind so it floats above everything like the others.
const KINDS: &[&str] = &["conn", "update", "about", "changelog"];

pub fn label_for(kind: &str) -> String {
    format!("{}{}", views::DIALOG_LABEL_PREFIX, kind)
}

/// Compiled-in defaults: `(title, width, height, min_width, min_height)`.
/// Sizes are logical pixels; long content scrolls inside the panel instead
/// of stretching the window.
fn dialog_meta(kind: &str) -> Result<(&'static str, f64, f64, f64, f64), String> {
    match kind {
        "conn" => Ok(("连接管理", 1040.0, 620.0, 920.0, 560.0)),
        "update" => Ok(("检查更新", 960.0, 720.0, 720.0, 520.0)),
        "about" => Ok(("关于", 620.0, 640.0, 480.0, 480.0)),
        "changelog" => Ok(("更新日志", 760.0, 660.0, 560.0, 480.0)),
        _ => Err(format!("unknown dialog kind: {kind}")),
    }
}

fn create_one(
    app: &tauri::AppHandle,
    owner: &tauri::WebviewWindow,
    kind: &str,
) -> Result<(), String> {
    let (title, default_w, default_h, min_width, min_height) = dialog_meta(kind)?;
    // Restore the last size the user picked; fall back to the compiled default.
    let root = owner
        .app_handle()
        .try_state::<crate::ShellState>()
        .map(|s| s.root.clone());
    let (width, height) = root
        .as_ref()
        .and_then(|r| dialog_sizes::load(r).0.get(kind).copied())
        .unwrap_or((default_w, default_h));
    let script = format!(
        "window.__DSH_DIALOG_VIEW__ = {};",
        serde_json::to_string(kind).map_err(|e| e.to_string())?
    );

    let builder = tauri::WebviewWindowBuilder::new(app, label_for(kind), WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .resizable(true)
        // System-native border + title bar: the user asked for a real OS frame.
        .decorations(true)
        .visible(false)
        .center()
        // A dialog does not need a taskbar entry; the owner's is enough.
        .skip_taskbar(true)
        .initialization_script(script);
    // Owned by the main window: keeps the dialog above its owner on Windows
    // and avoids it sliding behind the shell.
    let builder = builder.owner(owner).map_err(|e| e.to_string())?;
    let window = builder
        .build()
        .map_err(|e| format!("failed to create the {kind} dialog window: {e}"))?;

    // Native title-bar X hides instead of destroying, so the dialog can be
    // reused without re-creating a WebviewWindow later (see module docs).
    let app_handle = app.clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(win) = app_handle.get_webview_window(&label) {
                    let _ = win.hide();
                }
                let _ = app_handle.emit_to(
                    views::SHELL_WEBVIEW,
                    "dialog-closed",
                    serde_json::json!({}),
                );
            }
            tauri::WindowEvent::Resized(size) => {
                // Persist user-driven resizes so the next open restores them.
                // Programmatic `fit_dialog` resizes also land here; that is
                // fine — the fitted size *is* the size the user last saw.
                if let Some(state) = app_handle.try_state::<crate::ShellState>() {
                    let scale = app_handle
                        .get_webview_window(&label)
                        .and_then(|w| w.scale_factor().ok())
                        .unwrap_or(1.0);
                    let w = size.width as f64 / scale;
                    let h = size.height as f64 / scale;
                    let kind = label.trim_start_matches(views::DIALOG_LABEL_PREFIX);
                    dialog_sizes::save(&state.root, kind, w, h);
                }
            }
            _ => {}
        }
    });
    Ok(())
}

/// Pre-create every dialog window (hidden). Called from `setup`, before the
/// shell page creates the harness tab child webviews.
pub fn create_all(
    app: &tauri::AppHandle,
    owner: &tauri::WebviewWindow,
) -> Result<(), String> {
    for kind in KINDS {
        create_one(app, owner, kind)?;
    }
    Ok(())
}

/// Show (or focus) the dialog window for `kind`. Callable from the shell page
/// (and from another dialog window for nesting).
#[tauri::command]
pub fn open_dialog(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    kind: String,
    project: Option<String>,
) -> Result<(), String> {
    views::ensure_shell_or_dialog(&webview)?;
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown dialog kind: {kind}"));
    }
    let label = label_for(&kind);
    if app.get_webview_window(&label).is_none() {
        // Fallback if the pre-created window was closed/destroyed.
        let owner = app
            .get_webview_window(views::SHELL_WEBVIEW)
            .ok_or_else(|| "main shell window is missing".to_string())?;
        create_one(&app, &owner, &kind)?;
    }
    // Keep the window hidden: the matching dialog page starts its content,
    // then shows itself (`show_dialog`). The event is broadcast by Tauri's JS
    // listeners (they register as `Any`), so the payload carries `kind` and
    // every dialog page checks it — only the requested one acts.
    let _ = app.emit_to(
        &label,
        "dialog-open",
        serde_json::json!({ "kind": kind, "project": project }),
    );
    Ok(())
}

/// Show the calling dialog window after its page finished the content fit
/// (called by the dialog page itself; see `dialog-open` flow).
#[tauri::command]
pub fn show_dialog(window: tauri::Window, webview: tauri::Webview) -> Result<(), String> {
    views::ensure_dialog(&webview)?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Hide the calling dialog window (dialog page close button). The native
/// title-bar X is handled by `on_window_event` above with the same effect.
#[tauri::command]
pub fn close_dialog(window: tauri::Window, webview: tauri::Webview) -> Result<(), String> {
    views::ensure_dialog(&webview)?;
    let _ = window.hide();
    let _ = window
        .app_handle()
        .emit_to(views::SHELL_WEBVIEW, "dialog-closed", serde_json::json!({}));
    Ok(())
}

/// Resize the dialog window to fit its content (a native dialog does not
/// leave blank space around a fixed-size frame). The dialog page measures its
/// natural layout size (CSS px) and asks the Rust side to set the window
/// inner size accordingly.
#[tauri::command]
pub fn fit_dialog(
    window: tauri::Window,
    webview: tauri::Webview,
    width: f64,
    height: f64,
) -> Result<(), String> {
    views::ensure_dialog(&webview)?;
    let width = width.clamp(320.0, 1600.0);
    let height = height.clamp(220.0, 1100.0);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("failed to fit the dialog window: {e}"))
}

/// Persist one dialog's size (called after a successful content fit or a
/// user resize), so the next open restores the same geometry.
#[tauri::command]
pub fn save_dialog_size(
    webview: tauri::Webview,
    state: tauri::State<'_, crate::ShellState>,
    kind: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    views::ensure_dialog(&webview)?;
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown dialog kind: {kind}"));
    }
    dialog_sizes::save(&state.root, &kind, width, height);
    Ok(())
}

/// Report a successfully established connection from the connection dialog to
/// the main shell, which owns the tab list and the harness child webviews.
#[tauri::command]
pub fn connection_added(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    tab: serde_json::Value,
) -> Result<(), String> {
    views::ensure_dialog(&webview)?;
    app.emit_to(
        views::SHELL_WEBVIEW,
        "connection-added",
        serde_json::json!({ "tab": tab }),
    )
    .map_err(|e| format!("failed to forward the new connection to the shell: {e}"))
}

/// Ask the main shell to run the dsh-ai-update request inside the active tab
/// webview (only the shell knows which tab is active and owns `view_eval`).
#[tauri::command]
pub fn ai_update_request(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request_id: String,
    prompt: String,
) -> Result<(), String> {
    views::ensure_dialog(&webview)?;
    app.emit_to(
        views::SHELL_WEBVIEW,
        "ai-update-request",
        serde_json::json!({ "requestId": request_id, "prompt": prompt }),
    )
    .map_err(|e| format!("failed to forward the AI-update request: {e}"))
}

/// Shell → dialog result channel. The main shell owns the long-running AI
/// update flow; when it settles it pushes the outcome back to the dialog
/// window (`target` is a dialog kind, e.g. `"update"`).
#[tauri::command]
pub fn dialog_event(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    target: String,
    event: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    views::ensure_shell(&webview)?;
    if !KINDS.contains(&target.as_str()) {
        return Err(format!("unknown dialog target: {target}"));
    }
    app.emit_to(label_for(&target), event.as_str(), payload)
        .map_err(|e| format!("failed to forward the dialog event: {e}"))
}
