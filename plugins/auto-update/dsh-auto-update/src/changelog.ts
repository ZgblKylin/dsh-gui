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
 * npm plugin rows (`id` starting with `npm:`) use a different changelog: the
 * row's version range is the install script's pin to the registry's latest
 * version, so there is no commit range to read. Instead the package
 * repository's GitHub Releases between the two versions are collected, and the
 * dialog renders those notes; {@link selectNpmReleases} does the range filter
 * locally. A GitHub failure here *is* reported in `error`, because unlike a git
 * row there is no commit list to fall back to.
 *
 * Failure policy (contract §4.3): a GitHub lookup that fails, 404s, or returns
 * a release without a body is *not* an error — it silently falls back to the
 * commit list. `error` is reserved for local git failures, and an
 * unresolvable request (unknown project) is a 400 via
 * {@link ChangelogRequestError}.
 */

import { gitFailure, gitOutput, gitVersion, isGitRepo, localDefaultBranch, remoteDefaultBranch, runGit } from './git.ts'
import { githubReleasesUrl, npmPackageLatest } from './npm.ts'
import { isDirectory, listProjects } from './paths.ts'
import { listPluginNpmRows } from './plugin-specs.ts'
import { compareVersions } from './version.ts'

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

/** Row-id prefix of the npm plugin rows; the rest is the package name. */
const NPM_ROW_PREFIX = 'npm:'

/** Releases requested per GitHub page (the API's maximum). */
const GITHUB_RELEASES_PER_PAGE = 100

/** Pages fetched at most while collecting a package's releases. */
const GITHUB_RELEASES_MAX_PAGES = 3

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

/**
 * One GitHub Release of an npm package repository, as the dialog renders it.
 * Releases are ordered newest first by {@link selectNpmReleases}.
 */
export interface NpmRelease {
  /** Release tag, e.g. `v0.7.1`. */
  tag: string
  /** Release title; falls back to the tag when GitHub has none. */
  name: string
  /** The per-release page. */
  url: string
  /** Publish timestamp (ISO 8601); empty when GitHub did not record one. */
  publishedAt: string
  /** Release body markdown; may be empty. */
  body: string
}

