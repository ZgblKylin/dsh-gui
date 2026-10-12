/**
 * dsh-gui — resolve the proxy this chain's Node downloads must use.
 *
 * Node's global `fetch` (undici) carries the downloads a registry mirror cannot
 * serve: Electron's installer, `@electron/get` archives and the packaging chain's
 * locked primary-runtime assets. undici reads neither npm's `proxy` configuration
 * nor `HTTP_PROXY` / `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY` selects its
 * environment-proxy agent, so a proxy configured only for other tools stays
 * bypassed and those downloads go direct. This module turns the proxy the
 * environment names — or, when the environment names none, the Windows system
 * settings — into the overrides that make the chain honor it.
 */

import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Proxy variables the environment can carry, in the order the chain reports them. */
const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

/**
 * Hosts that must stay direct. The packaging chain's runtime smoke starts a Host
 * on 127.0.0.1 and fetches it, so a proxy applied to the loopback interface would
 * fail the build it is meant to unblock.
 */
const LOCAL_BYPASS = ['localhost', '127.0.0.1', '::1']

/** Registry key holding the per-user proxy the Windows settings app writes. */
const WINDOWS_INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/**
 * Read one environment value as a configured proxy.
 * @param {NodeJS.ProcessEnv} env - environment to read.
 * @param {string} name - variable name.
 * @returns {string | undefined} trimmed value, or undefined when unset or blank.
 */
function envValue(env, name) {
  const raw = env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Normalize a proxy address into a URL Node's environment-proxy agent accepts.
 * @param {string | undefined} raw - configured address, with or without a scheme.
 * @returns {string | undefined} HTTP(S) URL, or undefined for a scheme Node cannot proxy.
 */
function normalizeProxy(raw) {
  if (raw === undefined) return undefined
  const text = raw.trim()
  if (text === '') return undefined
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return `http://${text}`
  return /^https?:\/\//iu.test(text) ? text : undefined
}

/**
 * Build the `NO_PROXY` overrides merging the caller's list with the loopback hosts.
 * @param {NodeJS.ProcessEnv} env - environment carrying a possible existing list.
 * @param {string[]} [extra] - additional bypass entries, such as Windows' own list.
 * @returns {{ NO_PROXY: string, no_proxy: string }} both spellings of the merged list.
 */
function noProxyOverrides(env, extra = []) {
  const merged = (envValue(env, 'NO_PROXY') ?? envValue(env, 'no_proxy') ?? '')
    .split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  for (const entry of [...LOCAL_BYPASS, ...extra]) {
    if (!merged.includes(entry)) merged.push(entry)
  }
  const joined = merged.join(',')
  return { NO_PROXY: joined, no_proxy: joined }
}

/**
 * Run a command with stdout written to a file instead of a pipe. The dsh Windows
 * sandbox rejects child processes that capture through pipes, so the registry
 * query has to be captured through files.
 * @param {string} command - executable to spawn.
 * @param {string[]} args - arguments, verbatim.
 * @returns {{ ok: boolean, stdout: string }} whether the command succeeded and what it wrote.
 */
function captureCommand(command, args) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-gui-proxy-'))
  const outPath = join(scratch, 'stdout')
  const fd = openSync(outPath, 'w')
  let status
  let error
  try {
    const result = spawnSync(command, args, { stdio: ['ignore', fd, 'ignore'] })
    status = result.status
    error = result.error
  } finally {
    closeSync(fd)
  }
  const stdout = readFileSync(outPath, 'utf8')
  rmSync(scratch, { recursive: true, force: true })
  return { ok: status === 0 && error === undefined, stdout }
}

/**
 * Parse the values `reg query` prints for the Internet Settings key.
 * @param {string} stdout - captured registry output.
 * @returns {{ enabled: boolean, server: string | undefined, bypass: string[] }} proxy flag, server value and bypass entries.
 */
export function parseWindowsSettings(stdout) {
  const values = new Map()
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s+(\S+)\s+REG_(?:DWORD|SZ|EXPAND_SZ)\s+(.*?)\s*$/u.exec(line)
    if (match !== null) values.set(match[1], match[2])
  }
  const override = values.get('ProxyOverride') ?? ''
  return {
    enabled: values.get('ProxyEnable') === '0x1',
    server: values.get('ProxyServer'),
    bypass: override.split(';').map((entry) => entry.trim()).filter((entry) => entry !== ''),
  }
}

