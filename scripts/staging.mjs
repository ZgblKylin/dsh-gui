#!/usr/bin/env node
/**
 * dsh-gui — upgrade staging workspace.
 *
 * `.staging/dsh-gui` holds a persistent clone of this repository together with
 * every submodule. A plugin or harness upgrade is validated there first: the
 * clone carries its own DSH_HOME (`.dsh/`), toolchain (`.toolchain/`), pnpm
 * store (`.pnpm-store/`), and build output, so a failed upgrade never touches
 * the installation this repository serves.
 *
 * Commands:
 *   ensure   create the clone: clone this repository, seed the submodule URLs
 *            this repository already resolved, initialize every submodule, and
 *            register the real origin URL as the `upstream` remote
 *   sync     move the clone onto this repository's current revision and re-pin
 *            its submodules
 *   status   report revisions, drift, and how far the clone's build has come
 *   clean    delete the clone
 *
 * Flags:
 *   --from-origin  ensure: clone the superproject from its origin URL instead
 *                  of this repository's working path
 *   --recreate     ensure: replace an existing clone
 *   --yes          clean: confirm deletion
 *
 * Run outside a sandbox: `git submodule` on Windows is a shell script and git's
 * local transport spawns the same shell, so both need a mode that permits
 * `sh.exe`. From a dsh session that means approving the elevation prompt for
 * this command; a normal terminal needs nothing.
 */

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { ROOT } from './toolchain.mjs'

const STAGING_ROOT = join(ROOT, '.staging')
const CLONE = join(STAGING_ROOT, 'dsh-gui')
/** Remote of the clone holding this repository's origin URL (the GitHub side). */
const UPSTREAM_REMOTE = 'upstream'
/** Build stages `status` probes inside the clone. */
const HARNESS = 'deepseek-harness'

function fail(message) {
  console.error(`\n[error] ${message}`)
  process.exit(1)
}

/**
 * Run `git <args>` in `dir` with stdout/stderr redirected to files instead of
 * pipes. dsh's Windows sandbox rejects child processes that capture through
 * pipes, so the file form keeps the captured diagnostics available inside a
 * sandboxed session.
 * @param {string[]} args - git arguments, without `-C`.
 * @param {string} dir - repository or clone to run in.
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, spawnError: Error|undefined }}
 */
