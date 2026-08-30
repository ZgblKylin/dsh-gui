//! Update-log content for one row of the update dialog.
//!
//! The row's 「更新日志」 button asks what the pending update will bring.
//! When the row's update target is a tag and the repository's `origin` is a
//! GitHub repository, the official GitHub Release notes for that tag are
//! fetched and shown directly. Otherwise — commit target, non-GitHub remote,
//! a tag without a release note, or an unreachable API — a summary is produced
//! by the dsh AI over the commit range from the local HEAD to the resolved
//! update target.
//!
//! The summary is asked from the RUNNING harness's raw-LLM route (the
//! dsh-ai-update plugin's `/dsh-gui-api/changelog`): it streams `ctx.llm` with
//! the web profile's default model and creates no Agent and no Session, so the
//! run never appears in the DSH session list — the same approach the sidebar
//! conversation feature uses. When that route is unavailable (plugin not
//! installed, older harness, non-web deployment), the one-shot headless mode
//! (`dsh --profile headless`, same DSH_HOME) is the fallback; that run is
//! also display-only now — its session store is redirected to a temp directory
//! via a `--patch` overlay and removed afterwards, so no persistent session
//! is ever created either.
//!
//! [`prepare`] resolves the repository, the target, and (for a tag target) the
//! release notes; it runs while the caller holds the update lock so git
//! reads never race an in-dialog root update. [`finish`] runs the AI summary
//! without touching the repository (the commit data was already collected), so
//! it can run without the lock while the UI stays responsive.
//!
//! Both steps shell out through file-redirected stdio (dsh's Windows sandbox
//! rejects piped child stdio with EPERM) and never add a Rust HTTP client:
//! `node` is guaranteed present because the shell spawns the harness on it.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::update::{git_output, remote_default_branch, submodule_entries};

/// Distinguishes concurrent temp capture files within one process.
static CAPTURE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Embedded node script that fetches one GitHub release by tag and prints a
/// one-line JSON summary for the Rust side to parse. Written to a temp file at
/// call time; the harness requires Node ≥ 22, so global `fetch` + timeouts are
/// available.
const RELEASE_FETCH_SCRIPT: &str = r#"
const url = process.argv[2];
try {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-gui-changelog' },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) {
    console.log(JSON.stringify({ ok: false, status: 404 }));
    process.exit(0);
  }
  if (response.status < 200 || response.status >= 300) {
    console.log(JSON.stringify({ ok: false, status: response.status }));
    process.exit(0);
  }
  const json = await response.json();
  console.log(JSON.stringify({
    ok: true,
    name: typeof json.name === 'string' ? json.name : '',
    body: typeof json.body === 'string' ? json.body : '',
    tagName: typeof json.tag_name === 'string' ? json.tag_name : '',
    publishedAt: typeof json.published_at === 'string' ? json.published_at : '',
  }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, network: String((error && error.message) || error) }));
}
process.exit(0);
"#;

/// Wait ceiling for a dsh AI summary (one-shot agent run: profile boot, model
/// call, final text). The UI tells the user the run may take minutes.
const HEADLESS_TIMEOUT: Duration = Duration::from_secs(420);
/// Delay before the session-less route gets its retry. Right after a shell
/// restart the harness can accept TCP while the plugin routes are still
/// mounting, which would needlessly degrade to the one-shot run.
const HEADLESS_RETRY_DELAY: Duration = Duration::from_secs(3);
/// Wait ceiling for the release-note fetch (network only, has its own 15s
/// fetch timeout inside the script; this bounds process startup too).
const RELEASE_FETCH_TIMEOUT: Duration = Duration::from_secs(45);
/// Prompt-size bounds: every bound keeps the task text far below the Windows
/// 32K command-line limit and the model's context.
const MAX_COMMIT_LINES: usize = 400;
const MAX_COMMIT_CHARS: usize = 8000;
const MAX_DIFFSTAT_CHARS: usize = 3000;

/// The changelog the frontend renders: a one-line provenance note under the
/// dialog title plus the body (release notes markdown or the AI summary).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChangelog {
    pub subtitle: String,
    pub text: String,
}

