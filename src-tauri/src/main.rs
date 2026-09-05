//! dsh-gui — a thin desktop shell for the DeepSeek Harness web UI.
//!
//! It does three things:
//!   1. spawn the self-hosted harness web server (`dsh web`) from the
//!      `deepseek-harness` submodule checkout, with `DSH_HOME` pinned inside
//!      the repository;
//!   2. wait until that server answers HTTP on the loopback port;
//!   3. open a single frameless window: the shell page (served from the app
//!      origin, `frontendDist: ui`) renders the custom title bar and dialogs,
//!      and **each connection tab is hosted by its own child webview**
//!      (`views`) that loads the harness page as a real top-level document —
//!      no iframe, no wrapper server, no browser-auth workaround.
//!
//! The frontend lives in `src-tauri/ui/` (a plain HTML shell — no bundler). It
//! has one small IPC surface: window controls, connection tabs, and an About
//! dialog whose data (version/license/repository for the shell, the harness,
//! and every plugin) is assembled in [`about`].

// A plain Win32 GUI app in every profile: no console window on double-click,
// and the launching terminal (cmd or PowerShell) does not wait for it. All of
// dsh-gui's own diagnostics go to `.dsh\gui\gui.log` instead of a console.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod about;
mod changelog;
mod dialog_sizes;
mod dialogs;
#[cfg(windows)]
mod native_window;
mod update;
mod views;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{Emitter, Manager, State};

// Tab-view commands live in `views`; plain imports (not `views::fn` paths)
// keep the `generate_handler!` / permission-autogen name extraction working.
use views::{
    ai_update_result, page_theme, view_answer_permission, view_close, view_create, view_eval,
    view_set_bounds, view_set_visible,
};
// Native dialog-window commands (see `dialogs`).
use dialogs::{
    ai_update_request, close_dialog, connection_added, dialog_event, fit_dialog, open_dialog,
    save_dialog_size, show_dialog,
};

#[cfg(windows)]
mod job {
    //! A minimal Windows job-object wrapper: the job kills every process in it
    //! the moment its last handle closes. The kernel enforces that even when
    //! dsh-gui itself is terminated without running destructors (Task Manager,
    //! closing the terminal it was launched from), so the harness cannot
    //! outlive the shell.

    use std::os::windows::io::{AsRawHandle, RawHandle};
    use std::process::Child;

    type Handle = *mut std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut std::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *mut std::ffi::c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: RawHandle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    /// A kill-on-close job. Assignment is best-effort: on failure the caller
    /// falls back to `taskkill` so cleanup is still attempted.
    pub struct KillJob(Handle);

    // A kernel job handle has no thread affinity; it is safe to hold inside
    // Tauri managed state, which requires Send + Sync.
    unsafe impl Send for KillJob {}
    unsafe impl Sync for KillJob {}

    impl KillJob {
        /// Create a job whose members are killed when the handle closes.
        pub fn new() -> std::io::Result<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let mut info: ExtendedLimitInformation =
                    std::mem::MaybeUninit::zeroed().assume_init();
                info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &mut info as *mut ExtendedLimitInformation as *mut std::ffi::c_void,
                    std::mem::size_of::<ExtendedLimitInformation>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return Err(std::io::Error::last_os_error());
                }
                Ok(Self(handle))
            }
        }

        /// Put the harness process into the job. Processes it spawns later
        /// join automatically, so the whole harness tree is covered. The
        /// spawn/assign race is harmless here: the harness needs seconds to
        /// boot before it could spawn anything.
        pub fn assign(&self, child: &Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) != 0 }
        }

        /// Kill every process currently in the job.
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for KillJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Submodule directory name.
const HARNESS_DIR: &str = "deepseek-harness";
/// Built `dsh` entry, relative to the repository root.
const HARNESS_BIN: &str = "deepseek-harness/apps/cli/lib/bin.js";
/// Default loopback port (matches the harness `web` profile default; override
/// with the `DSH_GUI_PORT` environment variable).
const DEFAULT_PORT: u16 = 3080;

/// Walk up from the executable until the repository root (the directory that
/// holds both `deepseek-harness/` and `src-tauri/`) is found. The exe sits
/// either in `src-tauri/target/<profile>/` or at the repository root itself
/// (the build scripts copy it there), and both resolve on the first hop.
fn repo_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("could not resolve the executable path: {e}"))?;
    let mut dir = exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("executable has no parent directory: {exe:?}"))?;
    for _ in 0..8 {
        if dir.join(HARNESS_DIR).join("package.json").is_file()
            && dir.join("src-tauri").join("tauri.conf.json").is_file()
        {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    Err(format!("could not locate the repository root from {exe:?}"))
}

/// Resolve the loopback port: `DSH_GUI_PORT` if it parses as a u16, else 3080.
fn resolve_port() -> u16 {
    std::env::var("DSH_GUI_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// Refuse to launch while another process already owns the requested endpoint.
/// Without this preflight, the HTTP readiness probe can mistake that foreign
/// server for the child we just spawned while our child is still loading, open
/// the GUI against the wrong DSH_HOME, and only later log the child's
/// `EADDRINUSE` exit.
fn ensure_loopback_port_available(port: u16) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AddrInUse {
            format!(
                "127.0.0.1:{port} is already in use; close the existing dsh-gui / dsh web process or choose another DSH_GUI_PORT"
            )
        } else {
            format!("could not reserve 127.0.0.1:{port} for the harness: {error}")
        }
    })?;
    drop(listener);
    Ok(())
}

