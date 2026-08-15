//! dsh-gui — a thin desktop shell for the DeepSeek Harness web UI.
//!
//! It does three things:
//!   1. spawn the self-hosted harness web server (`dsh web`) from the
//!      `deepseek-harness` submodule checkout, with `DSH_HOME` pinned inside
//!      the repository;
//!   2. wait until that server answers HTTP on the loopback port;
//!   3. open a single frameless webview window that renders a custom title bar
//!      and embeds the harness web UI in an iframe.
//!
//! The frontend lives in `src-tauri/ui/` (a plain HTML shell — no bundler). It
//! has one small IPC surface: window controls and an About dialog whose data
//! (version/license/repository for the shell, the harness, and every plugin)
//! is assembled in [`about`].

// A plain Win32 GUI app in every profile: no console window on double-click,
// and the launching terminal (cmd or PowerShell) does not wait for it. All of
// dsh-gui's own diagnostics go to `.dsh\gui\gui.log` instead of a console.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod about;
mod update;

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{Manager, State};

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

/// Spawn `node <root>/deepseek-harness/apps/cli/lib/bin.js web --port <port>`
/// with `DSH_HOME` pinned to `<root>/.dsh`, and redirect its output to a log
/// file so a console-less launch is still debuggable.
fn spawn_harness(root: &Path, port: u16) -> Result<Child, Box<dyn std::error::Error>> {
    let bin = root.join(HARNESS_BIN);
    if !bin.is_file() {
        return Err(format!(
            "harness is not built: {} is missing — run `npm run setup` first",
            bin.display()
        )
        .into());
    }

    let home = root.join(".dsh");
    let log_dir = home.join("gui");
    fs::create_dir_all(&log_dir)?;
    let log = File::create(log_dir.join("harness.log"))?;

    let mut command = Command::new("node");
    command
        .arg(&bin)
        .arg("web")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(root.join(HARNESS_DIR))
        .env("DSH_HOME", &home)
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
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
    let child = command
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
    let request = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
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
    /// PIDs the detached update launcher must wait for before touching the
    /// checkout: this shell and the harness child it owns.
    gui_pid: u32,
    harness_pid: u32,
    /// Serializes update checks / launches (git fetch can take tens of
    /// seconds; two checks must never race each other's plan file).
    update_lock: Arc<Mutex<()>>,
}

#[tauri::command]
fn minimize_window(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn is_window_maximized(window: tauri::Window) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn close_window(window: tauri::Window) {
    let _ = window.close();
}

#[tauri::command]
fn start_window_drag(window: tauri::Window) {
    let _ = window.start_dragging();
}

/// The self-hosted harness UI URL, so the wrapper page can point its iframe at
/// the right port without the port being baked into the assets.
#[tauri::command]
fn harness_url(state: State<'_, ShellState>) -> String {
    format!("http://127.0.0.1:{}", state.port)
}

/// Everything the About dialog needs: version/license/repository for the
/// shell, the harness submodule, and every plugin under `plugins/`.
#[tauri::command]
fn about_info(state: State<'_, ShellState>) -> about::AboutInfo {
    about::collect(&state.root)
}

/// Cold-start preview for the update dialog: project list + local versions
/// only (no network). The frontend renders these rows immediately with
/// placeholders, then `check_updates` fills in the real latest/status.
#[tauri::command]
fn local_update_projects(state: State<'_, ShellState>) -> Vec<update::ProjectUpdate> {
    update::local_check(&state.root)
}

/// Check the dsh-gui repository and every submodule for updates. Runs off the
/// main thread: `git fetch` per repository can take tens of seconds, and the
/// manual dialog as well as the startup/interval background checks call here.
#[tauri::command]
async fn check_updates(state: State<'_, ShellState>) -> Result<update::UpdateStatus, String> {
    let root = state.root.clone();
    let gui_pid = state.gui_pid;
    let harness_pid = state.harness_pid;
    let lock = Arc::clone(&state.update_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "an update check is already running".to_string())?;
        update::check_and_sync(&root, gui_pid, harness_pid)
    })
    .await
    .map_err(|e| format!("update check task failed: {e}"))?
}