/// Everything the AI step needs. `prepare` fills it while holding the update
/// lock; `finish` consumes it without touching the repository again.
pub struct SummaryRequest {
    pub name: String,
    pub id: String,
    pub from_short: String,
    pub to_short: String,
    /// Human-readable target label: the tag name, or `最新提交`.
    pub label: String,
    pub commit_count: usize,
    pub commits: String,
    pub diffstat: String,
    /// Extra provenance for the subtitle (why the release path was skipped).
    pub note: Option<String>,
}

/// The outcome of [`prepare`]: either a complete changelog (release notes, or
/// an up-to-date marker) or the request for the AI summary.
pub enum Prepared {
    Done(UpdateChangelog),
    Summarize(SummaryRequest),
}

/// Resolve the repository, the update target, and (for a tag target) the
/// GitHub release notes. Call while holding the update lock.
pub fn prepare(root: &Path, id: &str, mode: &str) -> Result<Prepared, String> {
    let dir = project_dir(root, id)?;
    validate_repo(&dir)?;

    let name = crate::about::package_name(&dir).unwrap_or_else(|| id.to_string());
    // Prefer the local `refs/remotes/origin/HEAD` symbolic ref: the update
    // check just fetched, so it is fresh and no extra network roundtrip is
    // needed; the network query is only the fallback when the local ref is
    // missing (e.g. a fetch-free checkout).
    let branch = local_default_branch(&dir)
        .or_else(|| remote_default_branch(&dir))
        .ok_or_else(|| "无法确定远端默认分支".to_string())?;

    let (target_ref, label, tag) = if mode == "tag" {
        let tag = git_output(&dir, &["describe", "--tags", "--abbrev=0", &format!("origin/{branch}")])
            .ok_or_else(|| format!("远端默认分支 origin/{branch} 上没有可用的 tag"))?;
        (tag.clone(), tag.clone(), Some(tag))
    } else {
        (format!("origin/{branch}"), "最新提交".to_string(), None)
    };

    let from_sha = git_output(&dir, &["rev-parse", "HEAD"]).ok_or("无法读取本地 HEAD")?;
    let to_sha = git_output(&dir, &["rev-parse", &format!("{target_ref}^{{commit}}")])
        .ok_or_else(|| format!("无法解析更新目标 {target_ref}"))?;

    if from_sha == to_sha {
        return Ok(Prepared::Done(UpdateChangelog {
            subtitle: "当前提交已与更新目标一致，没有需要展示的变更".to_string(),
            text: format!(
                "当前提交（{}）已与更新目标（{label}）一致。",
                short_sha(&from_sha)
            ),
        }));
    }

    // Tag target: prefer the official GitHub Release notes.
    let mut note = None;
    if let Some(tag) = &tag {
        match release_notes(&dir, tag) {
            ReleaseLookup::Found(release) if !release.body.trim().is_empty() => {
                let when = if release.published_at.is_empty() {
                    String::new()
                } else {
                    format!("（发布于 {}）", release.published_at.chars().take(10).collect::<String>())
                };
                let shown = if release.name.is_empty() {
                    tag.clone()
                } else {
                    format!("{}（{}）", release.name, tag)
                };
                return Ok(Prepared::Done(UpdateChangelog {
                    subtitle: format!("GitHub Release「{shown}」官方说明{when}"),
                    text: release.body,
                }));
            }
            ReleaseLookup::Found(_) => {
                note = Some(format!("tag「{tag}」的 GitHub Release 没有正文"));
            }
            ReleaseLookup::Absent => {
                note = Some(format!("tag「{tag}」没有对应的 GitHub Release"));
            }
            ReleaseLookup::NotGithub => {
                note = Some("origin 不是 GitHub 仓库，无法获取 Release 说明".to_string());
            }
            ReleaseLookup::Failed(error) => {
                note = Some(format!("GitHub Release 获取失败（{error}），不影响本次汇总"));
            }
        }
    }

    let range = format!("{from_sha}..{to_sha}");
    let commit_count = git_output(&dir, &["rev-list", "--count", &range])
        .and_then(|count| count.parse::<usize>().ok())
        .unwrap_or(0);
    let commits = git_output(
        &dir,
        &["log", "--pretty=format:%h|%an|%ad|%s", "--date=short", &range],
    )
    .unwrap_or_default();
    let diffstat = git_output(&dir, &["diff", "--stat", "--no-color", &range]).unwrap_or_default();

    Ok(Prepared::Summarize(SummaryRequest {
        name,
        id: id.to_string(),
        from_short: short_sha(&from_sha),
        to_short: short_sha(&to_sha),
        label,
        commit_count,
        commits: bound_lines(&commits, MAX_COMMIT_LINES, MAX_COMMIT_CHARS, "提交过多或过长，列表已截断"),
        diffstat: bound_chars(&diffstat, MAX_DIFFSTAT_CHARS, "变更统计过长，已截断"),
        note,
    }))
}

