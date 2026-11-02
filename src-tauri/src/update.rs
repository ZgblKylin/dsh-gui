//! Update checking for the dsh-gui shell.
//!
//! The dialog lists two kinds of rows:
//!
//! * **git rows** — the shell is a git checkout: the dsh-gui repository itself
//!   plus every submodule listed in `.gitmodules` (the harness and the app
//!   icon). "Update available" means the remote default branch of a repository
//!   has commits that the local `HEAD` does not.
//! * **npm plugin rows** — every npm package pinned by a
//!   `plugins/<wrapper>/install.mjs` wrapper (`installNpmPlugin` with an exact
//!   `<name>@<version>` literal). These compare the script's pin with the
//!   registry's `/<pkg>/latest` version and update in place: the pin is
//!   rewritten and the wrapper re-run against the current profile
//!   ([`run_npm_plugin_update`]), no detached launcher involved.
//!
//! `check_and_sync` compares every repository against `origin`, writes a
//! pending-update plan plus a detached update launcher (`update.mjs`) when at
//! least one git repository is behind, and removes both files once nothing is
//! behind anymore. The plan only carries the git rows: npm plugin rows never
//! survive a process exit, they are updated from the dialog while the shell
//! keeps running. `start` executes that launcher with a list of project ids;
//! the launcher waits for the running dsh-gui/harness processes to exit, runs
//! the git updates, rebuilds, and relaunches dsh-gui.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::changelog::{run_node_captured, write_temp_script};

const UPDATE_SCRIPT: &str = "update.mjs";
const UPDATE_PLAN: &str = "pending-updates.json";
const UPDATE_CONSOLE_PS1: &str = "run-update.ps1";
const NPM_INSTALLS_FILE: &str = "npm-installs.json";
const NPM_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// Embedded node script that queries the npm registry for a batch of packages
/// and prints one JSON array for the Rust side to parse.
///
/// Like [`crate::changelog`]'s release-fetch script it must never call
/// `process.exit()`: on Windows that aborts node while undici is still draining
/// the fetches' async handles, and libuv then trips
/// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) … src\win\async.c`.
/// The answer is written with `writeSync(1, …)` (file stdio: flushed before the
/// process ends) and the event loop drains on its own; every body is consumed
/// or cancelled so no half-read socket survives the exit.
const NPM_FETCH_SCRIPT: &str = r#"
import { writeSync } from 'node:fs';

const packages = JSON.parse(process.argv[2] || '[]');
const target = process.argv[3] || '';
const results = await Promise.all(packages.map(async (name) => {
  try {
    const url = 'https://registry.npmjs.org/' + encodeURIComponent(name);
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'dsh-gui-update-check' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      return { name, error: 'HTTP ' + response.status };
    }
    const json = await response.json();
    const latest = json['dist-tags'] && typeof json['dist-tags'].latest === 'string'
      ? json['dist-tags'].latest : '';
    const versions = json.versions && typeof json.versions === 'object' ? json.versions : {};
    const hasTarget = Object.prototype.hasOwnProperty.call(versions, target);
    return { name, latest, hasTarget };
  } catch (error) {
    return { name, error: String((error && error.message) || error) };
  }
}));
writeSync(1, JSON.stringify(results) + '\n');
"#;

/// Embedded node script that queries the registry's `/<pkg>/latest` document
/// for the npm plugin rows; one invocation covers every package.
///
/// The accept type is the full-manifest `application/json`: the abbreviated
/// install type used by [`NPM_FETCH_SCRIPT`] is rejected with HTTP 406 on the
/// `/<pkg>/latest` endpoint, and the full document is also the only one that
/// carries `repository`, from which the row's Releases link is built.
///
/// Same Windows libuv convention as [`NPM_FETCH_SCRIPT`]: no `process.exit()`,
/// the answer is flushed with `writeSync(1, …)` and the event loop drains on
/// its own.
const NPM_LATEST_FETCH_SCRIPT: &str = r#"
import { writeSync } from 'node:fs';

const packages = JSON.parse(process.argv[2] || '[]');
const results = await Promise.all(packages.map(async (name) => {
  try {
    const url = 'https://registry.npmjs.org/' + encodeURIComponent(name) + '/latest';
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-gui-update-check' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      return { name, error: 'HTTP ' + response.status };
    }
    let json;
    try {
      json = await response.json();
    } catch {
      return { name, error: '无法解析 npm registry 响应' };
    }
    if (json === null || typeof json !== 'object') {
      return { name, error: '无法解析 npm registry 响应' };
    }
    const version = typeof json.version === 'string' ? json.version.trim() : '';
    if (version === '') return { name, error: 'npm registry 未返回版本号' };
    return { name, version, repository: json.repository };
  } catch (error) {
    return { name, error: String((error && error.message) || error) };
  }
}));
writeSync(1, JSON.stringify(results) + '\n');
"#;

/// Marker identifying an npm wrapper installer; other `.mjs` files are not
/// scanned for pinned specs.
const INSTALL_NPM_MARKER: &str = "installNpmPlugin(";

/// Prefix of the official packages: they move with the deepseek-harness row.
const OFFICIAL_PACKAGE_PREFIX: &str = "@deepseek-ai/dsh";

/// Row id prefix of an npm plugin row (`npm:<packageName>`).
const NPM_ROW_PREFIX: &str = "npm:";

/// Budget for one wrapper reinstall: pnpm plus `dsh plugin add` can take
/// minutes, and a hung child must not block the update lock forever.
const NPM_INSTALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

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
    /// Newest tag reachable from the remote default branch, when one exists.
    /// This is the target the "latest tag" update mode resets to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_tag: Option<String>,
    /// True when `latest_tag` is NOT strictly newer than the local HEAD (an
    /// ancestor of HEAD with further commits beyond it, or the very same
    /// commit): resetting to it would downgrade or no-op, so the UI disables
    /// that option.
    #[serde(default)]
    pub latest_tag_stale: bool,
    /// True when this row counts toward the update badge/notification. A
    /// checkout sitting exactly on a tag whose update carries no newer tag
    /// (only commits beyond the current tag) still appears in the dialog but
    /// must not light the badge.
    #[serde(default = "default_announce")]
    pub announce: bool,
    /// True when the remote default branch is strictly ahead of local HEAD.
    pub behind: bool,
    /// True while this row is only a local preview: `latest` is a placeholder
    /// and the real check result has not arrived yet.
    #[serde(default)]
    pub checking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// npm publish state for npm-installed wrappers (install scripts record
    /// their npm package names in `.dsh/gui/npm-installs.json`). Present only
    /// when the row offers a newer tag and the wrapper installs from npm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm: Option<NpmUpdateInfo>,
    /// The repository's GitHub Releases list page
    /// (`https://github.com/<owner>/<repo>/releases`), resolved from the row's
    /// `origin`; the dialog renders the module name as a link to it. `None`
    /// for a non-GitHub remote (or no remote at all), which leaves the name as
    /// plain text. Deliberately the releases *list*, never a per-tag subpage:
    /// a row is not tied to one version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
    /// Row source: `None` for a git checkout row (the default, which also keeps
    /// an older cached plan readable), `Some("npm")` for an npm plugin row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// npm plugin rows: the package the install script pins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    /// npm plugin rows: the install script this row's pin lives in, relative to
    /// the repository root (POSIX, e.g. `plugins/skill-mcp-center/install.mjs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_script: Option<String>,
}

/// npm-side publish state for one update row.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NpmUpdateInfo {
    /// npm packages this wrapper installs (from the install-time registry);
    /// includes packages currently skipped by the default install guard.
    pub packages: Vec<String>,
    /// npm registry's currently published newest version per package.
    pub latest: HashMap<String, String>,
    /// Packages that do not yet have the tag's version published on npm.
    pub missing: Vec<String>,
    /// True when every package already has the tag version on npm.
    pub complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_announce() -> bool {
    true
}

/// Everything the frontend needs after a check.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub projects: Vec<ProjectUpdate>,
    pub has_updates: bool,
    pub update_count: usize,
    /// Rows that are behind AND badge-worthy ([`ProjectUpdate::announce`]);
    /// drives the menu badge / dot only.
    pub notify_count: usize,
    /// False when at least one repository could not be checked (network/auth),
    /// so a transient failure never clears the badge or the pending plan.
    pub all_checked: bool,
    /// Unix seconds when this check finished; the dialog shows it as "上次
    /// 检查" so a cached result is visibly stale.
    pub checked_at: u64,
    /// Wall-clock milliseconds the check took; shown next to `checked_at`.
    pub duration_ms: u64,
}

fn gui_dir(root: &Path) -> PathBuf {
    crate::roots::dsh_home(root).join("gui")
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

    let mut command = crate::console::hidden_command("git");
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));
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
pub(crate) fn git_output(dir: &Path, args: &[&str]) -> Option<String> {
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

/// Short human-readable failure detail from a git capture: the first three
/// non-empty stderr lines (stdout as fallback), trimmed to 300 chars.
fn git_error_summary(capture: &GitCapture) -> String {
    let detail = capture.stderr.trim();
    let detail = if detail.is_empty() {
        capture.stdout.trim()
    } else {
        detail
    };
    detail
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" | ")
        .chars()
        .take(300)
        .collect()
}

/// `git fetch --prune origin` with the actual failure surfaced for the dialog.
fn git_fetch(dir: &Path) -> Result<(), String> {
    let capture = run_git_captured(dir, &["fetch", "--prune", "origin"])
        .ok_or_else(|| "无法启动 git（PATH 或沙箱策略禁止创建进程）".to_string())?;
    if capture.success {
        return Ok(());
    }
    let detail = git_error_summary(&capture);
    if detail.is_empty() {
        Err("git fetch 失败（未知原因）".to_string())
    } else {
        Err(format!("git fetch 失败：{detail}"))
    }
}

fn is_git_repo(dir: &Path) -> bool {
    git_output(dir, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true")
}

/// One `[submodule "<name>"]` entry of the repository's `.gitmodules`.
pub(crate) struct SubmoduleEntry {
    /// Submodule name, exactly as written in the section header.
    pub name: String,
    /// Working-tree path, already joined to the repository root.
    pub path: PathBuf,
    /// Upstream URL exactly as the manifest records it (possibly relative to
    /// the superproject's origin); empty when the section has no `url`.
    pub url: String,
}

/// Parse the top-level submodules from `.gitmodules`. Paths are checked for
/// traversal before they are joined to the repository root.
pub(crate) fn submodule_entries(root: &Path) -> Vec<SubmoduleEntry> {
    let text = fs::read_to_string(root.join(".gitmodules")).unwrap_or_default();
    let mut entries = Vec::new();
    let mut name: Option<String> = None;
    let mut path: Option<String> = None;
    let mut url: Option<String> = None;

    let flush = |name: &Option<String>,
                 path: &Option<String>,
                 url: &Option<String>,
                 entries: &mut Vec<SubmoduleEntry>| {
        if let (Some(name), Some(path)) = (name, path) {
            let rel = Path::new(path);
            let safe = !rel.is_absolute()
                && !rel
                    .components()
                    .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)));
            if safe {
                entries.push(SubmoduleEntry {
                    name: name.clone(),
                    path: root.join(rel),
                    url: url.clone().unwrap_or_default(),
                });
            }
        }
    };

    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("[submodule") {
            flush(&name, &path, &url, &mut entries);
            let rest = line
                .strip_prefix("[submodule")
                .unwrap_or("")
                .trim_end_matches(']')
                .trim()
                .trim_matches('"');
            name = Some(rest.to_string());
            path = None;
            url = None;
        } else if line.starts_with("path") {
            if let Some((_, value)) = line.split_once('=') {
                path = Some(value.trim().trim_matches('"').to_string());
            }
        } else if line.starts_with("url") {
            if let Some((_, value)) = line.split_once('=') {
                url = Some(value.trim().trim_matches('"').to_string());
            }
        }
    }
    flush(&name, &path, &url, &mut entries);
    entries
}

/// Whether a configured submodule URL is a filesystem path rather than a remote
/// URL — the signature of a path frozen by a checkout location that no longer
/// exists. `file://` URLs count as local paths for the same reason.
fn is_local_path_url(url: &str) -> bool {
    let url = url.trim();
    if url.is_empty() {
        return false;
    }
    if url
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        return true;
    }
    // Any real scheme (`https://`, `ssh://`, `git://`, …). An scp-like
    // `git@host:path` remote has no `://` and is handled below.
    if url.contains("://") {
        return false;
    }
    if url.starts_with('.') || url.starts_with('/') || url.starts_with('\\') {
        return true;
    }
    // Windows drive path (`E:/x`, `E:\x`) or UNC (`\\server\share`).
    let bytes = url.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

