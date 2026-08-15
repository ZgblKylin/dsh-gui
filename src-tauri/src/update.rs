//! Update checking for the dsh-gui shell.
//!
//! The shell is a git checkout: the dsh-gui repository itself plus every
//! submodule listed in `.gitmodules` (the harness, plugin repositories, agent
//! presets, and the icon). "Update available" means the remote default branch
//! of a repository has commits that the local `HEAD` does not.
//!
//! `check_and_sync` compares every repository against `origin`, writes a
//! pending-update plan plus a detached update launcher (`update.mjs`) when at
//! least one repository is behind, and removes both files once nothing is
//! behind anymore. `start` executes that launcher with a list of project ids;
//! the launcher waits for the running dsh-gui/harness processes to exit, runs
//! the git updates, rebuilds, and relaunches dsh-gui.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

const UPDATE_SCRIPT: &str = "update.mjs";
const UPDATE_PLAN: &str = "pending-updates.json";
const UPDATE_CONSOLE_PS1: &str = "run-update.ps1";

/// Distinguishes concurrent capture files within one process. The process id
/// in the filename keeps two dsh-gui instances from colliding.
static CAPTURE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Compiled-in template for the detached update launcher written to
/// `<root>/.dsh/gui/update.mjs` when an update is available.
const UPDATE_SCRIPT_TEMPLATE: &str = include_str!("update_script.mjs");

/// One repository row in the update dialog and in the pending-update plan.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdate {
    /// Stable identifier: `dsh-gui` for the root, otherwise the `.gitmodules`
    /// submodule name (e.g. `deepseek-harness`).
    pub id: String,
    pub name: String,
    /// Path relative to the repository root; empty for the root itself.
    pub path: String,
    /// Human-readable local version (exact tag, else short commit hash).
    pub current: String,
    /// Human-readable latest version on the remote default branch.
    pub latest: String,
    /// True when the remote default branch is strictly ahead of local HEAD.
    pub behind: bool,
    /// True while this row is only a local preview: `latest` is a placeholder
    /// and the real check result has not arrived yet.
    #[serde(default)]
    pub checking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Everything the frontend needs after a check.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub projects: Vec<ProjectUpdate>,
    pub has_updates: bool,
    pub update_count: usize,
    /// False when at least one repository could not be checked (network/auth),
    /// so a transient failure never clears the badge or the pending plan.
    pub all_checked: bool,
}

fn gui_dir(root: &Path) -> PathBuf {
    root.join(".dsh").join("gui")
}

fn plan_path(root: &Path) -> PathBuf {
    gui_dir(root).join(UPDATE_PLAN)
}

fn script_path(root: &Path) -> PathBuf {
    gui_dir(root).join(UPDATE_SCRIPT)
}

fn console_launcher_path(root: &Path) -> PathBuf {
    gui_dir(root).join(UPDATE_CONSOLE_PS1)
}

/// One completed `git` invocation whose stdio went to private files.
struct GitCapture {
    success: bool,
    stdout: String,
    stderr: String,
}

fn read_capture_file(path: &Path) -> String {
    fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

/// Run `git <args>` in `dir` with stdout/stderr redirected to per-call files
/// instead of anonymous pipes. dsh's Windows ACL sandbox allows file handles
/// but rejects child processes that capture through pipes (EPERM on spawn);
/// file redirection keeps update checks working when dsh-gui itself was
/// launched from a sandboxed harness session. Network prompts are disabled so
/// a background check can never hang on a credential prompt; on Windows the
/// console app is spawned with CREATE_NO_WINDOW so no console flashes next to
/// the frameless shell.
fn run_git_captured(dir: &Path, args: &[&str]) -> Option<GitCapture> {
    let id = CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let base = format!("dsh-gui-git-{}-{id}", std::process::id());
    let out_path = std::env::temp_dir().join(format!("{base}.out"));
    let err_path = std::env::temp_dir().join(format!("{base}.err"));

    let stdout_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&out_path)
        .ok()?;
    let stderr_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&err_path)
        .ok()?;

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let status = command.status().ok()?;
    let capture = GitCapture {
        success: status.success(),
        stdout: read_capture_file(&out_path),
        stderr: read_capture_file(&err_path),
    };
    let _ = fs::remove_file(&out_path);
    let _ = fs::remove_file(&err_path);
    Some(capture)
}