/// Produce the final changelog: no-op for [`Prepared::Done`], otherwise
/// summarize the collected commit data with the dsh AI. The preferred path is
/// the running harness's raw-LLM route ([`web_summary`]) — no Agent and no
/// Session is created, so the run never appears in the DSH session list (the
/// same approach dsh-sidebar-qa uses for its side conversations). When that
/// route is unavailable it gets one retry (the harness can still be booting):
/// only then does the one-shot headless run ([`run_headless_summary`]) take
/// over, whose session store is redirected to a temp directory so it never
/// persists a session either. Runs without the update lock.
pub fn finish(
    prepared: Prepared,
    root: &Path,
    harness_cli: &Path,
    port: u16,
    cookie: Option<String>,
) -> Result<UpdateChangelog, String> {
    let request = match prepared {
        Prepared::Done(changelog) => return Ok(changelog),
        Prepared::Summarize(request) => request,
    };

    let prompt = build_prompt(&request);
    let subtitle = summary_subtitle(&request);
    for attempt in 0..2 {
        if let Some(text) = web_summary(port, &prompt, cookie.as_deref())? {
            return Ok(UpdateChangelog { subtitle, text });
        }
        if attempt == 0 {
            // The harness may accept TCP while the plugin routes are still
            // mounting right after a restart; the session-less route is worth
            // one more chance before degrading to the one-shot run.
            std::thread::sleep(HEADLESS_RETRY_DELAY);
        }
    }
    run_headless_summary(root, harness_cli, &prompt, subtitle)
}

/// The provenance line shared by both AI paths.
fn summary_subtitle(request: &SummaryRequest) -> String {
    let mut subtitle = format!(
        "由 dsh AI 汇总 · {} 条提交 · {} → {}",
        request.commit_count, request.from_short, request.to_short
    );
    if let Some(note) = &request.note {
        subtitle.push_str(&format!(" · {note}"));
    }
    subtitle
}

/// Degraded path: the one-shot headless mode of the harness CLI. The headless
/// driver flushes its session to the configured session store; this summary is
/// a display-only answer, so the run's session store root is redirected to a
/// temp directory (a `--patch` overlay overriding the persistent backend's
/// `root`) which is removed afterwards — `$DSH_HOME/sessions` is never
/// touched.
fn run_headless_summary(
    root: &Path,
    harness_cli: &Path,
    prompt: &str,
    subtitle: String,
) -> Result<UpdateChangelog, String> {
    let (session_root, patch) = temp_session_redirect()?;
    let result = run_headless_summary_inner(root, harness_cli, prompt, subtitle, &patch);
    let _ = fs::remove_dir_all(&session_root);
    let _ = fs::remove_file(&patch);
    result
}

