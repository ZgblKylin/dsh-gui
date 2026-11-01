#!/usr/bin/env node
/**
 * dsh-gui — upgrade verification worktree.
 *
 * `.staging/dsh-gui` is a git worktree of this repository, checked out on the
 * `staging/verify` work branch and carrying every submodule: a plugin or
 * harness upgrade is built and smoke-tested there before it is merged here.
 * `.staging/` is that worktree's runtime root, holding its DSH_HOME (`.dsh/`),
 * toolchain (`.toolchain/`), pnpm store (`.pnpm-store/`), harness install
 * (`.harness/`) and the entry exe, so a failed upgrade never touches the
 * installation this repository serves. The copy lives inside this repository,
 * which keeps its files and work-branch commits inside the session workspace.
 *
 * The worktree shares this repository's object database and refs, so creating
 * and syncing it never fetches the superproject history again.
 *
 * Commands:
 *   ensure   create the worktree on the work branch and initialize every
 *            submodule
 *   sync     align the work branch with this repository's current HEAD and
 *            re-pin the submodules
 *   status   report revisions, the work branch, submodule drift, and how far
 *            the worktree's build has come
 *   clean    delete the worktree and its runtime directories
 *
 * Flags:
 *   --recreate     ensure: replace an existing worktree
 *   --rebase       sync: rebase the work branch onto this repository's HEAD
 *                  when it carries unmerged commits
 *   --yes          clean: confirm deletion
 *   --branch       clean: also delete the work branch
 *
 * `git worktree add` runs git-lfs smudge filters, and `git submodule` is a
 * shell script on Windows: both need a mode that permits spawning `sh.exe`.
 * From a dsh session, approve the elevation prompt for this command; a normal
 * terminal needs nothing.
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
import { join, resolve, sep } from 'node:path'
import { BIN_NAME, ROOT, RUNTIME_ROOT } from './toolchain.mjs'

/** Upgrade-validation workspace: inside this repository, so the sandbox already covers it. */
const STAGING_ROOT = join(ROOT, '.staging')
/** The repository's verification worktree. */
const WORKTREE = join(STAGING_ROOT, 'dsh-gui')
/** Runtime root of the worktree: the staging directory itself (nested checkout layout). */
const WORKTREE_RUNTIME = STAGING_ROOT
/** Work branch the verification worktree is checked out on. */
const WORK_BRANCH = 'staging/verify'
/** Runtime directories `clean` deletes under the staging root. */
const RUNTIME_DIRS = ['.toolchain', '.pnpm-store', '.harness', '.dsh', 'dsh-gui.exe', 'dsh-gui']

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
 * @param {string} dir - repository or worktree to run in.
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
 * @param {string} dir - repository or worktree to run in.
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
 * Run a git command whose failure should stop the script, printing the captured
 * diagnostics before the error so a sandbox refusal is not reported blind.
 * @param {string[]} args - git arguments, without `-C`.
 * @param {string} dir - repository or worktree to run in.
 * @param {string} what - operation name used in the error message.
 * @returns {string} trimmed stdout of the successful command.
 */
function runGit(args, dir, what) {
  const result = captureGit(args, dir)
  if (result.spawnError) fail(`cannot spawn git: ${result.spawnError.message}`)
  if (result.ok) return result.stdout.trim()
  const output = `${result.stdout}${result.stderr}`.trim()
  if (output !== '') console.error(output)
  fail(`${what} failed (exit ${result.status})${sandboxHint(result.stderr)}`)
}

/**
 * The sandbox leaves a recognizable signature when it blocks the Cygwin shell
 * that `git worktree add`'s git-lfs filters and `git submodule` need, so the
 * failure points at the fix instead of at git.
 * @param {string} text - captured stdout/stderr of the failed command.
 * @returns {string} hint line, or an empty string for unrelated failures.
 */