/// Run `git <args>` in `dir`, returning trimmed stdout on success.
fn git_output(dir: &Path, args: &[&str]) -> Option<String> {
    let capture = run_git_captured(dir, args)?;
    if !capture.success {
        return None;
    }
    let text = capture.stdout.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// `git fetch --prune origin` with the actual failure surfaced for the dialog.
fn git_fetch(dir: &Path) -> Result<(), String> {
    let capture = run_git_captured(dir, &["fetch", "--prune", "origin"])
        .ok_or_else(|| "无法启动 git（PATH 或沙箱策略禁止创建进程）".to_string())?;
    if capture.success {
        return Ok(());
    }
    let detail = capture.stderr.trim();
    let detail = if detail.is_empty() {
        capture.stdout.trim()
    } else {
        detail
    };
    let short: String = detail
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" | ");
    let short = short.chars().take(300).collect::<String>();
    if short.is_empty() {
        Err("git fetch 失败（未知原因）".to_string())
    } else {
        Err(format!("git fetch 失败：{short}"))
    }
}

fn is_git_repo(dir: &Path) -> bool {
    git_output(dir, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true")
}

/// Parse the top-level submodules from `.gitmodules`. Paths are checked for
/// traversal before they are joined to the repository root.
fn submodule_entries(root: &Path) -> Vec<(String, PathBuf)> {
    let text = fs::read_to_string(root.join(".gitmodules")).unwrap_or_default();
    let mut entries = Vec::new();
    let mut name: Option<String> = None;
    let mut path: Option<String> = None;

    let flush =
        |name: &Option<String>, path: &Option<String>, entries: &mut Vec<(String, PathBuf)>| {
            if let (Some(name), Some(path)) = (name, path) {
                let rel = Path::new(path);
                let safe = !rel.is_absolute()
                    && !rel
                        .components()
                        .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)));
                if safe {
                    entries.push((name.clone(), root.join(rel)));
                }
            }
        };

    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("[submodule") {
            flush(&name, &path, &mut entries);
            let rest = line
                .strip_prefix("[submodule")
                .unwrap_or("")
                .trim_end_matches(']')
                .trim()
                .trim_matches('"');
            name = Some(rest.to_string());
            path = None;
        } else if line.starts_with("path") {
            if let Some((_, value)) = line.split_once('=') {
                path = Some(value.trim().trim_matches('"').to_string());
            }
        }
    }
    flush(&name, &path, &mut entries);
    entries
}

fn package_name(dir: &Path) -> Option<String> {
    let manifest = fs::read_to_string(dir.join("package.json")).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&manifest).ok()?;
    value
        .get("name")
        .and_then(|n| n.as_str())
        .map(str::to_string)
}

/// The exact tag of `commitish` when one exists, else its short commit hash.
fn git_version(dir: &Path, commitish: &str) -> String {
    git_output(dir, &["describe", "--tags", "--exact-match", commitish])
        .or_else(|| git_output(dir, &["rev-parse", "--short", commitish]))
        .unwrap_or_else(|| "unknown".to_string())
}

/// The remote default branch (`origin/HEAD`). Ask the remote first so a stale
/// local `refs/remotes/origin/HEAD` symbolic ref can never point the updater at
/// an old branch; fall back to that local ref when the extra network roundtrip
/// fails.
fn remote_default_branch(dir: &Path) -> Option<String> {
    if let Some(symrefs) = git_output(dir, &["ls-remote", "--symref", "origin", "HEAD"]) {
        for line in symrefs.lines() {
            if let Some(rest) = line.strip_prefix("ref: refs/heads/") {
                let branch = rest.split('\t').next().unwrap_or("").trim();
                if !branch.is_empty() {
                    return Some(branch.to_string());
                }
            }
        }
    }
    let symref = git_output(
        dir,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )?;
    symref
        .strip_prefix("origin/")
        .filter(|branch| !branch.is_empty())
        .map(str::to_string)
}

