//! Quick-assistant overlay host: a hidden Tauri window that a global hotkey
//! shows on demand.
//!
//! The DSH plugin `dsh-quick-assistant` starts this process with the URL of the
//! overlay page (served by the plugin's host half) and the accelerator to
//! register. The shortcut and the window live in this separate process instead
//! of the Tauri shell or the Electron desktop app, so both shells share one
//! implementation and no upstream Electron code is patched.
//!
//! Behavior:
//! - the window is created hidden and loads the overlay page immediately;
//! - `RegisterHotKey` on a message-only window toggles it from anywhere;
//! - losing focus hides it unless the page pinned it;
//! - the page drives pin / hide / height / shortcut through Tauri commands;
//! - the process polls the plugin's native-state endpoint: it re-registers a
//!   changed shortcut, honors explicit show requests from the settings page,
//!   and exits once the DSH host stops answering.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "quick-assistant";
const DEFAULT_WIDTH: f64 = 720.0;
const DEFAULT_HEIGHT: f64 = 460.0;
const MIN_HEIGHT: f64 = 220.0;
const MAX_HEIGHT: f64 = 900.0;
/// Vertical placement of the panel as a fraction of the monitor height.
const TOP_FRACTION: f64 = 0.14;
/// Poll interval for the plugin's native-state endpoint.
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// Consecutive failed polls tolerated before the process gives up (the DSH
/// host normally outlives the helper, so this only absorbs short stalls).
const POLL_FAILURE_LIMIT: u32 = 4;

/// Window and shortcut state shared with the Tauri commands.
#[derive(Default)]
struct OverlayState {
    pinned: AtomicBool,
    /// Accelerator currently registered; empty when registration failed.
    accelerator: Mutex<String>,
    /// Epoch milliseconds of the last show; the blur handler ignores focus loss
    /// during the activation window so a window that cannot take the foreground
    /// stays visible instead of hiding immediately.
    shown_at: AtomicI64,
    /// Native message-only window that receives `WM_HOTKEY`.
    #[cfg(windows)]
    hotkey_window: AtomicI64,
}

/// Milliseconds since the Unix epoch; only differences are meaningful.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

impl OverlayState {
    fn accelerator(&self) -> String {
        self.accelerator.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    fn set_accelerator(&self, value: impl Into<String>) {
        *self.accelerator.lock().unwrap_or_else(|error| error.into_inner()) = value.into();
    }
}

/// Command-line arguments the plugin passes.
struct Args {
    url: String,
    shortcut: String,
    api: String,
    data_dir: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut url = None;
    let mut shortcut = String::new();
    let mut api = None;
    let mut data_dir = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--url" => url = args.next(),
            "--shortcut" => shortcut = args.next().unwrap_or_default(),
            "--api" => api = args.next(),
            "--data-dir" => data_dir = args.next(),
            "--help" | "-h" => {
                return Err(
                    "usage: dsh-quick-assistant --url <overlay-url> --api <native-state-url> \
                     [--shortcut <accelerator>] [--data-dir <path>]"
                        .into(),
                );
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Args {
        url: url.ok_or("--url is required")?,
        shortcut,
        api: api.ok_or("--api is required")?,
        data_dir,
    })
}

/// Show the panel on the primary monitor, slightly below its top edge.
fn show_overlay(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else { return };
    if let Some(state) = app.try_state::<OverlayState>() {
        state.shown_at.store(now_ms(), Ordering::Relaxed);
    }
    let _ = window.unminimize();
    place_overlay(&window);
    let _ = window.show();
    #[cfg(windows)]
    force_foreground(&window);
    // `WebviewWindow::set_focus` activates the top-level window; the webview
    // control needs its own focus call after a hide/show cycle, otherwise the
    // keystrokes stop at the frame and the page never receives them.
    let _ = window.set_focus();
    let webview: &tauri::Webview = window.as_ref();
    let _ = webview.set_focus();
    let _ = window.emit("qa-shown", ());
}

/// Take the foreground even when the hotkey arrived while another application
/// owned it. Windows grants the activation to the hotkey receiver in the normal
/// case; the thread attach covers the remaining cases where the previous
/// foreground application blocks it.
#[cfg(windows)]
fn force_foreground(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow, ShowWindow,
        SwitchToThisWindow, SW_SHOW,
    };

    let Ok(handle) = window.hwnd() else { return };
    let hwnd = handle.0;
    unsafe {
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        if GetForegroundWindow() == hwnd {
            return;
        }
        let foreground = GetForegroundWindow();
        let foreground_thread = GetWindowThreadProcessId(foreground, std::ptr::null_mut());
        let current_thread = GetCurrentThreadId();
        if foreground_thread != 0 && foreground_thread != current_thread {
            AttachThreadInput(current_thread, foreground_thread, 1);
            SetForegroundWindow(hwnd);
            AttachThreadInput(current_thread, foreground_thread, 0);
        }
        if GetForegroundWindow() != hwnd {
            SwitchToThisWindow(hwnd, 1);
        }
    }
}