function sandboxHint(text = '') {
  return /sh\.exe|CreateFileMapping/.test(text)
    ? '\nhint: the sandbox blocked sh.exe, which git-lfs filters (git worktree add) and git submodule need.\n      Approve the elevation prompt for this command, or run it in a normal terminal.'
    : ''
}

/**
 * Fail before any worktree work when the sandbox already blocks the shell that
 * every submodule operation runs on (`git submodule` is a shell script on
 * Windows).
 * @param {string} dir - repository or worktree to probe in.
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

/** Refuse to nest a verification worktree inside another one. */
function assertNotInsideStaging() {
  const segments = resolve(ROOT).split(sep)
  if (segments.includes('.staging')) {
    fail(`this is the verification worktree itself (${ROOT}); run the command from the working repository`)
  }
}

/** Every worktree git records for this repository: `{ path, branch }`. */
function worktrees() {
  const text = git(['worktree', 'list', '--porcelain']) ?? ''
  const entries = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('worktree ')) {
      current = { path: resolve(raw.slice('worktree '.length).trim()), branch: null }
      entries.push(current)
    } else if (current && raw.startsWith('branch ')) {
      current.branch = raw.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  return entries
}

/** The registered worktree record for {@link WORKTREE}, or null. */
function worktreeEntry() {
  return worktrees().find((entry) => entry.path === resolve(WORKTREE)) ?? null
}

/** Branch the verification worktree is checked out on, or null when detached. */
function worktreeBranch() {
  return worktreeEntry()?.branch ?? null
}

function branchExists(name = WORK_BRANCH) {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null
}

function assertWorktree() {
  if (!existsSync(WORKTREE)) {
    fail(`the verification worktree does not exist yet: ${WORKTREE} — run "npm run staging -- ensure" first`)
  }
  // `rev-parse --is-inside-work-tree` is also true for any directory inside the
  // main work tree, so the registration check is what rules out a plain
  // directory left at this path.
  if (worktreeEntry() === null || git(['rev-parse', '--is-inside-work-tree'], WORKTREE) !== 'true') {
    fail(`${WORKTREE} exists but is not a worktree of this repository — remove it or run "npm run staging -- ensure --recreate"`)
  }
}

/**
 * Whether `ancestor` is contained in `descendant` (`git merge-base --is-ancestor`).
 * @param {string} ancestor - revision name.
 * @param {string} descendant - revision name.
 * @returns {boolean} true when every commit of `ancestor` is in `descendant`.
 */
function isAncestor(ancestor, descendant) {
  const result = captureGit(['merge-base', '--is-ancestor', ancestor, descendant])
  if (result.spawnError) fail(`cannot spawn git: ${result.spawnError.message}`)
  if (result.status === 1) return false
  const output = `${result.stdout}${result.stderr}`.trim()
  if (!result.ok) {
    if (output !== '') console.error(output)
    fail(`git merge-base --is-ancestor failed (exit ${result.status})`)
  }
  return true
}

/**
 * How many commits `branch` carries that this repository's HEAD does not.
 * @param {string} branch - branch name.
 * @returns {number|null} commit count, or null when git cannot compute it.
 */
