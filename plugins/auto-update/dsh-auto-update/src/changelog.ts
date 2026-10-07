/**
 * Changelog collection for the auto-update host half.
 *
 * One request describes one row's pending update. `git log` over the local
 * `HEAD..<target>` range gives the commit list, `git rev-list --count` gives the
 * range's full commit count, and `git diff --stat` gives the change statistics
 * the summary prompt carries. For a tag target whose `origin` is GitHub, the
 * tag's Release notes replace the commit list. The semantics are ported from
 * `src-tauri/src/changelog.rs`, deliberately without its summary step: this half
 * neither runs a model nor starts a headless harness session, because the client
 * asks the already-installed `dsh-ai-update` route for the AI summary instead.
 *
 * Failure policy (contract §4.3): a GitHub lookup that fails, 404s, or returns
 * a release without a body is *not* an error — it silently falls back to the
 * commit list. `error` is reserved for local git failures, and an
 * unresolvable request (unknown project) is a 400 via
 * {@link ChangelogRequestError}.
 */

import { gitFailure, gitOutput, gitVersion, isGitRepo, localDefaultBranch, remoteDefaultBranch, runGit } from './git.ts'
import { isDirectory, listProjects } from './paths.ts'

/** Raised for an invalid changelog request (unknown project); the route answers 400. */
export class ChangelogRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChangelogRequestError'
  }
}

/** Upper bound on the returned commit list. */
export const MAX_COMMITS = 400

/** Upper bound on one commit subject. */
export const MAX_SUBJECT_CHARS = 200

/** Upper bound on the returned diffstat, truncation marker included. */
export const MAX_DIFFSTAT_CHARS = 3000

/** Appended to a diffstat that hit {@link MAX_DIFFSTAT_CHARS}. */
const DIFFSTAT_TRUNCATION_MARKER = '…（已截断）'

/** Timeout for one GitHub API call. */
const GITHUB_TIMEOUT_MS = 45_000

/**
 * GitHub API base. Overridable only so the fixture tests can point it at a dead
 * loopback port instead of waiting on the real network.
 */
const GITHUB_API_BASE = process.env.DSH_AUTO_UPDATE_GITHUB_API_BASE?.trim() || 'https://api.github.com'

/** One commit row of the changelog. */
export interface CommitRow {
  /** Abbreviated commit hash. */
  sha: string
  /** Subject line, capped at {@link MAX_SUBJECT_CHARS} characters. */
  subject: string
  /** Author name. */
  author: string
  /** Author date, `YYYY-MM-DD`. */
  date: string
}

/** The GitHub Release notes for the target tag, when one was found with a body. */
export interface ReleaseNotes {
  tag: string
  name: string
  /** The per-tag release page. */
  url: string
  /** Release body markdown. */
  body: string
}

/** The changelog response body. */
export interface ChangelogResult {
  id: string
  name: string
  /** Human-readable local version. */
  from?: string
  /** Human-readable target version. */
  to?: string
  /** The ref the update would move to: a tag name, or `origin/<branch>`. */
  target?: string
  targetKind: 'tag' | 'commit'
  release?: ReleaseNotes
  commits: CommitRow[]
  /**
   * `git rev-list --count <from>..<to>`: every commit in the range, merge
   * commits included and unaffected by {@link MAX_COMMITS}. Zero when no update
   * is available.
   */
  count: number
  /**
   * `git diff --stat` over the update range, capped at
   * {@link MAX_DIFFSTAT_CHARS}; empty when no update is available.
   */
  diffstat: string
  /** True when the commit list was capped at {@link MAX_COMMITS}. */
  truncated: boolean
  /** A local git failure; absent on success. */
  error?: string
}

/**
 * Build the changelog for one project's pending update.
 * @param root - repository root.
 * @param id - project id (`dsh-gui`, or a `.gitmodules` name).
 * @param mode - the update target kind the user selected.
 * @returns the response body; local git failures travel in `error`.
 * @throws {ChangelogRequestError} when no project has this id.
 */