/// Compare one repository against its `origin` default branch.
fn check_project(root: &Path, id: &str, fallback_name: &str, path: &Path) -> ProjectUpdate {
    let mut project = ProjectUpdate {
        id: id.to_string(),
        name: package_name(path).unwrap_or_else(|| fallback_name.to_string()),
        path: if path == root {
            String::new()
        } else {
            path.strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/")
        },
        current: "unknown".to_string(),
        latest: "—".to_string(),
        behind: false,
        checking: false,
        error: None,
    };

    if !path.is_dir() {
        project.error = Some("目录不存在，请先初始化该 submodule".to_string());
        return project;
    }
    if !is_git_repo(path) {
        project.error = Some("不是 git 仓库".to_string());
        return project;
    }
    if git_output(path, &["remote", "get-url", "origin"]).is_none() {
        project.error = Some("没有 origin 远程".to_string());
        return project;
    }

    let Some(current_sha) = git_output(path, &["rev-parse", "HEAD"]) else {
        project.error = Some("无法读取本地 HEAD".to_string());
        return project;
    };
    project.current = git_version(path, &current_sha);

    if let Err(error) = git_fetch(path) {
        project.error = Some(error);
        return project;
    }
    let Some(branch) = remote_default_branch(path) else {
        project.error = Some("无法确定远端默认分支".to_string());
        return project;
    };
    let latest_ref = format!("origin/{branch}");
    let Some(latest_sha) = git_output(path, &["rev-parse", &latest_ref]) else {
        project.error = Some(format!("远端缺少 {latest_ref}").to_string());
        return project;
    };
    project.latest = git_version(path, &latest_ref);

    if current_sha != latest_sha {
        let range = format!("{current_sha}..{latest_ref}");
        let behind = git_output(path, &["rev-list", "--count", &range])
            .and_then(|count| count.parse::<u32>().ok())
            .unwrap_or(0);
        project.behind = behind > 0;
    }
    project
}

/// Local-only preview of one repository: package name, path, and current
/// version are available immediately; `latest` stays a placeholder until the
/// network check finishes.
fn local_preview_project(root: &Path, id: &str, fallback_name: &str, path: &Path) -> ProjectUpdate {
    let mut project = ProjectUpdate {
        id: id.to_string(),
        name: package_name(path).unwrap_or_else(|| fallback_name.to_string()),
        path: if path == root {
            String::new()
        } else {
            path.strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/")
        },
        current: "unknown".to_string(),
        latest: "检查中…".to_string(),
        behind: false,
        checking: true,
        error: None,
    };
    if path.is_dir() && is_git_repo(path) {
        if let Some(sha) = git_output(path, &["rev-parse", "HEAD"]) {
            project.current = git_version(path, &sha);
        }
    }
    project
}

/// The cold-start dialog preview: the full project list plus local versions,
/// with every row marked `checking` so the frontend can render placeholders
/// before the slow network fetch starts.
pub fn local_check(root: &Path) -> Vec<ProjectUpdate> {
    let mut projects = Vec::new();
    projects.push(local_preview_project(root, "dsh-gui", "dsh-gui", root));
    for (name, path) in submodule_entries(root) {
        projects.push(local_preview_project(root, &name, &name, &path));
    }
    projects
}

/// Check the root repository and every submodule. The root is always first so
/// the pending plan has a deterministic order for the update launcher.
pub fn check(root: &Path) -> UpdateStatus {
    let mut projects = Vec::new();
    projects.push(check_project(root, "dsh-gui", "dsh-gui", root));
    for (name, path) in submodule_entries(root) {
        projects.push(check_project(root, &name, &name, &path));
    }
    let update_count = projects.iter().filter(|p| p.behind).count();
    let all_checked = projects.iter().all(|p| p.error.is_none());
    UpdateStatus {
        has_updates: update_count > 0,
        update_count,
        all_checked,
        projects,
    }
}