/// Re-point submodules whose recorded remote is a stale filesystem path at the
/// URL their `.gitmodules` entry records; returns how many values changed.
///
/// Git freezes the URL it resolved at `git submodule update --init` time into
/// the repository's own `submodule.<name>.url` override and into each
/// submodule's `remote.origin.url`. When the manifest carried a relative URL
/// resolved against a local origin — or the checkout once lived at another
/// location — those frozen values are absolute paths of a directory that no
/// longer exists, so every check failed with `fatal: '<old path>' does not
/// appear to be a git repository` for the affected submodules.
///
/// `.gitmodules` is the authoritative source: it lives inside the checkout, so
/// its URL always resolves against the *current* repository root (the one
/// `DSH_GUI_ROOT` selects) instead of depending on a recorded absolute path.
/// Repairing the drift here also keeps the update launcher's and
/// [`run_root_update`]'s `git submodule update --init --recursive` working.
/// Only local-path values are repaired: a remote override (a mirror, a fork) is
/// deliberate configuration.
fn reconcile_submodule_remotes(root: &Path) -> usize {
    let mut repaired = 0;
    for entry in submodule_entries(root) {
        let url = entry.url.trim();
        // Nothing to fall back to; a manifest-relative URL is resolved by git
        // against the superproject origin instead of being frozen as a path.
        if url.is_empty() || is_local_path_url(url) {
            continue;
        }
        let dir = entry.path.as_path();
        if !dir.is_dir() || !is_git_repo(dir) {
            continue;
        }
        let key = format!("submodule.{}.url", entry.name);
        if let Some(configured) = git_output(root, &["config", "--get", &key]) {
            if is_local_path_url(&configured) && configured != url {
                if run_git_captured(root, &["config", &key, url]).is_some_and(|c| c.success) {
                    repaired += 1;
                }
            }
        }
        if let Some(origin) = git_output(dir, &["remote", "get-url", "origin"]) {
            if is_local_path_url(&origin) && origin != url {
                if run_git_captured(dir, &["remote", "set-url", "origin", url])
                    .is_some_and(|c| c.success)
                {
                    repaired += 1;
                }
            }
        }
    }
    if repaired > 0 {
        crate::log_status(
            root,
            &format!("repaired {repaired} stale submodule remote path(s) from .gitmodules"),
        );
    }
    repaired
}

fn package_name(dir: &Path) -> Option<String> {
    let manifest = fs::read_to_string(dir.join("package.json")).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&manifest).ok()?;
    value
        .get("name")
        .and_then(|n| n.as_str())
        .map(str::to_string)
}

fn npm_installs_path(root: &Path) -> PathBuf {
    gui_dir(root).join(NPM_INSTALLS_FILE)
}

/// Names recorded by the install pipeline for npm-installed wrappers
/// (`.dsh/gui/npm-installs.json`; see scripts/plugin-install.mjs).
fn npm_install_packages(root: &Path) -> std::collections::HashSet<String> {
    let content = fs::read_to_string(npm_installs_path(root)).unwrap_or_default();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return std::collections::HashSet::new();
    };
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn manifest_name_from_file(path: &Path) -> Option<String> {
    let manifest = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&manifest).ok()?;
    value.get("name")?.as_str().map(str::to_string)
}

/// Recursively collect package.json `name`s under `dir`, skipping vendored
/// and generated directories that live inside submodule checkouts.
fn collect_manifest_names(dir: &Path, names: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if matches!(file_name, "node_modules" | ".git" | "target" | "dist")
                || file_name.starts_with('.')
            {
                continue;
            }
            collect_manifest_names(&path, names);
        } else if file_name == "package.json" {
            if let Some(name) = manifest_name_from_file(&path) {
                names.push(name);
            }
        }
    }
}

/// Package names this submodule provides (root manifest, `apps/*`, and
/// `packages/**`).
///
/// `apps/*` matters for the dsh runtime: `@deepseek-ai/dsh` lives in
/// `apps/cli`, and the npm runtime installs exactly that package, so the row's
/// npm publish state depends on the name being discovered here.
fn submodule_package_names(path: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(name) = package_name(path) {
        names.push(name);
    }
    for group in ["apps", "packages"] {
        let dir = path.join(group);
        if dir.is_dir() {
            collect_manifest_names(&dir, &mut names);
        }
    }
    names
}

/// Names of npm-installed packages belonging to this submodule: the source
/// manifests' names intersected with the install-time npm registry.
fn npm_packages_for_project(root: &Path, path: &Path) -> Vec<String> {
    let registry = npm_install_packages(root);
    if registry.is_empty() {
        return Vec::new();
    }
    submodule_package_names(path)
        .into_iter()
        .filter(|name| registry.contains(name))
        .collect()
}

fn parse_npm_results(text: &str, packages: &[String]) -> NpmUpdateInfo {
    let mut latest = HashMap::new();
    let mut missing = Vec::new();
    let mut error = None;
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return NpmUpdateInfo {
            packages: packages.to_vec(),
            latest,
            missing: packages.to_vec(),
            complete: false,
            error: Some("无法解析 npm registry 响应".to_string()),
        };
    };
    let Some(items) = value.as_array() else {
        return NpmUpdateInfo {
            packages: packages.to_vec(),
            latest,
            missing: packages.to_vec(),
            complete: false,
            error: Some("npm registry 响应格式异常".to_string()),
        };
    };
    for item in items {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if let Some(detail) = item.get("error").and_then(|v| v.as_str()) {
            error = Some(detail.to_string());
            continue;
        }
        if name.is_empty() {
            continue;
        }
        if let Some(latest_value) = item.get("latest").and_then(|v| v.as_str()) {
            latest.insert(name.clone(), latest_value.to_string());
        }
        if item.get("hasTarget").and_then(|v| v.as_bool()) != Some(true) {
            missing.push(name);
        }
    }
    let complete = missing.is_empty() && error.is_none();
    NpmUpdateInfo {
        packages: packages.to_vec(),
        latest,
        missing,
        complete,
        error,
    }
}

/// Whether a capture emitted the npm script's complete JSON array, regardless
/// of the child's exit status: node can abort after flushing the array (see the
/// `NPM_FETCH_SCRIPT` note), and such a complete answer must still be used.
/// `parse_npm_results` reports its own "unparseable response" error when nothing
/// usable was emitted, so a partial write can never be mistaken for a result.
fn emitted_npm_json(stdout: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .map(|value| value.is_array())
        .unwrap_or(false)
}

/// Query the npm registry for `packages` at `tag`'s version; one node fetch
/// covers every package. Failure is reported inside `NpmUpdateInfo.error`
/// instead of failing the row (git update state stays authoritative).
fn npm_update_check(path: &Path, packages: Vec<String>, tag: &str) -> Option<NpmUpdateInfo> {
    let version = tag.strip_prefix('v').unwrap_or(tag);
    let script = write_temp_script(NPM_FETCH_SCRIPT).ok()?;
    let packages_json = serde_json::to_string(&packages).ok()?;
    let args = vec![
        script.as_os_str().to_os_string(),
        packages_json.into(),
        version.to_owned().into(),
    ];
    let output = run_node_captured(Path::new("node"), &args, path, &[], NPM_FETCH_TIMEOUT);
    let _ = fs::remove_file(&script);
    match output {
        Ok(output) if output.success || emitted_npm_json(&output.stdout) => {
            Some(parse_npm_results(&output.stdout, &packages))
        }
        Ok(output) => {
            let detail = output.stderr.trim().chars().take(200).collect::<String>();
            Some(NpmUpdateInfo {
                packages,
                latest: HashMap::new(),
                missing: Vec::new(),
                complete: false,
                error: Some(if detail.is_empty() {
                    "npm 版本核对失败（未知原因）".to_string()
                } else {
                    detail
                }),
            })
        }
        Err(error) => Some(NpmUpdateInfo {
            packages,
            latest: HashMap::new(),
            missing: Vec::new(),
            complete: false,
            error: Some(error),
        }),
    }
}

// ---------------------------------------------------------------------------
// npm plugin rows
//
// Besides the git checkout rows, the dialog lists one row per npm package
// pinned by a `plugins/<wrapper>/install.mjs` wrapper. The parser mirrors the
// desktop plugin's `plugin-specs.ts`: it scans every `.mjs` file that calls
// `installNpmPlugin(`, strips JavaScript comments, and extracts the exact
// `<name>@<version>` string literals (single, double, or backtick quotes).
// The detector depends on that convention — a wrapper that builds its spec
// dynamically produces no row.
// ---------------------------------------------------------------------------

/// One npm plugin row: one package pinned by one wrapper script.
#[derive(Clone, Debug)]
struct PluginNpmRow {
    /// Stable row id: `npm:<packageName>`.
    id: String,
    /// npm package name, e.g. `@max-null/dsh-skill-mcp-center`.
    package_name: String,
    /// Wrapper script, relative to the repository root and POSIX
    /// (`plugins/<wrapper>/install.mjs`).
    install_script: String,
    /// First directory segment under `plugins/` (the wrapper id).
    wrapper_id: String,
    /// Exact version the script pins.
    pinned_version: String,
    /// The literal as written in the script: `<packageName>@<pinnedVersion>`.
    spec: String,
}

/// One `<package>@<version>` literal extracted from an install script.
#[derive(Clone, Debug)]
struct PinnedSpec {
    package_name: String,
    pinned_version: String,
    /// The literal as written (trimmed); the in-place rewrite replaces it.
    spec: String,
}

/// One package's registry `latest` answer, before it is folded into a row.
#[derive(Clone, Debug)]
struct PackageLatest {
    /// `version` of the `/<pkg>/latest` document, when the registry answered.
    latest: Option<String>,
    /// The manifest's `repository` URL, when it declares one.
    repository_url: Option<String>,
    /// A readable per-package failure; the other packages are unaffected.
    error: Option<String>,
}

/// Remove `//` line comments and `/* *\/` block comments from JavaScript
/// source while leaving string and template literals untouched.
///
/// A regex cannot do this safely (a `//` inside a URL literal is not a
/// comment, and the specs to extract are themselves literals), so this walks
/// the source with a tiny scanner. Template literals are treated as plain
/// strings (their `${…}` nests are not parsed) — sufficient for extracting
/// `pkg@version` literals, which never live inside a template expression.
fn strip_js_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        if current == '/' && chars.get(index + 1) == Some(&'/') {
            index += 2;
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if current == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index < chars.len() && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/')) {
                index += 1;
            }
            index = (index + 2).min(chars.len());
            continue;
        }
        if current == '\'' || current == '"' || current == '`' {
            out.push(current);
            index += 1;
            while index < chars.len() {
                let inner = chars[index];
                out.push(inner);
                index += 1;
                if inner == '\\' {
                    // Copy the escaped character verbatim so `\'` never closes
                    // the string.
                    if let Some(escaped) = chars.get(index) {
                        out.push(*escaped);
                        index += 1;
                    }
                    continue;
                }
                if inner == current {
                    break;
                }
            }
            continue;
        }
        out.push(current);
        index += 1;
    }
    out
}

/// Extract the body of every single-quoted, double-quoted, and backtick string
/// literal in `source` (comments already stripped). Escaped quotes are copied
/// into the body unescaped — a spec literal never contains one.
fn js_string_literals(source: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let mut literals = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        if current != '\'' && current != '"' && current != '`' {
            index += 1;
            continue;
        }
        let quote = current;
        index += 1;
        let mut body = String::new();
        while index < chars.len() {
            let inner = chars[index];
            index += 1;
            if inner == '\\' {
                if let Some(escaped) = chars.get(index) {
                    body.push(*escaped);
                    index += 1;
                }
                continue;
            }
            if inner == quote {
                literals.push(body);
                break;
            }
            body.push(inner);
        }
    }
    literals
}

/// Whether one bare or scoped package name segment is well formed: it must
/// start alphanumerically and only use the characters npm allows.
fn is_valid_name_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    segment
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Whether `name` is a bare (`pkg`) or scoped (`@scope/pkg`) package name.
fn is_valid_package_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let Some(rest) = name.strip_prefix('@') else {
        return is_valid_name_segment(name);
    };
    let mut parts = rest.splitn(2, '/');
    let Some(scope) = parts.next() else {
        return false;
    };
    let Some(package) = parts.next() else {
        return false;
    };
    // A second `/` means this is a path, not a package name.
    if package.contains('/') {
        return false;
    }
    is_valid_name_segment(scope) && is_valid_name_segment(package)
}

/// Whether `version` is the exact three-segment semver a spec pin carries
/// (prerelease allowed, build metadata not part of the convention).
fn is_pinned_version(version: &str) -> bool {
    let (core, prerelease) = match version.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (version, None),
    };
    let mut segments = core.split('.');
    let valid_core = (0..3).all(|_| {
        segments
            .next()
            .is_some_and(|segment| !segment.is_empty() && segment.chars().all(|c| c.is_ascii_digit()))
    }) && segments.next().is_none();
    if !valid_core {
        return false;
    }
    match prerelease {
        None => true,
        Some(prerelease) => {
            !prerelease.is_empty()
                && prerelease
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        }
    }
}

/// Parse one string literal body as a pinned spec.
/// @returns the package name and pinned version, or `None` when the body is
///   not exactly `<name>@<three-segment semver>`.
fn parse_pinned_spec(literal: &str) -> Option<(String, String)> {
    let literal = literal.trim();
    // A scoped name starts with `@`, so the version separator is the *last*
    // `@` and never at index 0.
    let at = literal.rfind('@')?;
    if at == 0 {
        return None;
    }
    let package_name = &literal[..at];
    let pinned_version = &literal[at + 1..];
    if !is_valid_package_name(package_name) || !is_pinned_version(pinned_version) {
        return None;
    }
    Some((package_name.to_string(), pinned_version.to_string()))
}

