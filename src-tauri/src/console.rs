//! Console-less process spawning.
//!
//! `git.exe`, `node.exe` and `taskkill.exe` are console-subsystem programs.
//! Windows only allocates a console for them when the *parent* has none, which
//! is exactly this shell's situation: dsh-gui is built with
//! `windows_subsystem = "windows"`, and a `cargo test` run started from a
//! console-less host (the shell's own command runner, an agent runner, a
//! double-clicked batch file) has no console either. Every child then gets a
//! brand-new console window, which is shown, steals the foreground for a moment
//! and closes — and a test run spawns `git` dozens of times, so the whole
//! machine is unusable for the duration. `CREATE_NO_WINDOW` keeps every child
//! headless; grandchildren such as git's msys `sh` attach to that hidden
//! console instead of opening their own.
//!
//! Every spawn in this crate goes through [`hidden_command`] unless it
//! deliberately wants a visible console — only the update launcher does (it
//! runs in the console window the user watches). `spawns_go_through_hidden_command`
//! below enforces that invariant over the crate's sources.

use std::ffi::OsStr;
use std::process::Command;

/// A `Command` for `program` that never allocates a visible console window.
pub(crate) fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The helper must still spawn ordinary console programs correctly.
    #[test]
    fn hidden_command_runs_a_console_program() {
        let output = hidden_command("git")
            .arg("--version")
            .output()
            .expect("git must be on PATH for the test suite");
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("git version"));
    }

    /// Regression guard for the console-window storm.
    ///
    /// A bare `Command::new(...)` in a crate file is a spawn that flashes a
    /// window whenever this process has no console — and the test suite spawns
    /// `git` dozens of times, so one forgotten flag brings the storm back. The
    /// only allowed exception is the update launcher, whose console window is
    /// the feature.
    #[test]
    fn spawns_go_through_hidden_command() {
        // Assembled from parts so this guard's own source line cannot match
        // itself when main.rs is scanned.
        let needle = concat!("Command", "::new(");
        let sources = [
            ("about.rs", include_str!("about.rs")),
            ("changelog.rs", include_str!("changelog.rs")),
            ("dialog_sizes.rs", include_str!("dialog_sizes.rs")),
            ("dialogs.rs", include_str!("dialogs.rs")),
            ("main.rs", include_str!("main.rs")),
            ("native_window.rs", include_str!("native_window.rs")),
            ("update.rs", include_str!("update.rs")),
            ("views.rs", include_str!("views.rs")),
        ];

        let mut visible_console_spawns = 0usize;
        for (name, source) in sources {
            for (index, line) in source.lines().enumerate() {
                if !line.contains(needle) || line.trim_start().starts_with("//") {
                    continue;
                }
                if line.contains("CREATE_NEW_CONSOLE") {
                    visible_console_spawns += 1;
                    continue;
                }
                panic!(
                    "{name}:{} spawns without a hidden console: {}\n\
                     use console::hidden_command(), or mark the line CREATE_NEW_CONSOLE \
                     when the visible window is intended",
                    index + 1,
                    line.trim()
                );
            }
        }
        assert_eq!(
            visible_console_spawns, 1,
            "exactly one spawn may stay visible: the update launcher's console"
        );
    }
}
