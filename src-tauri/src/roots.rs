//! Repository and runtime root discovery.
//!
//! The repository root holds `harness.json`, the `deepseek-harness` submodule and
//! the build sources. The runtime root holds `.dsh`, `.harness`, `.toolchain`,
//! `.pnpm-store` and the entry exe: the nested layout keeps the runtime outside
//! the DSH workspace, whose Windows sandbox labels the workspace tree with a Low
//! integrity label.
//!
//! Both roots resolve from the running executable, and both accept an explicit
//! environment override.

use std::path::{Path, PathBuf};

use crate::harness;

/// Directory holding the checkout when the exe runs from the runtime root.
pub(crate) const NESTED_CHECKOUT_DIR: &str = "dsh-gui";

/// Whether `dir` is a dsh-gui checkout: it carries the runtime manifest or the
/// `deepseek-harness` submodule, and it carries `src-tauri/tauri.conf.json`.
fn is_repository_root(dir: &Path) -> bool {
    let runtime_marker = dir.join(harness::CONFIG_FILE).is_file()
        || dir
            .join(harness::SUBMODULE_DIR)
            .join("package.json")
            .is_file();
    runtime_marker && dir.join("src-tauri").join("tauri.conf.json").is_file()
}

/// Read a non-empty environment variable as a path.
fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Resolve the repository root: `DSH_GUI_ROOT` when set, otherwise walk up from
/// the executable until a checkout is found, and otherwise the `dsh-gui/` child
/// of the executable's directory.
///
/// The exe sits in `src-tauri/target/<profile>/`, at the repository root itself,
/// or at the runtime root beside the checkout; the last candidate covers the
/// nested layout.
pub(crate) fn repo_root() -> Result<PathBuf, String> {
    if let Some(value) = env_path("DSH_GUI_ROOT") {
        return Ok(value);
    }
    let exe = std::env::current_exe()
        .map_err(|e| format!("could not resolve the executable path: {e}"))?;
    let mut dir = exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("executable has no parent directory: {exe:?}"))?;
    let nested = dir.join(NESTED_CHECKOUT_DIR);
    for _ in 0..8 {
        if is_repository_root(&dir) {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    if is_repository_root(&nested) {
        return Ok(nested);
    }
    Err(format!(
        "could not locate the repository root from {exe:?}; set DSH_GUI_ROOT, or place the checkout in a \
         {NESTED_CHECKOUT_DIR}/ child of the executable's directory"
    ))
}

/// Resolve the runtime root that holds `.dsh`, `.harness`, `.toolchain`,
/// `.pnpm-store`, `.staging` and the entry exe: `DSH_GUI_RUNTIME_ROOT` when set,
/// otherwise the repository's parent when the checkout is named `dsh-gui` or
/// that parent already carries `.dsh` or `.harness`, and otherwise the
/// repository root itself.
pub(crate) fn runtime_root(repo: &Path) -> PathBuf {
    if let Some(value) = env_path("DSH_GUI_RUNTIME_ROOT") {
        return value;
    }
    let nested = repo
        .file_name()
        .is_some_and(|name| name == NESTED_CHECKOUT_DIR);
    match repo.parent() {
        Some(parent)
            if parent != repo
                && (nested
                    || parent.join(".dsh").is_dir()
                    || parent.join(".harness").is_dir()) =>
        {
            parent.to_path_buf()
        }
        _ => repo.to_path_buf(),
    }
}

/// The DSH home, `<runtime root>/.dsh`.
pub(crate) fn dsh_home(repo: &Path) -> PathBuf {
    runtime_root(repo).join(".dsh")
}

/// WebView2 user-data folder shared by every webview the shell creates.
///
/// Kept next to `.dsh/gui/gui.log` instead of the per-user
/// `%LOCALAPPDATA%\<identifier>\EBWebView` default. When that default profile is
/// unusable — locked, corrupt, or otherwise rejected by WebView2 —
/// `CreateCoreWebView2EnvironmentWithOptions` fails, tauri-runtime-wry swallows
/// the error, and startup dies as the opaque `HandleError::Unavailable` panic
/// (see `logging`). A runtime-local folder is trivially resettable by deleting
/// `.dsh/gui/webview2`, and works under restricted execution where the per-user
/// AppData profile may be unavailable.
pub(crate) fn webview_data_dir(repo: &Path) -> PathBuf {
    dsh_home(repo).join("gui").join("webview2")
}