export async function buildChangelog(root: string, id: string, mode: 'tag' | 'commit'): Promise<ChangelogResult> {
  const project = listProjects(root).find((row) => row.id === id)
  if (project === undefined) throw new ChangelogRequestError(`未知工程：${id}`)
  const result: ChangelogResult = { id, name: project.name, targetKind: mode, commits: [], count: 0, diffstat: '', truncated: false }

  if (!isDirectory(project.dir)) {
    result.error = '目录不存在，请先初始化该 submodule'
    return result
  }
  if (!await isGitRepo(project.dir)) {
    result.error = '不是 git 仓库'
    return result
  }
  const origin = await gitOutput(['remote', 'get-url', 'origin'], project.dir)
  if (origin === undefined) {
    result.error = '没有 origin 远程'
    return result
  }
  const fromSha = await gitOutput(['rev-parse', 'HEAD'], project.dir)
  if (fromSha === undefined) {
    result.error = '无法读取本地 HEAD'
    return result
  }
  result.from = await gitVersion(project.dir, fromSha)
  // Prefer the local `refs/remotes/origin/HEAD` symbolic ref: the update check
  // just fetched, so it is fresh and needs no extra network roundtrip; the
  // network query is only the fallback for a fetch-free checkout.
  const branch = await localDefaultBranch(project.dir) ?? await remoteDefaultBranch(project.dir)
  if (branch === undefined) {
    result.error = '无法确定远端默认分支'
    return result
  }

  let targetRef: string
  if (mode === 'tag') {
    const tag = await gitOutput(['describe', '--tags', '--abbrev=0', `origin/${branch}`], project.dir)
    if (tag === undefined) {
      result.error = `远端默认分支 origin/${branch} 上没有可用的 tag`
      return result
    }
    targetRef = tag
  } else {
    targetRef = `origin/${branch}`
  }
  result.target = targetRef
  const toSha = await gitOutput(['rev-parse', `${targetRef}^{commit}`], project.dir)
  if (toSha === undefined) {
    result.error = `无法解析更新目标 ${targetRef}`
    return result
  }
  result.to = await gitVersion(project.dir, targetRef)
  if (fromSha === toSha) return result

  const log = await runGit(
    ['log', '--no-merges', '--date=short', '--pretty=%h%x09%s%x09%an%x09%ad', `${fromSha}..${toSha}`],
    project.dir,
  )
  if (!log.ok) {
    result.error = gitFailure(log, 'git log')
    return result
  }
  // The AI summary's subtitle counts every commit in the range (merges
  // included) and is not bounded by the 400-row list cap.
  const counted = await gitOutput(['rev-list', '--count', `${fromSha}..${toSha}`], project.dir)
  const count = Number.parseInt(counted ?? '0', 10)
  result.count = Number.isFinite(count) ? count : 0

  const lines = log.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  result.truncated = lines.length > MAX_COMMITS
  result.commits = lines
    .slice(0, MAX_COMMITS)
    .map(parseCommitLine)
    .filter((row): row is CommitRow => row !== undefined)
  // The AI summary prompt carries the change statistics next to the commit
  // list; a failed or empty diff is not an error.
  const diffstat = await runGit(['diff', '--stat', '--no-color', `${fromSha}..${toSha}`], project.dir)
  if (diffstat.ok) result.diffstat = boundDiffstat(diffstat.stdout.trim())

  if (mode === 'tag') {
    const repo = githubRepo(origin)
    if (repo !== undefined) {
      const release = await fetchRelease(repo.owner, repo.repo, targetRef)
      if (release !== undefined) result.release = release
    }
  }
  return result
}

/**
 * Cap the diffstat at {@link MAX_DIFFSTAT_CHARS} characters *including* the
 * truncation marker, so the response field always honours the documented limit.
 */
function boundDiffstat(text: string): string {
  if (text.length <= MAX_DIFFSTAT_CHARS) return text
  const budget = MAX_DIFFSTAT_CHARS - DIFFSTAT_TRUNCATION_MARKER.length - 1
  return `${text.slice(0, budget).replace(/\s+$/, '')}\n${DIFFSTAT_TRUNCATION_MARKER}`
}

/** Parse one `%h\t%s\t%an\t%ad` line; `undefined` when it is malformed. */
function parseCommitLine(line: string): CommitRow | undefined {
  const parts = line.split('\t')
  if (parts.length < 4) return undefined
  const [sha, subject, author, date] = parts
  if (sha === undefined || sha === '') return undefined
  return {
    sha: sha.trim(),
    subject: capSubject(subject ?? ''),
    author: (author ?? '').trim(),
    date: (date ?? '').trim(),
  }
}

/** Cap one subject at {@link MAX_SUBJECT_CHARS} characters, marking truncation. */
function capSubject(subject: string): string {
  const value = subject.trim()
  return value.length > MAX_SUBJECT_CHARS ? `${value.slice(0, MAX_SUBJECT_CHARS - 1)}…` : value
}

/**
 * Extract `owner/repo` from a GitHub `origin` URL (https, git@, or ssh forms);
 * another host yields `undefined`.
 */
export function githubRepo(url: string | undefined): { owner: string; repo: string } | undefined {
  const value = url?.trim()
  if (value === undefined || value === '') return undefined
  let rest: string
  if (value.startsWith('git@github.com:')) rest = value.slice('git@github.com:'.length)
  else if (value.startsWith('https://github.com/')) rest = value.slice('https://github.com/'.length)
  else if (value.startsWith('http://github.com/')) rest = value.slice('http://github.com/'.length)
  else if (value.startsWith('ssh://git@github.com/')) rest = value.slice('ssh://git@github.com/'.length)
  else return undefined
  if (rest.endsWith('.git')) rest = rest.slice(0, -'.git'.length)
  const parts = rest.split('/').filter((part) => part !== '')
  const owner = parts[0]
  const repo = parts[1]
  if (owner === undefined || repo === undefined || owner === '' || repo === '') return undefined
  return { owner, repo }
}

/**
 * The repository's Releases **list** page for a GitHub `origin` URL —
 * deliberately not the per-tag subpage: the dialog links the module name to the
 * list the reader can pick a version from. Non-GitHub remotes yield `undefined`.
 */
export function releasesPageUrl(origin: string | undefined): string | undefined {
  const repo = githubRepo(origin)
  return repo === undefined ? undefined : `https://github.com/${repo.owner}/${repo.repo}/releases`
}

/**
 * Fetch one tag's GitHub Release notes. Anonymous, bounded, and best-effort:
 * every failure (network, 404, non-GitHub JSON, empty body) yields `undefined`
 * so the caller falls back to the commit list without reporting an error.
 */
async function fetchRelease(owner: string, repo: string, tag: string): Promise<ReleaseNotes | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, GITHUB_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-auto-update' },
        signal: controller.signal,
      },
    )
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    if (payload === null || typeof payload !== 'object') return undefined
    const record = payload as { name?: unknown; body?: unknown }
    const body = typeof record.body === 'string' ? record.body : ''
    if (body.trim() === '') return undefined
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : tag
    return { tag, name, url: `https://github.com/${owner}/${repo}/releases/tag/${tag}`, body }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
