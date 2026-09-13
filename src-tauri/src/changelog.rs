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
//! The embedded scripts flush their answer and let the event loop drain instead
//! of calling `process.exit()` — see [`RELEASE_FETCH_SCRIPT`] for why that exit
//! used to surface as a "Release 获取失败" note on Windows.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::update::{git_output, remote_default_branch, submodule_entries};

/// Distinguishes concurrent temp capture files within one process.
static CAPTURE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Embedded node script that fetches the GitHub releases for a set of tags and
/// prints one JSON line for the Rust side to parse. Written to a temp file at
/// call time; the harness requires Node ≥ 22, so global `fetch` + timeouts are
/// available.
///
/// argv: `[baseUrl, wantedTagsJson]`, where `baseUrl` is the paginated release
/// list endpoint (`…/releases?per_page=100`) and `wantedTagsJson` is the array
/// of tags the update brings in. The endpoint is queried newest-first and pages
/// are followed (bounded) only until every wanted tag is accounted for, so an
/// update that spans several releases costs one request in the common case.
///
/// The script must never call `process.exit()`. On Windows that aborts node
/// while undici is still draining the fetch's async handles, and libuv then
/// trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) … src\win\async.c`
/// — the abort used to surface as a bogus "GitHub Release 获取失败" note and
/// pushed every tag target onto the slow AI fallback even though the release
/// had been fetched. Instead the answer is written with `writeSync(1, …)` (file
/// stdio: guaranteed to be flushed before the process ends) and the event loop
/// is left to drain; the response body is always consumed or cancelled so no
/// half-read socket survives the exit.
const RELEASE_FETCH_SCRIPT: &str = r#"
import { writeSync } from 'node:fs';

const base = process.argv[2];
const wanted = new Set(JSON.parse(process.argv[3] || '[]'));
const releases = [];
const PER_PAGE = 100;
const MAX_PAGES = 3;
let failure = null;
// True once the API list ran out (a page shorter than PER_PAGE): only then is a
// wanted tag that was never seen *proven* to have no release. If the page cap
// is reached instead, the remaining tags stay unresolved rather than being
// reported as release-less.
let exhausted = false;
try {
  for (let page = 1; page <= MAX_PAGES && wanted.size > 0; page += 1) {
    const response = await fetch(base + '&page=' + page, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-gui-changelog' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      failure = { status: response.status };
      break;
    }
    const items = await response.json();
    const list = Array.isArray(items) ? items : [];
    for (const item of list) {
      const tag = item && typeof item.tag_name === 'string' ? item.tag_name : '';
      if (!tag || !wanted.has(tag)) continue;
      wanted.delete(tag);
      releases.push({
        tag,
        name: typeof item.name === 'string' ? item.name : '',
        body: typeof item.body === 'string' ? item.body : '',
        publishedAt: typeof item.published_at === 'string' ? item.published_at : '',
        prerelease: item.prerelease === true,
      });
    }
    if (list.length < PER_PAGE) {
      exhausted = true;
      break;
    }
  }
} catch (error) {
  failure = { network: String((error && error.message) || error) };
}
const unresolved = [...wanted];
const capped = !exhausted && unresolved.length > 0;
const incomplete = failure
  ? (failure.status === undefined ? failure.network : 'GitHub API 返回 ' + failure.status)
  : (capped ? '只读取了 Release 列表的前 ' + MAX_PAGES * PER_PAGE + ' 个' : '');