/// Launch the detached update launcher for the selected project ids (empty:
/// every pending project), then exit so the launcher can safely touch the
/// checkout. Exiting drops `ChildGuard`, whose kill-on-close job tears the
/// whole harness process tree down.
#[tauri::command]
fn start_update(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let _guard = state
        .update_lock
        .lock()
        .map_err(|_| "an update check is already running".to_string())?;
    update::start(&state.root, state.gui_pid, state.harness_pid, &ids)?;
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
    "diag",
];

/// Minimal JSON HTTP/1.1 POST to the harness loopback server. The wrapper
/// document is served from a `tauri://` origin, so a browser `fetch` to
/// `http://127.0.0.1:<port>` would be cross-origin — and the `/remote-api`
/// route deliberately refuses cross-origin requests. An ad-hoc TcpStream
/// request carries no `Origin`/`Sec-Fetch-Site` headers, which the route
/// accepts as same-host. The response body comes back de-chunked if needed.
fn http_post_json(port: u16, op: &str, body: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("cannot reach the harness on 127.0.0.1:{port}: {e}"))?;
    // A deploy can take minutes (git clone + build on the remote); the caller
    // runs inside spawn_blocking so the main thread stays responsive.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
    let path = format!("/remote-api/{op}");
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("failed to send /remote-api/{op}: {e}"))?;
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
            Err(e) => return Err(format!("failed reading /remote-api/{op} response: {e}")),
        }
    }
    let text = String::from_utf8_lossy(&response).into_owned();
    let (head, body) = match text.find("\r\n\r\n") {
        Some(i) => (&text[..i], &text[i + 4..]),
        None => return Err(format!("malformed response from /remote-api/{op}")),
    };
    let status = head.lines().next().unwrap_or("");
    if !status.starts_with("HTTP/1.1 2") && !status.starts_with("HTTP/1.0 2") {
        return Err(format!(
            "{op} failed ({status}): {}",
            body.chars().take(500).collect::<String>()
        ));
    }
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(body)
    } else {
        body.to_string()
    };
    Ok(body)
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

/// Forward one operation to the harness plugin's `/remote-api` route. Runs off
/// the main thread (via spawn_blocking) so a long deploy never blocks the UI.
#[tauri::command]
async fn remote_call(
    state: State<'_, ShellState>,
    op: String,
    body: String,
) -> Result<String, String> {
    if !REMOTE_OPS.contains(&op.as_str()) {
        return Err(format!("unknown op: {op}"));
    }
    let port = state.port;
    tauri::async_runtime::spawn_blocking(move || http_post_json(port, &op, &body))
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
    // (log + message box) instead of silently behind a blank window.
    let child = match spawn_harness(&root, port)
        .and_then(|mut c| wait_ready(&mut c, port, Duration::from_secs(90)).map(|_| c))
    {
        Ok(c) => c,
        Err(e) => fatal(Some(&root), &format!("failed to start the harness: {e}")),
    };
    log_status(&root, &format!("harness ready at http://127.0.0.1:{port}"));

    let harness_pid = child.id();
    let child = ChildGuard::new(child);
    let setup_root = root.clone();

    tauri::Builder::default()
        .setup(move |app| {
            app.manage(ShellState {
                root: setup_root,
                port,
                gui_pid: std::process::id(),
                harness_pid,
                update_lock: Arc::new(Mutex::new(())),
            });
            app.manage(child);
            // Frameless: the wrapper page (ui/index.html) draws its own title
            // bar and window controls, and embeds the harness UI in an iframe.
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("DeepSeek Harness")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .decorations(false)
            // Sample every child frame's global text/background colors and
            // report them to the shell so the custom title bar can adapt to
            // the page theme. The script lives in ui/theme-bridge.js.
            .initialization_script_for_all_frames(include_str!("../ui/theme-bridge.js"))
            // Answer WebView2/WebKitGTK clipboard permission requests so
            // the embedded harness page (a cross-origin iframe) may use
            // the async Clipboard API; without this the code-block and
            // message copy controls cannot write the system clipboard.
            .enable_clipboard_access()
            .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            minimize_window,
            toggle_maximize_window,
            is_window_maximized,
            close_window,
            start_window_drag,
            harness_url,
            about_info,
            local_update_projects,
            remote_call,
            check_updates,
            start_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the dsh-gui application");

    log_status(&root, "exited");
}

#[cfg(all(test, windows))]
mod tests {
    use super::job::KillJob;
    use std::process::Command;
    use std::time::Duration;

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