/// The one-shot run with an already-redirected session store.
fn run_headless_summary_inner(
    root: &Path,
    harness_cli: &Path,
    prompt: &str,
    subtitle: String,
    patch: &Path,
) -> Result<UpdateChangelog, String> {
    let args = headless_args(harness_cli, patch, prompt);
    let output = run_node_captured(
        Path::new("node"),
        &args,
        root,
        &[("DSH_HOME", &root.join(".dsh").to_string_lossy())],
        HEADLESS_TIMEOUT,
    )?;

    if output.success {
        let text = output.stdout.trim();
        if !text.is_empty() {
            let mut subtitle = subtitle;
            subtitle.push_str(" · headless 回退（web 摘要路由不可用，结果不回存会话）");
            return Ok(UpdateChangelog {
                subtitle,
                text: text.to_string(),
            });
        }
    }

    let detail = output.stderr.trim();
    let detail = if detail.is_empty() {
        output.stdout.trim().to_string()
    } else {
        detail.to_string()
    };
    Err(if detail.is_empty() {
        format!("dsh AI 汇总失败（退出码 {}）", output.code.unwrap_or(-1))
    } else {
        format!(
            "dsh AI 汇总失败：{}",
            detail.chars().take(300).collect::<String>()
        )
    })
}

/// The one-shot run's argv: launcher flags first (`--profile`, then the
/// `--patch` overlay), with the task as the pass-through prompt afterwards.
fn headless_args(harness_cli: &Path, patch: &Path, prompt: &str) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    args.push(harness_cli.as_os_str().to_os_string());
    args.push("--profile".into());
    args.push("headless".into());
    args.push("--patch".into());
    args.push(patch.as_os_str().to_os_string());
    args.push(prompt.into());
    args
}

/// Create the temp session root and the `--patch` overlay that redirects the
/// `session-persistence-jsonl` backend's root into it.
fn temp_session_redirect() -> Result<(PathBuf, PathBuf), String> {
    let id = CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let session_root = std::env::temp_dir().join(format!(
        "dsh-gui-headless-sessions-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&session_root)
        .map_err(|e| format!("无法创建临时会话目录 {}：{e}", session_root.display()))?;
    let patch = std::env::temp_dir().join(format!(
        "dsh-gui-headless-{}-{id}.yml",
        std::process::id()
    ));
    // Forward slashes (accepted by Windows paths, unescaped YAML) and
    // doubled single quotes keep the scalar literal on any temp path.
    let root = session_root
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "''");
    let contents = format!(
        "- id: session-persistence-jsonl\n  config:\n    root: '{}'\n",
        root
    );
    if let Err(e) = fs::write(&patch, contents) {
        let _ = fs::remove_dir_all(&session_root);
        return Err(format!("无法写入临时覆盖层 {}：{e}", patch.display()));
    }
    Ok((session_root, patch))
}

/// Ask the running harness's raw-LLM changelog route (the dsh-ai-update
/// plugin's `/dsh-gui-api/changelog`) for the summary. `Ok(None)` means the
/// route is unavailable — the plugin is not installed, the harness is older,
/// the transport failed, or the answer is a non-2xx status — and the caller
/// falls back to the headless run; `Err` is a genuine model-side failure that
/// the dialog should surface as-is.
fn web_summary(port: u16, prompt: &str, cookie: Option<&str>) -> Result<Option<String>, String> {
    let payload = serde_json::json!({ "prompt": prompt }).to_string();
    let (code, _status, body) =
        match crate::http_post_json_raw(port, "/dsh-gui-api/changelog", &payload, cookie) {
            Ok(response) => response,
            Err(_) => return Ok(None),
        };
    if !(200..300).contains(&code) {
        return Ok(None);
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "无法解析更新日志响应".to_string())?;
    if json["ok"] == serde_json::Value::Bool(true) {
        return match json["text"].as_str() {
            Some(text) if !text.trim().is_empty() => Ok(Some(text.trim().to_string())),
            _ => Err("更新日志生成结果为空".to_string()),
        };
    }
    let message = json["error"]["message"].as_str().unwrap_or("未知错误");
    Err(format!("dsh AI 汇总失败：{message}"))
}

/// The repository directory for a project id: the shell root for `dsh-gui`,
/// otherwise the matching `.gitmodules` submodule.
fn project_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id == "dsh-gui" {
        return Ok(root.to_path_buf());
    }
    for (name, path) in submodule_entries(root) {
        if name == id {
            return Ok(path);
        }
    }
    Err(format!("未知工程：{id}"))
}