/// Check for updates and keep the pending plan / update launcher on disk in
/// sync with the result: present while at least one update exists, removed only
/// after a fully successful check finds nothing behind. A partially failed
/// check (network/auth) leaves the previous plan untouched.
pub fn check_and_sync(root: &Path, gui_pid: u32, harness_pid: u32) -> Result<UpdateStatus, String> {
    let status = check(root);
    let dir = gui_dir(root);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    if status.has_updates {
        let plan = serde_json::to_vec(&status.projects)
            .map_err(|e| format!("cannot serialize update plan: {e}"))?;
        fs::write(plan_path(root), plan)
            .map_err(|e| format!("cannot write {}: {e}", plan_path(root).display()))?;
        write_update_script(root, gui_pid, harness_pid)
            .map_err(|e| format!("cannot write {}: {e}", script_path(root).display()))?;
    } else if status.all_checked {
        // A complete check found nothing: drop the plan, launcher, and the
        // Windows console bootstrap.
        let _ = fs::remove_file(plan_path(root));
        let _ = fs::remove_file(script_path(root));
        let _ = fs::remove_file(console_launcher_path(root));
    }
    Ok(status)
}

/// Render the update launcher source with the root path and PIDs baked in.
fn render_update_script(root: &Path, gui_pid: u32, harness_pid: u32) -> io::Result<String> {
    let root_json = serde_json::to_string(&root.to_string_lossy())
        .map_err(|e| io::Error::other(e.to_string()))?;
    Ok(UPDATE_SCRIPT_TEMPLATE
        .replace("\"__ROOT__\"", &root_json)
        .replace("__GUI_PID__", &gui_pid.to_string())
        .replace("__HARNESS_PID__", &harness_pid.to_string()))
}

/// Write (or refresh) the in-repo update launcher copy. This file lives under
/// git-ignored `.dsh/`; it is the persisted plan artifact, while the script
/// actually executed is a temp-dir copy (see [`copy_update_script_to_temp`]).
fn write_update_script(root: &Path, gui_pid: u32, harness_pid: u32) -> io::Result<PathBuf> {
    let dir = gui_dir(root);
    fs::create_dir_all(&dir)?;
    let content = render_update_script(root, gui_pid, harness_pid)?;
    let path = script_path(root);
    fs::write(&path, content)?;
    Ok(path)
}

/// Copy the launcher to the system temp directory for execution. Running the
/// temp copy guarantees no git operation (including a root reset) can ever
/// touch the file node is currently reading, and Windows never sees the
/// in-repo copy as held by a running process.
fn copy_update_script_to_temp(root: &Path) -> Result<PathBuf, String> {
    let source = script_path(root);
    if !source.is_file() {
        return Err(format!("update launcher is missing: {}", source.display()));
    }
    let id = CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let target =
        std::env::temp_dir().join(format!("dsh-gui-update-{}-{id}.mjs", std::process::id()));
    fs::copy(&source, &target)
        .map_err(|e| format!("cannot copy update launcher to {}: {e}", target.display()))?;
    Ok(target)
}

/// Spawn the update launcher, fully detached from dsh-gui. The executed
/// script is a temp-dir copy; on Windows it runs inside a new PowerShell
/// console window so the user watches the real progress, on Unix it keeps
/// running detached with output in update.log.
fn spawn_update_script(root: &Path, ids: &[String]) -> Result<(), String> {
    let dir = gui_dir(root);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let script = copy_update_script_to_temp(root)?;

    #[cfg(windows)]
    {
        let launcher = write_windows_console_launcher(root, ids, &script)?;
        spawn_windows_update_console(root, &launcher)
    }
    #[cfg(not(windows))]
    {
        spawn_unix_update_node(root, &script, ids)
    }
}

