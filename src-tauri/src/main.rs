//! dsh-gui — a thin desktop shell for the DeepSeek Harness web UI.
//!
//! It does three things:
//!   1. spawn the self-hosted harness web server (`dsh web`) from the
//!      `deepseek-harness` submodule checkout, with `DSH_HOME` pinned inside
//!      the repository;
//!   2. wait until that server answers HTTP on the loopback port;
//!   3. open a single webview window (OS title bar + border only) pointed at it.
//!
//! There is no frontend, plugin, or IPC surface of its own: the webview renders
//! the full harness UI over HTTP, exactly as a browser would.

// Hide the console when double-clicking a release build; keep it in debug so
// `cargo run` still shows status lines.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::Manager;

/// Submodule directory name.
const HARNESS_DIR: &str = "deepseek-harness";
/// Built `dsh` entry, relative to the repository root.
const HARNESS_BIN: &str = "deepseek-harness/apps/cli/lib/bin.js";
/// Default loopback port (matches the harness `web` profile default; override
/// with the `DSH_GUI_PORT` environment variable).
const DEFAULT_PORT: u16 = 3080;

/// Walk up from the executable until the repository root (the directory that
/// holds both `deepseek-harness/` and `src-tauri/`) is found.
fn repo_root() -> PathBuf {
    let exe = std::env::current_exe().expect("current executable path");
    let mut dir = exe
        .parent()
        .map(Path::to_path_buf)
        .expect("executable has a parent directory");
    for _ in 0..8 {
        if dir.join(HARNESS_DIR).join("package.json").is_file()
            && dir.join("src-tauri").join("tauri.conf.json").is_file()
        {
            return dir;
        }
        if !dir.pop() {
            break;
        }
    }
    panic!("dsh-gui: could not locate the repository root from {exe:?}")
}

/// Resolve the loopback port: `DSH_GUI_PORT` if it parses as a u16, else 3080.
fn resolve_port() -> u16 {
    std::env::var("DSH_GUI_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// Spawn `node <root>/deepseek-harness/apps/cli/lib/bin.js web --port <port>`
/// with `DSH_HOME` pinned to `<root>/.dsh`, and redirect its output to a log
/// file so a console-less launch is still debuggable.
fn spawn_harness(root: &Path, port: u16) -> Result<Child, Box<dyn std::error::Error>> {
    let bin = root.join(HARNESS_BIN);
    if !bin.is_file() {
        return Err(format!(
            "harness is not built: {} is missing — run scripts\\setup.ps1 first",
            bin.display()
        )
        .into());
    }

    let home = root.join(".dsh");
    let log_dir = home.join("gui");
    fs::create_dir_all(&log_dir)?;
    let log = File::create(log_dir.join("harness.log"))?;

    let child = Command::new("node")
        .arg(&bin)
        .arg("web")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(root.join(HARNESS_DIR))
        .env("DSH_HOME", &home)
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("failed to spawn harness (is `node` on PATH?): {e}"))?;
    Ok(child)
}

/// Minimal HTTP readiness probe: returns true when the harness answers `GET /`
/// with a 200 on the loopback port (so we never open the webview on a socket
/// that is bound but not yet serving the frontend).
fn http_get_ok(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 1024];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// Wait until the harness serves the frontend, or until it exits / times out.
fn wait_ready(
    child: &mut Child,
    port: u16,
    timeout: Duration,
) -> Result<(), Box<dyn std::error::Error>> {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(format!(
                "harness exited before becoming ready (status {status}); see .dsh\\gui\\harness.log"
            )
            .into());
        }
        if http_get_ok(port) {
            return Ok(());
        }
        if start.elapsed() >= timeout {
            return Err(format!(
                "timed out after {timeout:?} waiting for the harness on 127.0.0.1:{port}; see .dsh\\gui\\harness.log"
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Owns the harness child process for the app's lifetime and reaps it on exit
/// (killing the whole process tree on Windows).
struct ChildGuard(Mutex<Option<Child>>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Some(mut child) = self.0.lock().ok().and_then(|mut g| g.take()) else {
            return;
        };
        #[cfg(windows)]
        {
            // Terminate the tree (node + any helpers it started), no console flash.
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .status();
        }
        #[cfg(not(windows))]
        {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

fn main() {
    let root = repo_root();
    let port = resolve_port();

    // Start the harness before the GUI so a startup failure reports clearly on
    // the console (debug) instead of silently behind a blank window.
    let child = match spawn_harness(&root, port)
        .and_then(|mut c| wait_ready(&mut c, port, Duration::from_secs(90)).map(|_| c))
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[dsh-gui] failed to start the harness: {e}");
            std::process::exit(1);
        }
    };
    println!("[dsh-gui] harness ready at http://127.0.0.1:{port}");

    let child = ChildGuard(Mutex::new(Some(child)));
    let url: tauri::Url = format!("http://127.0.0.1:{port}")
        .parse()
        .expect("a numeric loopback port always parses as a URL");

    tauri::Builder::default()
        .setup(move |app| {
            app.manage(child);
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("DeepSeek Harness")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the dsh-gui application");
}