/// Return the process that owns the IPv4 listener for `port` on Windows.
/// The preflight above handles the normal collision case; this post-spawn
/// ownership check closes the much smaller bind race between releasing the
/// preflight socket and Node claiming it.
#[cfg(windows)]
fn loopback_listener_pid(port: u16) -> Result<Option<u32>, String> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    let mut size = 0_u32;
    unsafe {
        // The first call reports the buffer size. Its status is normally
        // ERROR_INSUFFICIENT_BUFFER, but `size` is the only result needed.
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
    }
    if size < std::mem::size_of::<u32>() as u32 {
        return Err("Windows returned an empty TCP listener table".to_string());
    }

    // A u32 backing buffer gives the table header and every row their required
    // alignment; a Vec<u8> cast would not provide that guarantee.
    let mut words = vec![0_u32; (size as usize).div_ceil(std::mem::size_of::<u32>())];
    let status = unsafe {
        GetExtendedTcpTable(
            words.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if status != 0 {
        return Err(format!(
            "could not inspect the Windows TCP listener table: {}",
            std::io::Error::from_raw_os_error(status as i32)
        ));
    }

    let count = words[0] as usize;
    let row_words = std::mem::size_of::<MIB_TCPROW_OWNER_PID>()
        .div_ceil(std::mem::size_of::<u32>());
    if 1 + count.saturating_mul(row_words) > words.len() {
        return Err("Windows returned a truncated TCP listener table".to_string());
    }
    let rows = unsafe {
        std::slice::from_raw_parts(
            words.as_ptr().add(1).cast::<MIB_TCPROW_OWNER_PID>(),
            count,
        )
    };
    Ok(rows
        .iter()
        .find(|row| {
            u32::from_be(row.dwLocalAddr) == u32::from_be_bytes([127, 0, 0, 1])
                && u16::from_be(row.dwLocalPort as u16) == port
        })
        .map(|row| row.dwOwningPid))
}

/// Append a status line to `<root>/.dsh/gui/gui.log` (the only visible record
/// once the console is gone) and mirror it to stderr for `cargo run`.
fn log_status(root: &Path, msg: &str) {
    eprintln!("[dsh-gui] {msg}");
    let dir = root.join(".dsh").join("gui");
    if fs::create_dir_all(&dir).is_ok() {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("gui.log"))
        {
            let _ = writeln!(file, "[dsh-gui] {msg}");
        }
    }
}

/// Write a diagnostic line to `.dsh/gui/gui.log` (and stderr), reachable from
/// the other modules via `crate::dsh_log`. Used to trace the WebView2
/// permission-consent flow without a console.
pub(crate) fn dsh_log(app: &tauri::AppHandle, msg: &str) {
    if let Some(state) = app.try_state::<ShellState>() {
        log_status(&state.root, msg);
    } else {
        eprintln!("[dsh-gui] {msg}");
    }
}

/// Report a fatal startup error: the log line plus, on Windows, a message box,
/// so a double-clicked launch that fails is still visible without a console.
fn fatal(root: Option<&Path>, msg: &str) -> ! {
    if let Some(root) = root {
        log_status(root, msg);
    } else {
        eprintln!("[dsh-gui] {msg}");
    }
    #[cfg(windows)]
    show_error_box("dsh-gui", msg);
    std::process::exit(1);
}

/// A blocking `MessageBoxW` error dialog (GUI app: there is no console).
#[cfg(windows)]
fn show_error_box(caption: &str, text: &str) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            kind: u32,
        ) -> i32;
    }
    const MB_ICONERROR: u32 = 0x0010;
    let text: Vec<u16> = std::ffi::OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let caption: Vec<u16> = std::ffi::OsStr::new(caption)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_ICONERROR,
        );
    }
}

/// Panics in a GUI app would otherwise vanish; append them to a crash log next
/// to the exe so failures are still diagnosable.
fn install_panic_log() {
    std::panic::set_hook(Box::new(|info| {
        let dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."));
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("dsh-gui-crash.log"))
        {
            let _ = writeln!(file, "panic: {info}");
        }
    }));
}

/// A running harness process plus a reader of its stdout, which carries the
/// launch line `dsh web: http://127.0.0.1:<port>/?token=...` emitted once the
/// Web profile is ready (a harness ≥ dsh-v0.1.2-alpha.1 authenticates every
/// request through that one-time token or its minted session cookie).
struct HarnessProcess {
    child: Child,
    lines: mpsc::Receiver<String>,
}

impl HarnessProcess {
    fn into_child(self) -> Child {
        self.child
    }
}

/// Post-launch harness URL and browser session state the shell needs once the
/// Web profile answers HTTP.
struct HarnessAuth {
    /// URL the shell hands to the tab webviews; carries the launch-token query
    /// when the harness minted one, and is the plain loopback URL otherwise.
    web_url: String,
    /// `name=value` session cookie minted from the launch token. The shell's
    /// own HTTP calls (remote ops, changelog) attach it because an ad-hoc
    /// TcpStream request has no cookie jar.
    cookie: Option<String>,
}

