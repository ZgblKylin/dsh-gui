//! Global `log` sink so dsh-gui captures its dependencies' diagnostics.
//!
//! Tauri's runtime-wry swallows a failed native window/webview creation: its
//! `Message::CreateWindow` handler only `log::error!`s the failure and
//! `Context::create_window` still returns `Ok`, so `WebviewWindowBuilder::build`
//! appears to succeed. The window is then absent from the runtime's window map,
//! and the first `Window::hwnd()` fails with `raw_window_handle`'s
//! "the underlying handle is not available" — which `setup` propagated into a
//! panic, leaving only that opaque line in `dsh-gui-crash.log`.
//!
//! Because no logger was installed, wry's real error (`failed to create window`
//! / `failed to create webview: …` / `Could not find the webview runtime…`) was
//! dropped. This module installs a file logger so those lines land in
//! `.dsh/gui/gui.log` next to dsh-gui's own status lines, and a startup failure
//! can be diagnosed instead of guessed at.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Resolved at [`install`] time (the repository root is only known then).
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

struct FileLogger;

impl log::Log for FileLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        // The interesting records are `warn`/`error` from wry, but keep the
        // filter permissive: the file is small and only opened on demand.
        true
    }

    fn log(&self, record: &log::Record) {
        let Some(path) = LOG_PATH.get() else {
            return;
        };
        // Open per record: the harness reader threads and `log_status` append to
        // the same file, and Windows append handles make each write atomic.
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(
                file,
                "[{}] {}: {}",
                record.level(),
                record.target(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

/// Install the process-wide logger writing to `<root>/.dsh/gui/gui.log`.
///
/// Call once from `main` before the Tauri builder runs so that a window/
/// webview creation failure inside `setup` is captured. Idempotent: a second
/// call (or a `set_logger` race) is ignored.
pub fn install(root: &std::path::Path) {
    let dir = root.join(".dsh").join("gui");
    let _ = std::fs::create_dir_all(&dir);
    let _ = LOG_PATH.set(dir.join("gui.log"));

    static LOGGER: FileLogger = FileLogger;
    let _ = log::set_logger(&LOGGER);
    // `Info` is enough for dsh-gui's own progress lines; wry's creation errors
    // are `error!`. Raise to `Debug` temporarily for deeper WebView2 detail.
    log::set_max_level(log::LevelFilter::Info);
}
