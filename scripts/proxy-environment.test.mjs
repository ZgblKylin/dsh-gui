import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWindowsProxyServer, parseWindowsSettings, resolveDownloadProxy, windowsProxySettings } from './proxy-environment.mjs'

/** Internet Settings output as `reg query` prints it. */
const REG_OUTPUT = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyOverride    REG_SZ    <local>;localhost;10.*
    ProxyServer    REG_SZ    127.0.0.1:1080
`

test('an environment proxy only switches on the environment-proxy agent', () => {
  const resolved = resolveDownloadProxy({ env: { HTTPS_PROXY: 'http://127.0.0.1:1080' }, platform: 'linux' })
  assert.equal(resolved.source, 'environment')
  assert.equal(resolved.name, 'HTTPS_PROXY')
  assert.equal(resolved.proxy, 'http://127.0.0.1:1080')
  assert.deepEqual(resolved.env, { NODE_USE_ENV_PROXY: '1', NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' })
})

test('an environment proxy without a scheme becomes an HTTP URL', () => {
  const resolved = resolveDownloadProxy({ env: { HTTP_PROXY: '127.0.0.1:8080' }, platform: 'linux' })
  assert.equal(resolved.proxy, 'http://127.0.0.1:8080')
})

test('a blank environment proxy counts as unset', () => {
  const resolved = resolveDownloadProxy({ env: { HTTPS_PROXY: '   ', HTTP_PROXY: '' }, platform: 'linux' })
  assert.equal(resolved.source, 'none')
})

test('a socks environment proxy is refused instead of breaking fetch', () => {
  const resolved = resolveDownloadProxy({ env: { ALL_PROXY: 'socks5://127.0.0.1:1080' }, platform: 'linux' })
  assert.equal(resolved.source, 'none')
  assert.match(resolved.reason, /ALL_PROXY/u)
})

test('an existing bypass list keeps its entries and gains the loopback hosts', () => {
  const resolved = resolveDownloadProxy({ env: { HTTPS_PROXY: 'http://proxy:1', NO_PROXY: 'example.com' }, platform: 'linux' })
  assert.equal(resolved.env.NO_PROXY, 'example.com,localhost,127.0.0.1,::1')
})

test('Windows settings supply the proxy when the environment names none', () => {
  const resolved = resolveDownloadProxy({
    env: {},
    platform: 'win32',
    windowsSettings: () => ({ enabled: true, server: '127.0.0.1:1080', bypass: ['<local>', '10.*'] }),
  })
  assert.equal(resolved.source, 'windows')
  assert.equal(resolved.proxy, 'http://127.0.0.1:1080')
  assert.deepEqual(resolved.env, {
    HTTP_PROXY: 'http://127.0.0.1:1080',
    HTTPS_PROXY: 'http://127.0.0.1:1080',
    http_proxy: 'http://127.0.0.1:1080',
    https_proxy: 'http://127.0.0.1:1080',
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: 'localhost,127.0.0.1,::1,10.*',
    no_proxy: 'localhost,127.0.0.1,::1,10.*',
  })
})

test('a per-scheme Windows proxy keeps both schemes', () => {
  const resolved = resolveDownloadProxy({
    env: {},
    platform: 'win32',
    windowsSettings: () => ({ enabled: true, server: 'http=proxy:80;https=proxy:443', bypass: [] }),
  })
  assert.equal(resolved.env.HTTP_PROXY, 'http://proxy:80')
  assert.equal(resolved.env.HTTPS_PROXY, 'http://proxy:443')
})

test('a Windows proxy that is disabled leaves the downloads direct', () => {
  const resolved = resolveDownloadProxy({
    env: {},
    platform: 'win32',
    windowsSettings: () => ({ enabled: false, server: '127.0.0.1:1080', bypass: [] }),
  })
  assert.equal(resolved.source, 'none')
  assert.match(resolved.reason, /Windows/u)
})

test('a Windows bypass of every host leaves the downloads direct', () => {
  const resolved = resolveDownloadProxy({
    env: {},
    platform: 'win32',
    windowsSettings: () => ({ enabled: true, server: '127.0.0.1:1080', bypass: ['*'] }),
  })
  assert.equal(resolved.source, 'none')
})

test('a Windows proxy naming only socks is unusable', () => {
  const resolved = resolveDownloadProxy({
    env: {},
    platform: 'win32',
    windowsSettings: () => ({ enabled: true, server: 'socks=127.0.0.1:1080', bypass: [] }),
  })
  assert.equal(resolved.source, 'none')
})

test('a non-Windows host never reads the Windows settings', () => {
  const resolved = resolveDownloadProxy({
    env: {},
    platform: 'linux',
    windowsSettings: () => { throw new Error('the Windows settings must not be read') },
  })
  assert.equal(resolved.source, 'none')
})

test('unreadable Windows settings leave the downloads direct', () => {
  const resolved = resolveDownloadProxy({ env: {}, platform: 'win32', windowsSettings: () => undefined })
  assert.equal(resolved.source, 'none')
  assert.match(resolved.reason, /unreadable/u)
})

test('the registry output yields the proxy flag, server and bypass list', () => {
  assert.deepEqual(parseWindowsSettings(REG_OUTPUT), {
    enabled: true,
    server: '127.0.0.1:1080',
    bypass: ['<local>', 'localhost', '10.*'],
  })
})

test('a failed registry query yields no settings', () => {
  assert.equal(windowsProxySettings(() => ({ ok: false, stdout: '' })), undefined)
})

test('a Windows server value is split into its HTTP schemes', () => {
  assert.deepEqual(parseWindowsProxyServer('127.0.0.1:1080'), { http: '127.0.0.1:1080', https: '127.0.0.1:1080' })
  assert.deepEqual(parseWindowsProxyServer('http=a:1;socks=b:2'), { http: 'a:1', https: 'a:1' })
  assert.equal(parseWindowsProxyServer('socks=b:2'), undefined)
  assert.equal(parseWindowsProxyServer(undefined), undefined)
})
