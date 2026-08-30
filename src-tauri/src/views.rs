//! Connection-tab webviews.
//!
//! Every established tab is rendered by its own **child webview**
//! (`WebviewBuilder` → `Window::add_child`, tauri `unstable` feature) instead
//! of an iframe inside the wrapper page. A child webview is a real top-level
//! document, so:
//!
//! - the harness browser-auth flow works exactly like a browser tab: loading
//!   the `?token=` URL mints the session cookie inside the webview's own
//!   cookie jar, no proxy or SameSite iframe tricks needed;
//! - WebView2 new-window requests (popups, `target=_blank`) open a plain
//!   WebView2 window — the shell registers no custom popup handling;
//! - switching tabs keeps every page alive (hide/show, never reload) — the
//!   same semantics the iframe version had.
//!
//! The shell page (served from the loopback wrapper port) drives the views
//! through the `view_*` commands below. Bounds are logical (CSS) pixels, so
//! the shell can report its own `getBoundingClientRect()` directly; tauri
//! converts them with the window scale factor.
//!
//! Safety: every webview Tauri creates (including the child webviews and even
//! remote tab URLs) gets `window.__TAURI_INTERNALS__`, so every command here
//! verifies the *calling* webview's label. Shell-only commands accept only the
//! `main` webview; the bridge commands accept only `tab-*` views.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewBuilder, WebviewUrl,
    Window,
};

/// Label of the shell page webview (the frameless main window).
pub const SHELL_WEBVIEW: &str = "main";
/// Prefix of every tab view label: `<PREFIX><tab id>`.
pub const TAB_LABEL_PREFIX: &str = "tab-";

/// Live tab views: shell tab id → webview handle.
#[derive(Default)]
pub struct ViewRegistry {
    views: Mutex<HashMap<String, Webview>>,
}

impl ViewRegistry {
    fn get(&self, tab_id: &str) -> Option<Webview<tauri::Wry>> {
        self.views.lock().unwrap().get(tab_id).cloned()
    }

    fn insert(&self, tab_id: String, webview: Webview<tauri::Wry>) {
        self.views.lock().unwrap().insert(tab_id, webview);
    }

    fn remove(&self, tab_id: &str) -> Option<Webview<tauri::Wry>> {
        self.views.lock().unwrap().remove(tab_id)
    }
}

/// Guard: only the shell page may run shell-command IPC. (Remote tab pages
/// also receive `__TAURI_INTERNALS__` — never let them touch `view_*`,
/// `remote_call`, or anything that reaches the harness/system.)
pub fn ensure_shell(webview: &Webview) -> Result<(), String> {
    if webview.label() == SHELL_WEBVIEW {
        Ok(())
    } else {
        Err(format!(
            "command is only available to the shell webview (called from '{}')",
            webview.label()
        ))
    }
}

fn ensure_tab_view(webview: &Webview) -> Result<(), String> {
    if webview.label().starts_with(TAB_LABEL_PREFIX) {
        Ok(())
    } else {
        Err(format!(
            "command is only available to tab webviews (called from '{}')",
            webview.label()
        ))
    }
}

fn tab_id_of(webview: &Webview) -> Option<String> {
    webview
        .label()
        .strip_prefix(TAB_LABEL_PREFIX)
        .map(str::to_string)
}

/// `(x, y, width, height)` in logical (CSS) pixels.
pub type LogicalBounds = (f64, f64, f64, f64);

fn parse_url(url: &str) -> Result<tauri::Url, String> {
    url.parse()
        .map_err(|_| format!("invalid tab url: {url:?}"))
}

fn as_rect(bounds: LogicalBounds) -> Rect {
    Rect {
        position: LogicalPosition::new(bounds.0, bounds.1).into(),
        size: LogicalSize::new(bounds.2, bounds.3).into(),
    }
}

/// Create the webview for a tab (or re-target an existing one) and place it
/// inside the window's content area below the custom title bar.
pub fn ensure(
    window: &Window,
    tab_id: &str,
    url: &str,
    bounds: LogicalBounds,
) -> Result<(), String> {
    let registry = window.state::<ViewRegistry>();

    if let Some(view) = registry.get(tab_id) {
        view.navigate(parse_url(url)?)
            .map_err(|e| format!("failed to navigate the tab webview: {e}"))?;
        set_bounds(&view, bounds)?;
        set_visible(&view, true)?;
        return Ok(());
    }

    let label = format!("{TAB_LABEL_PREFIX}{tab_id}");
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parse_url(url)?))
        // Run the page-theme + AI-update bridge inside the harness page.
        .initialization_script(include_str!("../ui/view-bridge.js"))
        // Async Clipboard API (code-block / message copy controls).
        .enable_clipboard_access()
        // The harness walks WebView2's natural new-window flow (popups open
        // in their own WebView2 window); no shell-side popup handling for now.
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Allow);

    let (x, y, w, h) = bounds;
    let view = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| format!("failed to create the tab webview: {e}"))?;
    registry.insert(tab_id.to_string(), view);
    Ok(())
}

pub fn set_bounds(view: &Webview, bounds: LogicalBounds) -> Result<(), String> {
    view.set_bounds(as_rect(bounds))
        .map_err(|e| format!("failed to resize the tab webview: {e}"))
}