/// The default branch recorded by the local `refs/remotes/origin/HEAD`
/// symbolic ref, if present.
fn local_default_branch(dir: &Path) -> Option<String> {
    let symbolic = git_output(dir, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?;
    symbolic
        .strip_prefix("origin/")
        .filter(|branch| !branch.is_empty())
        .map(str::to_string)
}

fn validate_repo(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err("目录不存在，请先初始化该 submodule".to_string());
    }
    if git_output(dir, &["rev-parse", "--is-inside-work-tree"]).as_deref() != Some("true") {
        return Err("不是 git 仓库".to_string());
    }
    if git_output(dir, &["remote", "get-url", "origin"]).is_none() {
        return Err("没有 origin 远程".to_string());
    }
    Ok(())
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Take at most `lines` lines and at most `chars` characters of `text`,
/// appending a marker when anything was cut.
fn bound_lines(text: &str, lines: usize, chars: usize, marker: &str) -> String {
    let mut kept = String::new();
    let mut kept_lines = 0;
    let mut truncated = false;
    for line in text.lines() {
        if kept_lines >= lines || kept.len() + line.len() + 1 > chars {
            truncated = true;
            break;
        }
        if !kept.is_empty() {
            kept.push('\n');
        }
        kept.push_str(line);
        kept_lines += 1;
    }
    if truncated {
        kept.push_str(&format!("\n…（{marker}）"));
    }
    kept
}

fn bound_chars(text: &str, chars: usize, marker: &str) -> String {
    if text.len() <= chars {
        return text.to_string();
    }
    let mut kept: String = text.chars().take(chars).collect();
    while kept.ends_with(char::is_whitespace) {
        kept.pop();
    }
    kept.push_str(&format!("\n…（{marker}）"));
    kept
}

/// The instruction block handed to the one-shot harness run. The commit list
/// carries the facts; the model only reorganizes them (no tools, no workspace
/// access needed), so the run is fast and deterministic in scope.
fn build_prompt(request: &SummaryRequest) -> String {
    let mut prompt = String::new();
    prompt.push_str("你是 DeepSeek Harness（dsh-gui 桌面壳）的更新日志助手。\n");
    prompt.push_str(&format!(
        "仓库「{}」（{}）即将从 {} 更新到 {}（{}）。\n\n",
        request.name, request.id, request.from_short, request.to_short, request.label
    ));
    prompt.push_str("请根据下面的 git 提交变更，用中文输出一份 Markdown「变更汇总」，要求：\n");
    prompt.push_str("- 先写一段不超过 3 句话的总览；\n");
    prompt.push_str("- 然后按主题分组（新增 / 改进 / 修复 / 其他），每组用列表条目（- ）逐条概括，只基于给出的提交信息概括，不要臆测；\n");
    prompt.push_str("- 提交列表为空时仅输出「无提交变更」；\n");
    prompt.push_str("- 不要调用任何工具；直接输出汇总正文，不要输出前言、说明或代码块围栏。\n\n");
    prompt.push_str("提交列表（hash|作者|日期|主题）：\n");
    prompt.push_str(&request.commits);
    prompt.push_str("\n\n变更统计（diff --stat）：\n");
    prompt.push_str(&request.diffstat);
    prompt
}

/// GitHub release lookup outcome, mapped to a provenance note by the caller.
enum ReleaseLookup {
    Found(ReleaseInfo),
    /// The tag has no matching GitHub release (404).
    Absent,
    /// The origin remote is not a GitHub repository.
    NotGithub,
    Failed(String),
}

struct ReleaseInfo {
    name: String,
    body: String,
    published_at: String,
}

fn release_notes(dir: &Path, tag: &str) -> ReleaseLookup {
    let origin = git_output(dir, &["remote", "get-url", "origin"]);
    let Some((owner, repo)) = github_repo(origin.as_deref()) else {
        return ReleaseLookup::NotGithub;
    };
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/releases/tags/{}",
        percent_encode(tag)
    );
    let script_path = match write_temp_script(RELEASE_FETCH_SCRIPT) {
        Ok(path) => path,
        Err(error) => return ReleaseLookup::Failed(error),
    };
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    args.push(script_path.as_os_str().to_os_string());
    args.push(url.into());
    let output = run_node_captured(Path::new("node"), &args, dir, &[], RELEASE_FETCH_TIMEOUT);
    let _ = fs::remove_file(&script_path);
    let output = match output {
        Ok(output) => output,
        Err(error) => return ReleaseLookup::Failed(error),
    };
    if !output.success {
        return ReleaseLookup::Failed(
            output
                .stderr
                .trim()
                .chars()
                .take(120)
                .collect::<String>(),
        );
    }
    let line = output.stdout.lines().last().unwrap_or("").trim();
    let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
        return ReleaseLookup::Failed("无法解析 GitHub API 响应".to_string());
    };
    if json["ok"] == serde_json::Value::Bool(true) {
        return ReleaseLookup::Found(ReleaseInfo {
            name: json["name"].as_str().unwrap_or("").to_string(),
            body: json["body"].as_str().unwrap_or("").to_string(),
            published_at: json["publishedAt"].as_str().unwrap_or("").to_string(),
        });
    }
    if let Some(status) = json["status"].as_u64() {
        if status == 404 {
            return ReleaseLookup::Absent;
        }
        return ReleaseLookup::Failed(format!("GitHub API 返回 {status}"));
    }
    let detail = json["network"].as_str().unwrap_or("未知网络错误");
    ReleaseLookup::Failed(detail.to_string())
}