/// Center the panel horizontally and leave a command-palette-like top gap.
fn place_overlay(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else { return };
    let scale = monitor.scale_factor();
    let origin = monitor.position();
    let screen = monitor.size().to_logical::<f64>(scale);
    let size = window
        .outer_size()
        .map(|size| size.to_logical::<f64>(scale))
        .unwrap_or_else(|_| tauri::LogicalSize::new(DEFAULT_WIDTH, DEFAULT_HEIGHT));
    let x = origin.x as f64 / scale + (screen.width - size.width) / 2.0;
    let y = origin.y as f64 / scale + (screen.height * TOP_FRACTION).round();
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

fn hide_overlay(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else { return };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let _ = window.hide();
    let _ = window.emit("qa-hidden", ());
}

/// Hotkey toggle: hide a visible panel, otherwise show and focus it.
fn toggle_overlay(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else { return };
    if window.is_visible().unwrap_or(false) {
        hide_overlay(app);
        return;
    }
    show_overlay(app);
}

#[tauri::command]
fn qa_set_pinned(state: tauri::State<'_, OverlayState>, window: tauri::WebviewWindow, pinned: bool) -> bool {
    state.pinned.store(pinned, Ordering::Relaxed);
    let _ = window.set_always_on_top(pinned);
    pinned
}

#[tauri::command]
fn qa_hide(window: tauri::WebviewWindow) {
    let _ = window.hide();
    let _ = window.emit("qa-hidden", ());
}

/// Resize the panel to the height its content wants; the width stays fixed.
#[tauri::command]
fn qa_set_height(window: tauri::WebviewWindow, height: f64) {
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let _ = window.set_size(tauri::LogicalSize::new(DEFAULT_WIDTH, height));
}

#[tauri::command]
fn qa_log(message: String) {
    eprintln!("[quick-assistant] {message}");
}

/// Register (or re-register) the global shortcut. The page reports failure so
/// the settings page can surface the conflict.
#[tauri::command]
fn qa_set_shortcut(state: tauri::State<'_, OverlayState>, accelerator: String) -> Result<bool, String> {
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::sync::atomic::Ordering as _;
        let handle = state.hotkey_window.load(Ordering::Relaxed);
        if state.accelerator() == accelerator {
            return Ok(true);
        }
        hotkey::unregister(handle as isize);
        match hotkey::parse_accelerator(&accelerator).and_then(|parsed| hotkey::register(handle as isize, parsed)) {
            Ok(()) => {
                state.set_accelerator(accelerator);
                Ok(true)
            }
            Err(error) => {
                state.set_accelerator("");
                Err(error)
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (state, accelerator);
        Err("global shortcuts are only implemented on Windows".into())
    }
}

#[cfg(windows)]
mod hotkey {
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassW, WM_HOTKEY, WNDCLASSW,
    };

    use super::*;

    const HOTKEY_ID: i32 = 0x44_53_48;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    /// Parsed accelerator: Win32 modifier flags plus a virtual-key code.
    pub(super) struct Accelerator {
        modifiers: u32,
        key: u32,
    }

    fn virtual_key(token: &str) -> Option<u32> {
        let upper = token.to_ascii_uppercase();
        if upper.chars().count() == 1 {
            let single = upper.chars().next()?;
            if single.is_ascii_alphanumeric() {
                return Some(single as u32);
            }
        }
        let key = match upper.as_str() {
            "SPACE" => 0x20,
            "TAB" => 0x09,
            "ENTER" | "RETURN" => 0x0D,
            "ESC" | "ESCAPE" => 0x1B,
            "BACKSPACE" => 0x08,
            "DELETE" | "DEL" => 0x2E,
            "INSERT" | "INS" => 0x2D,
            "HOME" => 0x24,
            "END" => 0x23,
            "PAGEUP" | "PRIOR" => 0x21,
            "PAGEDOWN" | "NEXT" => 0x22,
            "UP" => 0x26,
            "DOWN" => 0x28,
            "LEFT" => 0x25,
            "RIGHT" => 0x27,
            "MINUS" => 0xBD,
            "EQUAL" => 0xBB,
            "COMMA" => 0xBC,
            "PERIOD" => 0xBE,
            "SLASH" => 0xBF,
            "BACKQUOTE" => 0xC0,
            "SEMICOLON" => 0xBA,
            "QUOTE" => 0xDE,
            "LBRACKET" => 0xDB,
            "RBRACKET" => 0xDD,
            "BACKSLASH" => 0xDC,
            _ => {
                if let Some(rest) = upper.strip_prefix('F') {
                    if let Ok(index) = rest.parse::<u32>() {
                        if (1..=24).contains(&index) {
                            return Some(0x70 + index - 1);
                        }
                    }
                }
                return None;
            }
        };
        Some(key)
    }

    pub(super) fn parse_accelerator(text: &str) -> Result<Accelerator, String> {
        let mut modifiers = 0u32;
        let mut key = None;
        for token in text.split('+').map(str::trim).filter(|token| !token.is_empty()) {
            match token.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => modifiers |= MOD_CONTROL,
                "shift" => modifiers |= MOD_SHIFT,
                "alt" | "option" => modifiers |= MOD_ALT,
                "win" | "meta" | "super" | "cmd" | "command" => modifiers |= MOD_WIN,
                _ => {
                    if key.is_some() {
                        return Err(format!("more than one non-modifier key in \"{text}\""));
                    }
                    key = Some(virtual_key(token).ok_or_else(|| format!("unknown key \"{token}\""))?);
                }
            }
        }
        let key = key.ok_or_else(|| format!("no non-modifier key in \"{text}\""))?;
        if modifiers == 0 {
            return Err("the shortcut needs at least one modifier".into());
        }
        Ok(Accelerator { modifiers, key })
    }

    pub(super) fn register(window: isize, accelerator: Accelerator) -> Result<(), String> {
        let ok = unsafe {
            RegisterHotKey(
                window as HWND,
                HOTKEY_ID,
                accelerator.modifiers | MOD_NOREPEAT,
                accelerator.key,
            )
        };
        if ok == 0 {
            return Err("the shortcut is already used by another application".into());
        }
        Ok(())
    }

    pub(super) fn unregister(window: isize) {
        unsafe {
            UnregisterHotKey(window as HWND, HOTKEY_ID);
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if message == WM_HOTKEY && wparam == HOTKEY_ID as WPARAM {
            if let Some(app) = APP.get() {
                let runner = app.clone();
                let _ = runner.run_on_main_thread(move || toggle_overlay(app));
            }
            return 0;
        }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    /// Create the hidden message-only window that owns the hotkey. It lives on
    /// the Tauri thread, whose message loop dispatches `WM_HOTKEY` to it.
    pub(super) fn install(app: &tauri::AppHandle, accelerator: Option<Accelerator>) -> Result<isize, String> {
        let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
        let class_name: Vec<u16> = "DshQuickAssistantHotkey\0".encode_utf16().collect();
        let class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        unsafe { RegisterClassW(&class) };
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class_name.as_ptr(),
                class_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                -3isize as HWND, // HWND_MESSAGE: message-only window
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null(),
            )
        };
        if hwnd.is_null() {
            return Err("failed to create the hotkey message window".into());
        }
        APP.get_or_init(|| app.clone());
        if let Some(accelerator) = accelerator {
            register(hwnd as isize, accelerator)?;
        }
        Ok(hwnd as isize)
    }
}