function captureGit(args, dir = ROOT) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-gui-staging-'))
  const outPath = join(scratch, 'stdout')
  const errPath = join(scratch, 'stderr')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync('git', ['-C', dir, ...args], {
      cwd: ROOT,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const captured = {
    ok: result.status === 0 && result.error === undefined,
    status: result.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
    spawnError: result.error,
  }
  rmSync(scratch, { recursive: true, force: true })
  return captured
}

/**
 * Same as {@link captureGit}, but stderr stays on the terminal: a submodule
 * update is long enough that its progress belongs in front of the user.
 * @param {string[]} args - git arguments, without `-C`.
 * @param {string} dir - repository or clone to run in.
 * @returns {{ ok: boolean, status: number|null, stdout: string }}
 */
function captureGitStdout(args, dir = ROOT) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-gui-staging-'))
  const outPath = join(scratch, 'stdout')
  const outFd = openSync(outPath, 'w')
  let result
  try {
    result = spawnSync('git', ['-C', dir, ...args], {
      cwd: ROOT,
      stdio: ['ignore', outFd, 'inherit'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  } finally {
    closeSync(outFd)
  }
  const captured = { ok: result.status === 0 && result.error === undefined, status: result.status, stdout: readFileSync(outPath, 'utf8') }
  rmSync(scratch, { recursive: true, force: true })
  return captured
}

/** `git <args>` in `dir`, returning trimmed stdout, or null when it fails. */
function git(args, dir = ROOT) {
  const result = captureGit(args, dir)
  if (result.spawnError) fail(`cannot spawn git: ${result.spawnError.message}`)
  return result.ok ? result.stdout.trim() : null
}

/**
 * The sandbox leaves a recognizable signature when it blocks the Cygwin shell
 * that `git submodule` and the local git transport need, so the failure points
 * at the fix instead of at git.
 * @param {string} text - captured stdout/stderr of the failed command.
 * @returns {string} hint line, or an empty string for unrelated failures.
 */
function sandboxHint(text = '') {
  return /sh\.exe|CreateFileMapping/.test(text)
    ? '\nhint: the sandbox blocked sh.exe, which git submodule and the local git transport need.\n      Approve the elevation prompt for this command, or run it in a normal terminal.'
    : ''
}

/**
 * Fail before any clone work when the sandbox already blocks the shell that
 * every submodule operation runs on (`git submodule` is a shell script on
 * Windows).
 * @param {string} dir - repository or clone to probe in.
 */
function assertSubmoduleShell(dir) {
  const probe = captureGit(['submodule', 'status'], dir)
  const hint = sandboxHint(probe.stderr)
  if (!probe.ok && hint !== '') fail(`cannot run git submodule in ${dir}${hint}`)
}

/** Run a command with inherited stdio and fail on a non-zero exit. */
function stream(command, args, cwd = ROOT, what = `${command} ${args.join(' ')}`) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.error) fail(`cannot spawn ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${what} failed (exit ${result.status})`)
}

/** Refuse to nest a staging clone inside another one. */
function assertNotInsideStaging() {
  const segments = resolve(ROOT).split(sep)
  if (segments.includes('.staging')) {
    fail(`this is the staging clone itself (${ROOT}); run the command from the working repository`)
  }
}

function assertClone() {
  if (!existsSync(CLONE)) {
    fail(`the staging clone does not exist yet: ${CLONE} — run "npm run staging -- ensure" first`)
  }
  if (git(['rev-parse', '--is-inside-work-tree'], CLONE) !== 'true') {
    fail(`${CLONE} exists but is not a git repository — remove it or run "npm run staging -- ensure --recreate"`)
  }
}

/** `[submodule "<name>"]` entries of this repository's `.gitmodules`. */
function submoduleEntries() {
  const text = readFileSync(join(ROOT, '.gitmodules'), 'utf8')
  const entries = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[submodule')) {
      current = { name: line.replace(/^\[submodule\s*/, '').replace(/\]$/, '').replace(/^"|"$/g, ''), path: '', url: '' }
      entries.push(current)
    } else if (current && line.startsWith('path')) {
      current.path = line.split('=').slice(1).join('=').trim()
    } else if (current && line.startsWith('url')) {
      current.url = line.split('=').slice(1).join('=').trim()
    }
  }
  return entries
}

/**
 * Resolve a `.gitmodules` URL that is relative to the superproject's origin
 * (a submodule that records its source as `../<repo>` rather than an absolute
 * URL). No in-tree submodule uses that form today; the branch is kept because
 * `.gitmodules` is editable by hand.
 * @returns {string|null} absolute URL, or null when the base cannot be parsed.
 */
function resolveRelativeUrl(url, base) {
  if (!url.startsWith('./') && !url.startsWith('../')) return url
  if (base === null || base === '') return null
  if (/^https?:\/\//i.test(base)) {
    try {
      return new URL(url, base.endsWith('/') ? base : `${base}/`).toString()
    } catch {
      return null
    }
  }
  const basePath = base.startsWith('file://') ? base.slice('file://'.length) : base
  if (!isAbsolute(basePath)) return null
  return resolve(dirname(basePath), url).replace(/\\/g, '/')
}

/**
 * Every submodule URL this repository can resolve: the values already written
 * to its config win (they are absolute), then relative `.gitmodules` URLs are
 * resolved against the origin so the clone never inherits a path that only
 * exists relative to the working copy.
 * @returns {Map<string, string>} config key (`submodule.<name>.url`) -> URL.
 */