/// PowerShell quoting helper: single quotes with `''` escaping.
#[cfg(windows)]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Write the tiny PowerShell file the visible console runs. It invokes the
/// generated update.mjs with the selected ids; `powershell -NoExit` keeps the
/// window open afterwards so success/failure is always readable.
#[cfg(windows)]
fn write_windows_console_launcher(
    root: &Path,
    ids: &[String],
    script: &Path,
) -> Result<PathBuf, String> {
    let mut content = String::from("\u{feff}$ErrorActionPreference = 'Continue'\n");
    content.push_str("Write-Host 'dsh-gui 更新程序'\n");
    content.push_str(&format!(
        "Write-Host '日志文件: {}'\n",
        ps_quote(&gui_dir(root).join("update.log").to_string_lossy())
    ));
    content.push_str(&format!("& node {}", ps_quote(&script.to_string_lossy())));
    if !ids.is_empty() {
        content.push_str(&format!(" --ids {}", ps_quote(&ids.join(","))));
    }
    content.push('\n');
    content.push_str("$code = $LASTEXITCODE\n");
    content.push_str("Write-Host ''\n");
    content.push_str("if ($code -eq 0) {\n");
    content.push_str("  Write-Host '更新完成，dsh-gui 正在自动重启。此窗口可手动关闭。'\n");
    content.push_str("} else {\n");
    content.push_str(
        "  Write-Host ('更新失败，退出码: ' + $code + '。窗口保持打开，请查看上方输出。')\n",
    );
    content.push_str("}\n");

    let path = console_launcher_path(root);
    fs::write(&path, content).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(path)
}

/// Prefer PowerShell 7 (`pwsh.exe`) when installed, otherwise Windows
/// PowerShell 5.1 (`powershell.exe`, present on every Windows).
#[cfg(windows)]
fn windows_powershell_program() -> &'static str {
    let mut probe = Command::new("pwsh.exe");
    probe
        .args(["-NoLogo", "-NoProfile", "-Command", "exit 0"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    use std::os::windows::process::CommandExt;
    probe.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, probe only
    if probe.status().is_ok_and(|status| status.success()) {
        "pwsh.exe"
    } else {
        "powershell.exe"
    }
}

/// Spawn PowerShell directly with CREATE_NEW_CONSOLE: no `cmd start` helper,
/// no title/quoting quirks. The new console window (and the node update
/// process inside it) keeps running after dsh-gui exits; -NoExit leaves the
/// window open so success/failure is always readable.
#[cfg(windows)]
fn spawn_windows_update_console(root: &Path, launcher: &Path) -> Result<(), String> {
    let mut command = Command::new(windows_powershell_program());
    command
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NoExit")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(launcher)
        .current_dir(root);
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP);
    command
        .spawn()
        .map_err(|e| format!("failed to open the update console: {e}"))?;
    Ok(())
}