/// Minimal blocking HTTP GET for the plugin's native-state endpoint.
fn http_get(url: &str) -> Result<String, String> {
    let rest = url.strip_prefix("http://").ok_or("only http:// endpoints are supported")?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().map_err(|_| "invalid port".to_string())?),
        None => (authority, 80),
    };
    let _ = host;
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(1500),
    )
    .map_err(|error| error.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(3000)));
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|error| error.to_string())?;
    Ok(response.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
}

/// Native-state payload served by the plugin.
#[derive(Deserialize)]
struct NativeState {
    #[serde(default)]
    shortcut: String,
    #[serde(default, rename = "showRequest")]
    show_request: i64,
}

/// Watch the plugin endpoint: re-register a changed shortcut, honor explicit
/// show requests, and exit when the host is gone.
fn poll_native_state(app: tauri::AppHandle, api: String) {
    let mut failures = 0u32;
    let mut known_show_request = -1i64;
    loop {
        std::thread::sleep(POLL_INTERVAL);
        match http_get(&api).and_then(|body| {
            serde_json::from_str::<NativeState>(&body).map_err(|error| error.to_string())
        }) {
            Ok(state) => {
                failures = 0;
                if known_show_request < 0 {
                    known_show_request = state.show_request;
                } else if state.show_request != known_show_request {
                    known_show_request = state.show_request;
                    let runner = app.clone();
                    let target = app.clone();
                    let _ = runner.run_on_main_thread(move || show_overlay(&target));
                }
                let Some(overlay) = app.try_state::<OverlayState>() else { continue };
                if state.shortcut == overlay.accelerator() {
                    continue;
                }
                let shortcut = state.shortcut.clone();
                let runner = app.clone();
                let target = app.clone();
                let _ = runner.run_on_main_thread(move || {
                    let Some(overlay) = target.try_state::<OverlayState>() else { return };
                    #[cfg(windows)]
                    {
                        let handle = overlay.hotkey_window.load(Ordering::Relaxed);
                        hotkey::unregister(handle as isize);
                        match hotkey::parse_accelerator(&shortcut)
                            .and_then(|parsed| hotkey::register(handle as isize, parsed))
                        {
                            Ok(()) => overlay.set_accelerator(shortcut),
                            Err(error) => {
                                eprintln!("[quick-assistant] shortcut '{shortcut}' rejected: {error}");
                                overlay.set_accelerator("");
                            }
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = (overlay, shortcut);
                    }
                });
            }
            Err(error) => {
                failures += 1;
                if failures == 1 {
                    eprintln!("[quick-assistant] native-state poll failed: {error}");
                }
                if failures >= POLL_FAILURE_LIMIT {
                    eprintln!("[quick-assistant] DSH host is unreachable; exiting");
                    std::process::exit(0);
                }
            }
        }
    }
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(error) => {
            eprintln!("[quick-assistant] {error}");
            std::process::exit(2);
        }
    };
    let url = match tauri::Url::parse(&args.url) {
        Ok(url) => url,
        Err(error) => {
            eprintln!("[quick-assistant] invalid overlay url: {error}");
            std::process::exit(2);
        }
    };
    #[cfg(windows)]
    let parsed_shortcut = if args.shortcut.is_empty() {
        None
    } else {
        match hotkey::parse_accelerator(&args.shortcut) {
            Ok(accelerator) => Some(accelerator),
            Err(error) => {
                eprintln!("[quick-assistant] invalid shortcut '{}': {error}", args.shortcut);
                None
            }
        }
    };
    #[cfg(not(windows))]
    let parsed_shortcut: Option<()> = None;

    let shortcut_text = if parsed_shortcut.is_some() { args.shortcut.clone() } else { String::new() };
    let data_dir = args.data_dir.clone();
    let api = args.api.clone();

    let context = tauri::generate_context!();
    tauri::Builder::default()
        .manage(OverlayState {
            accelerator: Mutex::new(shortcut_text),
            ..OverlayState::default()
        })
        .setup(move |app| {
            let mut builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url.clone()))
                .title("DeepSeek Harness 快捷助手")
                .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
                .min_inner_size(DEFAULT_WIDTH, MIN_HEIGHT)
                .max_inner_size(DEFAULT_WIDTH, MAX_HEIGHT)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .visible(false);
            if let Some(directory) = data_dir.as_ref() {
                builder = builder.data_directory(std::path::PathBuf::from(directory));
            }
            let window = builder.build()?;

            let handle = app.handle().clone();
            #[cfg(windows)]
            {
                match hotkey::install(&handle, parsed_shortcut) {
                    Ok(hwnd) => {
                        if let Some(overlay) = handle.try_state::<OverlayState>() {
                            overlay.hotkey_window.store(hwnd as i64, Ordering::Relaxed);
                        }
                    }
                    Err(error) => {
                        eprintln!("[quick-assistant] global shortcut unavailable: {error}");
                        if let Some(overlay) = handle.try_state::<OverlayState>() {
                            overlay.set_accelerator("");
                        }
                    }
                }
            }
            #[cfg(not(windows))]
            {
                let _ = &handle;
                eprintln!("[quick-assistant] global shortcuts are only implemented on Windows");
            }

            let blur_app = handle.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    let pinned = blur_app
                        .try_state::<OverlayState>()
                        .map(|overlay| overlay.pinned.load(Ordering::Relaxed))
                        .unwrap_or(false);
                    let just_shown = blur_app
                        .try_state::<OverlayState>()
                        .map(|overlay| now_ms() - overlay.shown_at.load(Ordering::Relaxed) < 800)
                        .unwrap_or(false);
                    if !pinned && !just_shown {
                        hide_overlay(&blur_app);
                    }
                }
            });

            let poll_app = handle.clone();
            std::thread::spawn(move || poll_native_state(poll_app, api));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            qa_set_pinned,
            qa_hide,
            qa_set_height,
            qa_set_shortcut,
            qa_log
        ])
        .build(context)
        .expect("failed to build the quick-assistant overlay application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // Hiding the panel never closes the window; this only fires for
                // an explicit shutdown, which must not end the process while the
                // DSH host still owns it.
                api.prevent_exit();
            }
        });
}