/// Extract `owner/repo` from a GitHub `origin` URL (https, git@, or ssh forms);
/// other hosts yield `None`.
fn github_repo(url: Option<&str>) -> Option<(String, String)> {
    let url = url?.trim();
    let rest = if let Some(rest) = url.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = url.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = url.strip_prefix("http://github.com/") {
        rest
    } else if let Some(rest) = url.strip_prefix("ssh://git@github.com/") {
        rest
    } else {
        return None;
    };
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

/// Percent-encode a tag for a URL path segment (unreserved chars kept).
fn percent_encode(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub(crate) fn write_temp_script(contents: &str) -> Result<PathBuf, String> {
    let id = CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("dsh-gui-release-{}-{id}.mjs", std::process::id()));
    fs::write(&path, contents)
        .map_err(|e| format!("无法写入临时脚本 {}：{e}", path.display()))?;
    Ok(path)
}

fn read_capture_file(path: &Path) -> String {
    fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

pub(crate) struct ProcessOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run `node <args…>` in `cwd` (the first argument is the script/entry to run)
/// with stdout/stderr redirected to per-call files (dsh's Windows sandbox
/// rejects piped child stdio) and an overall timeout; on timeout the child is
/// terminated and an error returns.
pub(crate) fn run_node_captured(
    program: &Path,
    args: &[std::ffi::OsString],
    cwd: &Path,
    envs: &[(&str, &str)],
    timeout: Duration,
) -> Result<ProcessOutput, String> {
    let id = CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let base = format!("dsh-gui-changelog-{}-{id}", std::process::id());
    let out_path = std::env::temp_dir().join(format!("{base}.out"));
    let err_path = std::env::temp_dir().join(format!("{base}.err"));

    let stdout_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&out_path)
        .map_err(|e| format!("无法创建输出文件 {out_path:?}：{e}"))?;
    let stderr_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&err_path)
        .map_err(|e| format!("无法创建输出文件 {err_path:?}：{e}"))?;

    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));
    for (key, value) in envs {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 node（{}）：{e}", program.display()))?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("超时（{} 秒）——请稍后重试", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(300));
            }
            Err(e) => return Err(format!("等待子进程失败：{e}")),
        }
    };

    let output = ProcessOutput {
        success: status.success(),
        code: status.code(),
        stdout: read_capture_file(&out_path),
        stderr: read_capture_file(&err_path),
    };
    let _ = fs::remove_file(&out_path);
    let _ = fs::remove_file(&err_path);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Serve one canned HTTP response, then return the port + join handle.
    fn canned_server(status: &str, body: &str) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let status = status.to_string();
        let body = body.to_string();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let _ = stream.read(&mut buf);
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        (port, handle)
    }

    #[test]
    fn web_summary_parses_the_route_answer() {
        let (port, handle) =
            canned_server("200 OK", r##"{"ok":true,"text":"# 摘要\n\n- 完成"}"##);
        assert_eq!(
            web_summary(port, "prompt", None).unwrap(),
            Some("# 摘要\n\n- 完成".to_string())
        );
        handle.join().unwrap();
    }

    #[test]
    fn web_summary_falls_back_when_the_route_is_absent() {
        // Non-2xx (route not installed) and an unreachable port both degrade to
        // the headless fallback instead of an error.
        let (port, handle) = canned_server("404 Not Found", r#"{"ok":false,"error":{"code":"not-found","message":"x"}}"#);
        assert_eq!(web_summary(port, "prompt", None).unwrap(), None);
        handle.join().unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener); // nothing listens there now
        assert_eq!(web_summary(port, "prompt", None).unwrap(), None);
    }

    #[test]
    fn web_summary_surfaces_model_side_failures() {
        let (port, handle) = canned_server(
            "200 OK",
            r#"{"ok":false,"error":{"code":"llm-error","message":"模型失败"}}"#,
        );
        let error = web_summary(port, "prompt", None).unwrap_err();
        assert!(error.contains("模型失败"), "unexpected error: {error}");
        handle.join().unwrap();
    }

    #[test]
    fn temp_session_redirect_overrides_the_persistence_root() {
        // The overlay must target the durable backend's `root` only and quote
        // the temp path as a literal YAML scalar (forward slashes, doubled
        // single quotes), so the one-shot run can never touch the real store.
        let (session_root, patch) = temp_session_redirect().expect("redirect must work");
        let contents = fs::read_to_string(&patch).expect("patch must be readable");
        assert!(contents.starts_with("- id: session-persistence-jsonl\n  config:\n    root: '"));
        assert!(contents.contains(&session_root.to_string_lossy().replace('\\', "/")));
        assert!(contents.ends_with("'\n"));
        assert!(session_root.is_dir());
        let _ = fs::remove_dir_all(&session_root);
        let _ = fs::remove_file(&patch);
    }

    #[test]
    fn headless_args_carry_the_patch_and_then_the_prompt() {
        // The launcher flags must come before the pass-through prompt, with
        // the patch overlay between `headless` and the task text.
        let args = headless_args(Path::new("bin.js"), Path::new("overlay.yml"), "task");
        let text = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(text, "bin.js --profile headless --patch overlay.yml task");
    }

    #[test]
    fn github_repo_parses_common_forms() {
        assert_eq!(
            github_repo(Some("https://github.com/omdsh-dev/dsh-gui.git")),
            Some(("omdsh-dev".to_string(), "dsh-gui".to_string()))
        );
        assert_eq!(
            github_repo(Some("https://github.com/omdsh-dev/dsh-gui")),
            Some(("omdsh-dev".to_string(), "dsh-gui".to_string()))
        );
        assert_eq!(
            github_repo(Some("git@github.com:omdsh-dev/dsh-gui.git")),
            Some(("omdsh-dev".to_string(), "dsh-gui".to_string()))
        );
        assert_eq!(
            github_repo(Some("ssh://git@github.com/omdsh-dev/dsh-gui.git")),
            Some(("omdsh-dev".to_string(), "dsh-gui".to_string()))
        );
        assert_eq!(github_repo(Some("https://gitlab.com/x/y.git")), None);
        assert_eq!(github_repo(Some("https://github.com/only-owner")), None);
        assert_eq!(github_repo(None), None);
    }

    #[test]
    fn percent_encode_keeps_unreserved_and_encodes_rest() {
        assert_eq!(percent_encode("v1.2.3"), "v1.2.3");
        assert_eq!(percent_encode("release/v1.0+hotfix"), "release%2Fv1.0%2Bhotfix");
    }

    #[test]
    fn prompt_carries_range_and_commits() {
        let request = SummaryRequest {
            name: "dsh-gui".to_string(),
            id: "dsh-gui".to_string(),
            from_short: "a1b2c3d".to_string(),
            to_short: "e4f5a6b".to_string(),
            label: "最新提交".to_string(),
            commit_count: 2,
            commits: "abc1234|Alice|2026-08-20|feat: 增加更新日志".to_string(),
            diffstat: "2 files changed".to_string(),
            note: None,
        };
        let prompt = build_prompt(&request);
        assert!(prompt.contains("a1b2c3d"));
        assert!(prompt.contains("e4f5a6b"));
        assert!(prompt.contains("feat: 增加更新日志"));
        assert!(prompt.contains("不要调用任何工具"));
    }

    #[test]
    fn bound_lines_caps_and_marks() {
        let text = (0..10).map(|i| format!("line{i}")).collect::<Vec<_>>().join("\n");
        assert_eq!(bound_lines(&text, 3, 100, "截断"), "line0\nline1\nline2\n…（截断）");
        assert_eq!(bound_lines(&text, 100, 100, "截断"), text);
    }

    #[test]
    fn prepare_reports_same_target_as_no_change() {
        // No real origin is used: the remote state is modeled with local
        // refs (update-ref + symbolic-ref). Pushing to a local bare origin
        // spawns an msys sh helper that dsh's sandbox ACL rejects, so it must
        // not be part of the keyless test anyway.
        let root = std::env::temp_dir().join(format!("dsh-gui-changelog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            Command::new("git")
                .current_dir(&repo)
                .args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run")
                .success()
        };
        let git_ok = |args: &[&str]| {
            assert!(git(args), "git {args:?} failed in {}", repo.display())
        };

        git_ok(&["init", "-q", "-b", "main"]);
        git_ok(&["config", "user.name", "test"]);
        git_ok(&["config", "user.email", "test@example.com"]);
        git_ok(&["config", "commit.gpgsign", "false"]);
        git_ok(&["config", "tag.gpgsign", "false"]);
        git_ok(&["config", "remote.origin.url", "https://example.com/not-github/x.git"]);
        fs::write(repo.join("a.txt"), "a").unwrap();
        git_ok(&["add", "a.txt"]);
        git_ok(&["commit", "-q", "-m", "a"]);
        let sha_a = git_output(&repo, &["rev-parse", "HEAD"]).unwrap();
        git_ok(&["update-ref", "refs/remotes/origin/main", &sha_a]);
        git_ok(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

        // Local HEAD equals the remote default branch: no change to show.
        let Prepared::Done(changelog) =
            prepare(&repo, "dsh-gui", "commit").expect("prepare must succeed")
        else {
            panic!("same-target prepare must be Done, got Summarize")
        };
        assert!(changelog.text.contains("已与更新目标"));
        assert_eq!(changelog.subtitle, "当前提交已与更新目标一致，没有需要展示的变更");

        // A newer commit on the remote ref turns the row into an AI request.
        fs::write(repo.join("b.txt"), "b").unwrap();
        git_ok(&["add", "b.txt"]);
        git_ok(&["commit", "-q", "-m", "feat: second"]);
        let sha_b = git_output(&repo, &["rev-parse", "HEAD"]).unwrap();
        git_ok(&["tag", "v2.0.0", &sha_b]);
        git_ok(&["update-ref", "refs/remotes/origin/main", &sha_b]);
        git_ok(&["reset", "--hard", &sha_a]);
        let Prepared::Summarize(request) =
            prepare(&repo, "dsh-gui", "commit").expect("prepare must succeed")
        else {
            panic!("behind prepare must be Summarize, got Done")
        };
        assert_eq!(request.commit_count, 1);
        assert!(request.commits.contains("feat: second"));
        assert_eq!(request.label, "最新提交");

        // The same repo with a tag target: the tag resolves on the remote
        // branch, but the origin is not GitHub, so the AI path carries the
        // provenance note instead of release notes.
        let Prepared::Summarize(request) =
            prepare(&repo, "dsh-gui", "tag").expect("tag prepare must succeed")
        else {
            panic!("tag prepare must be Summarize, got Done")
        };
        assert_eq!(request.label, "v2.0.0");
        assert!(request
            .note
            .as_deref()
            .is_some_and(|note| note.contains("不是 GitHub 仓库")));

        let _ = fs::remove_dir_all(&root);
    }
}