function resolvedSubmoduleUrls() {
  const urls = new Map()
  const configured = git(['config', '--get-regexp', '^submodule\\..*\\.url$']) ?? ''
  for (const line of configured.split(/\r?\n/)) {
    const match = line.trim().match(/^(submodule\..*?\.url)\s+(.+)$/)
    if (match) urls.set(match[1], match[2].trim())
  }
  const origin = git(['remote', 'get-url', 'origin'])
  for (const entry of submoduleEntries()) {
    const key = `submodule.${entry.name}.url`
    if (urls.has(key) || entry.url === '') continue
    const resolved = resolveRelativeUrl(entry.url, origin)
    if (resolved !== null) urls.set(key, resolved)
  }
  return urls
}

/** Copy this repository's resolved submodule URLs into the clone's config. */
function seedSubmoduleUrls() {
  const urls = resolvedSubmoduleUrls()
  if (urls.size === 0) return
  for (const [key, url] of urls) git(['config', key, url], CLONE)
}

/** Register the working repository's origin URL as the clone's `upstream`. */
function registerUpstreamRemote() {
  const origin = git(['remote', 'get-url', 'origin'])
  if (origin === null) return
  if (git(['remote', 'get-url', UPSTREAM_REMOTE], CLONE) !== null) return
  git(['remote', 'add', UPSTREAM_REMOTE, origin], CLONE)
}

function describeRevision(dir, revision = 'HEAD') {
  const tag = git(['describe', '--tags', '--exact-match', revision], dir)
  const short = git(['rev-parse', '--short', revision], dir)
  return tag ?? short ?? 'unknown'
}

/** Count worktree entries git reports as changed. */
function dirtyCount(dir) {
  const porcelain = git(['status', '--porcelain'], dir) ?? ''
  return porcelain === '' ? 0 : porcelain.split(/\r?\n/).filter((line) => line.trim() !== '').length
}