/// Spawn `node <root>/deepseek-harness/apps/cli/lib/bin.js web --port <port> --no-open`
/// with `DSH_HOME` pinned to `<root>/.dsh`. The harness's stdout is captured
/// (the launch URL line carries its one-time token) and mirrored to
/// `.dsh\gui\harness.log`; stderr goes to the same log file. `--no-open` stops
/// the harness web bundle from handing the page to the default browser: the
/// shell opens its own window, and the harness runs embedded in it.
fn spawn_harness(root: &Path, port: u16) -> Result<HarnessProcess, Box<dyn std::error::Error>> {
    let bin = root.join(HARNESS_BIN);
    if !bin.is_file() {
        return Err(format!(
            "harness is not built: {} is missing — run `npm run setup` first",
            bin.display()
        )
        .into());
    }

    ensure_loopback_port_available(port)?;

    let home = root.join(".dsh");
    let log_dir = home.join("gui");
    fs::create_dir_all(&log_dir)?;
    let log_path = log_dir.join("harness.log");
    // Truncate the previous run, then let both reader threads append below.
    File::create(&log_path)?;

    let mut command = Command::new("node");
    command
        .arg(&bin)
        .arg("web")
        .arg("--port")
        .arg(port.to_string())
        .arg("--no-open")
        .current_dir(root.join(HARNESS_DIR))
        .env("DSH_HOME", &home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: `node.exe` is a console-subsystem executable, so
        // without this flag Windows allocates a brand-new console window for
        // it whenever dsh-gui is launched from Explorer. The harness runs
        // fully in the background; its output already goes to
        // `.dsh\gui\harness.log`.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn harness (is `node` on PATH?): {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("harness stdout is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("harness stderr is unavailable")?;
    let (tx, rx) = mpsc::channel();
    // One writer thread per stream: each line is appended to the shared log
    // file (append-mode handles) and, for stdout, replayed to the channel so
    // `wait_ready` can parse the token from the launch URL line.
    let tee_path = log_path.clone();
    let tx_tee = tx.clone();
    let tee = std::thread::spawn(move || {
        let mut file = log_file(&tee_path);
        let mut buf = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match buf.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let cooked = line.trim_end().to_string();
                    if let Some(f) = file.as_mut() {
                        let _ = f.write_all(cooked.as_bytes());
                        let _ = f.write_all(b"\n");
                    }
                    if tx_tee.send(cooked).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let tee_path = log_path.clone();
    let tee2 = std::thread::spawn(move || {
        let mut file = log_file(&tee_path);
        let mut buf = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match buf.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let cooked = line.trim_end().to_string();
                    if let Some(f) = file.as_mut() {
                        let _ = f.write_all(cooked.as_bytes());
                        let _ = f.write_all(b"\n");
                    }
                }
            }
        }
    });
    let _ = (tee, tee2);
    Ok(HarnessProcess { child, lines: rx })
}

/// Append-mode handle for the harness log, opened lazily per thread (Windows
/// append handles make each `write_all` an atomic append, so two concurrent
/// streams cannot overwrite each other).
fn log_file(path: &Path) -> Option<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

/// Extract the launch token from a `dsh web: ...?token=...` output line. The
/// line may carry a second token query for the LAN URL; both are identical.
fn parse_launch_token(line: &str) -> Option<String> {
    const MARKER: &str = "?token=";
    let pos = line.find(MARKER)?;
    let token: String = line[pos + MARKER.len()..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    (!token.is_empty()).then_some(token)
}

/// Loopback URL carrying the harness launch token as its sole authentication.
fn authenticated_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/?token={token}")
}

/// Minimal HTTP readiness probe: returns the status code the harness answers
/// `GET /` with on the loopback port. The Web profile serves the browser-auth
/// gate before any other HTTP: unauthenticated index requests answer 401. The
/// probe never distinguishes the status, only whether the port answers.
fn http_probe_status(port: u16) -> Option<u16> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut buf = [0u8; 1024];
    let n = stream.read(&mut buf).ok()?;
    let head = String::from_utf8_lossy(&buf[..n]);
    head.lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()
}