let result;
if (releases.length > 0) {
  // A failure or the page cap part-way through keeps the releases already
  // collected and flags the list as possibly incomplete instead of dropping a
  // partial answer.
  result = { ok: true, releases, missing: exhausted ? unresolved : [] };
  if (incomplete) result.partial = incomplete;
} else if (failure) {
  result = failure.status === undefined
    ? { ok: false, network: failure.network }
    : { ok: false, status: failure.status };
} else if (capped) {
  // Nothing matched and the list was never exhausted: absence is unproven, so
  // report "cannot determine" instead of "no release".
  result = { ok: false, error: '无法确定范围内的 GitHub Release（' + incomplete + '）' };
} else {
  result = { ok: true, releases: [], missing: unresolved };
}
writeSync(1, JSON.stringify(result) + '\n');
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

    // Tag target: prefer the official GitHub Release notes for every release
    // the update brings in — a checkout several releases behind (or several
    // tags inside one release) must show all of them, newest first, not just
    // the target tag's notes.
    let mut note = None;
    if let Some(tag) = &tag {
        let tags = release_range_tags(&dir, &from_sha, &to_sha, tag);
        match release_notes(&dir, &tags) {
            ReleaseLookup::Found(set) if set.releases.iter().any(|r| !r.body.trim().is_empty()) => {
                return Ok(Prepared::Done(UpdateChangelog {
                    subtitle: release_subtitle(&set),
                    text: render_releases(&set),
                }));
            }
            ReleaseLookup::Found(set) => {
                note = Some(format!(
                    "{} 个 GitHub Release 都没有正文",
                    set.releases.len()
                ));
            }
            ReleaseLookup::Absent => {
                note = Some(if tags.len() == 1 {
                    format!("tag「{tag}」没有对应的 GitHub Release")
                } else {
                    format!(
                        "范围内的 {} 个 tag（{} … {}）都没有对应的 GitHub Release",
                        tags.len(),
                        tags.first().map(String::as_str).unwrap_or(""),
                        tags.last().map(String::as_str).unwrap_or("")
                    )
                });
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
#[derive(Debug)]
enum ReleaseLookup {
    /// At least one wanted tag has a release; `releases` may still be partial
    /// when a later page of the list failed (see [`ReleaseSet::partial`]).
    Found(ReleaseSet),
    /// No wanted tag has a GitHub release.
    Absent,
    /// The origin remote is not a GitHub repository.
    NotGithub,
    Failed(String),
}

/// The releases an update brings in, newest first.
#[derive(Debug)]
struct ReleaseSet {
    releases: Vec<ReleaseInfo>,
    /// Wanted tags that have no GitHub release at all.
    missing: Vec<String>,
    /// A non-fatal error while paging the release list: the answer may be
    /// incomplete, so the subtitle says so instead of hiding the releases.
    partial: Option<String>,
}

#[derive(Debug)]
struct ReleaseInfo {
    tag: String,
    name: String,
    body: String,
    published_at: String,
    prerelease: bool,
}

/// The tags an update from `from_sha` to `to_sha` brings in: every tag
/// reachable from the update target but not already reachable from the local
/// HEAD (so a checkout sitting on `v0.2.0` yields `v0.3.0 … v0.5.0` for a
/// `v0.5.0` target), plus the target tag itself. Local tags are enough because
/// the update check fetches the remote first; `git tag --merged`/`--no-merged`
/// keeps unrelated tags off other branches out of the list.
fn release_range_tags(dir: &Path, from_sha: &str, to_sha: &str, target_tag: &str) -> Vec<String> {
    let mut tags: Vec<String> = git_output(dir, &["tag", "--merged", to_sha, "--no-merged", from_sha])
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if !tags.iter().any(|tag| tag == target_tag) {
        tags.push(target_tag.to_string());
    }
    // Sorted for a stable argv/URL; the display order is by publish time.
    tags.sort();
    tags.dedup();
    tags
}

/// Look up the GitHub releases for `tags` (one paginated list request, see
/// [`RELEASE_FETCH_SCRIPT`]).
fn release_notes(dir: &Path, tags: &[String]) -> ReleaseLookup {
    let origin = git_output(dir, &["remote", "get-url", "origin"]);
    let Some((owner, repo)) = github_repo(origin.as_deref()) else {
        return ReleaseLookup::NotGithub;
    };
    let base = format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page=100");
    let wanted = match serde_json::to_string(tags) {
        Ok(json) => json,
        Err(error) => return ReleaseLookup::Failed(format!("无法序列化 tag 列表：{error}")),
    };
    let script_path = match write_temp_script(RELEASE_FETCH_SCRIPT) {
        Ok(path) => path,
        Err(error) => return ReleaseLookup::Failed(error),
    };
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    args.push(script_path.as_os_str().to_os_string());
    args.push(base.into());
    args.push(wanted.into());
    let output = run_node_captured(Path::new("node"), &args, dir, &[], RELEASE_FETCH_TIMEOUT);
    let _ = fs::remove_file(&script_path);
    match output {
        Ok(output) => parse_release_capture(&output.stdout, output.success, &output.stderr),
        Err(error) => ReleaseLookup::Failed(error),
    }
}

/// Map one capture of [`RELEASE_FETCH_SCRIPT`] to a lookup.
///
/// The JSON line the script emitted is authoritative even when the child
/// exited non-zero: node can abort *after* the line reached stdout (the libuv
/// teardown assertion the script must never trigger, but a future crash must
/// not regress this), and discarding a complete answer would drop the official
/// release notes for tags that have them. Only a missing or unparseable line
/// falls back to the exit status and the stderr diagnostic.
fn parse_release_capture(stdout: &str, success: bool, stderr: &str) -> ReleaseLookup {
    let line = stdout.lines().last().unwrap_or("").trim();
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
        if json["ok"] == serde_json::Value::Bool(true) {
            let mut releases: Vec<ReleaseInfo> = json["releases"]
                .as_array()
                .map(|items| items.iter().filter_map(parse_release_item).collect())
                .unwrap_or_default();
            // Newest first, regardless of the order the API happened to return.
            // GitHub publishes fixed-width UTC timestamps
            // (`2026-09-13T14:30:35Z`), whose byte order matches chronological
            // order; an empty date sorts last.
            releases.sort_by(|a, b| b.published_at.cmp(&a.published_at));
            if releases.is_empty() {
                return ReleaseLookup::Absent;
            }
            let missing = json["missing"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str())
                        .filter(|tag| !tag.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let partial = json["partial"].as_str().map(str::to_string);
            return ReleaseLookup::Found(ReleaseSet {
                releases,
                missing,
                partial,
            });
        }
        if let Some(status) = json["status"].as_u64() {
            // The list endpoint answers 200 with an empty array when a
            // repository simply has no releases, so a 404 means the repository
            // itself is unreachable (private, renamed, or deleted) — a fetch
            // failure, not "these tags have no release".
            return ReleaseLookup::Failed(format!("GitHub API 返回 {status}"));
        }
        if let Some(detail) = json["network"].as_str() {
            return ReleaseLookup::Failed(detail.to_string());
        }
        // "Cannot determine" (the list was capped before the wanted tags were
        // reached): surfaced as a failure so no tag is misreported as missing.
        if let Some(detail) = json["error"].as_str() {
            return ReleaseLookup::Failed(detail.to_string());
        }
    }
    if !success {
        let detail: String = stderr.trim().chars().take(120).collect();
        return ReleaseLookup::Failed(if detail.is_empty() {
            "node 进程异常退出（没有错误输出）".to_string()
        } else {
            detail
        });
    }
    ReleaseLookup::Failed("无法解析 GitHub API 响应".to_string())
}

/// One release entry of the script's answer; an entry without a tag carries no
/// usable identity and is dropped.
fn parse_release_item(item: &serde_json::Value) -> Option<ReleaseInfo> {
    let tag = item["tag"].as_str().unwrap_or("").trim();
    if tag.is_empty() {
        return None;
    }
    Some(ReleaseInfo {
        tag: tag.to_string(),
        name: item["name"].as_str().unwrap_or("").to_string(),
        body: item["body"].as_str().unwrap_or("").to_string(),
        published_at: item["publishedAt"].as_str().unwrap_or("").to_string(),
        prerelease: item["prerelease"] == serde_json::Value::Bool(true),
    })
}

/// The provenance line for a release-backed changelog: the familiar single-tag
/// wording stays for one release, several releases report the span and the
/// newest-first order.
fn release_subtitle(set: &ReleaseSet) -> String {
    let mut subtitle = if set.releases.len() == 1 {
        let release = &set.releases[0];
        let when = if release.published_at.is_empty() {
            String::new()
        } else {
            format!(
                "（发布于 {}）",
                release.published_at.chars().take(10).collect::<String>()
            )
        };
        let shown = if release.name.trim().is_empty() {
            release.tag.clone()
        } else {
            format!("{}（{}）", release.name.trim(), release.tag)
        };
        format!("GitHub Release「{shown}」官方说明{when}")
    } else {
        format!(
            "GitHub Release 官方说明 · {} 个版本（{} → {}，最新在上）",
            set.releases.len(),
            set.releases.last().map(|r| r.tag.as_str()).unwrap_or(""),
            set.releases.first().map(|r| r.tag.as_str()).unwrap_or("")
        )
    };
    if !set.missing.is_empty() {
        subtitle.push_str(&format!(" · {} 个 tag 无 Release", set.missing.len()));
    }
    if let Some(partial) = &set.partial {
        subtitle.push_str(&format!(" · Release 列表可能不完整（{partial}）"));
    }
    subtitle
}

/// Render the release set as one markdown document: one `## <tag> · <name>`
/// section per release, newest first, separated by rules, with the release body
/// underneath. Releases without a body stay listed (their version still tells
/// the reader what the update contains) and tags with no release at all are
/// listed in a trailing note.
fn render_releases(set: &ReleaseSet) -> String {
    let mut out = String::new();
    for (index, release) in set.releases.iter().enumerate() {
        if index > 0 {
            out.push_str("\n\n---\n\n");
        }
        let name = release.name.trim();
        if name.is_empty() {
            out.push_str(&format!("## {}\n", release.tag));
        } else {
            out.push_str(&format!("## {} · {name}\n", release.tag));
        }
        let mut facts: Vec<String> = Vec::new();
        if !release.published_at.is_empty() {
            facts.push(format!(
                "发布于 {}",
                release.published_at.chars().take(10).collect::<String>()
            ));
        }
        if release.prerelease {
            facts.push("预发布".to_string());
        }
        out.push('\n');
        if !facts.is_empty() {
            out.push_str(&format!("*{}*\n\n", facts.join(" · ")));
        }
        let body = release.body.trim();
        if body.is_empty() {
            out.push_str("（该 Release 没有正文）\n");
        } else {
            out.push_str(body);
            out.push('\n');
        }
    }
    if !set.missing.is_empty() {
        out.push_str("\n---\n\n> 以下 tag 没有对应的 GitHub Release：");
        out.push_str(&set.missing.join("、"));
        out.push('\n');
    }
    out
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
    fn embedded_release_script_never_calls_process_exit() {
        // Regression guard for the Windows libuv abort: `process.exit()` while
        // undici still drains the fetch's async handles fails the child (and
        // used to turn a successful fetch into a bogus 「获取失败」 note), so
        // the script must flush its answer and let the loop drain instead.
        assert!(!RELEASE_FETCH_SCRIPT.contains("process.exit"));
        assert!(RELEASE_FETCH_SCRIPT.contains("writeSync(1"));
    }

    #[test]
    fn release_capture_prefers_the_emitted_line_over_a_crashed_child() {
        // A node abort *after* the JSON line reached stdout (the Windows libuv
        // teardown assertion the script must never trigger, but a future crash
        // cannot be allowed to regress this) must not throw the answer away:
        // the tags keep their official release notes instead of degrading to
        // the slow AI fallback.
        let stdout = r##"{"ok":true,"releases":[{"tag":"v1.2.3","name":"v1.2.3","body":"# 说明","publishedAt":"2026-01-02T03:04:05Z","prerelease":false}],"missing":[]}"##;
        let assertion = r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94";
        match parse_release_capture(stdout, false, assertion) {
            ReleaseLookup::Found(set) => {
                assert_eq!(set.releases.len(), 1);
                assert_eq!(set.releases[0].tag, "v1.2.3");
                assert_eq!(set.releases[0].body, "# 说明");
                assert!(set.missing.is_empty());
                assert!(set.partial.is_none());
            }
            other => panic!("expected Found, got {other:?}"),
        }
    }

    #[test]
    fn release_capture_lists_every_release_newest_first() {
        // The whole point of the list endpoint: an update spanning several
        // releases shows all of them, ordered by publish time even when the
        // API (or a future script change) returns them in another order.
        // One line, exactly like the script's output (`parse_release_capture`
        // reads the last stdout line).
        let stdout = r##"{"ok":true,"releases":[{"tag":"v1.2.0","name":"one-two","body":"b2","publishedAt":"2026-02-01T00:00:00Z","prerelease":false},{"tag":"v1.3.0","name":"","body":"b3","publishedAt":"2026-03-01T00:00:00Z","prerelease":false},{"tag":"v1.1.0","name":"one-one","body":"b1","publishedAt":"","prerelease":true},{"tag":"","name":"junky","body":"x","publishedAt":"2026-04-01T00:00:00Z"}],"missing":["v1.1.5"],"partial":"GitHub API 返回 502"}"##;
        let ReleaseLookup::Found(set) = parse_release_capture(stdout, true, "") else {
            panic!("expected Found")
        };
        let tags: Vec<&str> = set.releases.iter().map(|r| r.tag.as_str()).collect();
        // Newest first; the dateless release sorts last, the tagless entry is
        // dropped instead of being rendered without an identity.
        assert_eq!(tags, vec!["v1.3.0", "v1.2.0", "v1.1.0"]);
        assert_eq!(set.missing, vec!["v1.1.5".to_string()]);
        assert_eq!(set.partial.as_deref(), Some("GitHub API 返回 502"));
        assert!(set.releases[2].prerelease);
    }

    #[test]
    fn release_capture_maps_status_and_network_answers() {
        // The list endpoint only answers 404 when the repository is not
        // reachable (private/renamed): that is a fetch failure, not an
        // "no release" answer.
        assert!(matches!(
            parse_release_capture(r#"{"ok":false,"status":404}"#, true, ""),
            ReleaseLookup::Failed(ref detail) if detail == "GitHub API 返回 404"
        ));
        // No wanted tag has a release lists an empty array, not an error.
        assert!(matches!(
            parse_release_capture(
                r#"{"ok":true,"releases":[],"missing":["v1.0.0","v1.1.0"]}"#,
                true,
                ""
            ),
            ReleaseLookup::Absent
        ));
        assert!(matches!(
            parse_release_capture(r#"{"ok":false,"status":403}"#, true, ""),
            ReleaseLookup::Failed(ref detail) if detail == "GitHub API 返回 403"
        ));
        assert!(matches!(
            parse_release_capture(r#"{"ok":false,"network":"fetch failed"}"#, true, ""),
            ReleaseLookup::Failed(ref detail) if detail == "fetch failed"
        ));
    }

    #[test]
    fn release_capture_flags_an_incomplete_list_instead_of_inventing_absence() {
        // A page failure or the page cap keeps the collected releases and says
        // the list may be short.
        let partial = r#"{"ok":true,"releases":[{"tag":"v1.0.0","name":"","body":"b","publishedAt":"","prerelease":false}],"missing":[],"partial":"只读取了 Release 列表的前 300 个"}"#;
        let ReleaseLookup::Found(set) = parse_release_capture(partial, true, "") else {
            panic!("expected Found")
        };
        assert_eq!(set.releases.len(), 1);
        assert_eq!(set.partial.as_deref(), Some("只读取了 Release 列表的前 300 个"));
        // Nothing collected and the list never ran out: "cannot determine", not
        // "no release" (the wanted tag may live beyond the page cap).
        assert!(matches!(
            parse_release_capture(
                r#"{"ok":false,"error":"无法确定范围内的 GitHub Release（只读取了 Release 列表的前 300 个）"}"#,
                true,
                ""
            ),
            ReleaseLookup::Failed(ref detail) if detail.contains("无法确定")
        ));
    }

    #[test]
    fn release_capture_reports_the_crash_when_nothing_was_emitted() {
        // No parseable line: the exit status decides, so a real crash still
        // reaches the note as its (truncated) stderr diagnostic.
        let assertion = r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94";
        assert!(matches!(
            parse_release_capture("", false, assertion),
            ReleaseLookup::Failed(ref detail) if detail == assertion
        ));
        assert!(matches!(
            parse_release_capture("", false, ""),
            ReleaseLookup::Failed(ref detail) if detail.contains("异常退出")
        ));
        assert!(matches!(
            parse_release_capture("not json", true, ""),
            ReleaseLookup::Failed(ref detail) if detail == "无法解析 GitHub API 响应"
        ));
    }

    #[test]
    fn release_subtitle_and_body_cover_a_multi_release_update() {
        // Oldest → newest update: the subtitle names the span and the body
        // carries one section per release, newest first, separated by rules.
        let set = ReleaseSet {
            releases: vec![
                ReleaseInfo {
                    tag: "v0.5.0".to_string(),
                    name: "第五版".to_string(),
                    body: "notes-five".to_string(),
                    published_at: "2026-05-05T10:00:00Z".to_string(),
                    prerelease: false,
                },
                ReleaseInfo {
                    tag: "v0.3.0".to_string(),
                    name: String::new(),
                    body: String::new(),
                    published_at: "2026-03-03T10:00:00Z".to_string(),
                    prerelease: true,
                },
            ],
            missing: vec!["v0.4.0".to_string()],
            partial: None,
        };
        let subtitle = release_subtitle(&set);
        assert!(subtitle.contains("2 个版本"), "unexpected subtitle: {subtitle}");
        assert!(subtitle.contains("v0.3.0 → v0.5.0"), "unexpected subtitle: {subtitle}");
        assert!(subtitle.contains("最新在上"));
        assert!(subtitle.contains("1 个 tag 无 Release"));

        let text = render_releases(&set);
        assert!(text.contains("## v0.5.0 · 第五版"));
        assert!(text.contains("*发布于 2026-05-05*"));
        // A release without notes keeps its version heading and says so, and a
        // prerelease is labelled.
        assert!(text.contains("## v0.3.0\n"));
        assert!(text.contains("（该 Release 没有正文）"));
        assert!(text.contains("预发布"));
        assert!(text.contains("\n---\n"), "releases must be separated by a rule");
        assert!(text.contains("> 以下 tag 没有对应的 GitHub Release：v0.4.0"));
        // Newest release first.
        let five = text.find("v0.5.0").unwrap();
        let three = text.find("v0.3.0").unwrap();
        assert!(five < three, "newest release must come first");

        // A single release keeps the familiar one-line subtitle.
        let single = ReleaseSet {
            releases: vec![ReleaseInfo {
                tag: "v1.2.3".to_string(),
                name: "说明".to_string(),
                body: "b".to_string(),
                published_at: "2026-01-02T03:04:05Z".to_string(),
                prerelease: false,
            }],
            missing: Vec::new(),
            partial: None,
        };
        assert_eq!(
            release_subtitle(&single),
            "GitHub Release「说明（v1.2.3）」官方说明（发布于 2026-01-02）"
        );
    }

    #[test]
    fn release_range_tags_covers_every_tag_the_update_brings_in() {
        // A checkout on v1.0.0 updating to v1.3.0 must yield the three tags in
        // between (plus nothing older), so all three releases are shown.
        let root = std::env::temp_dir().join(format!("dsh-gui-range-tags-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            assert!(
                Command::new("git")
                    .current_dir(&root)
                    .args(args)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .expect("git must run")
                    .success(),
                "git {args:?} failed"
            );
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "test"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "commit.gpgsign", "false"]);
        git(&["config", "tag.gpgsign", "false"]);

        let mut shas = Vec::new();
        for (index, name) in ["v1.0.0", "v1.1.0", "v1.2.0", "v1.3.0"].iter().enumerate() {
            fs::write(root.join(format!("{index}.txt")), name).unwrap();
            let file = format!("{index}.txt");
            git(&["add", &file]);
            git(&["commit", "-q", "-m", name]);
            let sha = git_output(&root, &["rev-parse", "HEAD"]).unwrap();
            git(&["tag", name, &sha]);
            shas.push(sha);
        }
        // A tag on an unrelated branch must not be pulled in.
        git(&["checkout", "-q", "-b", "side", &shas[0]]);
        fs::write(root.join("side.txt"), "side").unwrap();
        git(&["add", "side.txt"]);
        git(&["commit", "-q", "-m", "side"]);
        git(&["tag", "v9.9.9"]);
        git(&["checkout", "-q", "main"]);
        git(&["checkout", "-q", &shas[0]]); // local HEAD sits on v1.0.0

        let tags = release_range_tags(&root, &shas[0], &shas[3], "v1.3.0");
        assert_eq!(
            tags,
            vec![
                "v1.1.0".to_string(),
                "v1.2.0".to_string(),
                "v1.3.0".to_string()
            ],
            "only the tags the update brings in, oldest-first for stable argv"
        );

        // A target tag that is not in the local range (e.g. tags not fetched)
        // is still queried rather than silently dropped.
        let tags = release_range_tags(&root, &shas[0], &shas[3], "v1.4.0");
        assert!(tags.iter().any(|tag| tag == "v1.4.0"));
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