function removeClone() {
  if (!existsSync(CLONE)) return
  // Remove the module git directories first: on Windows a read-only file inside
  // them aborts the recursive delete otherwise.
  git(['submodule', 'deinit', '-f', '--all'], CLONE)
  rmSync(CLONE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

function ensure(options) {
  assertNotInsideStaging()
  if (existsSync(CLONE)) {
    if (!options.recreate) {
      console.log(`staging clone already present: ${CLONE}`)
      console.log('run "npm run staging -- sync" to move it onto this repository\'s revision')
      return
    }
    console.log(`removing the existing clone: ${CLONE}`)
    removeClone()
  }
  mkdirSync(STAGING_ROOT, { recursive: true })
  assertSubmoduleShell(ROOT)

  const source = options.fromOrigin ? git(['remote', 'get-url', 'origin']) : ROOT
  if (source === null) fail('this repository has no origin remote to clone from')
  console.log(`==> clone ${source}\n    -> ${CLONE}`)
  stream('git', ['clone', '--quiet', source, CLONE], ROOT, `git clone ${source}`)

  console.log('==> seed submodule URLs resolved by this repository')
  seedSubmoduleUrls()

  console.log('==> initialize submodules (git submodule update --init --recursive)')
  const update = captureGitStdout(['submodule', 'update', '--init', '--recursive', '--progress'], CLONE)
  if (!update.ok) {
    fail(`submodule initialization failed (exit ${update.status}) — rerun "npm run staging -- ensure --recreate" after fixing the cause`)
  }

  registerUpstreamRemote()
  console.log('\nstaging clone ready:')
  report()
  console.log(`
next:
  cd ${CLONE}
  npm run build -- --skip-exe     # harness install+build, plugins, presets (no cargo/exe)
  npm run build                   # full validation, including the entry exe`)
}

function sync() {
  assertNotInsideStaging()
  assertClone()
  assertSubmoduleShell(CLONE)
  const dirty = dirtyCount(CLONE)
  if (dirty > 0) {
    fail(`the staging clone has ${dirty} uncommitted change(s); commit or discard them in ${CLONE} before syncing`)
  }
  const sourceHead = git(['rev-parse', 'HEAD'])
  const sourceBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const sourceDirty = dirtyCount(ROOT)
  if (sourceHead === null) fail('cannot read this repository\'s HEAD')

  console.log('==> fetch origin (this repository)')
  const fetched = captureGitStdout(['fetch', '--prune', 'origin'], CLONE)
  if (!fetched.ok) fail(`git fetch failed (exit ${fetched.status}) in ${CLONE}`)
  if (sourceBranch !== null && sourceBranch !== 'HEAD') {
    console.log(`==> check out ${sourceBranch} at origin/${sourceBranch}`)
    if (git(['checkout', '--force', '-B', sourceBranch, `origin/${sourceBranch}`], CLONE) === null) {
      fail(`cannot check out origin/${sourceBranch} in ${CLONE}`)
    }
  } else {
    console.log(`==> detach the clone at ${sourceHead.slice(0, 7)}`)
    if (git(['checkout', '--force', '--detach', sourceHead], CLONE) === null) {
      fail(`cannot detach ${CLONE} at ${sourceHead.slice(0, 7)}`)
    }
  }

  seedSubmoduleUrls()
  console.log('==> re-pin submodules')
  const updated = captureGitStdout(['submodule', 'update', '--init', '--recursive'], CLONE)
  if (!updated.ok) fail(`submodule update failed (exit ${updated.status}) in ${CLONE}`)

  report()
  if (sourceDirty > 0) {
    console.log(`note: this repository has ${sourceDirty} uncommitted change(s); the clone carries its committed revision only.
      apply the same edits in the clone (or "git -C ${ROOT} diff HEAD > patch && git -C ${CLONE} apply patch")
      before validating them.`)
  }
}

/** Does the clone contain one of the listed paths? */
function present(...parts) {
  return existsSync(join(CLONE, ...parts))
}

/**
 * The runtime the clone is configured for, read from its own `harness.json`.
 * A clone that predates the manifest keeps the source runtime, matching both
 * resolvers' default.
 * @returns {{ runtime: 'npm' | 'source', version: string | null }}
 */
function cloneRuntime() {
  try {
    const config = JSON.parse(readFileSync(join(CLONE, 'harness.json'), 'utf8'))
    return {
      runtime: config?.runtime === 'npm' ? 'npm' : 'source',
      version: typeof config?.version === 'string' && config.version !== '' ? config.version : null,
    }
  } catch {
    return { runtime: 'source', version: null }
  }
}

function report() {
  const sourceHead = git(['rev-parse', 'HEAD'])
  const cloneHead = git(['rev-parse', 'HEAD'], CLONE)
  const lines = []
  lines.push(`  repository : ${ROOT}`)
  lines.push(`    HEAD     : ${describeRevision(ROOT)} (${sourceHead === null ? 'unknown' : sourceHead.slice(0, 7)})`)
  lines.push(`    worktree : ${dirtyCount(ROOT)} changed entr(ies)`)
  lines.push(`  clone      : ${CLONE}`)
  lines.push(`    HEAD     : ${describeRevision(CLONE)} (${cloneHead === null ? 'unknown' : cloneHead.slice(0, 7)})`)
  lines.push(`    worktree : ${dirtyCount(CLONE)} changed entr(ies)`)
  lines.push(`    revision : ${sourceHead === cloneHead ? 'matches the repository' : 'DIFFERS from the repository'}`)
  lines.push(`    remotes  : ${(git(['remote'], CLONE) ?? '').split(/\r?\n/).filter(Boolean).join(', ')}`)

  // Drift = the clone checked out a commit other than the one this repository
  // records for that submodule (a half-finished update, or a stale checkout).
  const drifted = []
  for (const entry of submoduleEntries()) {
    const recorded = git(['ls-tree', 'HEAD', entry.path]) ?? ''
    const pinned = recorded.split(/\s+/)[2] ?? ''
    const checkedOut = git(['rev-parse', 'HEAD'], join(CLONE, entry.path))
    if (checkedOut === null) drifted.push(`${entry.path}: missing`)
    else if (checkedOut !== pinned) drifted.push(`${entry.path}: ${checkedOut.slice(0, 7)} != ${pinned.slice(0, 7)}`)
  }
  lines.push(`    submodules: ${drifted.length === 0 ? `${submoduleEntries().length} pinned as recorded` : `DRIFT — ${drifted.join('; ')}`}`)

  lines.push('  clone build stages:')
  lines.push(`    toolchain        : ${present('.toolchain', 'node_modules', 'pnpm') ? 'bootstrapped' : 'missing'} (.toolchain/node_modules/pnpm/)`)
  lines.push(`    pnpm store       : ${present('.pnpm-store') ? 'present' : 'missing'} (.pnpm-store/)`)
  const runtime = cloneRuntime()
  if (runtime.runtime === 'npm') {
    const version = runtime.version ?? 'version from the submodule manifest'
    lines.push(`    dsh runtime      : npm (${version}) — ${present('.harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') ? 'installed' : 'missing'} (.harness/node_modules/@deepseek-ai/dsh/lib/bin.js)`)
    lines.push(`    harness submodule: not compiled (npm runtime); ${present(HARNESS, 'apps', 'cli', 'package.json') ? 'checkout present' : 'checkout missing'} (${HARNESS}/)`)
  } else {
    lines.push(`    dsh runtime      : source — ${present(HARNESS, 'apps', 'cli', 'lib', 'bin.js') ? 'built' : 'missing'} (${HARNESS}/apps/cli/lib/bin.js)`)
    lines.push(`    harness deps     : ${present(HARNESS, 'node_modules') ? 'installed' : 'missing'} (${HARNESS}/node_modules/)`)
  }
  lines.push(`    entry exe        : ${present('dsh-gui.exe') || present('dsh-gui') ? 'built' : 'not built'}`)
  lines.push(`    installed profile: ${present('.dsh', 'profiles', 'web', 'cordis.patch.yml') ? 'present' : 'absent'} (.dsh/profiles/web/)`)
  lines.push(`    agent presets    : ${present('.dsh', '.agent-presets') ? 'installed' : 'absent'} (.dsh/.agent-presets/)`)
  console.log(lines.join('\n'))
}

function clean(options) {
  assertNotInsideStaging()
  if (!existsSync(CLONE)) {
    console.log(`no staging clone at ${CLONE}`)
    return
  }
  if (!options.yes) {
    fail(`refusing to delete ${CLONE} without --yes`)
  }
  console.log(`==> remove ${CLONE}`)
  removeClone()
  console.log('staging clone removed')
}

function help() {
  console.log(`dsh-gui — upgrade staging workspace (.staging/dsh-gui).

Usage:
  node scripts/staging.mjs <command> [flags]
  npm run staging -- <command> [flags]     (from the repository root)

Commands:
  ensure   create the staging clone: clone this repository, seed the submodule
           URLs it resolved, initialize every submodule, add the origin URL as
           the "upstream" remote
  sync     fetch this repository into the clone, move it onto the repository's
           current revision, and re-pin its submodules
  status   report revisions, submodule drift, and the clone's build stages
  clean    delete the staging clone (requires --yes)

Flags:
  --from-origin  ensure: clone the superproject from its origin URL instead of
                 this repository's working path
  --recreate     ensure: replace an existing clone
  --yes          clean: confirm deletion

Validate an upgrade in the clone:
  npm run staging -- sync
  cd .staging/dsh-gui && npm run build -- --skip-exe
  cd .staging/dsh-gui && npm run build          # including the entry exe`)
}

function main() {
  const argv = process.argv.slice(2)
  const command = argv.find((arg) => !arg.startsWith('-')) ?? 'help'
  const flags = new Set(argv.filter((arg) => arg.startsWith('-')))
  const options = {
    fromOrigin: flags.has('--from-origin'),
    recreate: flags.has('--recreate'),
    yes: flags.has('--yes'),
  }
  switch (command) {
    case 'ensure': ensure(options); break
    case 'sync': sync(); break
    case 'status': assertClone(); report(); break
    case 'clean': clean(options); break
    case 'help':
    case '--help':
    case '-h': help(); break
    default:
      console.error(`unknown command: ${command}`)
      help()
      process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  fail(error.message)
}