/// Wait until the harness serves the frontend (or answers the browser-auth
/// gate), and recover its launch token before opening the webview. The Web
/// profile ≥ dsh-v0.1.2-alpha.1 answers unauthenticated requests with HTTP 401
/// and prints its launcher URL (with a one-time `?token=`) on stdout; older
/// profiles answer 200 directly and print no token — both are supported here.
fn wait_ready(
    process: &mut HarnessProcess,
    port: u16,
    timeout: Duration,
) -> Result<HarnessAuth, Box<dyn std::error::Error>> {
    let start = Instant::now();
    let mut token: Option<String> = None;
    loop {
        while let Ok(line) = process.lines.try_recv() {
            if token.is_none() {
                token = parse_launch_token(&line);
            }
        }
        if let Some(status) = process.child.try_wait()? {
            return Err(format!(
                "harness exited before becoming ready (status {status}); see .dsh\\gui\\harness.log"
            )
            .into());
        }
        if let Some(code) = http_probe_status(port) {
            if code == 200 || code == 401 {
                #[cfg(windows)]
                match loopback_listener_pid(port)? {
                    Some(pid) if pid == process.child.id() => {
                        // The HTTP connection may have closed just as the table
                        // was sampled; let the normal child/timeout checks decide.
                    }
                    Some(pid) => {
                        return Err(format!(
                            "127.0.0.1:{port} answered from unexpected process {pid}, not the spawned harness process {}; refusing to open the wrong DSH_HOME",
                            process.child.id()
                        )
                        .into())
                    }
                    None => {}
                }
                // A 200 on a legacy (no-auth) profile is fully ready; a 401
                // means the browser-auth gate is up and only the launch-token
                // line is still pending — keep draining until it arrives.
                if code == 200 || token.is_some() {
                    break;
                }
            }
        }
        if start.elapsed() >= timeout {
            let hint = if token.is_none() {
                "the harness answered the browser-auth gate but never printed its launch URL; check .dsh\\gui\\harness.log"
            } else {
                "check .dsh\\gui\\harness.log"
            };
            return Err(format!(
                "timed out after {timeout:?} waiting for the harness on 127.0.0.1:{port}; {hint}"
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let web_url = match &token {
        Some(t) => authenticated_url(port, t),
        None => format!("http://127.0.0.1:{port}/"),
    };
    // Exchange the one-time token for the signed session cookie once, so the
    // shell's own HTTP calls (remote ops, changelog) come through the gate.
    let cookie = match &token {
        Some(t) => fetch_session_cookie(port, t).ok().flatten(),
        None => None,
    };
    Ok(HarnessAuth { web_url, cookie })
}

/// Exchange the launch token for the browser-auth session cookie with one
/// `GET /?token=...` and return the first `name=value` pair of the minted
/// `set-cookie` header. The response is a 303 redirect; the cookie payload is
/// signed by the harness secret and bound to the request authority, so the
/// shell must echo the exact same `Host` header it uses for later calls.
fn fetch_session_cookie(port: u16, token: &str) -> Result<Option<String>, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("cannot reach the harness on 127.0.0.1:{port}: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let request = format!(
        "GET /?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("failed to send token exchange request: {e}"))?;
    let mut buf = [0u8; 8192];
    let mut head = String::new();
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                head.push_str(&String::from_utf8_lossy(&buf[..n]));
                if head.contains("\r\n\r\n") {
                    break;
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                break
            }
            Err(e) => return Err(format!("failed reading token exchange response: {e}")),
        }
    }
    let Some((head, _)) = head.split_once("\r\n\r\n") else {
        return Ok(None);
    };
    for line in head.lines().skip(1) {
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("set-cookie:") {
            let first = value
                .trim()
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if first.contains('=') {
                return Ok(Some(first));
            }
        }
    }
    Ok(None)
}

/// Owns the harness child process for the app's lifetime and guarantees it
/// cannot outlive the shell: on Windows the child sits in a kill-on-close job,
/// so the kernel tears the whole harness tree down even when dsh-gui is killed
/// without running destructors (Task Manager, closing its launching terminal).
struct ChildGuard {
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    job: Option<job::KillJob>,
}

impl ChildGuard {
    #[cfg(windows)]
    fn new(child: Child) -> Self {
        match job::KillJob::new() {
            Ok(job) if job.assign(&child) => Self {
                child: Mutex::new(Some(child)),
                job: Some(job),
            },
            // Job creation/assignment failed: keep the child and fall back to
            // taskkill in Drop.
            _ => Self {
                child: Mutex::new(Some(child)),
                job: None,
            },
        }
    }

    #[cfg(not(windows))]
    fn new(child: Child) -> Self {
        Self {
            child: Mutex::new(Some(child)),
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            // Kill the whole harness tree at once; the direct child is reaped
            // below.
            job.terminate();
        }
        let Some(mut child) = self.child.lock().ok().and_then(|mut g| g.take()) else {
            return;
        };
        #[cfg(windows)]
        if self.job.is_none() {
            // Without a job (creation or assignment failed), terminate the
            // tree with taskkill, no console flash.
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .status();
        }
        #[cfg(not(windows))]
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// App-global state handed to the window-control, About, and update commands.
struct ShellState {
    root: PathBuf,
    port: u16,
    /// URL the shell hands to tab webviews. Carries the harness launch
    /// token (Web profiles ≥ dsh-v0.1.2-alpha.1 mint a one-time token and
    /// answer every unauthenticated request with 401).
    web_url: String,
    /// Browser session cookie minted from the token, used by the shell's own
    /// HTTP calls (`remote_call`, changelog); ad-hoc TcpStream requests carry
    /// no browser cookie jar.
    cookie: Option<String>,
    /// PIDs the detached update launcher must wait for before touching the
    /// checkout: this shell and the harness child it owns.
    gui_pid: u32,
    harness_pid: u32,
    /// Serializes update checks / launches (git fetch can take tens of
    /// seconds; two checks must never race each other's plan file).
    update_lock: Arc<Mutex<()>>,
    /// Last completed update check, shared with the dedicated update dialog
    /// window so it can render immediately instead of racing the shell's
    /// background check for the lock.
    update_cache: Arc<Mutex<Option<update::UpdateStatus>>>,
}

/// The native-looking menu shown by the custom top-left window icon.
struct WindowMenuState {
    menu: Menu<tauri::Wry>,
}

#[tauri::command]
fn minimize_window(window: tauri::Window, webview: tauri::Webview) {
    if views::ensure_shell(&webview).is_err() {
        return;
    }
    let _ = window.minimize();
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window, webview: tauri::Webview) {
    if views::ensure_shell(&webview).is_err() {
        return;
    }
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn is_window_maximized(window: tauri::Window, webview: tauri::Webview) -> bool {
    if views::ensure_shell(&webview).is_err() {
        return false;
    }
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn close_window(window: tauri::Window, webview: tauri::Webview) {
    if views::ensure_shell(&webview).is_err() {
        return;
    }
    let _ = window.close();
}

#[tauri::command]
fn start_window_drag(window: tauri::Window, webview: tauri::Webview) {
    if views::ensure_shell(&webview).is_err() {
        return;
    }
    let _ = window.start_dragging();
}

/// Shows the window-control menu from the custom top-left window icon.
/// The actual `TrackPopupMenu` call is modal and must run on the window thread;
/// a background thread is used as a bridge so the IPC command itself returns
/// immediately and does not wait for the menu to close.
#[tauri::command]
fn show_window_menu(
    window: tauri::Window,
    webview: tauri::Webview,
    state: State<'_, WindowMenuState>,
) -> Result<(), String> {
    views::ensure_shell(&webview)?;
    // Logical window coordinates: just below the 32x36 title-bar icon.
    let position = tauri::Position::Logical(tauri::LogicalPosition::new(6.0, 36.0));
    let menu = state.menu.clone();
    std::thread::spawn(move || {
        let _ = window.popup_menu_at(&menu, position);
    });
    Ok(())
}

/// One entry of the hamburger menu's tab list, reported by the shell page.
#[derive(serde::Deserialize)]
struct ConfigTab {
    id: String,
    title: String,
}

/// Shows the hamburger (☰) menu as a *native* popup menu instead of a DOM
/// dropdown. A DOM dropdown lives in the shell page and would be covered by
/// the native harness tab webviews — the old code worked around that by
/// hiding the harness (the black content area in the screenshot). A native
/// OS popup floats above every child webview, so the harness stays visible.
#[tauri::command]
fn show_config_menu(
    window: tauri::Window,
    webview: tauri::Webview,
    tabs: Vec<ConfigTab>,
    has_updates: bool,
    x: f64,
    y: f64,
) -> Result<(), String> {
    views::ensure_shell(&webview)?;
    let handle = window.app_handle().clone();

    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    if !tabs.is_empty() {
        items.push(Box::new(
            MenuItem::with_id(&handle, "tabs.header", "标签页", false, None::<&str>)
                .map_err(|e| e.to_string())?,
        ));
        for tab in tabs {
            items.push(Box::new(
                MenuItem::with_id(&handle, format!("tab.{}", tab.id), tab.title, true, None::<&str>)
                    .map_err(|e| e.to_string())?,
            ));
        }
        items.push(Box::new(
            PredefinedMenuItem::separator(&handle).map_err(|e| e.to_string())?,
        ));
    }
    items.push(Box::new(
        MenuItem::with_id(&handle, "conn.new", "新建连接", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    ));
    items.push(Box::new(
        MenuItem::with_id(&handle, "conn.close", "关闭当前连接", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    ));
    items.push(Box::new(
        PredefinedMenuItem::separator(&handle).map_err(|e| e.to_string())?,
    ));
    items.push(Box::new(
        MenuItem::with_id(
            &handle,
            "config.update",
            if has_updates { "更新软件" } else { "检查更新" },
            true,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?,
    ));
    items.push(Box::new(
        PredefinedMenuItem::separator(&handle).map_err(|e| e.to_string())?,
    ));
    items.push(Box::new(
        MenuItem::with_id(&handle, "config.about", "关于", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    ));
    items.push(Box::new(
        MenuItem::with_id(&handle, "config.exit", "退出", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    ));

    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|b| b.as_ref()).collect();
    let menu = Menu::with_items(&handle, &refs).map_err(|e| e.to_string())?;

    let position = tauri::Position::Logical(tauri::LogicalPosition::new(x, y));
    std::thread::spawn(move || {
        let _ = window.popup_menu_at(&menu, position);
    });
    Ok(())
}

/// The self-hosted harness UI URL, so the shell can point tab webviews at the
/// right port without the port being baked into the assets. Carries the
/// one-time launch token when the Web profile minted one.
#[tauri::command]
fn harness_url(webview: tauri::Webview, state: State<'_, ShellState>) -> Result<String, String> {
    views::ensure_shell_or_dialog(&webview)?;
    Ok(state.web_url.clone())
}

/// Everything the About dialog needs: version/license/repository for the
/// shell, the harness submodule, and every plugin under `plugins/`. Runs off
/// the main thread: collecting it shells out to `git` for every module.
#[tauri::command]
async fn about_info(
    webview: tauri::Webview,
    state: State<'_, ShellState>,
) -> Result<about::AboutInfo, String> {
    views::ensure_shell_or_dialog(&webview)?;
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || about::collect(&root))
        .await
        .map_err(|e| format!("about info task failed: {e}"))
}

/// Cold-start preview for the update dialog: project list + local versions
/// only (no network). The frontend renders these rows immediately with
/// placeholders, then `check_updates` fills in the real latest/status.
#[tauri::command]
fn local_update_projects(
    webview: tauri::Webview,
    state: State<'_, ShellState>,
) -> Result<Vec<update::ProjectUpdate>, String> {
    views::ensure_shell_or_dialog(&webview)?;
    Ok(update::local_check(&state.root))
}

/// Last completed update check (shared cache for dialog windows). The shell
/// runs a startup + periodic background check; the dedicated update dialog
/// reads this first so it never has to race the background check for the
/// update lock.
#[tauri::command]
fn cached_update_status(
    webview: tauri::Webview,
    state: State<'_, ShellState>,
) -> Result<Option<update::UpdateStatus>, String> {
    views::ensure_shell_or_dialog(&webview)?;
    Ok(state.update_cache.lock().map_err(|_| "update cache is poisoned")?.clone())
}

/// Check the dsh-gui repository and every submodule for updates. Runs off the
/// main thread: `git fetch` per repository can take tens of seconds, and the
/// manual dialog as well as the startup/interval background checks call here.
#[tauri::command]
async fn check_updates(
    webview: tauri::Webview,
    state: State<'_, ShellState>,
) -> Result<update::UpdateStatus, String> {
    views::ensure_shell_or_dialog(&webview)?;
    let root = state.root.clone();
    let gui_pid = state.gui_pid;
    let harness_pid = state.harness_pid;
    let lock = Arc::clone(&state.update_lock);
    let cache = Arc::clone(&state.update_cache);
    let status = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "an update check is already running".to_string())?;
        update::check_and_sync(&root, gui_pid, harness_pid)
    })
    .await
    .map_err(|e| format!("update check task failed: {e}"))??;
    if let Ok(mut cached) = cache.lock() {
        *cached = Some(status.clone());
    }
    Ok(status)
}

/// Launch the detached update launcher for the selected project ids (empty:
/// every pending project), then exit so the launcher can safely touch the
/// checkout. Exiting drops `ChildGuard`, whose kill-on-close job tears the
/// whole harness process tree down.
#[tauri::command]
fn start_update(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, ShellState>,
    ids: Vec<String>,
    modes: HashMap<String, String>,
) -> Result<(), String> {
    views::ensure_shell_or_dialog(&webview)?;
    let _guard = state
        .update_lock
        .lock()
        .map_err(|_| "an update check is already running".to_string())?;
    update::start(&state.root, state.gui_pid, state.harness_pid, &ids, &modes)?;
    log_status(
        &state.root,
        &format!(
            "update launcher spawned for: {}",
            if ids.is_empty() {
                "all".to_string()
            } else {
                ids.join(", ")
            }
        ),
    );
    app.exit(0);
    Ok(())
}

/// In-dialog update of the top-level repository (dsh-gui 仓库本体): the row's
/// 「更新」 button runs this instead of an AI update — it fast-forwards the
/// root to its target and recursively syncs every submodule, streaming
/// progress lines as `update-root-log` events while the shell keeps running.
/// Nothing is rebuilt here: the dialog reminds the user to run
/// `npm run build` afterwards and then restart.
#[tauri::command]
async fn update_root(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, ShellState>,
    mode: Option<String>,
) -> Result<(), String> {
    views::ensure_shell_or_dialog(&webview)?;
    let root = state.root.clone();
    let lock = Arc::clone(&state.update_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "另一个更新操作正在进行".to_string())?;
        let mut log = |line: &str| {
            let _ = app.emit("update-root-log", line);
        };
        update::run_root_update(&root, mode.as_deref().unwrap_or("commit"), &mut log)
    })
    .await
    .map_err(|e| format!("更新任务失败：{e}"))?
}

/// Update-log content for one row of the update dialog: for a tag target the
/// official GitHub Release notes when the remote is a GitHub repository and a
/// release exists, otherwise a dsh-AI summary of the commit range from the
/// local HEAD to the resolved target.
///
/// The summary first asks the running harness's raw-LLM route (dsh-ai-update
/// plugin, /dsh-gui-api/changelog): no Agent/Session is created, so the run
/// never appears in the DSH session list. When that route is unavailable the
/// command retries it once and only then falls back to the harness's one-shot
/// headless mode (`dsh --profile headless`), whose session store is redirected
/// to a temp directory — neither path persists a session.
///
/// The repository/network part runs under the update lock (git reads must not
/// race an in-dialog root update), then the lock is released for the AI run —
/// the commit data was already collected, so the multi-minute model call never
/// blocks an update check.
#[tauri::command]
async fn update_changelog(
    webview: tauri::Webview,
    state: State<'_, ShellState>,
    id: String,
    mode: Option<String>,
) -> Result<changelog::UpdateChangelog, String> {
    views::ensure_shell_or_dialog(&webview)?;
    let root = state.root.clone();
    let harness_cli = root.join(HARNESS_BIN);
    let port = state.port;
    let cookie = state.cookie.clone();
    let lock = Arc::clone(&state.update_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = {
            let _guard = lock
                .lock()
                .map_err(|_| "另一个更新操作正在进行".to_string())?;
            changelog::prepare(&root, &id, mode.as_deref().unwrap_or("commit"))?
        };
        changelog::finish(prepared, &root, &harness_cli, port, cookie)
    })
    .await
    .map_err(|e| format!("更新日志任务失败：{e}"))?
}

/// Operation names the shell may forward to the harness `/remote-api` route.
/// Whitelist only: the dsh-remote plugin host implements exactly these, and the
/// shell must never reach outside them (path-injection guard on `op`).
const REMOTE_OPS: &[&str] = &[
    "env",
    "probe",
    "local.start",
    "local.stop",
    "local.list",
    "creds.has",
    "creds.read",
    "creds.save",
    "creds.remove",
    "keyfile.write",
    "auth.available",
    "tunnel.close",
    "ssh.connect",
    "ssh.cancel",
    "ssh.status",
    "docker.available",
    "docker.list",
    "docker.connect",
    "docker.cancel",
    "docker.status",
    "diag",
];

/// Minimal JSON HTTP/1.1 POST to the harness loopback server. The shell page
/// lives on the app origin, so a browser `fetch` to `http://127.0.0.1:<port>`
/// would be cross-origin — and the harness's browser-trust fence deliberately
/// refuses cross-origin requests. An ad-hoc TcpStream request carries no
/// `Origin`/`Sec-Fetch-Site` headers, which the fence accepts as same-host.
/// Returns the numeric status, the raw status line, and the (de-chunked)
/// response body; non-2xx statuses are returned to the caller for its own
/// policy.
pub(crate) fn http_post_json_raw(
    port: u16,
    path: &str,
    body: &str,
    cookie: Option<&str>,
) -> Result<(u16, String, String), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("cannot reach the harness on 127.0.0.1:{port}: {e}"))?;
    // A remote start can take a while (first-run npx fetch + backend boot on
    // the remote); the caller runs inside spawn_blocking so the main thread
    // stays responsive.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
    let mut header = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n"
    );
    if let Some(cookie) = cookie {
        header.push_str(&format!("Cookie: {cookie}\r\n"));
    }
    let request = format!(
        "{header}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("failed to send POST {path}: {e}"))?;
    let mut response = Vec::new();
    let mut buf = [0u8; 16384];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => response.extend_from_slice(&buf[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                break
            }
            Err(e) => return Err(format!("failed reading POST {path} response: {e}")),
        }
    }
    let text = String::from_utf8_lossy(&response).into_owned();
    let (head, body) = match text.find("\r\n\r\n") {
        Some(i) => (&text[..i], &text[i + 4..]),
        None => return Err(format!("malformed response from POST {path}")),
    };
    let status_line = head.lines().next().unwrap_or("");
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(body)
    } else {
        body.to_string()
    };
    Ok((status_code, status_line.to_string(), body))
}