function unmergedCount(branch) {
  const count = git(['rev-list', '--count', `HEAD..refs/heads/${branch}`])
  if (count === null) return null
  const parsed = Number.parseInt(count, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function describeRevision(dir, revision = 'HEAD') {
  const tag = git(['describe', '--tags', '--exact-match', revision], dir)
  const short = git(['rev-parse', '--short', revision], dir)
  return tag ?? short ?? 'unknown'
}

/** Count working-tree entries git reports as changed. */
function dirtyCount(dir) {
  const porcelain = git(['status', '--porcelain'], dir) ?? ''
  return porcelain === '' ? 0 : porcelain.split(/\r?\n/).filter((line) => line.trim() !== '').length
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

/** Remove the worktree, keeping the work branch: `git worktree prune`, then `remove --force`. */
function removeWorktree() {
  // A worktree deleted by hand keeps a stale administrative entry; prune drops it
  // so the remove below runs against a consistent record.
  git(['worktree', 'prune'])
  if (worktreeEntry() !== null) {
    runGit(['worktree', 'remove', '--force', WORKTREE], ROOT, `git worktree remove ${WORKTREE}`)
  }
  // A plain directory at the same path (an interrupted creation) has no worktree
  // record to remove; delete it directly so `ensure` can start from scratch.
  if (existsSync(WORKTREE)) {
    rmSync(WORKTREE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

/** Does `base` contain one of the listed paths? */
function presentAt(base, ...parts) {
  return existsSync(join(base, ...parts))
}

function report() {
  const repoHead = git(['rev-parse', 'HEAD'])
  const worktreeHead = git(['rev-parse', 'HEAD'], WORKTREE)
  const branch = worktreeBranch()
  const unmerged = branch === null ? null : unmergedCount(branch)
  const lines = []
  lines.push(`  repository  : ${ROOT}`)
  lines.push(`    HEAD      : ${describeRevision(ROOT)} (${repoHead === null ? 'unknown' : repoHead.slice(0, 7)})`)
  lines.push(`    changes   : ${dirtyCount(ROOT)} changed entr(ies)`)
  lines.push(`  worktree    : ${WORKTREE}`)
  lines.push(`    branch    : ${branch ?? 'detached HEAD'}`)
  lines.push(`    HEAD      : ${describeRevision(WORKTREE)} (${worktreeHead === null ? 'unknown' : worktreeHead.slice(0, 7)})`)
  lines.push(`    changes   : ${dirtyCount(WORKTREE)} changed entr(ies)`)
  lines.push(`    unmerged  : ${unmerged === null ? 'unknown' : `${unmerged} commit(s) not in this repository's HEAD`}`)

  // Drift = the worktree checked out a commit other than the one this repository
  // records for that submodule (a half-finished update, or a stale checkout).
  const entries = submoduleEntries()
  const drifted = []
  for (const entry of entries) {
    const recorded = git(['ls-tree', 'HEAD', entry.path]) ?? ''
    const pinned = recorded.split(/\s+/)[2] ?? ''
    const checkedOut = git(['rev-parse', 'HEAD'], join(WORKTREE, entry.path))
    if (checkedOut === null) drifted.push(`${entry.path}: missing`)
    else if (checkedOut !== pinned) drifted.push(`${entry.path}: ${checkedOut.slice(0, 7)} != ${pinned.slice(0, 7)}`)
  }
  lines.push(`    submodules: ${drifted.length === 0 ? `${entries.length} pinned as recorded` : `DRIFT — ${drifted.join('; ')}`}`)

  lines.push(`  worktree runtime: ${WORKTREE_RUNTIME}`)
  lines.push(`    toolchain : ${presentAt(WORKTREE_RUNTIME, '.toolchain', 'node_modules', 'pnpm') ? 'bootstrapped' : 'missing'} (.staging/.toolchain/node_modules/pnpm/)`)
  lines.push(`    pnpm store: ${presentAt(WORKTREE_RUNTIME, '.pnpm-store') ? 'present' : 'missing'} (.staging/.pnpm-store/)`)
  lines.push(`    harness   : ${presentAt(WORKTREE_RUNTIME, '.harness') ? 'present' : 'missing'} (.staging/.harness/)`)
  lines.push(`    entry exe : ${presentAt(WORKTREE_RUNTIME, BIN_NAME) ? 'built' : 'not built'} (.staging/${BIN_NAME})`)
  lines.push(`    web profile: ${presentAt(WORKTREE_RUNTIME, '.dsh', 'profiles', 'web') ? 'present' : 'absent'} (.staging/.dsh/profiles/web/)`)
  console.log(lines.join('\n'))
}

function ensure(options) {
  assertNotInsideStaging()
  // A worktree directory deleted by hand leaves its registration behind; prune
  // it so the existence check below reflects the disk.
  git(['worktree', 'prune'])
  if (worktreeEntry() !== null || existsSync(WORKTREE)) {
    if (!options.recreate) {
      console.log(`the verification worktree already exists: ${WORKTREE}`)
      console.log('run "npm run staging -- sync" to align its work branch with this repository\'s HEAD,')
      console.log('or "npm run staging -- ensure --recreate" to replace it')
      return
    }
    console.log(`==> remove the existing verification worktree (the work branch ${WORK_BRANCH} is kept)`)
    removeWorktree()
  }
  mkdirSync(STAGING_ROOT, { recursive: true })
  const head = git(['rev-parse', 'HEAD'])
  if (head === null) fail('cannot read this repository\'s HEAD')
  assertSubmoduleShell(ROOT)

  if (branchExists()) {
    console.log(`==> add the worktree on the existing work branch ${WORK_BRANCH}`)
    runGit(['worktree', 'add', WORKTREE, WORK_BRANCH], ROOT, `git worktree add ${WORKTREE} ${WORK_BRANCH}`)
  } else {
    console.log(`==> add the worktree on a new work branch ${WORK_BRANCH} at ${describeRevision(ROOT)} (${head.slice(0, 7)})`)
    runGit(['worktree', 'add', '-b', WORK_BRANCH, WORKTREE, 'HEAD'], ROOT, `git worktree add -b ${WORK_BRANCH} ${WORKTREE} HEAD`)
  }

  console.log('==> initialize submodules (git -C .staging/dsh-gui submodule update --init --recursive)')
  const update = captureGitStdout(['submodule', 'update', '--init', '--recursive', '--progress'], WORKTREE)
  if (!update.ok) {
    fail(`submodule initialization failed (exit ${update.status}) — rerun "npm run staging -- ensure --recreate" after fixing the cause`)
  }

  console.log('\nthe verification worktree is ready:')
  report()
  console.log(`
next:
  cd ${WORKTREE}
  # set DSH_HOME to ${join(WORKTREE_RUNTIME, '.dsh')} so the build does not inherit the installed home
  npm run build -- --skip-exe     # dsh runtime + plugins + presets (no cargo/exe)
  npm run build                   # full validation, including the entry exe`)
}

function sync(options) {
  assertNotInsideStaging()
  assertWorktree()
  const branch = worktreeBranch()
  // Never reset or rebase a branch other than the work branch: the worktree is
  // defined as checked out on it, and moving anything else would be a surprise.
  if (branch !== WORK_BRANCH) {
    fail(`the verification worktree is checked out on ${branch ?? 'a detached HEAD'}, not ${WORK_BRANCH} — check out ${WORK_BRANCH} in ${WORKTREE} before syncing`)
  }
  const dirty = dirtyCount(WORKTREE)
  if (dirty > 0) {
    fail(`the verification worktree has ${dirty} uncommitted change(s); commit or discard them on ${branch} in ${WORKTREE} before syncing`)
  }
  assertSubmoduleShell(WORKTREE)

  const head = git(['rev-parse', 'HEAD'])
  if (head === null) fail('cannot read this repository\'s HEAD')
  const repoDirty = dirtyCount(ROOT)
  if (repoDirty > 0) {
    console.log(`note: this repository has ${repoDirty} uncommitted change(s); the worktree carries its committed revision only.`)
  }

  if (isAncestor(branch, 'HEAD')) {
    console.log(`==> reset ${branch} to this repository's HEAD ${describeRevision(ROOT)} (${head.slice(0, 7)})`)
    runGit(['reset', '--hard', head], WORKTREE, 'git reset --hard')
  } else if (options.rebase) {
    console.log(`==> rebase ${branch} onto this repository's HEAD ${describeRevision(ROOT)} (${head.slice(0, 7)})`)
    const rebase = captureGit(['rebase', head], WORKTREE)
    if (!rebase.ok) {
      const output = `${rebase.stdout}${rebase.stderr}`.trim()
      if (output !== '') console.error(output)
      // Leave the worktree in its pre-rebase state: a half-resolved conflict is
      // worse than the failure itself.
      captureGit(['rebase', '--abort'], WORKTREE)
      fail(`git rebase failed (exit ${rebase.status}); the worktree was returned to its pre-rebase state with "git rebase --abort"`)
    }
  } else {
    const unmerged = unmergedCount(branch) ?? 'some'
    fail(`the work branch ${branch} carries ${unmerged} commit(s) this repository's HEAD does not contain.
       rebase it onto the repository HEAD with "npm run staging -- sync --rebase", or merge the work branch back first:
       git -C ${ROOT} merge --no-ff ${branch}`)
  }

  console.log('==> re-pin submodules (git -C .staging/dsh-gui submodule update --init --recursive)')
  const update = captureGitStdout(['submodule', 'update', '--init', '--recursive'], WORKTREE)
  if (!update.ok) fail(`submodule update failed (exit ${update.status}) in ${WORKTREE}`)
  report()
}

function clean(options) {
  assertNotInsideStaging()
  if (!options.yes) {
    fail(`refusing to delete the verification worktree and its runtime directories without --yes`)
  }

  console.log(`==> remove the worktree: ${WORKTREE}`)
  removeWorktree()
  console.log('==> remove the worktree runtime directories')
  for (const name of RUNTIME_DIRS) {
    const target = join(STAGING_ROOT, name)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }

  if (options.branch) {
    if (branchExists()) {
      console.log(`==> delete the work branch ${WORK_BRANCH}`)
      runGit(['branch', '-D', WORK_BRANCH], ROOT, `git branch -D ${WORK_BRANCH}`)
    }
  } else if (branchExists()) {
    console.log(`kept the work branch ${WORK_BRANCH}: it can carry verification commits that are not merged yet`)
    console.log('pass --branch to delete it as well')
  }

  // The old workspace lived beside the repository, i.e. in the runtime root.
  // Only report it when that is a different path from the staging root here.
  const legacy = join(RUNTIME_ROOT, '.staging')
  if (resolve(legacy) !== resolve(STAGING_ROOT)) {
    console.log(`note: ${legacy} is the former repository-external staging workspace; this script no longer maintains it.`)
    console.log('      confirm it holds nothing you need, then delete it manually.')
  }
  console.log('the verification worktree and its runtime directories are removed')
}

function help() {
  console.log(`dsh-gui — upgrade verification worktree (.staging/dsh-gui).

Usage:
  node scripts/staging.mjs <command> [flags]
  npm run staging -- <command> [flags]     (from the repository root)

Commands:
  ensure   create the verification worktree on the work branch ${WORK_BRANCH}
           and initialize every submodule
  sync     align the work branch with this repository's current HEAD and re-pin
           the submodules
  status   report revisions, the work branch, submodule drift, and the
           worktree's build stages
  clean    delete the worktree and its runtime directories (requires --yes)

Flags:
  --recreate     ensure: replace an existing worktree (the work branch is kept)
  --rebase       sync: rebase the work branch onto this repository's HEAD when
                 it carries unmerged commits
  --yes          clean: confirm deletion
  --branch       clean: also delete the work branch ${WORK_BRANCH}

Validate an upgrade in the verification worktree:
  npm run staging -- sync
  cd .staging/dsh-gui
  # set DSH_HOME to <repository root>/.staging/.dsh before building
  npm run build -- --skip-exe
  npm run build          # including the entry exe`)
}

function main() {
  const argv = process.argv.slice(2)
  const command = argv.find((arg) => !arg.startsWith('-')) ?? 'help'
  const flags = new Set(argv.filter((arg) => arg.startsWith('-')))
  const options = {
    recreate: flags.has('--recreate'),
    rebase: flags.has('--rebase'),
    yes: flags.has('--yes'),
    branch: flags.has('--branch'),
  }
  switch (command) {
    case 'ensure': ensure(options); break
    case 'sync': sync(options); break
    case 'status': assertWorktree(); report(); break
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
