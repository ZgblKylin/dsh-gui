//! Dedicated dialog card webviews.
//!
//! The connection/update/about dialogs used to be DOM overlays inside the
//! shell page. After the webview conversion every connection tab is a native
//! child webview layered **above** the shell document, so the only way to
//! make those overlays visible was to hide the harness webview — leaving a
//! black content area behind the dialogs.
//!
//! This module hosts each dialog in its own **child webview** (`Window::
//! add_child`, same mechanism as the tab webviews) placed exactly over the
//! dialog's card bounds. The harness tab webviews stay visible the whole time
//! (the shell reports dialog bounds that fit inside the content area), and
//! the dialog page runs in `dialog-mode` (see `ui/app.js`).
//!
//! Note: a *separate native window* (`WebviewWindowBuilder`) was tried first,
//! but with the `unstable` feature (required for child webviews) Tauri has a
//! known bug where additional WebviewWindows render white and hang the app
//! ([tauri#10011]). Child webviews do not hit that bug.
//!
//! The dialog pages report results back to the main shell (`connection-added`,
//! `ai-update-request` events); the shell answers via `dialog_event`.

use tauri::{Emitter, Manager, LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl};

use crate::views;

/// Reserved `ViewRegistry` key for the dialog card webview.
pub const DIALOG_KEY: &str = "__dialog__";

/// Dialog kinds (webview labels are `<DIALOG_LABEL_PREFIX><kind>`).
const KINDS: &[&str] = &["conn", "update", "changelog", "about"];

pub fn label_for(kind: &str) -> String {
    format!("{}{}", views::DIALOG_LABEL_PREFIX, kind)
}

/// Open (or replace) the dialog card webview. Callable from the shell page;
/// the shell reports the card's logical bounds (CSS pixels) so the card is
/// laid out inside the harness content area and the harness stays visible
/// around it.
#[tauri::command]
pub async fn open_dialog(
    window: tauri::Window,
    webview: tauri::Webview,
    kind: String,
    project_id: Option<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    views::ensure_shell(&webview)?;
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown dialog kind: {kind}"));
    }

    let mut script = format!(
        "window.__DSH_DIALOG_VIEW__ = {};",
        serde_json::to_string(&kind).map_err(|e| e.to_string())?
    );
    if kind == "changelog" {
        if let Some(project_id) = project_id {
            script.push_str(&format!(
                "window.__DSH_DIALOG_PROJECT__ = {};",
                serde_json::to_string(&project_id).map_err(|e| e.to_string())?
            ));
        }
    }

    // Create the child webview off the main thread (same pattern as
    // `views::view_create`): WebView2 child-window creation can block the
    // IPC callback and freeze the shell UI.
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let registry = window.state::<views::ViewRegistry>();
        if let Some(old) = registry.remove(DIALOG_KEY) {
            let _ = old.close();
        }

        let builder = WebviewBuilder::new(label_for(&kind), WebviewUrl::App("index.html".into()))
            .initialization_script(script)
            // The dialogs have copy buttons (connection log, changelog markdown).
            .enable_clipboard_access();
        let view = window
            .add_child(
                builder,
                LogicalPosition::new(x, y),
                LogicalSize::new(w.max(240.0), h.max(160.0)),
            )
            .map_err(|e| format!("failed to open the {kind} dialog card: {e}"))?;
        // Raise + focus the card so it sits above the harness tab webview.
        let _ = view.set_focus();
        registry.insert(DIALOG_KEY.to_string(), view);
        Ok(())
    })
    .await
    .map_err(|e| format!("dialog create task failed: {e}"))?
}

/// Close the calling dialog card (dialog page close button or backdrop);
/// also notifies the shell so its dialog-open flag resets.
#[tauri::command]
pub async fn close_dialog(window: tauri::Window, webview: tauri::Webview) -> Result<(), String> {
    views::ensure_dialog(&webview)?;
    let window = window.clone();
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let registry = window.state::<views::ViewRegistry>();
        if let Some(view) = registry.remove(DIALOG_KEY) {
            let _ = view.close();
        }
        let _ = app.emit_to(
            views::SHELL_WEBVIEW,
            "dialog-closed",
            serde_json::json!({}),
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("dialog close task failed: {e}"))?
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
/// update flow; when it settles it pushes the outcome back to the dialog card
/// (`target` is a dialog kind, e.g. `"update"`).
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