/// Erroring wrapper for the remote-ops whitelist: any non-2xx status becomes
/// an Err carrying the status line and the response body.
fn http_post_json(port: u16, op: &str, body: &str, cookie: Option<&str>) -> Result<String, String> {
    let (code, status, response) =
        http_post_json_raw(port, &format!("/remote-api/{op}"), body, cookie)?;
    if !(200..300).contains(&code) {
        return Err(format!(
            "{op} failed ({status}): {}",
            response.chars().take(500).collect::<String>()
        ));
    }
    Ok(response)
}

/// Strip HTTP chunked-transfer framing out of a response body.
fn dechunk(body: &str) -> String {
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let mut line_end = i;
        while line_end < bytes.len() && bytes[line_end] != b'\r' {
            line_end += 1;
        }
        let size_line = std::str::from_utf8(&bytes[i..line_end]).unwrap_or("0");
        let size_text = size_line.split(';').next().unwrap_or("0").trim();
        let Ok(size) = usize::from_str_radix(size_text, 16) else {
            break;
        };
        let mut data_start = line_end;
        if data_start + 1 < bytes.len()
            && bytes[data_start] == b'\r'
            && bytes[data_start + 1] == b'\n'
        {
            data_start += 2;
        }
        if size == 0 {
            break;
        }
        let data_end = data_start + size;
        if data_end + 2 > bytes.len() {
            break;
        }
        out.extend_from_slice(&bytes[data_start..data_end]);
        i = data_end + 2;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Bridge for frontend diagnostics: appends one line to `.dsh\gui\gui.log`
/// (the shell page has no console in release builds, so boot-time facts are
/// otherwise invisible).
#[tauri::command]
fn shell_log(
    webview: tauri::Webview,
    state: State<'_, ShellState>,
    msg: String,
) -> Result<(), String> {
    views::ensure_shell_or_dialog(&webview)?;
    log_status(&state.root, &format!("[ui] {msg}"));
    Ok(())
}

/// Forward one operation to the harness plugin's `/remote-api` route. Runs off
/// the main thread (via spawn_blocking) so a long remote run never blocks the UI.
#[tauri::command]
async fn remote_call(
    webview: tauri::Webview,
    state: State<'_, ShellState>,
    op: String,
    body: String,
) -> Result<String, String> {
    views::ensure_shell_or_dialog(&webview)?;
    if !REMOTE_OPS.contains(&op.as_str()) {
        return Err(format!("unknown op: {op}"));
    }
    let port = state.port;
    let cookie = state.cookie.clone();
    tauri::async_runtime::spawn_blocking(move || http_post_json(port, &op, &body, cookie.as_deref()))
        .await
        .map_err(|e| format!("remote_call task failed: {e}"))?
}

fn main() {
    install_panic_log();

    let root = match repo_root() {
        Ok(root) => root,
        Err(e) => fatal(None, &e),
    };
    let port = resolve_port();

    // Start the harness before the GUI so a startup failure reports clearly
    // (log + message box) instead of silently behind a blank window. The
    // ready wait also recovers the harness launch token (Web profiles ≥
    // dsh-v0.1.2-alpha.1 authenticate via a one-time token) so the tab
    // webviews and the shell's own HTTP calls can pass the browser-auth gate.
    let mut harness = match spawn_harness(&root, port) {
        Ok(h) => h,
        Err(e) => fatal(Some(&root), &format!("failed to spawn the harness: {e}")),
    };
    let auth = match wait_ready(&mut harness, port, Duration::from_secs(90)) {
        Ok(auth) => auth,
        Err(e) => fatal(Some(&root), &format!("failed to start the harness: {e}")),
    };
    let child = harness.into_child();
    log_status(&root, &format!("harness ready at {}", auth.web_url));

    let harness_pid = child.id();
    let child = ChildGuard::new(child);
    let setup_root = root.clone();
    let web_url = auth.web_url;
    let cookie = auth.cookie;

    tauri::Builder::default()
        .plugin(
            tauri_plugin_snap_layout::init()
                .button_id("btn-max")
                .cursor(tauri_plugin_snap_layout::SnapCursor::Arrow)
                .build(),
        )
        .setup(move |app| {
            app.manage(ShellState {
                root: setup_root,
                port,
                web_url,
                cookie,
                gui_pid: std::process::id(),
                harness_pid,
                update_lock: Arc::new(Mutex::new(())),
                update_cache: Arc::new(Mutex::new(None)),
            });
            app.manage(child);
            // Connection-tab child webviews (created lazily by the shell page).
            app.manage(views::ViewRegistry::default());
            // WebView2 notification-permission consent registry (Windows).
            #[cfg(windows)]
            app.manage(views::PermissionRegistry::default());
            // Frameless: the shell page (ui/index.html, served from the app
            // origin) draws its own title bar and window controls; every
            // connection tab is hosted by a child webview (see views.rs) that
            // loads the harness page as a real top-level document, so the
            // browser-auth token flow works exactly like a browser tab.
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("DeepSeek Harness")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .decorations(false)
            // Answer WebView2/WebKitGTK clipboard permission requests so the
            // shell page (copy buttons in the dialogs) may use the async
            // Clipboard API. The harness webviews get their own
            // `.enable_clipboard_access()` in views.rs.
            .enable_clipboard_access()
            .build()?;

            // Add the native non-client interactions missing from a plain
            // `decorations(false)` window: forward the top/bottom resize
            // border double-click to the parent so Windows' default WndProc
            // performs its native vertical fill/restore action. (The actual
            // OS Snap Layouts flyout is provided by the snap-layout plugin.)
            #[cfg(windows)]
            native_window::install(window.hwnd()?.0);

            // Window-control menu shown by the custom top-left icon. Predefined
            // minimize/maximize/close items act on the HWND the menu is shown
            // for; restore/move/size are forwarded here.
            let handle = app.handle().clone();
            let restore = MenuItem::with_id(&handle, "window.restore", "还原", true, None::<&str>)?;
            let move_item = MenuItem::with_id(&handle, "window.move", "移动", true, None::<&str>)?;
            let size_item = MenuItem::with_id(&handle, "window.size", "大小", true, None::<&str>)?;
            let minimize = PredefinedMenuItem::minimize(&handle, Some("最小化"))?;
            let maximize = PredefinedMenuItem::maximize(&handle, Some("最大化"))?;
            let close = PredefinedMenuItem::close_window(&handle, Some("关闭"))?;
            let sep1 = PredefinedMenuItem::separator(&handle)?;
            let sep2 = PredefinedMenuItem::separator(&handle)?;
            let menu = Menu::with_items(
                &handle,
                &[
                    &restore, &sep1, &move_item, &size_item, &minimize, &maximize, &sep2, &close,
                ],
            )?;

            window.on_menu_event(|window, event| {
                let id = event.id().0.as_str();
                match id {
                    "window.restore" => {
                        let _ = window.unmaximize();
                    }
                    "window.move" => {
                        let _ = window.start_dragging();
                    }
                    "window.size" => {
                        #[cfg(windows)]
                        if let Ok(hwnd) = window.hwnd() {
                            native_window::start_system_size(hwnd.0);
                        }
                        #[cfg(not(windows))]
                        let _ = window;
                    }
                    // Hamburger (☰) menu actions: the native menu cannot be a
                    // DOM handler, so it forwards every choice to the shell
                    // page as a `config-menu-action` event.
                    "conn.new" => {
                        let _ = window.app_handle().emit_to(
                            "main",
                            "config-menu-action",
                            serde_json::json!({ "action": "new-conn" }),
                        );
                    }
                    "conn.close" => {
                        let _ = window.app_handle().emit_to(
                            "main",
                            "config-menu-action",
                            serde_json::json!({ "action": "close-conn" }),
                        );
                    }
                    "config.update" => {
                        let _ = window.app_handle().emit_to(
                            "main",
                            "config-menu-action",
                            serde_json::json!({ "action": "update" }),
                        );
                    }
                    "config.about" => {
                        let _ = window.app_handle().emit_to(
                            "main",
                            "config-menu-action",
                            serde_json::json!({ "action": "about" }),
                        );
                    }
                    "config.exit" => {
                        let _ = window.close();
                    }
                    _ if id.starts_with("tab.") => {
                        let tab_id = &id["tab.".len()..];
                        let _ = window.app_handle().emit_to(
                            "main",
                            "config-menu-action",
                            serde_json::json!({ "action": "switch-tab", "tabId": tab_id }),
                        );
                    }
                    _ => {}
                }
            });

            // Pre-create the dialog windows (hidden) before the shell page can
            // create harness tab child webviews: creating an additional
            // WebviewWindow later, while the tauri `unstable` feature is on,
            // hits tauri#10011 (white + hang).
            dialogs::create_all(app.handle(), &window)?;

            app.manage(WindowMenuState { menu });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            minimize_window,
            toggle_maximize_window,
            is_window_maximized,
            close_window,
            start_window_drag,
            show_window_menu,
            harness_url,
            about_info,
            local_update_projects,
            cached_update_status,
            remote_call,
            check_updates,
            start_update,
            update_root,
            update_changelog,
            shell_log,
            // Native hamburger menu + dialog-card webviews.
            show_config_menu,
            open_dialog,
            close_dialog,
            fit_dialog,
            show_dialog,
            save_dialog_size,
            connection_added,
            ai_update_request,
            dialog_event,
            // Connection-tab child webviews + page bridge.
            view_create,
            view_set_bounds,
            view_set_visible,
            view_close,
            view_eval,
            page_theme,
            ai_update_result,
            view_answer_permission,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the dsh-gui application");

    log_status(&root, "exited");
}

#[cfg(all(test, windows))]
mod tests {
    use super::{ensure_loopback_port_available, job::KillJob, loopback_listener_pid, parse_launch_token};
    use std::net::TcpListener;
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn launch_token_is_extracted_from_the_url_line() {
        assert_eq!(
            parse_launch_token("dsh web: http://127.0.0.1:4567/?token=test-token (LAN: http://192.168.1.5:4567/?token=test-token)"),
            Some("test-token".to_string())
        );
        assert_eq!(parse_launch_token("dsh web: http://127.0.0.1:4567/"), None);
        assert_eq!(parse_launch_token(""), None);
    }

    /// Spawn a long-lived node helper to stand in for the harness.
    fn spawn_worker() -> std::process::Child {
        Command::new("node")
            .args(["-e", "setInterval(() => {}, 1000)"])
            .spawn()
            .expect("node must be on PATH to run dsh-gui tests")
    }

    /// Wait until the worker has exited (or give up after 5s). Node's exit
    /// code for a job kill is OS-defined (0 or 1), so only the exit itself is
    /// asserted; the aliveness checks above pin the exit to the job.
    fn wait_dead(child: &mut std::process::Child) -> std::process::ExitStatus {
        for _ in 0..50 {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        child.wait().expect("the job must kill the child")
    }

    #[test]
    fn occupied_port_is_rejected_and_reports_its_owner() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
        let port = listener.local_addr().expect("test listener address").port();

        let error = ensure_loopback_port_available(port).expect_err("occupied port must fail");
        assert!(error.contains("already in use"), "unexpected error: {error}");
        assert_eq!(
            loopback_listener_pid(port).expect("query listener owner"),
            Some(std::process::id())
        );

        drop(listener);
        ensure_loopback_port_available(port).expect("released port must be available");
    }

    /// The clean-exit path: `ChildGuard::drop` terminates the job first, so
    /// the harness dies immediately and the direct child is reaped.
    #[test]
    fn terminate_kills_assigned_child() {
        let mut child = spawn_worker();
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            child.try_wait().ok().flatten().is_none(),
            "worker exited before the job was touched"
        );

        let job = KillJob::new().expect("CreateJobObject must succeed");
        assert!(job.assign(&child), "AssignProcessToJobObject must succeed");

        job.terminate();
        wait_dead(&mut child);
    }

    /// The hard-kill path: closing the job handle (the exe died without
    /// running destructors) must still kill every member — the kernel
    /// enforces `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
    #[test]
    fn handle_close_kills_assigned_child() {
        let mut child = spawn_worker();
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            child.try_wait().ok().flatten().is_none(),
            "worker exited before the job handle closed"
        );

        {
            let job = KillJob::new().expect("CreateJobObject must succeed");
            assert!(job.assign(&child), "AssignProcessToJobObject must succeed");
            // Job dropped here: the handle closes and the kernel kills members.
        }
        wait_dead(&mut child);
    }
}
