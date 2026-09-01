//! About-dialog data: version, license, and repository link for the shell
//! itself, the harness submodule, the app-icon submodule (`src-tauri/whale-icon`),
//! and every plugin package under `plugins/`.
//!
//! Version display follows one rule everywhere: the exact tag of `HEAD` when
//! one exists, otherwise the short commit hash. Repo links come from each
//! repository's `origin` remote, normalized to an https GitHub URL.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One row of the About dialog.
#[derive(Serialize, Clone)]
pub struct AboutItem {
    pub name: String,
    pub version: String,
    pub license: String,
    pub repo: String,
}

/// Everything the About dialog renders.
#[derive(Serialize, Clone)]
pub struct AboutInfo {
    pub shell: AboutItem,
    pub harness: AboutItem,
    pub icon: AboutItem,
    pub plugins: Vec<AboutItem>,
}

/// In-process cache: the About rows change only when a checkout moves, so a
/// short TTL avoids re-running `git describe` for every dialog open while
/// still picking up updates within minutes.
static ABOUT_CACHE: Mutex<Option<(Instant, AboutInfo)>> = Mutex::new(None);
const ABOUT_CACHE_TTL: Duration = Duration::from_secs(300);

/// Collect the About rows, served from the in-process cache when fresh.
pub fn collect(root: &Path) -> AboutInfo {
    if let Ok(guard) = ABOUT_CACHE.lock() {
        if let Some((at, info)) = guard.as_ref() {
            if at.elapsed() < ABOUT_CACHE_TTL {
                return info.clone();
            }
        }
    }
    let info = collect_fresh(root);
    if let Ok(mut guard) = ABOUT_CACHE.lock() {
        *guard = Some((Instant::now(), info.clone()));
    }
    info
}

/// Run `git <args>` in `dir`, returning trimmed stdout on success.
///
/// On Windows the git console app is spawned with CREATE_NO_WINDOW so a
/// dialog-fetch never flashes a console window next to the frameless shell.
fn git_output(dir: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// The exact tag of `HEAD` when one exists, else the short commit hash.
fn git_version(dir: &Path) -> Option<String> {
    git_output(dir, &["describe", "--tags", "--exact-match", "HEAD"])
        .or_else(|| git_output(dir, &["rev-parse", "--short", "HEAD"]))
}

/// Normalize an `origin` remote URL to an https GitHub link; other hosts or
/// missing remotes yield `None` (the dialog then shows no link).
fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let https = if let Some(rest) = url.strip_prefix("git@github.com:") {
        format!("https://github.com/{rest}")
    } else if url.starts_with("https://github.com/") || url.starts_with("http://github.com/") {
        url.to_string()
    } else {
        return None;
    };
    Some(https.strip_suffix(".git").unwrap_or(&https).to_string())
}

/// The repository link for `dir`, from its `origin` remote.
fn repo_url(dir: &Path) -> String {
    git_output(dir, &["remote", "get-url", "origin"])
        .and_then(|url| normalize_remote(&url))
        .unwrap_or_default()
}

/// Best-effort license name: the package.json `license` field first, then the
/// LICENSE file (Unlicense preamble and MIT header are recognized by text).
fn license_name(dir: &Path) -> String {
    if let Ok(manifest) = std::fs::read_to_string(dir.join("package.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&manifest) {
            if let Some(license) = value.get("license").and_then(|l| l.as_str()) {
                if !license.is_empty() {
                    return license.to_string();
                }
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(dir.join("LICENSE")) {
        let text = text.trim_start();
        if text.starts_with("MIT License") {
            return "MIT License".to_string();
        }
        if text.contains("unencumbered") {
            return "The Unlicense".to_string();
        }
        if let Some(first) = text.lines().next() {
            let first = first.trim();
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    "Unknown".to_string()
}

/// The package.json `name` of `dir`, when present.
pub(crate) fn package_name(dir: &Path) -> Option<String> {
    let manifest = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&manifest).ok()?;
    value
        .get("name")
        .and_then(|n| n.as_str())
        .map(str::to_string)
}

/// One About row for the repository at `dir`.
fn item(dir: &Path, fallback_name: &str) -> AboutItem {
    AboutItem {
        name: package_name(dir).unwrap_or_else(|| fallback_name.to_string()),
        version: git_version(dir).unwrap_or_else(|| "unknown".to_string()),
        license: license_name(dir),
        repo: repo_url(dir),
    }
}

/// Collect the About rows for the shell, the harness submodule, the app-icon
/// submodule, and every plugin package. The preset-style `plugins/` layout has
/// one wrapper directory per plugin (`plugins/<id>/install.mjs`) holding the
/// package/repo in a second-level directory; multi-package distribution repos
/// (e.g. `deep-whale/dsh-deep-whale`) hold their package one level deeper.
fn collect_fresh(root: &Path) -> AboutInfo {
    let shell = item(root, "dsh-gui");
    let harness = item(&root.join("deepseek-harness"), "deepseek-harness");
    let icon = item(
        &root.join("src-tauri").join("whale-icon"),
        "whale-girl-icon",
    );
    let mut plugins = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root.join("plugins")) {
        for entry in entries.flatten() {
            let path: PathBuf = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Ok(children) = std::fs::read_dir(&path) {
                for child in children.flatten() {
                    let child_path = child.path();
                    if !child_path.is_dir() {
                        continue;
                    }
                    if child_path.join("package.json").is_file() {
                        plugins.push(item(&child_path, &child.file_name().to_string_lossy()));
                        continue;
                    }
                    // Distribution-repo submodule: the checkout root itself is
                    // not a package, but each skin/plugin lives in a child dir.
                    if let Ok(grandchildren) = std::fs::read_dir(&child_path) {
                        for grandchild in grandchildren.flatten() {
                            let grandchild_path = grandchild.path();
                            if grandchild_path.is_dir()
                                && grandchild_path.join("package.json").is_file()
                            {
                                plugins.push(item(
                                    &grandchild_path,
                                    &grandchild.file_name().to_string_lossy(),
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    AboutInfo {
        shell,
        harness,
        icon,
        plugins,
    }
}
