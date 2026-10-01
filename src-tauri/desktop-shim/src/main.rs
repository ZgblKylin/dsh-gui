//! dsh-gui desktop shim: a console-less launcher for the desktop build.
//!
//! Building/running the Tauri shell needs `npm run desktop` from the repository
//! root, but a user starting the desktop app from Explorer (or a shortcut)
//! should not get a console window flashing up first, nor a console that stays
//! around for the lifetime of the app. This exe is that launcher: it never
//! allocates a console itself, spawns the real command with `CREATE_NO_WINDOW`,
//! and adopts the child's exit code.
//!
//! Layout it relies on (see `docs/dsh-gui/nested-clone-layout.md`): the runtime
//! root holds the entry exes and `run.cmd`, and its `dsh-gui` subdirectory is
//! the source checkout. "Runtime root" is therefore simply the directory this
//! exe sits in — the shim never needs to know an absolute repository path.
//!
//! Launcher resolution:
//!   1. `<runtime root>\run.cmd desktop` — the forwarding script the build
//!      writes next to the entry exe. It `cd`s to the repository it was
//!      generated for, so a stale `PATH`/`npm` resolution order cannot select a
//!      different project.
//!   2. `npm run desktop` in `<runtime root>\dsh-gui` — fallback for a runtime
//!      root that has not been built yet (no `run.cmd`).
//!
//! Diagnostics: there is no console to print to, so failures are appended, best
//! effort, to `<runtime root>\.desktop\shim.log`; a failure to log is ignored
//! and never changes the launch behaviour or the exit code.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    std::process::exit(shim::launch());
}

#[cfg(not(windows))]
fn main() {
    // The desktop build only exists on Windows; fail readably on other targets.
    eprintln!("dsh-gui-desktop is a Windows-only launcher; there is nothing to start here.");
    std::process::exit(1);
}

#[cfg(windows)]
mod shim {
    use std::fs::OpenOptions;
    use std::io::Write as _;
    use std::os::windows::process::CommandExt as _;
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitStatus};

    /// `CREATE_NO_WINDOW`: the child `cmd.exe`, and every console application it
    /// starts, runs without a console window. A GUI process started further
    /// down the chain (the Tauri shell) creates its own window independently.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Exit code when the launcher could not even be started.
    const SPAWN_FAILED: i32 = 1;

    /// Spawn the desktop build and return its exit code.
    pub fn launch() -> i32 {
        let Some(root) = runtime_root() else {
            return SPAWN_FAILED;
        };
        match spawn_launcher(&root) {
            Ok(status) => exit_code(&status),
            Err(error) => {
                log(&root, &format!("failed to start the desktop build: {error}"));
                SPAWN_FAILED
            }
        }
    }

    /// The directory holding this exe, i.e. the runtime root.
    fn runtime_root() -> Option<PathBuf> {
        std::env::current_exe()
            .ok()?
            .parent()
            .map(Path::to_path_buf)
    }

    /// Run `run.cmd desktop` (preferred) or `npm run desktop` (fallback).
    ///
    /// `raw_arg` is used for the `/c` payload because `cmd.exe` parses its own
    /// command line instead of following Rust's argv quoting rules: a value
    /// passed through `arg()` would be re-quoted with `\"` escapes that `cmd.exe`
    /// does not read back as quotes. The command lines below are exactly the
    /// documented `cmd.exe /d /s /c "..."` forms.
    fn spawn_launcher(root: &Path) -> std::io::Result<ExitStatus> {
        let run_cmd = root.join("run.cmd");

        let mut command = Command::new("cmd.exe");
        command.arg("/d").arg("/s").arg("/c").creation_flags(CREATE_NO_WINDOW);

        if run_cmd.is_file() {
            command.raw_arg(format!("\"\"{}\" desktop\"", run_cmd.display()));
            command.current_dir(root);
        } else {
            command.raw_arg("\"npm run desktop\"");
            command.current_dir(root.join("dsh-gui"));
        }

        command.spawn()?.wait()
    }

    /// Adopt the child's exit code; a child killed by a signal reports none.
    fn exit_code(status: &ExitStatus) -> i32 {
        status.code().unwrap_or(SPAWN_FAILED)
    }

    /// Append one line to `<runtime root>\.desktop\shim.log`, best effort.
    fn log(root: &Path, message: &str) {
        let directory = root.join(".desktop");
        if std::fs::create_dir_all(&directory).is_err() {
            return;
        }
        let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("shim.log"))
        else {
            return;
        };
        let _ = writeln!(file, "{message}");
    }
}