/** The changelog response body. */
export interface ChangelogResult {
  id: string
  name: string
  /** Row source; a git row omits it (the client reads a missing value as git). */
  kind?: 'git' | 'npm'
  /** Human-readable local version; the install script's pin for an npm row. */
  from?: string
  /** Human-readable target version; the registry's latest for an npm row. */
  to?: string
  /** The ref the update would move to: a tag name, or `origin/<branch>`. */
  target?: string
  targetKind: 'tag' | 'commit' | 'npm'
  release?: ReleaseNotes
  /** npm rows only: the GitHub Releases inside `(from, to]`, newest first. */
  releases?: NpmRelease[]
  /** npm rows only: the package repository's Releases list page. */
  releaseUrl?: string
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
 * Build the changelog for one row's pending update.
 * @param root - repository root.
 * @param id - row id: `dsh-gui`, a `.gitmodules` name, or `npm:<packageName>`.
 * @param mode - the update target kind the user selected (git rows only; an npm
 *   row ignores it because its range is the pin-to-registry one).
 * @returns the response body; failures travel in `error`.
 * @throws {ChangelogRequestError} when no row has this id.
 */
export async function buildChangelog(root: string, id: string, mode: 'tag' | 'commit'): Promise<ChangelogResult> {
  if (id.startsWith(NPM_ROW_PREFIX)) return await buildNpmChangelog(root, id)
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
 * Extract `owner/repo` from a GitHub URL (https, git@, ssh, or git protocol
 * forms); another host yields `undefined`.
 */
export function githubRepo(url: string | undefined): { owner: string; repo: string } | undefined {
  const value = url?.trim()
  if (value === undefined || value === '') return undefined
  let rest: string
  if (value.startsWith('git@github.com:')) rest = value.slice('git@github.com:'.length)
  else if (value.startsWith('https://github.com/')) rest = value.slice('https://github.com/'.length)
  else if (value.startsWith('http://github.com/')) rest = value.slice('http://github.com/'.length)
  else if (value.startsWith('ssh://git@github.com/')) rest = value.slice('ssh://git@github.com/'.length)
  else if (value.startsWith('git://github.com/')) rest = value.slice('git://github.com/'.length)
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

/**
 * A GitHub release entry as fetched, before the version-range filter. The
 * `prerelease` flag is kept only while fetching: the dialog highlights the
 * range's releases, not GitHub's prerelease marking.
 */
interface FetchedRelease extends NpmRelease {
  prerelease: boolean
}

/** A releases-page fetch: the entries, or a message for the row's `error`. */
type ReleaseListResult = { releases: FetchedRelease[] } | { error: string }

/** A whole tag that already *is* a version once a leading `v` is dropped. */
const SEMVER_TEXT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** A version-shaped substring of a tag like `release-1.2.3`. */
const SEMVER_SUBSTRING = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g

/**
 * The version a release tag denotes: drop a leading `v`/`V`, use the whole
 * string when that is semver, and otherwise take the last version-shaped
 * substring (`release-1.2.3` → `1.2.3`). `undefined` when the tag names no
 * version.
 */
export function versionFromTag(tag: string): string | undefined {
  const value = tag.trim()
  if (value === '') return undefined
  const withoutPrefix = value.startsWith('v') || value.startsWith('V') ? value.slice(1) : value
  if (SEMVER_TEXT.test(withoutPrefix)) return withoutPrefix
  const matches = withoutPrefix.match(SEMVER_SUBSTRING)
  return matches === null || matches.length === 0 ? undefined : matches[matches.length - 1]
}

/**
 * The releases inside the update range `(from, to]`, newest published first.
 * `from` is the installed version and `to` the registry's latest, so the
 * range's endpoints follow semver order rather than the release list's order;
 * a release whose tag names no version is skipped.
 */
export function selectNpmReleases(releases: readonly NpmRelease[], from: string, to: string): NpmRelease[] {
  const matched: NpmRelease[] = []
  for (const release of releases) {
    const version = versionFromTag(release.tag)
    if (version === undefined) continue
    if (!(compareVersions(from, version) < 0)) continue
    if (!(compareVersions(version, to) <= 0)) continue
    matched.push({
      tag: release.tag,
      name: release.name,
      url: release.url,
      publishedAt: release.publishedAt,
      body: release.body,
    })
  }
  matched.sort((left, right) => {
    if (left.publishedAt === right.publishedAt) return 0
    return left.publishedAt < right.publishedAt ? 1 : -1
  })
  return matched
}

/** The owner/repo of an npm `repository` URL, `git+` transport prefix accepted. */
function packageRepository(repositoryUrl: string | undefined): { owner: string; repo: string } | undefined {
  const value = repositoryUrl?.trim()
  if (value === undefined || value === '') return undefined
  return githubRepo(value.startsWith('git+') ? value.slice('git+'.length) : value)
}

/** Describe a caught value for a user-facing message. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Normalize one GitHub release JSON entry; entries without a tag are dropped. */
function parseReleaseItem(entry: unknown): FetchedRelease | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  const tag = typeof record.tag_name === 'string' ? record.tag_name.trim() : ''
  if (tag === '') return undefined
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : tag
  const url = typeof record.html_url === 'string' ? record.html_url.trim() : ''
  const publishedAt = typeof record.published_at === 'string' ? record.published_at.trim() : ''
  const body = typeof record.body === 'string' ? record.body : ''
  return { tag, name, url, publishedAt, body, prerelease: record.prerelease === true }
}

/**
 * Fetch up to {@link GITHUB_RELEASES_MAX_PAGES} pages of a repository's
 * releases, newest first. Every failure is reported as a message, because an
 * npm row has no commit list to fall back to.
 */
async function fetchReleaseList(owner: string, repo: string): Promise<ReleaseListResult> {
  const collected: FetchedRelease[] = []
  for (let page = 1; page <= GITHUB_RELEASES_MAX_PAGES; page += 1) {
    let payload: unknown
    try {
      const response = await fetch(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases?per_page=${GITHUB_RELEASES_PER_PAGE}&page=${page}`,
        {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-auto-update' },
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        },
      )
      if (!response.ok) return { error: `GitHub Releases 请求失败（HTTP ${response.status}）` }
      payload = await response.json()
    } catch (error) {
      return { error: `GitHub Releases 请求失败：${errorText(error)}` }
    }
    if (!Array.isArray(payload)) return { error: 'GitHub Releases 返回格式无法解析' }
    for (const entry of payload) {
      const release = parseReleaseItem(entry)
      if (release !== undefined) collected.push(release)
    }
    // A short page is the last page.
    if (payload.length < GITHUB_RELEASES_PER_PAGE) break
  }
  return { releases: collected }
}

/** The npm row's result scaffold: the pin is `from`, the latest is `to`. */
function npmChangelogResult(id: string, packageName: string, pinnedVersion: string): ChangelogResult {
  return {
    id,
    name: packageName,
    kind: 'npm',
    from: pinnedVersion,
    // The latest version is filled in once the registry answered; the empty
    // string keeps the field present for the client while it is unknown.
    to: '',
    targetKind: 'npm',
    releases: [],
    commits: [],
    count: 0,
    diffstat: '',
    truncated: false,
  }
}

/**
 * Build an npm plugin row's changelog: the package repository's GitHub Releases
 * inside `(pinned, registry latest]`.
 *
 * The range's two ends come from the install script and the registry rather than
 * from local git, so a lookup failure is reported in `error` — there is no
 * commit list to fall back to.
 * @param root - repository root.
 * @param id - the row id, `npm:<packageName>`.
 * @throws {ChangelogRequestError} when the id or its install-script pin cannot be resolved.
 */
async function buildNpmChangelog(root: string, id: string): Promise<ChangelogResult> {
  const packageName = id.slice(NPM_ROW_PREFIX.length).trim()
  if (packageName === '') throw new ChangelogRequestError('npm 行的 id 缺少包名')
  const plugin = (await listPluginNpmRows(root)).find((row) => row.packageName === packageName)
  if (plugin === undefined) throw new ChangelogRequestError('安装脚本中找不到该 npm 插件的 pin')
  const result = npmChangelogResult(id, packageName, plugin.pinnedVersion)

  const answers = await npmPackageLatest([packageName])
  const answer = answers[0]
  if (answer === undefined) {
    result.error = 'npm 版本查询失败：未返回结果'
    return result
  }
  if (answer.error !== undefined) {
    result.error = `npm 版本查询失败：${answer.error}`
    return result
  }
  const latest = answer.latest?.trim()
  if (latest === undefined || latest === '') {
    result.error = 'npm 版本查询失败：未返回最新版本'
    return result
  }
  result.to = latest

  const releaseUrl = githubReleasesUrl(answer.repositoryUrl)
  if (releaseUrl === undefined) {
    result.error = '该 npm 包未声明 GitHub repository'
    return result
  }
  result.releaseUrl = releaseUrl
  const repo = packageRepository(answer.repositoryUrl)
  if (repo === undefined) {
    result.error = '该 npm 包未声明 GitHub repository'
    return result
  }

  const fetched = await fetchReleaseList(repo.owner, repo.repo)
  if ('error' in fetched) {
    result.error = fetched.error
    return result
  }
  const matched = selectNpmReleases(fetched.releases, plugin.pinnedVersion, latest)
  result.releases = matched
  result.count = matched.length
  return result
}
