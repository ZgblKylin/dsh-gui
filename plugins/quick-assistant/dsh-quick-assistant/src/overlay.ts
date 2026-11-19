/**
 * Overlay page assets.
 *
 * The overlay is a standalone page the native helper loads into a WebView2
 * window; it is not part of the built client bundle. Files live in the
 * package's `assets/` directory and are served by file name only, with the
 * one-time token substituted into the page.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory holding the overlay page and its static siblings. */
const ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

/** Literal the page uses wherever the one-time token belongs. */
const TOKEN_LITERAL = '__QA_TOKEN__'

/** Compatibility literal for a page generated without {@link TOKEN_LITERAL}. */
const TOKEN_PLACEHOLDER = '__QA_TOKEN_PLACEHOLDER__'

/** MIME type per served extension. */
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
})

/** Only plain file names are addressable; the overlay has no subdirectories. */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Absolute directory of the overlay assets.
 * @returns the assets directory next to the built entry (`lib/../assets`).
 */
export function assetsDirectory(): string {
  return ASSETS_DIR
}

/**
 * Resolve one requested asset file inside the assets directory.
 * @param fileName - untrusted file name from the request path.
 * @returns the absolute path, or `undefined` when the name could escape the
 *   directory or does not name a regular file.
 */
export function resolveAssetPath(fileName: string): string | undefined {
  if (!SAFE_FILE_NAME.test(fileName) || fileName.includes('..')) return undefined
  const target = resolve(join(ASSETS_DIR, fileName))
  return target.startsWith(`${ASSETS_DIR}${sep}`) ? target : undefined
}

/**
 * Content type for one asset path.
 * @param fileName - resolved asset file name.
 * @returns the MIME type; unknown extensions are served as octets.
 */
export function contentTypeOf(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf('.'))
  return CONTENT_TYPES[extension.toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Read one asset file.
 * @param fileName - untrusted file name from the request path.
 * @returns the bytes and content type, or `undefined` when the name is unsafe
 *   or the file does not exist.
 */
export async function readAsset(fileName: string): Promise<{ body: Buffer; contentType: string } | undefined> {
  const path = resolveAssetPath(fileName)
  if (path === undefined) return undefined
  try {
    return { body: await readFile(path), contentType: contentTypeOf(path) }
  } catch {
    return undefined
  }
}

/**
 * Ensure the page carries the token on `window.__QA_TOKEN__`.
 * @param html - page markup.
 * @param token - one-time token to expose.
 * @returns markup whose scripts can read `window.__QA_TOKEN__`.
 */
function ensureTokenGlobal(html: string, token: string): string {
  if (html.includes('window.__QA_TOKEN__')) return html
  const script = `<script>window.__QA_TOKEN__ = ${JSON.stringify(token)};</script>`
  const headEnd = html.search(/<\/head\s*>/i)
  if (headEnd !== -1) return `${html.slice(0, headEnd)}${script}\n${html.slice(headEnd)}`
  return `${script}\n${html}`
}

/**
 * Substitute the one-time token into the overlay page.
 *
 * The page's own markup decides where the token appears: every
 * `__QA_TOKEN__` literal is replaced, a single `__QA_TOKEN_PLACEHOLDER__` is
 * accepted for compatibility, and a page with neither still gets the global so
 * script-side requests have a credential.
 * @param html - raw page markup.
 * @param token - one-time token.
 * @returns the page to serve.
 */
export function injectToken(html: string, token: string): string {
  let page = html
  if (page.includes(TOKEN_LITERAL)) {
    page = page.split(TOKEN_LITERAL).join(token)
  } else if (page.includes(TOKEN_PLACEHOLDER)) {
    page = page.replace(TOKEN_PLACEHOLDER, token)
  }
  return ensureTokenGlobal(page, token)
}

/**
 * Read the overlay page with the token substituted.
 * @param token - one-time token.
 * @returns the page markup, or `undefined` when `overlay.html` is missing.
 */
export async function readOverlayPage(token: string): Promise<string | undefined> {
  try {
    return injectToken(await readFile(join(ASSETS_DIR, 'overlay.html'), 'utf8'), token)
  } catch {
    return undefined
  }
}