pub fn set_visible(view: &Webview, visible: bool) -> Result<(), String> {
    if visible {
        view.show()
            .map_err(|e| format!("failed to show the tab webview: {e}"))?;
        // Hand keyboard focus to the harness so typing goes straight to it.
        let _ = view.set_focus();
    } else {
        view.hide()
            .map_err(|e| format!("failed to hide the tab webview: {e}"))?;
    }
    Ok(())
}

pub fn close(window: &Window, tab_id: &str) -> Result<(), String> {
    let registry = window.state::<ViewRegistry>();
    if let Some(view) = registry.remove(tab_id) {
        view.close()
            .map_err(|e| format!("failed to close the tab webview: {e}"))?;
    }
    Ok(())
}

pub fn eval(view: &Webview, js: &str) -> Result<(), String> {
    view.eval(js)
        .map_err(|e| format!("failed to evaluate in the tab webview: {e}"))
}

/// Derive the tab id of a `tab-*` webview (bridge payloads carry it so the
/// shell can attribute themes/results to the right tab).
fn view_tab_id(webview: &Webview) -> Result<String, String> {
    ensure_tab_view(webview)?;
    tab_id_of(webview).ok_or_else(|| format!("webview label '{}' has no tab id", webview.label()))
}

/// One RGBA color the harness page reports (same shape the wrapper page kept
/// in `tabs[].theme.background`/`.text`).
#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct ThemeColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f64,
}

/* ── Commands (all shell-state writes run off the main thread) ── */

/// Create or re-target a tab webview at the shell's content-area bounds.
#[tauri::command]
pub async fn view_create(
    window: tauri::Window,
    webview: tauri::Webview,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    ensure_shell(&webview)?;
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure(&window, &tab_id, &url, (x, y, w, h))
    })
    .await
    .map_err(|e| format!("tab webview task failed: {e}"))?
}

/// Re-place a tab webview (window moved / resized / DPI changed).
#[tauri::command]
pub async fn view_set_bounds(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    tab_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    ensure_shell(&webview)?;
    let registry = app.state::<ViewRegistry>();
    if let Some(view) = registry.get(&tab_id) {
        let view = view.clone();
        tauri::async_runtime::spawn_blocking(move || set_bounds(&view, (x, y, w, h)))
            .await
            .map_err(|e| format!("tab view task failed: {e}"))?
    } else {
        Err(format!("unknown tab: {tab_id}"))
    }
}

/// Show/hide a tab webview (tab switching, modal dialogs).
#[tauri::command]
pub async fn view_set_visible(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    tab_id: String,
    visible: bool,
) -> Result<(), String> {
    ensure_shell(&webview)?;
    let registry = app.state::<ViewRegistry>();
    if let Some(view) = registry.get(&tab_id) {
        let view = view.clone();
        tauri::async_runtime::spawn_blocking(move || set_visible(&view, visible))
            .await
            .map_err(|e| format!("tab view task failed: {e}"))?
    } else {
        Err(format!("unknown tab: {tab_id}"))
    }
}

/// Close a tab webview for good (tab closed).
#[tauri::command]
pub async fn view_close(
    window: tauri::Window,
    webview: tauri::Webview,
    tab_id: String,
) -> Result<(), String> {
    ensure_shell(&webview)?;
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || close(&window, &tab_id))
        .await
        .map_err(|e| format!("tab view task failed: {e}"))?
}

/// Run `js` inside a tab webview (shell → harness page; used by the AI-update
/// request bridge, which has to live in the harness page itself).
#[tauri::command]
pub async fn view_eval(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    tab_id: String,
    js: String,
) -> Result<(), String> {
    ensure_shell(&webview)?;
    let registry = app.state::<ViewRegistry>();
    let view = registry
        .get(&tab_id)
        .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
    tauri::async_runtime::spawn_blocking(move || eval(&view, &js))
        .await
        .map_err(|e| format!("tab view task failed: {e}"))?
}

/// Theme payload reported by a harness page (view-bridge.js) — forwarded to
/// the shell as a `page-theme` event tagged with the tab id.
#[tauri::command]
pub fn page_theme(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    background: ThemeColor,
    text: ThemeColor,
) -> Result<(), String> {
    let tab_id = view_tab_id(&webview)?;
    app.emit_to(
        SHELL_WEBVIEW,
        "page-theme",
        serde_json::json!({ "tabId": tab_id, "colors": { "background": background, "text": text } }),
    )
    .map_err(|e| format!("failed to forward the page theme: {e}"))
}

/// AI-update result replied by the harness page (view-bridge.js forwards the
/// dsh-ai-update plugin's `window.parent` answer) — forwarded to the shell as
/// an `ai-update-result` event.
#[tauri::command]
pub fn ai_update_result(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request_id: String,
    ok: bool,
    error: Option<String>,
) -> Result<(), String> {
    let tab_id = view_tab_id(&webview)?;
    app.emit_to(
        SHELL_WEBVIEW,
        "ai-update-result",
        serde_json::json!({
            "tabId": tab_id,
            "requestId": request_id,
            "ok": ok,
            "error": error,
        }),
    )
    .map_err(|e| format!("failed to forward the AI-update result: {e}"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::TAB_LABEL_PREFIX;

    #[test]
    fn tab_labels_carry_the_prefix() {
        assert!(TAB_LABEL_PREFIX.starts_with("tab-"));
        assert!(!TAB_LABEL_PREFIX.starts_with("main"));
    }
}