/// Extract every pinned spec from one install script (comments stripped
/// first). The first literal per package wins; official `@deepseek-ai/dsh*`
/// packages are excluded because they move with the deepseek-harness row.
fn extract_pinned_specs(source: &str) -> Vec<PinnedSpec> {
    let stripped = strip_js_comments(source);
    let mut specs: Vec<PinnedSpec> = Vec::new();
    for literal in js_string_literals(&stripped) {
        let Some((package_name, pinned_version)) = parse_pinned_spec(&literal) else {
            continue;
        };
        if package_name.starts_with(OFFICIAL_PACKAGE_PREFIX) {
            continue;
        }
        if specs.iter().any(|spec| spec.package_name == package_name) {
            continue;
        }
        specs.push(PinnedSpec {
            package_name,
            pinned_version,
            spec: literal.trim().to_string(),
        });
    }
    specs
}

/// Collect the absolute paths of every `.mjs` file under `dir`, recursively.
/// Vendored installs and dot directories are skipped.
fn collect_install_scripts(dir: &Path, scripts: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if file_name == "node_modules" || file_name.starts_with('.') {
                continue;
            }
            collect_install_scripts(&path, scripts);
        } else if path.is_file() && file_name.ends_with(".mjs") {
            scripts.push(path);
        }
    }
}

/// List every npm plugin row under `<root>/plugins`.
///
/// Only `.mjs` files that call `installNpmPlugin(` contribute. Rows are sorted
/// by install script, then package name, so the dialog's row order is stable
/// across checks. An unreadable script contributes no rows; an absent
/// `plugins/` tree is simply an empty list.
fn plugin_npm_rows(root: &Path) -> Vec<PluginNpmRow> {
    let mut scripts: Vec<PathBuf> = Vec::new();
    collect_install_scripts(&root.join("plugins"), &mut scripts);
    let mut rows: Vec<PluginNpmRow> = Vec::new();
    for script_path in scripts {
        let Ok(source) = fs::read_to_string(&script_path) else {
            continue;
        };
        if !source.contains(INSTALL_NPM_MARKER) {
            continue;
        }
        let Ok(relative) = script_path.strip_prefix(root) else {
            continue;
        };
        let install_script = relative.to_string_lossy().replace('\\', "/");
        let parts: Vec<&str> = install_script.split('/').collect();
        // `plugins/<wrapper>/…`: anything directly under `plugins/` has no
        // wrapper directory to name and is not an installer.
        if parts.len() < 3 {
            continue;
        }
        let wrapper_id = parts[1].to_string();
        for spec in extract_pinned_specs(&source) {
            rows.push(PluginNpmRow {
                id: format!("npm:{}", spec.package_name),
                package_name: spec.package_name,
                install_script: install_script.clone(),
                wrapper_id: wrapper_id.clone(),
                pinned_version: spec.pinned_version,
                spec: spec.spec,
            });
        }
    }
    rows.sort_by(|left, right| {
        left.install_script
            .cmp(&right.install_script)
            .then_with(|| left.package_name.cmp(&right.package_name))
    });
    rows
}

/// A parsed version: the three numeric segments plus the prerelease parts.
struct ParsedVersion {
    core: [u64; 3],
    prerelease: Vec<String>,
}

/// Parse `major.minor.patch[-prerelease]` (`+build` metadata ignored). A
/// leading `v` is tolerated because git tags carry one; every other shape ends
/// up as `None`.
fn parse_version(value: &str) -> Option<ParsedVersion> {
    let trimmed = value.trim();
    let without_v = trimmed.strip_prefix('v').unwrap_or(trimmed);
    let (core_and_prerelease, build) = match without_v.split_once('+') {
        Some((left, build)) => (left, Some(build)),
        None => (without_v, None),
    };
    if let Some(build) = build {
        if build.is_empty()
            || !build
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            return None;
        }
    }
    let (core, prerelease) = match core_and_prerelease.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (core_and_prerelease, None),
    };
    let mut segments = core.split('.');
    let mut numbers: [u64; 3] = [0; 3];
    for number in numbers.iter_mut() {
        let segment = segments.next()?;
        if segment.is_empty() || !segment.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        *number = segment.parse::<u64>().ok()?;
    }
    if segments.next().is_some() {
        return None;
    }
    let prerelease = match prerelease {
        None => Vec::new(),
        Some(prerelease) => {
            if prerelease.is_empty()
                || !prerelease
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
            {
                return None;
            }
            prerelease.split('.').map(str::to_string).collect()
        }
    };
    Some(ParsedVersion {
        core: numbers,
        prerelease,
    })
}

/// Compare two numeric prerelease identifiers without overflowing on long
/// digit strings: strip leading zeros, then compare by length and text.
fn compare_numeric_identifiers(left: &str, right: &str) -> std::cmp::Ordering {
    let left = left.trim_start_matches('0');
    let right = right.trim_start_matches('0');
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

/// Compare two versions by semver precedence.
///
/// A release outranks every prerelease of the same core; prerelease
/// identifiers compare left to right (numeric below alphanumeric, shorter list
/// below a longer one with the same prefix); `None` means "not comparable", so
/// a malformed version can never be made to claim an update.
fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering as CmpOrdering;
    let left = parse_version(a)?;
    let right = parse_version(b)?;
    for index in 0..3 {
        match left.core[index].cmp(&right.core[index]) {
            CmpOrdering::Equal => continue,
            other => return Some(other),
        }
    }
    match (left.prerelease.is_empty(), right.prerelease.is_empty()) {
        (true, true) => return Some(CmpOrdering::Equal),
        (true, false) => return Some(CmpOrdering::Greater),
        (false, true) => return Some(CmpOrdering::Less),
        (false, false) => {}
    }
    let count = left.prerelease.len().max(right.prerelease.len());
    for index in 0..count {
        match (left.prerelease.get(index), right.prerelease.get(index)) {
            // A shorter list with the same prefix ranks lower.
            (None, _) => return Some(CmpOrdering::Less),
            (_, None) => return Some(CmpOrdering::Greater),
            (Some(left_part), Some(right_part)) => {
                if left_part == right_part {
                    continue;
                }
                let left_numeric = left_part.chars().all(|c| c.is_ascii_digit());
                let right_numeric = right_part.chars().all(|c| c.is_ascii_digit());
                return Some(match (left_numeric, right_numeric) {
                    (true, true) => compare_numeric_identifiers(left_part, right_part),
                    (true, false) => CmpOrdering::Less,
                    (false, true) => CmpOrdering::Greater,
                    (false, false) => left_part.as_str().cmp(right_part.as_str()),
                });
            }
        }
    }
    Some(CmpOrdering::Equal)
}

/// Whether `latest` is strictly newer than `current`. An unparseable pair never
/// counts as an update.
fn is_newer(latest: &str, current: &str) -> bool {
    matches!(
        compare_versions(latest, current),
        Some(std::cmp::Ordering::Greater)
    )
}

/// The GitHub Releases **list** page for an npm manifest's `repository` URL.
///
/// npm records the field in several forms — `git+https://github.com/o/r.git`,
/// `https://github.com/o/r`, `git@github.com:o/r` — and the dialog links the
/// row name to the list the reader can pick a version from. A non-GitHub
/// repository yields `None` so the row renders without an external link.
fn github_releases_url(repository: Option<&str>) -> Option<String> {
    let value = repository?.trim();
    if value.is_empty() {
        return None;
    }
    // npm prefixes a git-transport marker (`git+https://…`, `git+ssh://…`).
    let rest = value.strip_prefix("git+").unwrap_or(value);
    let rest = if let Some(rest) = rest.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = rest.strip_prefix("http://github.com/") {
        rest
    } else if let Some(rest) = rest.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(rest) = rest.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = rest.strip_prefix("git://github.com/") {
        rest
    } else {
        return None;
    };
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?;
    let repository = parts.next()?;
    if owner.is_empty() || repository.is_empty() {
        return None;
    }
    Some(format!("https://github.com/{owner}/{repository}/releases"))
}

/// Rewrite every occurrence of one exact pinned spec in an install script.
///
/// The pin is a plain string literal (`'pkg@1.2.3'`), so a literal
/// split/join is exactly what the source needs; every occurrence is replaced
/// because a constant and a comment that mirror the pin describe the same
/// install target.
fn replace_pinned_version(text: &str, old_spec: &str, new_spec: &str) -> Result<String, String> {
    if old_spec.is_empty() {
        return Err("安装脚本中的 spec 为空，无法替换".to_string());
    }
    if new_spec.is_empty() {
        return Err("目标 spec 为空，无法替换".to_string());
    }
    if !text.contains(old_spec) {
        return Err(format!("安装脚本中已找不到 {old_spec}"));
    }
    let updated = text.replace(old_spec, new_spec);
    if !updated.contains(new_spec) {
        return Err(format!("安装脚本中没有写入 {new_spec}"));
    }
    Ok(updated)
}

