/**
 * Semver comparison for the auto-update host half.
 *
 * The npm plugin rows compare an install script's exact pin against the
 * registry's `latest` version, and that comparison alone decides whether the
 * row is behind. The host ships no third-party dependency, so this module keeps
 * the subset of semver precedence it needs: three numeric segments and the
 * prerelease rules. Build metadata is ignored, as semver prescribes for
 * precedence.
 *
 * The parsing is intentionally strict: a version is `major.minor.patch` with an
 * optional prerelease, and anything else is *not comparable*. Callers that only
 * need a yes/no answer use {@link isNewerVersion}, which treats "not comparable"
 * as "not newer" so a malformed pin can never make the row claim an update.
 */

/** A parsed version: the three numeric segments plus the prerelease identifiers. */
interface ParsedVersion {
  core: readonly [number, number, number]
  prerelease: readonly string[]
}

/**
 * Parse `major.minor.patch[-prerelease]` (`+build` metadata ignored). A leading
 * `v` is tolerated because git tags carry one; every other shape (two segments,
 * an empty segment, a non-numeric core) is invalid.
 * @param value - the version text.
 * @returns the parsed version, or `undefined` when `value` is not a version.
 */
function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return undefined
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  return { core: [major, minor, patch], prerelease }
}

/**
 * Compare two versions by semver precedence.
 *
 * - `a` lower than `b` returns a negative number, equal returns `0`, higher
 *   returns a positive number;
 * - a release version outranks every prerelease of the same core;
 * - prerelease identifiers compare left to right: numeric identifiers compare
 *   numerically and always rank below alphanumeric ones, alphanumeric ones
 *   compare by ASCII order, and a shorter identifier list ranks below a longer
 *   one that starts with the same identifiers;
 * - an unparseable argument yields `NaN`, so a caller can tell "not comparable"
 *   apart from "equal" instead of fabricating an order from the strings.
 *
 * @param a - left version.
 * @param b - right version.
 * @returns the precedence difference, or `NaN` when either side is not a version.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) return Number.NaN
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index]! - right.core[index]!
    if (difference !== 0) return difference
  }
  const leftPre = left.prerelease
  const rightPre = right.prerelease
  if (leftPre.length === 0 && rightPre.length === 0) return 0
  // 1.0.0 > 1.0.0-rc.1: a release version outranks any prerelease of it.
  if (leftPre.length === 0) return 1
  if (rightPre.length === 0) return -1
  const count = Math.max(leftPre.length, rightPre.length)
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftPre[index]
    const rightPart = rightPre[index]
    // A shorter list with the same prefix ranks lower.
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    // Numeric identifiers always rank below alphanumeric ones.
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/**
 * Whether `latest` is strictly newer than `current`.
 *
 * An unparseable pair never counts as an update: a row must not claim a move it
 * cannot compare, and a malformed registry answer must not grow the badge.
 *
 * @param latest - the registry's latest version.
 * @param current - the version pinned by the install script.
 * @returns true only when both parse and `latest > current`.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const result = compareVersions(latest, current)
  return !Number.isNaN(result) && result > 0
}
