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

#[cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use webview2_com::PermissionRequestedEventHandler;
#[cfg(windows)]
use webview2_com::SetPermissionStateCompletedHandler;
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
    COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    COREWEBVIEW2_PERMISSION_STATE_DEFAULT, COREWEBVIEW2_PERMISSION_STATE_DENY,
    ICoreWebView2, ICoreWebView2_13, ICoreWebView2Deferral,
    ICoreWebView2PermissionRequestedEventArgs, ICoreWebView2Profile4,
};
#[cfg(windows)]
use windows::core::{HSTRING, Interface, PCWSTR};

/// Label of the shell page webview (the frameless main window).
pub const SHELL_WEBVIEW: &str = "main";
/// Prefix of every tab view label: `<PREFIX><tab id>`.
pub const TAB_LABEL_PREFIX: &str = "tab-";
/// Prefix of every dialog-card webview label: `<PREFIX><kind>`.
/// Dialog cards are child webviews (not native windows) so the harness tab
/// webviews never have to be hidden (and the content area never falls back to
/// a black void).
pub const DIALOG_LABEL_PREFIX: &str = "dialog-";

/// Live tab views: shell tab id → webview handle.
#[derive(Default)]
pub struct ViewRegistry {
    views: Mutex<HashMap<String, Webview>>,
}

impl ViewRegistry {
    pub(crate) fn get(&self, tab_id: &str) -> Option<Webview<tauri::Wry>> {
        self.views.lock().unwrap().get(tab_id).cloned()
    }

    pub(crate) fn insert(&self, tab_id: String, webview: Webview<tauri::Wry>) {
        self.views.lock().unwrap().insert(tab_id, webview);
    }