/// Read a manifest's `repository` field: npm allows a bare URL string or an
/// object with a `url` member (plus optional `type`/`directory`).
fn repository_url_of(field: Option<&serde_json::Value>) -> Option<String> {
    let value = match field? {
        serde_json::Value::String(text) => text.trim().to_string(),
        serde_json::Value::Object(map) => map.get("url")?.as_str()?.trim().to_string(),
        _ => return None,
    };
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Fold the embedded latest-fetch script's JSON answer into one
/// [`PackageLatest`] per requested package, in request order. A bad body fails
/// every requested package (there is nothing to attribute it to); a missing
/// package entry or a missing `version` is a per-package answer problem.
fn parse_latest_results(text: &str, packages: &[String]) -> Vec<PackageLatest> {
    let items: Vec<serde_json::Value> = match serde_json::from_str::<serde_json::Value>(text.trim())
    {
        Ok(serde_json::Value::Array(items)) => items,
        Ok(_) => {
            return packages
                .iter()
                .map(|_| PackageLatest {
                    latest: None,
                    repository_url: None,
                    error: Some("npm registry 响应格式异常".to_string()),
                })
                .collect()
        }
        Err(_) => {
            return packages
                .iter()
                .map(|_| PackageLatest {
                    latest: None,
                    repository_url: None,
                    error: Some("无法解析 npm registry 响应".to_string()),
                })
                .collect()
        }
    };
    packages
        .iter()
        .map(|name| {
            let Some(item) = items.iter().find(|item| {
                item.get("name").and_then(|value| value.as_str()) == Some(name.as_str())
            }) else {
                return PackageLatest {
                    latest: None,
                    repository_url: None,
                    error: Some("npm registry 未返回版本信息".to_string()),
                };
            };
            if let Some(error) = item.get("error").and_then(|value| value.as_str()) {
                return PackageLatest {
                    latest: None,
                    repository_url: None,
                    error: Some(error.to_string()),
                };
            }
            let latest = item
                .get("version")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            PackageLatest {
                latest,
                repository_url: repository_url_of(item.get("repository")),
                error: None,
            }
        })
        .collect()
}

/// Query the registry's `/<pkg>/latest` document for `packages`; one embedded
/// node invocation covers every package. A non-zero child that still flushed a
/// complete JSON array is accepted (`emitted_npm_json`), mirroring the publish
/// check.
fn npm_latest_answers(root: &Path, packages: &[String]) -> Result<Vec<PackageLatest>, String> {
    if packages.is_empty() {
        return Ok(Vec::new());
    }
    let script = write_temp_script(NPM_LATEST_FETCH_SCRIPT)?;
    let packages_json = serde_json::to_string(packages)
        .map_err(|error| format!("无法序列化 npm 包名列表：{error}"))?;
    let args = vec![script.as_os_str().to_os_string(), packages_json.into()];
    let output = run_node_captured(Path::new("node"), &args, root, &[], NPM_FETCH_TIMEOUT);
    let _ = fs::remove_file(&script);
    match output {
        Ok(output) if output.success || emitted_npm_json(&output.stdout) => {
            Ok(parse_latest_results(&output.stdout, packages))
        }
        Ok(output) => {
            let detail = output.stderr.trim().chars().take(200).collect::<String>();
            Err(if detail.is_empty() {
                "npm 版本查询失败（未知原因）".to_string()
            } else {
                detail
            })
        }
        Err(error) => Err(error),
    }
}

/// Local-only preview of one npm plugin row: the install script's pin is known
/// offline, the registry answer is not.
fn local_npm_preview(row: &PluginNpmRow) -> ProjectUpdate {
    ProjectUpdate {
        id: row.id.clone(),
        name: row.package_name.clone(),
        path: row.install_script.clone(),
        current: row.pinned_version.clone(),
        latest: "检查中…".to_string(),
        latest_tag: None,
        latest_tag_stale: false,
        announce: true,
        behind: false,
        checking: true,
        error: None,
        npm: None,
        release_url: None,
        kind: Some("npm".to_string()),
        package_name: Some(row.package_name.clone()),
        install_script: Some(row.install_script.clone()),
    }
}

/// Fold one registry answer into its npm plugin row. A failed query keeps the
/// pin readable, carries the error on the row, and never counts as an update.
fn checked_npm_row(row: &PluginNpmRow, answer: &PackageLatest) -> ProjectUpdate {
    let mut update = ProjectUpdate {
        id: row.id.clone(),
        name: row.package_name.clone(),
        path: row.install_script.clone(),
        // The pin is what the current deployment installs; the registry answer
        // is what a fresh deployment would get.
        current: row.pinned_version.clone(),
        latest: "—".to_string(),
        latest_tag: None,
        latest_tag_stale: false,
        announce: false,
        behind: false,
        checking: false,
        error: None,
        npm: None,
        release_url: None,
        kind: Some("npm".to_string()),
        package_name: Some(row.package_name.clone()),
        install_script: Some(row.install_script.clone()),
    };
    if let Some(error) = &answer.error {
        update.error = Some(format!("npm 版本查询失败：{error}"));
        return update;
    }
    let Some(latest) = &answer.latest else {
        update.error = Some("npm registry 未返回版本号".to_string());
        return update;
    };
    update.latest = latest.clone();
    update.behind = is_newer(latest, &row.pinned_version);
    update.announce = update.behind;
    update.release_url = github_releases_url(answer.repository_url.as_deref());
    update
}

/// The npm plugin rows for one completed check: scan locally, query every pin
/// in one registry phase, then fold the answers in. A registry failure is
/// written to the affected row instead of failing the whole check.
fn check_plugin_rows(root: &Path) -> Vec<ProjectUpdate> {
    let rows = plugin_npm_rows(root);
    if rows.is_empty() {
        return Vec::new();
    }
    let packages: Vec<String> = rows.iter().map(|row| row.package_name.clone()).collect();
    match npm_latest_answers(root, &packages) {
        Ok(answers) => rows
            .iter()
            .zip(answers.iter())
            .map(|(row, answer)| checked_npm_row(row, answer))
            .collect(),
        Err(error) => rows
            .iter()
            .map(|row| {
                let mut update = local_npm_preview(row);
                update.checking = false;
                update.latest = "—".to_string();
                update.error = Some(format!("npm 版本查询失败：{error}"));
                update
            })
            .collect(),
    }
}

/// Whether every git row was checked: `allChecked` describes the git side
/// only. An npm plugin row's registry failure is already carried on that row
/// (like a tag's npm publish note) and must not clear the badge or drop the
/// pending plan, which the detached launcher works from.
fn all_git_rows_checked(projects: &[ProjectUpdate]) -> bool {
    projects
        .iter()
        .filter(|project| project.kind.is_none())
        .all(|project| project.error.is_none())
}

/// The npm package name of an npm row id (`npm:<package>`); any other id is
/// returned unchanged so an error message always has something readable.
fn package_name_of_row_id(id: &str) -> &str {
    id.strip_prefix(NPM_ROW_PREFIX).unwrap_or(id)
}

/// The exact tag of `commitish` when one exists, else its short commit hash.
fn git_version(dir: &Path, commitish: &str) -> String {
    git_output(dir, &["describe", "--tags", "--exact-match", commitish])
        .or_else(|| git_output(dir, &["rev-parse", "--short", commitish]))
        .unwrap_or_else(|| "unknown".to_string())
}

/// Whether `tag` is NOT strictly newer than the current HEAD: an ancestor
/// (older) of HEAD, or the very same commit. `git merge-base --is-ancestor`
/// treats a commit as an ancestor of itself, so one check covers both.
/// Resetting to such a tag would downgrade or no-op, so the UI never offers
/// it as an update target.
fn tag_is_stale(dir: &Path, tag: &str) -> bool {
    if git_output(dir, &["rev-parse", &format!("{tag}^{{commit}}")]).is_none() {
        return false;
    }
    run_git_captured(dir, &["merge-base", "--is-ancestor", tag, "HEAD"])
        .map(|capture| capture.success)
        .unwrap_or(false)
}

/// The remote default branch (`origin/HEAD`). Ask the remote first so a stale
/// local `refs/remotes/origin/HEAD` symbolic ref can never point the updater at
/// an old branch; fall back to that local ref when the extra network roundtrip
/// fails.
pub(crate) fn remote_default_branch(dir: &Path) -> Option<String> {
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

/// The GitHub Releases list page for one update row's module name, or `None`
/// when the row has no GitHub origin.
///
/// The row's own `git remote get-url origin` wins (that is the repository the
/// update will actually fetch from); `manifest_url` — the `.gitmodules` entry
/// for a submodule — is the fallback for a checkout that is not initialized
/// yet, where git cannot answer. A local-path or non-GitHub remote resolves to
/// `None`, leaving the module name as plain text.
fn release_page_for(path: &Path, manifest_url: Option<&str>) -> Option<String> {
    let origin = git_output(path, &["remote", "get-url", "origin"])
        .or_else(|| manifest_url.map(str::to_string));
    crate::changelog::releases_page_url(origin.as_deref())
}

/// Compare one repository against its `origin` default branch.
fn check_project(
    root: &Path,
    id: &str,
    fallback_name: &str,
    path: &Path,
    manifest_url: Option<&str>,
) -> ProjectUpdate {
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
        latest_tag: None,
        latest_tag_stale: false,
        announce: true,
        behind: false,
        checking: false,
        error: None,
        npm: None,
        release_url: release_page_for(path, manifest_url),
        kind: None,
        package_name: None,
        install_script: None,
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
    // The "latest tag" update target: the newest tag reachable from the
    // remote default branch (describe output is the bare tag name with
    // --abbrev=0). Absent when the branch carries no tags.
    project.latest_tag = git_output(path, &["describe", "--tags", "--abbrev=0", &latest_ref]);
    // A tag that is not strictly newer than the local HEAD (older, or the very
    // commit currently checked out) is never a usable update target.
    project.latest_tag_stale = project
        .latest_tag
        .as_deref()
        .is_some_and(|tag| tag_is_stale(path, tag));

    if current_sha != latest_sha {
        let range = format!("{current_sha}..{latest_ref}");
        let behind = git_output(path, &["rev-list", "--count", &range])
            .and_then(|count| count.parse::<u32>().ok())
            .unwrap_or(0);
        project.behind = behind > 0;
        // The update badge only announces new-tag updates: while the checkout
        // sits exactly on a tag and the remote adds commits beyond it without
        // a newer tag, the update stays visible in the dialog but is not
        // counted into the badge notification.
        if project.behind {
            let on_exact_tag =
                git_output(path, &["describe", "--tags", "--exact-match", "HEAD"]).is_some();
            let has_newer_tag = project
                .latest_tag
                .as_deref()
                .is_some_and(|tag| !tag_is_stale(path, tag));
            project.announce = !(on_exact_tag && !has_newer_tag);
            // npm-installed wrappers: verify the newest tag already has a
            // matching npm publish before the dialog offers it as an update.
            // A missing npm publish is shown as an extra note in the
            // current -> latest comparison, not a row failure.
            if let Some(tag) = project.latest_tag.clone() {
                let npm_packages = npm_packages_for_project(root, path);
                if !npm_packages.is_empty() && !tag_is_stale(path, &tag) {
                    project.npm = npm_update_check(path, npm_packages, &tag);
                }
            }
        }
    }
    project
}

/// Local-only preview of one repository: package name, path, and current
/// version are available immediately; `latest` stays a placeholder until the
/// network check finishes.
fn local_preview_project(
    root: &Path,
    id: &str,
    fallback_name: &str,
    path: &Path,
    manifest_url: Option<&str>,
) -> ProjectUpdate {
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
        latest_tag: None,
        latest_tag_stale: false,
        announce: true,
        behind: false,
        checking: true,
        error: None,
        npm: None,
        // Resolved locally in the skeleton state too, so the name is a link
        // from the first paint, not only after the network check lands.
        release_url: release_page_for(path, manifest_url),
        kind: None,
        package_name: None,
        install_script: None,
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
/// before the slow network fetch starts. npm plugin rows append after the git
/// rows with their install-script pin already known.
pub fn local_check(root: &Path) -> Vec<ProjectUpdate> {
    let mut projects = Vec::new();
    projects.push(local_preview_project(root, "dsh-gui", "dsh-gui", root, None));
    for entry in submodule_entries(root) {
        projects.push(local_preview_project(
            root,
            &entry.name,
            &entry.name,
            &entry.path,
            Some(&entry.url),
        ));
    }
    for row in plugin_npm_rows(root) {
        projects.push(local_npm_preview(&row));
    }
    projects
}

/// Check the root repository and every submodule. The root is always first so
/// the pending plan has a deterministic order for the update launcher.
pub fn check(root: &Path) -> UpdateStatus {
    let started = std::time::Instant::now();
    // A checkout that was moved (or created from a local origin) can carry the
    // previous location in its submodule remotes; realign them with
    // `.gitmodules` before fetching, so the check never reports a stale path.
    reconcile_submodule_remotes(root);
    let mut projects = Vec::new();
    projects.push(check_project(root, "dsh-gui", "dsh-gui", root, None));
    for entry in submodule_entries(root) {
        projects.push(check_project(
            root,
            &entry.name,
            &entry.name,
            &entry.path,
            Some(&entry.url),
        ));
    }
    // npm plugin rows land after every git row: a registry failure is carried
    // on that row and never changes a git row's state.
    projects.extend(check_plugin_rows(root));
    let update_count = projects.iter().filter(|p| p.behind).count();
    let notify_count = projects.iter().filter(|p| p.behind && p.announce).count();
    let all_checked = all_git_rows_checked(&projects);
    let checked_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    UpdateStatus {
        has_updates: update_count > 0,
        update_count,
        notify_count,
        all_checked,
        checked_at,
        duration_ms: started.elapsed().as_millis() as u64,
        projects,
    }
}

/// Check for updates and keep the pending plan / update launcher on disk in
/// sync with the result: present while at least one update exists, removed only
/// after a fully successful check finds nothing behind. A partially failed
/// check (network/auth) leaves the previous plan untouched.
///
/// The plan only carries the git rows: npm plugin rows update in place from
/// the dialog ([`run_npm_plugin_update`]), so they must never reach the
/// detached launcher.
pub fn check_and_sync(root: &Path, gui_pid: u32, harness_pid: u32) -> Result<UpdateStatus, String> {
    let status = check(root);
    let dir = gui_dir(root);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let plan_rows: Vec<&ProjectUpdate> = status
        .projects
        .iter()
        .filter(|project| project.kind.is_none())
        .collect();
    let has_git_updates = plan_rows.iter().any(|project| project.behind);
    if has_git_updates {
        let plan = serde_json::to_vec(&plan_rows)
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

/// Render the update launcher source with the two roots and the PIDs baked in.
fn render_update_script(root: &Path, gui_pid: u32, harness_pid: u32) -> io::Result<String> {
    let root_json = serde_json::to_string(&root.to_string_lossy())
        .map_err(|e| io::Error::other(e.to_string()))?;
    let runtime_json = serde_json::to_string(&crate::roots::runtime_root(root).to_string_lossy())
        .map_err(|e| io::Error::other(e.to_string()))?;
    Ok(UPDATE_SCRIPT_TEMPLATE
        .replace("\"__ROOT__\"", &root_json)
        .replace("\"__RUNTIME_ROOT__\"", &runtime_json)
        .replace("__GUI_PID__", &gui_pid.to_string())
        .replace("__HARNESS_PID__", &harness_pid.to_string()))
}

/// Write (or refresh) the update launcher copy under the runtime root's
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
fn spawn_update_script(
    root: &Path,
    ids: &[String],
    modes: &HashMap<String, String>,
) -> Result<(), String> {
    let dir = gui_dir(root);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let script = copy_update_script_to_temp(root)?;

    #[cfg(windows)]
    {
        let launcher = write_windows_console_launcher(root, ids, modes, &script)?;
        spawn_windows_update_console(root, &launcher)
    }
    #[cfg(not(windows))]
    {
        spawn_unix_update_node(root, &script, ids, modes)
    }
}

/// PowerShell quoting helper: single quotes with `''` escaping.
#[cfg(windows)]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Render the "--modes id=mode,..." argument (per-project update target).
fn modes_argument(modes: &HashMap<String, String>) -> String {
    let mut entries: Vec<&String> = modes.keys().collect();
    entries.sort();
    entries
        .into_iter()
        .map(|id| format!("{id}={}", modes.get(id).map(String::as_str).unwrap_or("commit")))
        .collect::<Vec<_>>()
        .join(",")
}

/// Write the tiny PowerShell file the visible console runs. It invokes the
/// generated update.mjs with the selected ids and per-project update targets;
/// powershell -NoExit keeps the window open afterwards so success/failure is
/// always readable.
#[cfg(windows)]
fn write_windows_console_launcher(
    root: &Path,
    ids: &[String],
    modes: &HashMap<String, String>,
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
    if !modes.is_empty() {
        content.push_str(&format!(" --modes {}", ps_quote(&modes_argument(modes))));
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
    let mut probe = crate::console::hidden_command("pwsh.exe");
    probe
        .args(["-NoLogo", "-NoProfile", "-Command", "exit 0"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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
    // The one spawn that must stay visible: the update runs in a console window
    // the user watches (see the CREATE_NEW_CONSOLE flag below), so this call is
    // exempt from `console::hidden_command` — and marked accordingly for
    // `spawns_go_through_hidden_command`.
    let mut command = Command::new(windows_powershell_program()); // CREATE_NEW_CONSOLE
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
fn spawn_unix_update_node(
    root: &Path,
    script: &Path,
    ids: &[String],
    modes: &HashMap<String, String>,
) -> Result<(), String> {
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(gui_dir(root).join("update.log"))
        .map_err(|e| format!("cannot open update.log: {e}"))?;

    let mut command = crate::console::hidden_command("node");
    command
        .arg(script)
        .current_dir(root)
        .env("DSH_HOME", crate::roots::dsh_home(root))
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            log.try_clone()
                .map_err(|e| format!("cannot clone update.log: {e}"))?,
        ))
        .stderr(Stdio::from(log));
    if !ids.is_empty() {
        command.arg("--ids").arg(ids.join(","));
    }
    if !modes.is_empty() {
        command.arg("--modes").arg(modes_argument(modes));
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
/// project). `modes` maps a project id to its update target ("commit" for the
/// remote default branch HEAD, "tag" for the newest tag reachable from it);
/// missing entries default to "commit". The plan written by the most recent
/// check is authoritative; the launcher is refreshed so it waits for the exact
/// running dsh-gui/harness processes.
pub fn start(
    root: &Path,
    gui_pid: u32,
    harness_pid: u32,
    ids: &[String],
    modes: &HashMap<String, String>,
) -> Result<(), String> {
    let plan_file = plan_path(root);
    let text = fs::read_to_string(&plan_file)
        .map_err(|_| "还没有检查到可用更新，请先点击「检查更新」".to_string())?;
    let projects: Vec<ProjectUpdate> =
        serde_json::from_str(&text).map_err(|e| format!("更新计划损坏（{e}），请重新检查更新"))?;

    // The plan holds git rows only; keep the filter anyway so a hand-edited or
    // stale plan can never route an npm plugin row through the detached git
    // launcher, which would reset a checkout instead of rewriting a pin.
    let mut selected: Vec<&ProjectUpdate> = projects
        .iter()
        .filter(|p| p.kind.is_none() && p.behind && p.error.is_none())
        .collect();
    if !ids.is_empty() {
        if ids.iter().any(|id| id.starts_with(NPM_ROW_PREFIX)) {
            return Err("npm 插件行请用行内「更新」（就地执行）".to_string());
        }
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
    spawn_update_script(root, ids, modes)?;
    Ok(())
}

/// In-dialog update of the top-level repository: fast-forward the root to its
/// update target, then recursively sync every submodule to the commits the
/// new root revision records (`git submodule update --init --recursive`) —
/// the same submodule handling the detached launcher applies to the root.
///
/// Runs while the shell stays up: no exit, no rebuild (the dialog reminds the
/// user to run `npm run build` afterwards). Progress is reported line by line
/// through `log`.
pub fn run_root_update(
    root: &Path,
    mode: &str,
    log: &mut dyn FnMut(&str),
) -> Result<(), String> {
    // Same realignment as the check: the recursive submodule sync below must
    // not fetch through an absolute path from a previous checkout location.
    let repaired = reconcile_submodule_remotes(root);
    if repaired > 0 {
        log(&format!(
            "已按 .gitmodules 修正 {repaired} 个子模块的过期本地路径远端"
        ));
    }
    log("fetch origin（顶层工程）");
    git_fetch(root)?;
    let branch = remote_default_branch(root)
        .ok_or_else(|| "无法确定远端默认分支".to_string())?;
    let (target, label) = if mode == "tag" {
        let tag = git_output(root, &["describe", "--tags", "--abbrev=0", &format!("origin/{branch}")])
            .ok_or_else(|| format!("origin/{branch} 上没有可用 tag"))?;
        (tag.clone(), format!("reset --hard 到最新 tag「{tag}」"))
    } else {
        let target = format!("origin/{branch}");
        let label = format!("reset --hard 到 {target}");
        (target, label)
    };
    log(&label);
    match run_git_captured(root, &["reset", "--hard", &target]) {
        Some(capture) if capture.success => {}
        Some(capture) => {
            let detail = git_error_summary(&capture);
            return Err(if detail.is_empty() {
                format!("git reset --hard {target} 失败（未知原因）")
            } else {
                format!("git reset --hard {target} 失败：{detail}")
            });
        }
        None => return Err("无法启动 git（PATH 或沙箱策略禁止创建进程）".to_string()),
    }
    log(&format!("顶层工程已更新到 {}", git_version(root, "HEAD")));
    log("递归同步子模块（git submodule update --init --recursive）…");
    match run_git_captured(root, &["submodule", "update", "--init", "--recursive"]) {
        Some(capture) if capture.success => {
            log("子模块已同步到顶层修订记录的提交（个别子模块若自身还有更新，仍会在列表中单独显示）");
        }
        Some(capture) => {
            let detail = git_error_summary(&capture);
            return Err(if detail.is_empty() {
                "子模块同步失败（未知原因）".to_string()
            } else {
                format!("子模块同步失败：{detail}")
            });
        }
        None => return Err("无法启动 git（PATH 或沙箱策略禁止创建进程）".to_string()),
    }
    Ok(())
}

/// A capture file being followed while the child writes to it: the byte offset
/// already forwarded and the partial line held back until its newline arrives.
struct CaptureTail {
    stdout_offset: usize,
    stderr_offset: usize,
    stdout_pending: Vec<u8>,
    stderr_pending: Vec<u8>,
}

impl CaptureTail {
    fn new() -> Self {
        CaptureTail {
            stdout_offset: 0,
            stderr_offset: 0,
            stdout_pending: Vec::new(),
            stderr_pending: Vec::new(),
        }
    }

    /// Forward every complete line appended since the last call.
    fn drain(&mut self, stdout_path: &Path, stderr_path: &Path, log: &mut dyn FnMut(&str)) {
        forward_capture_file(
            stdout_path,
            &mut self.stdout_offset,
            &mut self.stdout_pending,
            &mut *log,
        );
        forward_capture_file(
            stderr_path,
            &mut self.stderr_offset,
            &mut self.stderr_pending,
            &mut *log,
        );
    }

    /// Forward trailing output that never got a final newline (process exit).
    fn flush(&mut self, log: &mut dyn FnMut(&str)) {
        let pending: [&mut Vec<u8>; 2] = [&mut self.stdout_pending, &mut self.stderr_pending];
        for buffer in pending {
            flush_pending_line(buffer, &mut *log);
        }
    }
}

/// Read the bytes appended to `path` since `offset`, forward every complete
/// line, and keep the partial tail in `pending`.
fn forward_capture_file(
    path: &Path,
    offset: &mut usize,
    pending: &mut Vec<u8>,
    log: &mut dyn FnMut(&str),
) {
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    if bytes.len() <= *offset {
        return;
    }
    let chunk = &bytes[*offset..];
    *offset = bytes.len();
    pending.extend_from_slice(chunk);
    while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
        let line = String::from_utf8_lossy(&pending[..position])
            .trim_end_matches('\r')
            .to_string();
        pending.drain(..=position);
        if !line.trim().is_empty() {
            log(&line);
        }
    }
}

/// Forward the last partial line of a capture file, if any.
fn flush_pending_line(pending: &mut Vec<u8>, log: &mut dyn FnMut(&str)) {
    if pending.is_empty() {
        return;
    }
    let line = String::from_utf8_lossy(pending.as_slice())
        .trim_end_matches('\r')
        .to_string();
    pending.clear();
    if !line.trim().is_empty() {
        log(&line);
    }
}

/// Re-run one wrapper installer while streaming its output as log lines.
///
/// stdout/stderr are redirected to per-call files (dsh's Windows sandbox
/// rejects piped child stdio) and the files are tailed while the child runs, so
/// the dialog sees pnpm's and `dsh plugin add`'s progress line by line. The
/// profile is selected with `DSH_PLUGIN_PROFILE` (the shell serves the web
/// profile; an inherited value wins) and `DSH_PLUGIN_MIN_AGE=0` bypasses
/// pnpm's release-age gate for the freshly published version. Everything else —
/// including `DSH_HOME` — is inherited from the shell, so the reinstall lands in
/// the same home the shell serves. The child is killed after
/// [`NPM_INSTALL_TIMEOUT`]; the caller treats a timeout like any other failure
/// and rolls the install script back.
fn run_install_script_streaming(
    root: &Path,
    script: &Path,
    log: &mut dyn FnMut(&str),
) -> Result<(), String> {
    let id = CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let base = format!("dsh-gui-npm-install-{}-{id}", std::process::id());
    let stdout_path = std::env::temp_dir().join(format!("{base}.out"));
    let stderr_path = std::env::temp_dir().join(format!("{base}.err"));
    let stdout_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&stdout_path)
        .map_err(|e| format!("无法创建输出文件 {}：{e}", stdout_path.display()))?;
    let stderr_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&stderr_path)
        .map_err(|e| format!("无法创建输出文件 {}：{e}", stderr_path.display()))?;

    let profile = std::env::var("DSH_PLUGIN_PROFILE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "web".to_string());
    let mut command = crate::console::hidden_command("node");
    command
        .arg(script)
        .current_dir(root)
        .env("DSH_PLUGIN_PROFILE", &profile)
        .env("DSH_PLUGIN_MIN_AGE", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动安装脚本（node）：{e}"))?;

    let deadline = std::time::Instant::now() + NPM_INSTALL_TIMEOUT;
    let mut tail = CaptureTail::new();
    let mut status: Option<std::process::ExitStatus> = None;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(done)) => {
                status = Some(done);
                break;
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&stdout_path);
                let _ = fs::remove_file(&stderr_path);
                return Err(format!("等待安装脚本失败：{error}"));
            }
        }
        tail.drain(&stdout_path, &stderr_path, &mut *log);
        if std::time::Instant::now() >= deadline {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    // The child exited (or was killed): pick up whatever it wrote last.
    tail.drain(&stdout_path, &stderr_path, &mut *log);
    tail.flush(&mut *log);
    let _ = fs::remove_file(&stdout_path);
    let _ = fs::remove_file(&stderr_path);
    if timed_out {
        return Err(format!(
            "安装脚本超时（{} 秒）",
            NPM_INSTALL_TIMEOUT.as_secs()
        ));
    }
    let status = status.ok_or_else(|| "安装脚本未返回退出状态".to_string())?;
    if status.success() {
        Ok(())
    } else {
        match status.code() {
            Some(code) => Err(format!("安装脚本退出码 {code}")),
            None => Err("安装脚本被信号终止".to_string()),
        }
    }
}

/// Update one npm plugin row in place: rewrite the exact pin in its install
/// script, re-run that wrapper against the current profile, and roll the script
/// back when the reinstall fails.
///
/// The re-scanned row is authoritative (the script may have changed on disk
/// while the dialog was open). Only the target install script is written; the
/// caller serializes installs through the shell's update lock. No rebuild is
/// needed — the dialog reminds the user to restart dsh-gui so the harness boots
/// the reinstalled plugin.
pub fn run_npm_plugin_update(
    root: &Path,
    id: &str,
    log: &mut dyn FnMut(&str),
) -> Result<(), String> {
    let rows = plugin_npm_rows(root);
    let Some(row) = rows.into_iter().find(|row| row.id == id) else {
        return Err(format!(
            "安装脚本中已找不到插件「{}」，请重新检查更新",
            package_name_of_row_id(id)
        ));
    };
    log(&format!(
        "检查插件 {}（{}）的最新版本，当前 pin {}",
        row.package_name, row.wrapper_id, row.pinned_version
    ));
    let packages = vec![row.package_name.clone()];
    let answers = npm_latest_answers(root, &packages)?;
    let Some(answer) = answers.into_iter().next() else {
        return Err("npm registry 未返回版本信息".to_string());
    };
    if let Some(error) = answer.error {
        return Err(format!("npm 版本查询失败：{error}"));
    }
    let Some(latest) = answer.latest else {
        return Err("npm registry 未返回版本号".to_string());
    };
    if !is_newer(&latest, &row.pinned_version) {
        log(&format!("已是最新（{}）", row.pinned_version));
        return Ok(());
    }

    let script_path = root.join(&row.install_script);
    let original = fs::read_to_string(&script_path)
        .map_err(|e| format!("无法读取安装脚本 {}：{e}", row.install_script))?;
    let new_spec = format!("{}@{}", row.package_name, latest);
    let rewritten = replace_pinned_version(&original, &row.spec, &new_spec)?;
    if let Err(error) = fs::write(&script_path, &rewritten) {
        // The write may have clipped the file before failing; restore the pin
        // that matches what the profile currently has installed.
        let _ = fs::write(&script_path, &original);
        return Err(format!("无法写入安装脚本 {}：{error}", row.install_script));
    }
    log(&format!(
        "已把安装脚本 {} 的 pin 改为 {new_spec}",
        row.install_script
    ));

    if let Err(error) = run_install_script_streaming(root, &script_path, &mut *log) {
        let rollback = match fs::write(&script_path, &original) {
            Ok(()) => "已回滚安装脚本".to_string(),
            Err(rollback_error) => format!("安装脚本回滚失败：{rollback_error}"),
        };
        return Err(format!("{error}（{rollback}）"));
    }
    log(&format!("安装脚本已按 {new_spec} 重新安装"));
    log("重启 dsh-gui 后新版本插件生效；不需要重新构建");
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
            .any(|entry| entry.name == "deepseek-harness"
                && entry.path.ends_with("deepseek-harness")
                && entry.url == "https://github.com/deepseek-ai/deepseek-harness"));
        assert!(entries.iter().any(|entry| entry.name == "src-tauri/whale-icon"
            && entry.path.ends_with("whale-icon")));
        assert!(entries.iter().any(|entry| {
            entry.name == "global_template.agents/docs/awesome-design-md"
                && entry.path.ends_with("awesome-design-md")
                && entry.url == "https://github.com/VoltAgent/awesome-design-md"
        }));
    }

    #[test]
    fn local_path_and_remote_submodule_urls_are_distinguished() {
        for local in [
            "E:/Git/dsh-gui/deepseek-harness",
            "E:\\Git\\dsh-gui\\deepseek-harness",
            "e:/git/checkout/sub",
            "/home/me/checkout/sub",
            "\\\\server\\share\\sub",
            "../deepseek-harness",
            "./deepseek-harness",
            "file:///E:/Git/dsh-gui/sub",
        ] {
            assert!(
                is_local_path_url(local),
                "{local} must be treated as a local filesystem path"
            );
        }
        for remote in [
            "https://github.com/deepseek-ai/deepseek-harness",
            "http://example.com/x.git",
            "ssh://git@github.com/org/repo.git",
            "git://example.com/repo.git",
            "git@github.com:org/repo.git",
            "",
        ] {
            assert!(
                !is_local_path_url(remote),
                "{remote} must be treated as a remote, not a path"
            );
        }
    }

    /// A checkout that moved (or whose submodule URLs were resolved against a
    /// local origin) keeps the previous location in `.git/config` and in each
    /// submodule's `origin`. The check must fall back to `.gitmodules` instead
    /// of failing with "'<old path>' does not appear to be a git repository".
    #[test]
    fn stale_local_submodule_remotes_are_repointed_at_gitmodules() {
        let dir = std::env::temp_dir().join(format!("dsh-gui-sub-url-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("root");
        let stale = "E:/Git/dsh-gui/deepseek-harness";
        let manifest = "https://github.com/deepseek-ai/deepseek-harness";
        let mirror = "https://mirror.example.com/dsh-deep-whale.git";
        let manifest_mirror = "https://github.com/Small-tailqwq/dsh-deep-whale";
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(root.join("mirror")).unwrap();

        let git = |cwd: &Path, args: &[&str]| -> bool {
            let output = crate::console::hidden_command("git")
                .current_dir(cwd)
                .args(args)
                .output()
                .expect("git must run");
            if !output.status.success() {
                eprintln!(
                    "git {:?} in {} failed:\n{}",
                    args,
                    cwd.display(),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            output.status.success()
        };
        let git_ok = |cwd: &Path, args: &[&str]| {
            assert!(git(cwd, args), "git {args:?} failed in {}", cwd.display())
        };

        git_ok(&root, &["init", "-q", "-b", "main"]);
        git_ok(&root.join("sub"), &["init", "-q", "-b", "main"]);
        git_ok(&root.join("mirror"), &["init", "-q", "-b", "main"]);
        fs::write(
            root.join(".gitmodules"),
            format!(
                "[submodule \"sub\"]\n\tpath = sub\n\turl = {manifest}\n\
                 [submodule \"mirror\"]\n\tpath = mirror\n\turl = {manifest_mirror}\n"
            ),
        )
        .unwrap();

        // `sub`: the previous checkout location frozen into the override and
        // into the submodule's own origin.
        git_ok(&root, &["config", "submodule.sub.url", stale]);
        git_ok(&root.join("sub"), &["remote", "add", "origin", stale]);
        // `mirror`: a deliberate remote override must survive untouched.
        git_ok(&root, &["config", "submodule.mirror.url", mirror]);
        git_ok(&root.join("mirror"), &["remote", "add", "origin", mirror]);

        assert_eq!(
            reconcile_submodule_remotes(&root),
            2,
            "both the config override and the submodule origin must be repaired"
        );
        assert_eq!(
            git_output(&root, &["config", "--get", "submodule.sub.url"]).as_deref(),
            Some(manifest)
        );
        assert_eq!(
            git_output(&root.join("sub"), &["remote", "get-url", "origin"]).as_deref(),
            Some(manifest)
        );
        assert_eq!(
            git_output(&root, &["config", "--get", "submodule.mirror.url"]).as_deref(),
            Some(mirror),
            "a remote override is configuration, not drift"
        );
        assert_eq!(
            git_output(&root.join("mirror"), &["remote", "get-url", "origin"]).as_deref(),
            Some(mirror)
        );
        assert_eq!(
            reconcile_submodule_remotes(&root),
            0,
            "the repair must be idempotent"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A throwaway git repository with one `origin` remote: the tests below
    /// need a real `git remote get-url origin` answer, not a stub.
    fn temp_repo(name: &str, origin: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-gui-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let output = crate::console::hidden_command("git")
                .current_dir(&dir)
                .args(args)
                .output()
                .expect("git must run");
            assert!(
                output.status.success(),
                "git {args:?} failed in {}:\n{}",
                dir.display(),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["remote", "add", "origin", origin]);
        dir
    }

    /// Every update row links its module name to the repository's GitHub
    /// Releases **list**. The row's own `origin` wins — it is what an update
    /// actually fetches from — and `.gitmodules` is only the fallback for a
    /// submodule whose checkout is not initialized yet.
    #[test]
    fn module_name_links_resolve_to_the_github_releases_list() {
        let ssh = temp_repo("release-link-ssh", "git@github.com:ZgblKylin/dsh-gui.git");
        assert_eq!(
            release_page_for(&ssh, None).as_deref(),
            Some("https://github.com/ZgblKylin/dsh-gui/releases"),
            "an ssh origin must still resolve to the https releases list"
        );

        let gitlab = temp_repo("release-link-gitlab", "https://gitlab.com/x/y.git");
        assert_eq!(
            release_page_for(&gitlab, Some("https://github.com/omdsh-dev/dsh-gui")),
            None,
            "a non-GitHub origin must not borrow the manifest's link"
        );

        let missing = std::env::temp_dir().join(format!(
            "dsh-gui-release-link-missing-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&missing);
        assert_eq!(
            release_page_for(
                &missing,
                Some("https://github.com/zhu1090093659/dsh-web-ui.git")
            )
            .as_deref(),
            Some("https://github.com/zhu1090093659/dsh-web-ui/releases"),
            "an uninitialized submodule still links through .gitmodules"
        );
        assert_eq!(
            release_page_for(&missing, None),
            None,
            "no origin and no manifest entry stays plain text"
        );
        let _ = fs::remove_dir_all(&ssh);
        let _ = fs::remove_dir_all(&gitlab);
    }

    /// The cold-start preview row already carries the link (it resolves
    /// locally, without the network check), and the wire field is
    /// `releaseUrl` — the name `ui/app.js` reads. A row without a GitHub origin
    /// omits the field instead of sending `null`.
    #[test]
    fn project_rows_carry_the_release_page_as_camel_case() {
        let repo = temp_repo(
            "release-link-row",
            "https://github.com/zhu1090093659/dsh-web-ui.git",
        );
        let row = local_preview_project(&repo, "dsh-web-ui", "dsh-web-ui", &repo, None);
        let value = serde_json::to_value(&row).unwrap();
        assert_eq!(
            value["releaseUrl"],
            "https://github.com/zhu1090093659/dsh-web-ui/releases"
        );

        let plain = temp_repo("release-link-plain", "https://gitlab.com/x/y.git");
        let row = local_preview_project(&plain, "other", "other", &plain, None);
        let value = serde_json::to_value(&row).unwrap();
        assert!(
            value.get("releaseUrl").is_none(),
            "unexpected payload: {value}"
        );
        assert_eq!(row.release_url, None);
        let _ = fs::remove_dir_all(&repo);
        let _ = fs::remove_dir_all(&plain);
    }

    #[test]
    fn tag_staleness_is_ancestry_based() {
        let dir = std::env::temp_dir().join(format!("dsh-gui-tag-stale-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            crate::console::hidden_command("git")
                .current_dir(&dir)
                .args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run")
                .success()
        };
        assert!(git(&["init", "-q"]));
        assert!(git(&["config", "user.name", "test"]));
        assert!(git(&["config", "user.email", "test@example.com"]));
        // The test host may pin commit.gpgsign/tag.gpgsign globally; signing
        // is unavailable here (and irrelevant for ancestry checks).
        assert!(git(&["config", "commit.gpgsign", "false"]));
        assert!(git(&["config", "tag.gpgsign", "false"]));
        fs::write(dir.join("a.txt"), "a").unwrap();
        assert!(git(&["add", "a.txt"]));
        assert!(git(&["commit", "-q", "-m", "a"]));
        assert!(git(&["tag", "v1.0.0"]));
        fs::write(dir.join("a.txt"), "ab").unwrap();
        assert!(git(&["add", "a.txt"]));
        assert!(git(&["commit", "-q", "-m", "b"]));

        // Tag strictly before HEAD: stale (resetting would downgrade).
        assert!(tag_is_stale(&dir, "v1.0.0"));
        // HEAD itself: a reset to it is a no-op, so it is never a usable
        // update target either.
        assert!(tag_is_stale(&dir, "HEAD"));
        // Unknown tag: never stale (falls back to usable).
        assert!(!tag_is_stale(&dir, "v9.9.9"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn badge_skips_commit_only_updates_while_on_tag() {
        // Local sits exactly on tag v1.0.0 and the remote has ONLY new
        // commits beyond it (no newer tag): the row stays behind (dialog)
        // but is not announced by the badge.
        let dir = std::env::temp_dir().join(format!("dsh-gui-badge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = dir.join("root");
        let origin = dir.join("origin.git");
        let git = |cwd: &Path, args: &[&str]| -> bool {
            let output = crate::console::hidden_command("git")
                .current_dir(cwd)
                .args(args)
                .output()
                .expect("git must run");
            if !output.status.success() {
                eprintln!(
                    "git {:?} in {} failed:\n{}",
                    args,
                    cwd.display(),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            output.status.success()
        };
        let git_ok = |cwd: &Path, args: &[&str]| {
            assert!(git(cwd, args), "git {args:?} failed in {}", cwd.display())
        };
        let init_signed_off = |cwd: &Path| {
            git_ok(cwd, &["config", "user.name", "test"]);
            git_ok(cwd, &["config", "user.email", "test@example.com"]);
            git_ok(cwd, &["config", "commit.gpgsign", "false"]);
            git_ok(cwd, &["config", "tag.gpgsign", "false"]);
        };

        git_ok(&dir, &["init", "-q", "-b", "main", "root"]);
        init_signed_off(&root);
        fs::write(root.join("a.txt"), "a").unwrap();
        git_ok(&root, &["add", "a.txt"]);
        git_ok(&root, &["commit", "-q", "-m", "a"]);
        let tag_sha = git_output(&root, &["rev-parse", "HEAD"]).unwrap();
        git_ok(&root, &["tag", "v1.0.0", &tag_sha]);
        git_ok(&dir, &["init", "--bare", "-q", "origin.git"]);
        git_ok(&origin, &["symbolic-ref", "HEAD", "refs/heads/main"]);

        let check_row = |root: &Path| {
            let status = check(root);
            assert_eq!(status.projects.len(), 1);
            status.projects.into_iter().next().unwrap()
        };

        // Remote gains one untagged commit while local stays on the tag.
        fs::write(root.join("b.txt"), "b").unwrap();
        git_ok(&root, &["add", "b.txt"]);
        git_ok(&root, &["commit", "-q", "-m", "b"]);
        git_ok(
            &root,
            &["remote", "add", "origin", &origin.to_string_lossy()],
        );
        git_ok(&root, &["push", "-q", "origin", "main"]);
        let commit_sha = git_output(&root, &["rev-parse", "HEAD"]).unwrap();
        git_ok(&root, &["reset", "--hard", &tag_sha]);

        let project = check_row(&root);
        assert!(project.behind, "remote commits beyond the tag must show as behind");
        assert!(
            !project.announce,
            "on-tag checkout with only commit updates must not announce"
        );
        assert_eq!(project.latest_tag.as_deref(), Some("v1.0.0"));
        assert!(
            project.latest_tag_stale,
            "the tag at the current commit is not a usable target"
        );

        // Dropping the local tag moves the checkout off any tag: the same
        // update is announced again.
        git_ok(&root, &["tag", "-d", "v1.0.0"]);
        let project = check_row(&root);
        assert!(project.behind);
        assert!(project.announce, "not on a tag: commit-only update must announce");
        assert!(project.latest_tag.is_none());

        // A newer tag on the remote restores announcement even on a tag.
        git_ok(&root, &["tag", "v1.0.0", &tag_sha]);
        git_ok(&root, &["tag", "v2.0.0", &commit_sha]);
        git_ok(&root, &["push", "-q", "origin", "v2.0.0"]);
        let project = check_row(&root);
        assert!(project.behind);
        assert!(project.announce, "a newer release tag must announce");
        assert_eq!(project.latest_tag.as_deref(), Some("v2.0.0"));
        assert!(!project.latest_tag_stale);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn root_update_fast_forwards_and_syncs_submodules() {
        let dir = std::env::temp_dir().join(format!("dsh-gui-root-update-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = dir.join("root");
        let root_origin = dir.join("root-origin.git");
        let sub_work = dir.join("sub-work");
        let sub_origin = dir.join("sub-origin.git");

        let git = |cwd: &Path, args: &[&str]| -> bool {
            let output = crate::console::hidden_command("git")
                .current_dir(cwd)
                .args(args)
                .output()
                .expect("git must run");
            if !output.status.success() {
                eprintln!(
                    "git {:?} in {} failed:\n{}",
                    args,
                    cwd.display(),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            output.status.success()
        };
        let git_ok = |cwd: &Path, args: &[&str]| {
            assert!(git(cwd, args), "git {args:?} failed in {}", cwd.display())
        };
        let init_signed_off = |cwd: &Path| {
            git_ok(cwd, &["config", "user.name", "test"]);
            git_ok(cwd, &["config", "user.email", "test@example.com"]);
            git_ok(cwd, &["config", "commit.gpgsign", "false"]);
            git_ok(cwd, &["config", "tag.gpgsign", "false"]);
        };

        // A submodule repo with two commits pushed to its origin.
        git_ok(&dir, &["init", "--bare", "-q", "sub-origin.git"]);
        git_ok(
            &sub_origin,
            &["symbolic-ref", "HEAD", "refs/heads/main"],
        );
        git_ok(&dir, &["init", "-q", "-b", "main", "sub-work"]);
        init_signed_off(&sub_work);
        fs::write(sub_work.join("a.txt"), "a").unwrap();
        git_ok(&sub_work, &["add", "a.txt"]);
        git_ok(&sub_work, &["commit", "-q", "-m", "sub a"]);
        git_ok(
            &sub_work,
            &["remote", "add", "origin", &sub_origin.to_string_lossy()],
        );
        git_ok(&sub_work, &["push", "-q", "origin", "main"]);
        let sub_sha1 = git_output(&sub_work, &["rev-parse", "HEAD"]).unwrap();

        // Root repository that records the first submodule commit.
        git_ok(&dir, &["init", "-q", "-b", "main", "root"]);
        init_signed_off(&root);
        fs::write(root.join("root.txt"), "root").unwrap();
        git_ok(&root, &["add", "root.txt"]);
        git_ok(&root, &["commit", "-q", "-m", "root init"]);
        git_ok(
            &root,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                &sub_origin.to_string_lossy(),
                "sub",
            ],
        );
        git_ok(&root, &["commit", "-q", "-m", "add sub"]);
        git_ok(
            &root,
            &["remote", "add", "origin", &root_origin.to_string_lossy()],
        );
        let root_old = git_output(&root, &["rev-parse", "HEAD"]).unwrap();
        git_ok(&dir, &["init", "--bare", "-q", "root-origin.git"]);
        git_ok(
            &root_origin,
            &["symbolic-ref", "HEAD", "refs/heads/main"],
        );
        git_ok(&root, &["push", "-q", "origin", "main"]);

        // Later: the submodule advances, and the root advances recording the
        // OLD submodule commit.
        fs::write(sub_work.join("b.txt"), "b").unwrap();
        git_ok(&sub_work, &["add", "b.txt"]);
        git_ok(&sub_work, &["commit", "-q", "-m", "sub b"]);
        git_ok(&sub_work, &["push", "-q", "origin", "main"]);
        let sub_sha2 = git_output(&sub_work, &["rev-parse", "HEAD"]).unwrap();
        fs::write(root.join("root2.txt"), "root2").unwrap();
        git_ok(&root, &["add", "root2.txt"]);
        git_ok(&root, &["commit", "-q", "-m", "root new"]);
        git_ok(&root, &["push", "-q", "origin", "main"]);
        let root_new = git_output(&root, &["rev-parse", "HEAD"]).unwrap();

        // Simulate an outdated checkout: root at the old commit, the submodule
        // worktree moved ahead of what the old root revision records.
        git_ok(&root, &["reset", "--hard", &root_old]);
        git_ok(&root.join("sub"), &["fetch", "-q", "origin"]);
        git_ok(&root.join("sub"), &["checkout", "-q", &sub_sha2]);

        let mut lines: Vec<String> = Vec::new();
        run_root_update(&root, "commit", &mut |line| lines.push(line.to_string()))
            .expect("root update must succeed");
        assert_eq!(
            git_output(&root, &["rev-parse", "HEAD"]).unwrap(),
            root_new,
            "root must fast-forward to the remote default branch"
        );
        assert_eq!(
            git_output(&root.join("sub"), &["rev-parse", "HEAD"]).unwrap(),
            sub_sha1,
            "submodule must sync back to the commit the new root revision records"
        );
        assert!(
            lines.iter().any(|line| line.contains("子模块已同步")),
            "progress must report the recursive submodule sync"
        );

        // A tag-target run on the same repo: tags on the remote branch land at
        // the latest tagged commit (here: root_new).
        git_ok(&root, &["tag", "v1.0.0", &root_new]);
        git_ok(&root, &["push", "-q", "origin", "v1.0.0"]);
        git_ok(&root, &["reset", "--hard", &root_old]);
        run_root_update(&root, "tag", &mut |_| {}).expect("tag update must succeed");
        assert_eq!(
            git_output(&root, &["rev-parse", "HEAD"]).unwrap(),
            root_new,
            "tag mode must settle at the newest tag on the remote branch"
        );

        let _ = fs::remove_dir_all(&dir);
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
    fn windows_console_launcher_carries_selected_ids_and_modes() {
        let temp =
            std::env::temp_dir().join(format!("dsh-gui-console-test-{}", std::process::id()));
        let script = write_update_script(&temp, 4242, 4343).expect("script generation must work");
        let ids = vec!["deepseek-harness".to_string(), "dsh-review".to_string()];
        let modes = HashMap::from([
            ("deepseek-harness".to_string(), "tag".to_string()),
            ("dsh-review".to_string(), "commit".to_string()),
        ]);
        let launcher = write_windows_console_launcher(&temp, &ids, &modes, &script)
            .expect("ps1 generation must work");
        let content = fs::read_to_string(&launcher).expect("ps1 must be readable");
        assert!(content.contains("& node"));
        assert!(content.contains("--ids 'deepseek-harness,dsh-review'"));
        assert!(content.contains("--modes 'deepseek-harness=tag,dsh-review=commit'"));
        let _ = fs::remove_dir_all(temp.join(".dsh"));
    }

    #[test]
    fn generated_launcher_replaces_all_placeholders() {
        let temp = std::env::temp_dir().join(format!("dsh-gui-update-test-{}", std::process::id()));
        let script = write_update_script(&temp, 4242, 4343).expect("script generation must work");
        let content = fs::read_to_string(&script).expect("generated script must be readable");
        assert!(!content.contains("__ROOT__"));
        assert!(!content.contains("__RUNTIME_ROOT__"));
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

    #[test]
    fn npm_registry_parsing_marks_missing_and_complete() {
        let packages = vec![
            "@linxin666/dsh-liangshen".to_string(),
            "@linxin666/dsh-pet".to_string(),
        ];
        let missing_json = r#"[
            {"name":"@linxin666/dsh-liangshen","latest":"0.3.6","hasTarget":false},
            {"name":"@linxin666/dsh-pet","latest":"0.3.6","hasTarget":false}
        ]"#;
        let info = parse_npm_results(missing_json, &packages);
        assert!(!info.complete);
        assert_eq!(info.missing, packages);
        assert_eq!(
            info.latest
                .get("@linxin666/dsh-liangshen")
                .map(String::as_str),
            Some("0.3.6")
        );
        assert!(info.error.is_none());

        let complete_json = r#"[
            {"name":"@linxin666/dsh-liangshen","latest":"0.3.8","hasTarget":true},
            {"name":"@linxin666/dsh-pet","latest":"0.3.8","hasTarget":true}
        ]"#;
        let info = parse_npm_results(complete_json, &packages);
        assert!(info.complete);
        assert!(info.missing.is_empty());
        assert_eq!(
            info.latest.get("@linxin666/dsh-pet").map(String::as_str),
            Some("0.3.8")
        );
    }

    #[test]
    fn embedded_npm_script_never_calls_process_exit() {
        // Same Windows libuv guard as the release-fetch script (see
        // changelog.rs): flush the array and let the event loop drain.
        assert!(!NPM_FETCH_SCRIPT.contains("process.exit"));
        assert!(NPM_FETCH_SCRIPT.contains("writeSync(1"));
    }

    #[test]
    fn npm_answer_is_used_even_when_the_child_aborted() {
        // A complete array on stdout is authoritative; a crash after flushing it
        // (the Windows libuv teardown assertion) must not turn the whole npm
        // check into an error row.
        assert!(emitted_npm_json(r#"[{"name":"x","latest":"1.0.0","hasTarget":true}]"#));
        assert!(!emitted_npm_json(""));
        assert!(!emitted_npm_json("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"));
        assert!(!emitted_npm_json(r#"[{"name":"x","latest":"#));
        assert!(!emitted_npm_json(r#"{"name":"x"}"#));
    }

    #[test]
    fn npm_packages_intersect_install_registry() {
        let dir = std::env::temp_dir().join(format!("dsh-gui-npm-check-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = dir.join("root");
        let sub = root
            .join("plugins")
            .join("dsh-web-ui")
            .join("dsh-web-ui");
        fs::create_dir_all(sub.join("packages").join("dsh-pet")).unwrap();
        fs::write(
            sub.join("package.json"),
            r#"{"name":"dsh-web","version":"0.1.1"}"#,
        )
        .unwrap();
        fs::write(
            sub.join("packages")
                .join("dsh-pet")
                .join("package.json"),
            r#"{"name":"@linxin666/dsh-pet","version":"0.3.8"}"#,
        )
        .unwrap();
        let registry_dir = crate::roots::dsh_home(&root).join("gui");
        fs::create_dir_all(&registry_dir).unwrap();
        fs::write(
            registry_dir.join(NPM_INSTALLS_FILE),
            r#"["@linxin666/dsh-pet","not-installed-here"]"#,
        )
        .unwrap();

        let names = npm_packages_for_project(&root, &sub);
        assert_eq!(names, vec!["@linxin666/dsh-pet"]);
        assert!(submodule_package_names(&sub).contains(&"dsh-web".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A minimal row for the pure row-model tests.
    fn project_row(id: &str, kind: Option<&str>, error: Option<&str>) -> ProjectUpdate {
        ProjectUpdate {
            id: id.to_string(),
            name: id.to_string(),
            path: String::new(),
            current: "unknown".to_string(),
            latest: "—".to_string(),
            latest_tag: None,
            latest_tag_stale: false,
            announce: true,
            behind: false,
            checking: false,
            error: error.map(str::to_string),
            npm: None,
            release_url: None,
            kind: kind.map(str::to_string),
            package_name: None,
            install_script: None,
        }
    }

    fn plugin_row(package_name: &str, pinned_version: &str) -> PluginNpmRow {
        PluginNpmRow {
            id: format!("npm:{package_name}"),
            package_name: package_name.to_string(),
            install_script: format!("plugins/{package_name}/install.mjs"),
            wrapper_id: package_name.to_string(),
            pinned_version: pinned_version.to_string(),
            spec: format!("{package_name}@{pinned_version}"),
        }
    }

    #[test]
    fn versions_compare_by_semver_precedence() {
        assert_eq!(
            compare_versions("1.2.3", "1.2.3"),
            Some(std::cmp::Ordering::Equal)
        );
        assert_eq!(
            compare_versions("1.2.4", "1.2.3"),
            Some(std::cmp::Ordering::Greater)
        );
        assert_eq!(
            compare_versions("1.3.0", "1.2.9"),
            Some(std::cmp::Ordering::Greater)
        );
        assert_eq!(
            compare_versions("2.0.0", "1.99.99"),
            Some(std::cmp::Ordering::Greater)
        );
        // A leading `v` is tolerated (git tags carry one) and build metadata is
        // ignored, as semver prescribes for precedence.
        assert_eq!(
            compare_versions("v1.2.3", "1.2.3"),
            Some(std::cmp::Ordering::Equal)
        );
        assert_eq!(
            compare_versions("1.2.3+build.5", "1.2.3"),
            Some(std::cmp::Ordering::Equal)
        );
        // A release outranks every prerelease of the same core.
        assert_eq!(
            compare_versions("1.0.0", "1.0.0-rc.1"),
            Some(std::cmp::Ordering::Greater)
        );
        assert_eq!(
            compare_versions("1.0.0-rc.1", "1.0.0"),
            Some(std::cmp::Ordering::Less)
        );
        assert_eq!(
            compare_versions("1.0.0-alpha.2", "1.0.0-alpha.1"),
            Some(std::cmp::Ordering::Greater)
        );
        // Numeric identifiers rank below alphanumeric ones.
        assert_eq!(
            compare_versions("1.0.0-1", "1.0.0-alpha"),
            Some(std::cmp::Ordering::Less)
        );
        // A shorter identifier list with the same prefix ranks lower.
        assert_eq!(
            compare_versions("1.0.0-alpha", "1.0.0-alpha.1"),
            Some(std::cmp::Ordering::Less)
        );
        // Unparseable versions are not comparable rather than equal.
        assert_eq!(compare_versions("latest", "1.0.0"), None);
        assert_eq!(compare_versions("1.2", "1.2.3"), None);
        assert_eq!(compare_versions("1.2.3.4", "1.2.3"), None);
        assert_eq!(compare_versions("", ""), None);
    }

    #[test]
    fn only_comparable_greater_versions_count_as_an_update() {
        assert!(is_newer("0.8.0", "0.7.0"));
        assert!(is_newer("1.0.0", "1.0.0-rc.1"));
        assert!(!is_newer("0.7.0", "0.7.0"));
        assert!(!is_newer("0.6.0", "0.7.0"));
        // A malformed registry answer must never make the row claim an update.
        assert!(!is_newer("not-a-version", "0.7.0"));
        assert!(!is_newer("0.8.0", ""));
    }

    #[test]
    fn npm_repository_urls_resolve_to_the_releases_list() {
        let expected = Some("https://github.com/owner/repo/releases");
        for (repository, want) in [
            ("git+https://github.com/owner/repo.git", expected),
            ("https://github.com/owner/repo", expected),
            ("http://github.com/owner/repo/", expected),
            ("ssh://git@github.com/owner/repo.git", expected),
            ("git@github.com:owner/repo.git", expected),
            ("git://github.com/owner/repo.git", expected),
            ("https://gitlab.com/owner/repo", None),
            ("git+ssh://git@gitlab.com/owner/repo.git", None),
            ("", None),
        ] {
            assert_eq!(
                github_releases_url(Some(repository)).as_deref(),
                want,
                "repository URL: {repository}"
            );
        }
        assert_eq!(github_releases_url(None), None);
    }

    #[test]
    fn pinned_specs_are_rewritten_everywhere_and_verified() {
        let source = "const SPEC = 'pkg@1.2.3'\n// pin: pkg@1.2.3\ninstallNpmPlugin({ packageSpec: 'pkg@1.2.3' })\n";
        let updated =
            replace_pinned_version(source, "pkg@1.2.3", "pkg@1.2.4").expect("rewrite must work");
        assert_eq!(updated.matches("pkg@1.2.4").count(), 3);
        assert!(!updated.contains("pkg@1.2.3"));
        // A pin that is no longer in the script means the file changed under
        // the dialog: the rewrite must refuse instead of landing half updated.
        assert!(replace_pinned_version(source, "pkg@9.9.9", "pkg@1.2.4").is_err());
        assert!(replace_pinned_version(source, "", "pkg@1.2.4").is_err());
        assert!(replace_pinned_version(source, "pkg@1.2.3", "").is_err());
    }

    #[test]
    fn plugin_specs_are_extracted_from_install_scripts() {
        let source = r#"
import { installNpmPlugin } from '../../scripts/plugin-install.mjs'
// installNpmPlugin({ packageSpec: 'commented-out@9.9.9' })
// see https://example.com/pkg@9.9.9
/* installNpmPlugin({ packageSpec: '@scope/block-comment@8.8.8' }) */
const PACKAGE_SPEC = 'dsh-pet@0.3.8'
const SKIN_SPECS = [
  "@smalltailqwq/dsh-skin@0.1.8",
  '@scope/multi-part-name@1.2.3-rc.1',
]
installNpmPlugin({ id: 'x', packageSpec: PACKAGE_SPEC })
installNpmPlugin({ id: 'x-again', packageSpec: 'dsh-pet@0.3.8' })
installNpmPlugin({ id: 'official', packageSpec: '@deepseek-ai/dsh-browser-use@0.2.2-alpha.2' })
installNpmPlugin({ id: 'url', packageSpec: 'pkg@1.2.3', source: 'https://example.com/pkg' })
const range = 'pkg@^1.2.3'
const two = 'pkg@1.2'
const latest = 'pkg@latest'
const buildMetadata = 'pkg@1.2.3+build.5'
"#;
        let specs = extract_pinned_specs(source);
        let packages: Vec<&str> = specs
            .iter()
            .map(|spec| spec.package_name.as_str())
            .collect();
        assert_eq!(
            packages,
            vec!["dsh-pet", "@smalltailqwq/dsh-skin", "@scope/multi-part-name", "pkg"],
            "comments, official packages, ranges and duplicates must be filtered"
        );
        assert_eq!(specs[0].pinned_version, "0.3.8");
        assert_eq!(specs[0].spec, "dsh-pet@0.3.8");
        assert_eq!(specs[2].pinned_version, "1.2.3-rc.1");
    }

    #[test]
    fn plugin_rows_scan_the_plugins_tree_in_stable_order() {
        let dir = std::env::temp_dir().join(format!("dsh-gui-plugin-rows-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let plugins = dir.join("plugins");
        fs::create_dir_all(plugins.join("alpha").join("node_modules").join("skip")).unwrap();
        fs::create_dir_all(plugins.join(".hidden")).unwrap();
        fs::create_dir_all(plugins.join("beta")).unwrap();
        fs::write(
            plugins.join("alpha").join("install.mjs"),
            "import { installNpmPlugin } from '../../scripts/plugin-install.mjs'\ninstallNpmPlugin({ packageSpec: 'dsh-alpha@1.0.0' })\n",
        )
        .unwrap();
        fs::write(
            plugins.join("beta").join("install.mjs"),
            "// comments only: no installed package\n",
        )
        .unwrap();
        fs::write(
            plugins.join("beta").join("nested.mjs"),
            "installNpmPlugin({ packageSpec: 'dsh-beta@2.0.0' })\ninstallNpmPlugin({ packageSpec: 'dsh-alpha@3.0.0' })\n",
        )
        .unwrap();
        fs::write(
            plugins.join("beta").join("not-a-script.mjs"),
            "export const marker = 'installNpmPlugin('\n",
        )
        .unwrap();
        fs::write(
            plugins.join(".hidden").join("install.mjs"),
            "installNpmPlugin({ packageSpec: 'dsh-hidden@1.0.0' })\n",
        )
        .unwrap();
        fs::write(
            plugins
                .join("alpha")
                .join("node_modules")
                .join("skip")
                .join("install.mjs"),
            "installNpmPlugin({ packageSpec: 'dsh-vendored@1.0.0' })\n",
        )
        .unwrap();

        let rows = plugin_npm_rows(&dir);
        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["npm:dsh-alpha", "npm:dsh-alpha", "npm:dsh-beta"],
            "rows must skip dot/vendored files and sort by script, then package"
        );
        assert_eq!(rows[0].install_script, "plugins/alpha/install.mjs");
        assert_eq!(rows[0].wrapper_id, "alpha");
        assert_eq!(rows[1].install_script, "plugins/beta/nested.mjs");
        assert_eq!(rows[1].wrapper_id, "beta");
        assert_eq!(rows[2].install_script, "plugins/beta/nested.mjs");
        assert_eq!(rows[1].pinned_version, "3.0.0");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn latest_registry_answers_are_mapped_per_package() {
        let packages = vec![
            "dsh-a".to_string(),
            "@scope/b".to_string(),
            "dsh-missing".to_string(),
        ];
        let body = r#"[
            {"name":"dsh-a","version":"0.2.0","repository":"git+https://github.com/x/dsh-a.git"},
            {"name":"@scope/b","version":"1.0.0","repository":{"url":"https://github.com/y/dsh-b"}}
        ]"#;
        let answers = parse_latest_results(body, &packages);
        assert_eq!(answers.len(), 3);
        assert_eq!(answers[0].latest.as_deref(), Some("0.2.0"));
        assert_eq!(
            answers[0].repository_url.as_deref(),
            Some("git+https://github.com/x/dsh-a.git")
        );
        assert!(answers[0].error.is_none());
        assert_eq!(answers[1].latest.as_deref(), Some("1.0.0"));
        assert_eq!(
            answers[1].repository_url.as_deref(),
            Some("https://github.com/y/dsh-b")
        );
        assert!(
            answers[2].error.is_some(),
            "a package missing from the answer must carry an error"
        );

        let failed = parse_latest_results(r#"[{"name":"dsh-a","error":"HTTP 404"}]"#, &packages[..1]);
        assert_eq!(failed[0].error.as_deref(), Some("HTTP 404"));
        assert!(failed[0].latest.is_none());

        let bad = parse_latest_results("not json", &packages[..1]);
        assert_eq!(
            bad[0].error.as_deref(),
            Some("无法解析 npm registry 响应")
        );

        let empty_version =
            parse_latest_results(r#"[{"name":"dsh-a","version":"  "}]"#, &packages[..1]);
        assert!(empty_version[0].latest.is_none());
        assert!(empty_version[0].error.is_none());
    }

    #[test]
    fn embedded_latest_script_uses_the_full_manifest_accept_type() {
        // The `/<pkg>/latest` endpoint rejects the abbreviated install accept
        // type with HTTP 406; the full manifest is also the only document that
        // carries `repository`. Same Windows libuv guard as the publish script.
        assert!(!NPM_LATEST_FETCH_SCRIPT.contains("process.exit"));
        assert!(NPM_LATEST_FETCH_SCRIPT.contains("writeSync(1"));
        assert!(NPM_LATEST_FETCH_SCRIPT.contains("accept: 'application/json'"));
        assert!(NPM_LATEST_FETCH_SCRIPT.contains("'/latest'"));
        assert!(NPM_LATEST_FETCH_SCRIPT.contains("user-agent"));
    }

    #[test]
    fn npm_rows_carry_their_wire_fields() {
        let row = plugin_row("dsh-pet", "0.3.8");
        let value = serde_json::to_value(local_npm_preview(&row)).unwrap();
        assert_eq!(value["kind"], "npm");
        assert_eq!(value["packageName"], "dsh-pet");
        assert_eq!(value["installScript"], "plugins/dsh-pet/install.mjs");
        assert_eq!(value["path"], "plugins/dsh-pet/install.mjs");
        assert_eq!(value["current"], "0.3.8");
        assert_eq!(value["checking"], true);
        assert!(value.get("latestTag").is_none());

        let checked = checked_npm_row(
            &row,
            &PackageLatest {
                latest: Some("0.4.0".to_string()),
                repository_url: Some("git+https://github.com/x/dsh-pet.git".to_string()),
                error: None,
            },
        );
        assert!(checked.behind);
        assert!(checked.announce);
        assert_eq!(checked.latest, "0.4.0");
        assert_eq!(
            checked.release_url.as_deref(),
            Some("https://github.com/x/dsh-pet/releases")
        );
        let value = serde_json::to_value(&checked).unwrap();
        assert_eq!(value["behind"], true);
        assert_eq!(value["announce"], true);
        assert_eq!(
            value["releaseUrl"],
            "https://github.com/x/dsh-pet/releases"
        );

        let failed = checked_npm_row(
            &row,
            &PackageLatest {
                latest: None,
                repository_url: None,
                error: Some("HTTP 404".to_string()),
            },
        );
        assert!(!failed.behind);
        assert!(!failed.announce);
        assert_eq!(failed.latest, "—");
        assert_eq!(
            failed.error.as_deref(),
            Some("npm 版本查询失败：HTTP 404")
        );
    }

    #[test]
    fn npm_rows_do_not_carry_git_row_fields() {
        let git_row = project_row("dsh-gui", None, None);
        let value = serde_json::to_value(&git_row).unwrap();
        assert!(value.get("kind").is_none(), "unexpected payload: {value}");
        assert!(value.get("packageName").is_none());
        assert!(value.get("installScript").is_none());
    }

    #[test]
    fn all_checked_ignores_npm_row_errors() {
        // A failed git row still means the check did not complete...
        assert!(!all_git_rows_checked(&[project_row(
            "dsh-gui",
            None,
            Some("git fetch 失败")
        )]));
        // ...while an npm row's registry failure is carried on that row only.
        assert!(all_git_rows_checked(&[
            project_row("dsh-gui", None, None),
            project_row(
                "npm:dsh-pet",
                Some("npm"),
                Some("npm 版本查询失败：HTTP 500")
            ),
        ]));
    }

    /// The real repository's wrappers must all be recognized: every npm
    /// wrapper in the checkout produces rows, and no official
    /// `@deepseek-ai/dsh*` package becomes one (it moves with the harness row).
    #[test]
    fn scans_this_repo_plugin_wrappers() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = manifest
            .parent()
            .expect("src-tauri must live under the repo root");
        let rows = plugin_npm_rows(root);
        assert!(!rows.is_empty(), "the checkout ships npm plugin wrappers");
        for row in &rows {
            assert!(
                row.install_script.starts_with("plugins/"),
                "unexpected install script: {}",
                row.install_script
            );
            assert!(
                !row.package_name.starts_with(OFFICIAL_PACKAGE_PREFIX),
                "an official package must not become a row: {}",
                row.package_name
            );
            assert_eq!(row.id, format!("npm:{}", row.package_name));
            assert!(
                row.spec.starts_with(&row.package_name),
                "spec `{}` does not start with the package name",
                row.spec
            );
        }
    }

    #[test]
    fn npm_update_of_an_unknown_row_is_a_readable_error() {
        let missing = std::env::temp_dir().join(format!("dsh-gui-no-plugins-{}", std::process::id()));
        let mut lines: Vec<String> = Vec::new();
        let error = run_npm_plugin_update(&missing, "npm:dsh-pet", &mut |line| {
            lines.push(line.to_string())
        })
        .expect_err("a root without plugins/ must not resolve the row");
        assert!(
            error.contains("安装脚本中已找不到插件「dsh-pet」"),
            "unexpected error: {error}"
        );
        assert!(lines.is_empty());
    }
}