/**
 * Read the Windows per-user proxy settings.
 * @param {(command: string, args: string[]) => { ok: boolean, stdout: string }} [capture] - command capture to use.
 * @returns {{ enabled: boolean, server: string | undefined, bypass: string[] } | undefined} settings, or undefined when unreadable.
 */
export function windowsProxySettings(capture = captureCommand) {
  const result = capture('reg', ['query', WINDOWS_INTERNET_SETTINGS])
  if (!result.ok) return undefined
  return parseWindowsSettings(result.stdout)
}

/**
 * Split a Windows `ProxyServer` value into the proxy of each HTTP scheme.
 *
 * The settings app writes either a bare `host:port` serving every protocol or a
 * `scheme=host:port;…` list. Only the HTTP schemes are usable here: `socks=` and
 * the remaining protocols cannot be reached by Node's environment-proxy agent.
 * @param {string | undefined} raw - `ProxyServer` value.
 * @returns {{ http: string | undefined, https: string | undefined } | undefined} per-scheme addresses, or undefined when none is usable.
 */
export function parseWindowsProxyServer(raw) {
  if (raw === undefined || raw.trim() === '') return undefined
  const named = new Map()
  let bare
  for (const part of raw.split(';')) {
    const text = part.trim()
    if (text === '') continue
    const separator = text.indexOf('=')
    if (separator === -1) {
      if (bare === undefined) bare = text
      continue
    }
    const scheme = text.slice(0, separator).trim().toLowerCase()
    const host = text.slice(separator + 1).trim()
    if (host !== '' && (scheme === 'http' || scheme === 'https')) named.set(scheme, host)
  }
  // A per-scheme list is normally asymmetric; each scheme falls back to the other
  // rather than leaving that scheme direct.
  const http = named.get('http') ?? named.get('https') ?? bare
  const https = named.get('https') ?? named.get('http') ?? bare
  if (http === undefined && https === undefined) return undefined
  return { http, https }
}

/**
 * Resolve the proxy the chain's Node `fetch` downloads should use.
 *
 * The environment wins: when it names a proxy, the chain only switches on the
 * environment-proxy agent and leaves the caller's addresses untouched. Windows
 * otherwise supplies the system proxy, which the chain applies itself.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform,
 *   windowsSettings?: () => ({ enabled: boolean, server: string | undefined, bypass: string[] } | undefined) }} [options] -
 *   environment, host platform and Windows settings reader; the defaults come from the running process.
 * @returns {{ source: 'environment' | 'windows' | 'none', env: Record<string, string>,
 *   proxy?: string, name?: string, reason?: string }} environment overrides plus the source and, when there is none, why.
 */
export function resolveDownloadProxy(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const readWindowsSettings = options.windowsSettings ?? (() => windowsProxySettings())
  const name = PROXY_ENV_NAMES.find((candidate) => envValue(env, candidate) !== undefined)
  if (name !== undefined) {
    const proxy = normalizeProxy(envValue(env, name))
    if (proxy === undefined) return { source: 'none', env: {}, reason: `${name} names no HTTP proxy` }
    return { source: 'environment', name, proxy, env: { NODE_USE_ENV_PROXY: '1', ...noProxyOverrides(env) } }
  }
  if (platform !== 'win32') return { source: 'none', env: {}, reason: 'the environment names no proxy' }
  const settings = readWindowsSettings()
  if (settings === undefined) {
    return { source: 'none', env: {}, reason: 'the environment names no proxy and the Windows settings are unreadable' }
  }
  if (!settings.enabled) return { source: 'none', env: {}, reason: 'the environment names no proxy and Windows has no proxy enabled' }
  if (settings.bypass.includes('*')) return { source: 'none', env: {}, reason: 'Windows bypasses every host' }
  const parsed = parseWindowsProxyServer(settings.server)
  const http = parsed === undefined ? undefined : normalizeProxy(parsed.http)
  const https = parsed === undefined ? undefined : normalizeProxy(parsed.https)
  if (http === undefined && https === undefined) {
    return { source: 'none', env: {}, reason: 'Windows names no usable HTTP proxy' }
  }
  const appliedHttp = http ?? https
  const appliedHttps = https ?? http
  return {
    source: 'windows',
    proxy: appliedHttps,
    env: {
      HTTP_PROXY: appliedHttp,
      HTTPS_PROXY: appliedHttps,
      http_proxy: appliedHttp,
      https_proxy: appliedHttps,
      NODE_USE_ENV_PROXY: '1',
      ...noProxyOverrides(env, settings.bypass.filter((entry) => entry !== '<local>')),
    },
  }
}