    pub(crate) fn remove(&self, tab_id: &str) -> Option<Webview<tauri::Wry>> {
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

/// Guard for commands shared by the shell page and the dialog-card webviews
/// (`dialog-*`): data commands (remote RPC, update checks, about) are safe
/// from any app-origin page we create, but must still be refused for tab
/// webviews that load remote harness content.
pub fn ensure_shell_or_dialog(webview: &Webview) -> Result<(), String> {
    if webview.label() == SHELL_WEBVIEW || webview.label().starts_with(DIALOG_LABEL_PREFIX) {
        Ok(())
    } else {
        Err(format!(
            "command is only available to the shell or a dialog webview (called from '{}')",
            webview.label()
        ))
    }
}

/// Guard for commands that only the dialog-card webviews may call
/// (reporting a completed connection, requesting an AI update, closing self).
pub fn ensure_dialog(webview: &Webview) -> Result<(), String> {
    if webview.label().starts_with(DIALOG_LABEL_PREFIX) {
        Ok(())
    } else {
        Err(format!(
            "command is only available to dialog webviews (called from '{}')",
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
        // The harness walks WebView2's natural new-window flow (popups open
        // in their own WebView2 window); no shell-side popup handling for now.
        // Clipboard and notification permissions are answered by the
        // `install_webview_permissions` handler (below) instead of wry's
        // built-in clipboard-only handler, so the consent dialog can prompt.
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Allow);

    let (x, y, w, h) = bounds;
    let view = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| format!("failed to create the tab webview: {e}"))?;
    // Windows: answer WebView2 permission requests ourselves (clipboard always
    // allowed; notifications deferred to an in-page consent prompt).
    #[cfg(windows)]
    install_webview_permissions(&view, origin_of(url));
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

/* ── WebView2 permission consent (Windows) ─────────────────────── */

/// A pending WebView2 notification-permission request held while the user
/// decides in the in-page consent overlay (view-bridge.js).
#[cfg(windows)]
struct PendingPermission {
    args: ICoreWebView2PermissionRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
}

// WebView2's `ICoreWebView2Deferral` is the documented mechanism for
// completing a permission request asynchronously (optionally from another
// thread), and we only touch both COM objects on the main thread (the
// `PermissionRequested` handler and `run_on_main_thread`). Marking the pair
// Send lets the registry live in Tauri's `Send + Sync` app state.
#[cfg(windows)]
unsafe impl Send for PendingPermission {}

/// Registry of deferred WebView2 permission requests, keyed by the request id
/// handed to the page overlay; `view_answer_permission` resolves them.
#[cfg(windows)]
#[derive(Default)]
pub struct PermissionRegistry {
    pending: Mutex<HashMap<u64, PendingPermission>>,
    next_id: AtomicU64,
}

/// Reset the persisted notification permission for `origin` back to `default`
/// so the next `requestPermission()` re-raises `PermissionRequested`.
#[cfg(windows)]
fn reset_notification_permission(core: &ICoreWebView2, origin: &str) -> bool {
    let Ok(core13) = core.cast::<ICoreWebView2_13>() else {
        return false;
    };
    let Ok(profile) = (unsafe { core13.Profile() }) else {
        return false;
    };
    let Ok(profile4) = profile.cast::<ICoreWebView2Profile4>() else {
        return false;
    };
    let origin_w = HSTRING::from(origin);
    let handler = SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(())));
    unsafe {
        profile4
            .SetPermissionState(
                COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
                PCWSTR(origin_w.as_ptr()),
                COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                &handler,
            )
            .is_ok()
    }
}

/// Extract the origin (`scheme://host[:port]`) from a tab URL for WebView2's
/// `SetPermissionState`.
#[cfg(windows)]
fn origin_of(url: &str) -> Option<String> {
    let u = url.parse::<tauri::Url>().ok()?;
    let scheme = u.scheme();
    let host = u.host_str()?;
    match u.port() {
        Some(p) => Some(format!("{scheme}://{host}:{p}")),
        None => Some(format!("{scheme}://{host}")),
    }
}

/// Attach the WebView2 permission handler to a connection-tab webview.
///
/// This replaces wry's built-in clipboard-only handler, so
/// `enable_clipboard_access()` is intentionally left off the tab builder:
/// clipboard is always allowed, while the notifications permission is deferred
/// and answered by the user through the injected consent overlay
/// (`window.__dshPermissionPrompt`, see view-bridge.js).
#[cfg(windows)]
fn install_webview_permissions(view: &Webview, origin: Option<String>) {
    let outer: Webview = (*view).clone();
    let inner_view: Webview = (*view).clone();
    let app: tauri::AppHandle = tauri::AppHandle::clone(view.app_handle());
    let label = view.label().to_string();
    crate::dsh_log(&app, &format!("perm: install_webview_permissions on '{label}'"));
    // Runs on the main thread while the tab webview is created.
    let _ = outer.with_webview(move |platform| {
        let controller = platform.controller();
        let core = unsafe { controller.CoreWebView2() };
        let Ok(core) = core else {
            crate::dsh_log(&app, &format!("perm: CoreWebView2() failed on '{label}'"));
            return;
        };
        // WebView2 persists a per-origin notification permission 'denied' from
        // earlier runs; dsh-pet only re-requests when the state is 'default',
        // so reset it once so the consent prompt can fire again.
        match &origin {
            Some(origin) => {
                let ok = reset_notification_permission(&core, origin);
                crate::dsh_log(
                    &app,
                    &format!("perm: reset notification state ok={ok} origin='{origin}' label='{label}'"),
                );
            }
            None => {
                crate::dsh_log(&app, &format!("perm: no origin to reset label='{label}'"));
            }
        }
        let mut token = 0i64;
        let handler_app = app.clone();
        let handler_label = label.clone();
        let handler = PermissionRequestedEventHandler::create(Box::new(
            move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                unsafe { args.PermissionKind(&mut kind) }?;
                crate::dsh_log(
                    &handler_app,
                    &format!("perm: event kind={kind:?} label='{handler_label}'"),
                );
                if kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ {
                    unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW) }?;
                    return Ok(());
                }
                if kind != COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                    return Ok(());
                }
                let deferral = unsafe { args.GetDeferral() };
                let Ok(deferral) = deferral else {
                    crate::dsh_log(
                        &handler_app,
                        &format!("perm: GetDeferral failed on '{handler_label}'"),
                    );
                    return Ok(());
                };
                let id = handler_app
                    .state::<PermissionRegistry>()
                    .next_id
                    .fetch_add(1, Ordering::SeqCst);
                handler_app
                    .state::<PermissionRegistry>()
                    .pending
                    .lock()
                    .unwrap()
                    .insert(id, PendingPermission { args, deferral });
                crate::dsh_log(
                    &handler_app,
                    &format!("perm: deferred id={id} label='{handler_label}'"),
                );
                // Ask the page to render the consent overlay.
                let js = format!(
                    "window.__dshPermissionPrompt && window.__dshPermissionPrompt({});",
                    serde_json::json!({ "requestId": id })
                );
                let eval_res = inner_view.eval(&js);
                crate::dsh_log(
                    &handler_app,
                    &format!("perm: overlay eval id={id} ok={}", eval_res.is_ok()),
                );
                Ok(())
            },
        ));
        let add_res = unsafe { core.add_PermissionRequested(&handler, &mut token) };
        crate::dsh_log(
            &app,
            &format!(
                "perm: add_PermissionRequested result={:?} token={token} label='{label}'",
                add_res
            ),
        );
    });
}

/// Answer a previously deferred WebView2 permission request. Called by the
/// injected consent overlay (view-bridge.js) once the user chooses.
#[tauri::command]
pub fn view_answer_permission(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request_id: u64,
    allow: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        ensure_tab_view(&webview)?;
        crate::dsh_log(
            &app,
            &format!("perm: answer request_id={request_id} allow={allow}"),
        );
        let pending = {
            let registry = app.state::<PermissionRegistry>();
            let removed = registry.pending.lock().unwrap().remove(&request_id);
            removed
        };
        let Some(pending) = pending else {
            crate::dsh_log(&app, &format!("perm: answer id={request_id} not found"));
            return Ok(());
        };
        // Complete the WebView2 request on the main thread (COM apartment).
        // `let p = pending` moves the whole struct so Rust's disjoint field
        // capture doesn't capture the non-`Send` COM fields separately.
        let res = app.run_on_main_thread(move || {
            let p = pending;
            let state = if allow {
                COREWEBVIEW2_PERMISSION_STATE_ALLOW
            } else {
                COREWEBVIEW2_PERMISSION_STATE_DENY
            };
            let _ = unsafe { p.args.SetState(state) };
            let _ = unsafe { p.deferral.Complete() };
        });
        if let Err(e) = &res {
            crate::dsh_log(&app, &format!("perm: answer id={request_id} main-thread err: {e}"));
        } else {
            crate::dsh_log(&app, &format!("perm: answer id={request_id} done"));
        }
        res.map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, webview, request_id, allow);
        Ok(())
    }
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
