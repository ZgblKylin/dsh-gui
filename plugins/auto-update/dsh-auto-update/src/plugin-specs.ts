/**
 * npm plugin rows from the `plugins/` install scripts.
 *
 * The desktop update panel's plugin rows are no longer git checkouts: after the
 * npm migration each `plugins/<wrapper>/install.mjs` pins its package(s) with an
 * exact `<name>@<version>` literal, and `installNpmPlugin` installs that pin.
 * This module scans those scripts and turns every extracted literal into one
 * row; `./check.ts` compares a row's pin with the registry's latest version and
 * `./update.ts` rewrites the literal in place and re-runs the wrapper.
 *
 * The convention the parser depends on: the spec is a `pkg@version` string
 * literal (single, double, or backtick quotes) inside a file that calls
 * `installNpmPlugin(`. A wrapper that builds the spec dynamically (from a file,
 * a range, `@latest`) produces no row — the source of truth must stay
 * greppable, as `plugins/README.md` says.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Prefix of the official packages: they move with the deepseek-harness row. */
const OFFICIAL_PACKAGE_PREFIX = '@deepseek-ai/dsh'

/** Marker identifying a wrapper installer; other `.mjs` files are not scanned. */
const INSTALL_MARKER = 'installNpmPlugin('

/** Directories skipped while collecting scripts (vendored installs, VCS data). */
const SKIPPED_DIRECTORIES = new Set(['node_modules'])

/**
 * One `<name>@<version>` string literal body: a bare or scoped package name
 * followed by an exact three-segment semver (prerelease allowed).
 */
const SPEC_PATTERN = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i

/** One npm plugin row: one package pinned by one install script. */
export interface PluginNpmRow {
  /** Stable row id: `npm:<packageName>`. */
  id: string
  /** npm package name, e.g. `@max-null/dsh-skill-mcp-center`. */
  packageName: string
  /** Install script, relative to the repository root, POSIX (`plugins/<wrapper>/install.mjs`). */
  installScript: string
  /** The wrapper id: the first directory segment under `plugins/`. */
  wrapperId: string
  /** Exact version the script pins. */
  pinnedVersion: string
  /** The literal as written in the script: `<packageName>@<pinnedVersion>`. */
  spec: string
}

/**
 * List every npm plugin row under `<root>/plugins`.
 *
 * Scans all `.mjs` files recursively (skipping `node_modules` and dot
 * directories), keeps only those that call `installNpmPlugin(`, strips their
 * comments, and extracts the `<name>@<version>` string literals. One row per
 * package per script (the same package pinned by two scripts keeps both rows:
 * each id repeats and the dialog shows the pin that decides that install).
 * Official `@deepseek-ai/dsh*` packages are excluded because they upgrade with
 * the deepseek-harness row.
 *
 * Rows are sorted by install script, then package name, so the dialog's row
 * order is stable across checks.
 *
 * @param root - repository root holding the `plugins/` directory.
 * @returns the rows; empty when `plugins/` is missing or holds no matching pin.
 */
export async function listPluginNpmRows(root: string): Promise<PluginNpmRow[]> {
  const scripts: string[] = []
  collectInstallScripts(join(root, 'plugins'), scripts)
  const rows: PluginNpmRow[] = []
  for (const scriptPath of scripts) {
    let source: string
    try {
      source = readFileSync(scriptPath, 'utf8')
    } catch {
      // An unreadable wrapper contributes no rows; the rest of the panel still
      // works, and a missing/corrupt file is not this detector's failure.
      continue
    }
    if (!source.includes(INSTALL_MARKER)) continue
    const installScript = toPosix(relative(root, scriptPath))
    const parts = installScript.split('/')
    // `plugins/<wrapper>/…`: anything directly under `plugins/` has no wrapper
    // directory to name and is not an installer.
    if (parts.length < 3) continue
    const wrapperId = parts[1]!
    const seen = new Set<string>()
    for (const literal of stringLiterals(stripComments(source))) {
      const spec = parseSpec(literal)
      if (spec === undefined) continue
      if (spec.packageName.startsWith(OFFICIAL_PACKAGE_PREFIX)) continue
      // One row per package per file; the first literal wins (a duplicate pin
      // elsewhere in the same script would be the same install target).
      if (seen.has(spec.packageName)) continue
      seen.add(spec.packageName)
      rows.push({
        id: `npm:${spec.packageName}`,
        packageName: spec.packageName,
        installScript,
        wrapperId,
        pinnedVersion: spec.pinnedVersion,
        spec: literal.trim(),
      })
    }
  }
  rows.sort((left, right) => {
    const byScript = compareText(left.installScript, right.installScript)
    return byScript !== 0 ? byScript : compareText(left.packageName, right.packageName)
  })
  return rows
}

/** Collect the absolute paths of every `.mjs` file under `dir`, recursively. */
function collectInstallScripts(dir: string, scripts: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      collectInstallScripts(join(dir, entry.name), scripts)
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      scripts.push(join(dir, entry.name))
    }
  }
}

/**
 * Remove `//` line comments and `/* *\/` block comments from JavaScript source
 * while leaving string and template literals untouched.
 *
 * A regex cannot do this safely (a `//` inside a URL literal is not a comment,
 * and the specs to extract are themselves literals), so this walks the source
 * with a tiny scanner. Template literals are treated as plain strings (their
 * `${…}` nests are not parsed) — sufficient for extracting `pkg@version`
 * literals, which never live inside a template expression.
 */
function stripComments(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === '/' && source[index + 1] === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      out += char
      index += 1
      while (index < source.length) {
        const inner = source[index]!
        out += inner
        index += 1
        if (inner === '\\') {
          // Copy the escaped character verbatim so `\'` never closes the string.
          if (index < source.length) {
            out += source[index]!
            index += 1
          }
          continue
        }
        if (inner === quote) break
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Extract the body of every single-quoted, double-quoted, and backtick string
 * literal in `source` (comments already stripped). Escaped quotes are copied
 * into the body unescaped — a spec literal never contains one.
 */
function stringLiterals(source: string): string[] {
  const literals: string[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char !== "'" && char !== '"' && char !== '`') {
      index += 1
      continue
    }
    const quote = char
    index += 1
    let body = ''
    while (index < source.length) {
      const inner = source[index]!
      index += 1
      if (inner === '\\') {
        const escaped = source[index]
        if (escaped !== undefined) {
          body += escaped
          index += 1
        }
        continue
      }
      if (inner === quote) {
        literals.push(body)
        break
      }
      body += inner
    }
  }
  return literals
}

/**
 * Parse one string literal body as a pinned spec.
 * @returns the package name and pinned version, or `undefined` when the body is
 *   not exactly `<name>@<three-segment semver>`.
 */
function parseSpec(literal: string): { packageName: string; pinnedVersion: string } | undefined {
  const match = SPEC_PATTERN.exec(literal.trim())
  if (match === null) return undefined
  return { packageName: match[1]!, pinnedVersion: match[2]! }
}

/** Sort two strings by code unit, independent of the host locale. */
function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Convert a platform path to the POSIX form the wire contract uses. */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}