/// Unix fallback: detached node with stdout/stderr appended to update.log.
#[cfg(not(windows))]
fn spawn_unix_update_node(root: &Path, script: &Path, ids: &[String]) -> Result<(), String> {
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(gui_dir(root).join("update.log"))
        .map_err(|e| format!("cannot open update.log: {e}"))?;

    let mut command = Command::new("node");
    command
        .arg(script)
        .current_dir(root)
        .env("DSH_HOME", root.join(".dsh"))
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            log.try_clone()
                .map_err(|e| format!("cannot clone update.log: {e}"))?,
        ))
        .stderr(Stdio::from(log));
    if !ids.is_empty() {
        command.arg("--ids").arg(ids.join(","));
    }
    use std::os::unix::process::CommandExt;
    // Detach from the launching terminal/session like DETACHED_PROCESS does
    // on Windows: setsid() makes the node launcher the leader of a brand-new
    // session + process group, so closing the terminal or killing the shell
    // process group cannot take the updater down.
    unsafe {
        extern "C" {
            fn setsid() -> i32;
        }
        command.pre_exec(|| {
            if setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command
        .spawn()
        .map_err(|e| format!("failed to spawn the update launcher (is `node` on PATH?): {e}"))?;
    Ok(())
}

/// Prepare and launch the detached update for `ids` (empty means every pending
/// project). The plan written by the most recent check is authoritative; the
/// launcher is refreshed so it waits for the exact running dsh-gui/harness
/// processes.
pub fn start(root: &Path, gui_pid: u32, harness_pid: u32, ids: &[String]) -> Result<(), String> {
    let plan_file = plan_path(root);
    let text = fs::read_to_string(&plan_file)
        .map_err(|_| "还没有检查到可用更新，请先点击「检查更新」".to_string())?;
    let projects: Vec<ProjectUpdate> =
        serde_json::from_str(&text).map_err(|e| format!("更新计划损坏（{e}），请重新检查更新"))?;

    let mut selected: Vec<&ProjectUpdate> = projects
        .iter()
        .filter(|p| p.behind && p.error.is_none())
        .collect();
    if !ids.is_empty() {
        selected.retain(|p| ids.iter().any(|id| id == &p.id));
        if selected.is_empty() {
            return Err("所选工程当前没有可用更新，请重新检查更新".to_string());
        }
    }
    if selected.is_empty() {
        return Err("没有可用更新".to_string());
    }

    write_update_script(root, gui_pid, harness_pid)
        .map_err(|e| format!("cannot write {}: {e}", script_path(root).display()))?;
    spawn_update_script(root, ids)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_this_repo_submodules() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = manifest
            .parent()
            .expect("src-tauri must live under the repo root");
        let entries = submodule_entries(root);
        assert!(entries
            .iter()
            .any(|(name, path)| name == "deepseek-harness" && path.ends_with("deepseek-harness")));
        assert!(entries.iter().any(|(name, _)| name == "dsh-terminal"));
    }

    #[test]
    fn git_capture_uses_files_not_pipes() {
        // Under dsh's Windows sandbox, spawning a child with piped stdio
        // fails with EPERM while file-redirected stdio works. This test runs
        // inside that same sandbox, so it guards the update-check transport.
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = manifest
            .parent()
            .expect("src-tauri must live under the repo root");
        let capture = run_git_captured(root, &["--version"])
            .expect("git must spawn with file-redirected stdio");
        assert!(capture.success, "git --version failed: {}", capture.stderr);
        assert!(capture.stdout.contains("git version"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_console_launcher_carries_selected_ids() {
        let temp =
            std::env::temp_dir().join(format!("dsh-gui-console-test-{}", std::process::id()));
        let script = write_update_script(&temp, 4242, 4343).expect("script generation must work");
        let ids = vec!["deepseek-harness".to_string(), "dsh-terminal".to_string()];
        let launcher =
            write_windows_console_launcher(&temp, &ids, &script).expect("ps1 generation must work");
        let content = fs::read_to_string(&launcher).expect("ps1 must be readable");
        assert!(content.contains("& node"));
        assert!(content.contains("--ids 'deepseek-harness,dsh-terminal'"));
        let _ = fs::remove_dir_all(temp.join(".dsh"));
    }

    #[test]
    fn generated_launcher_replaces_all_placeholders() {
        let temp = std::env::temp_dir().join(format!("dsh-gui-update-test-{}", std::process::id()));
        let script = write_update_script(&temp, 4242, 4343).expect("script generation must work");
        let content = fs::read_to_string(&script).expect("generated script must be readable");
        assert!(!content.contains("__ROOT__"));
        assert!(!content.contains("__GUI_PID__"));
        assert!(!content.contains("__HARNESS_PID__"));
        assert!(content.contains("const GUI_PID = 4242;"));
        assert!(content.contains("const HARNESS_PID = 4343;"));

        // The executed copy must land outside the repository and carry the
        // same rendered placeholders.
        let executed = copy_update_script_to_temp(&temp).expect("temp copy must work");
        assert_ne!(executed.parent(), Some(script.parent().unwrap()));
        assert!(executed.starts_with(std::env::temp_dir()));
        let executed_content = fs::read_to_string(&executed).expect("temp copy must be readable");
        assert!(executed_content.contains("const GUI_PID = 4242;"));
        let _ = fs::remove_file(&executed);
        let _ = fs::remove_dir_all(temp.join(".dsh"));
    }
}
