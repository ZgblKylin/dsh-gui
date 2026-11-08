/**
 * Remote-guest image context menu: capture the image under a guest context-menu
 * point and copy it to the system clipboard from the application document.
 *
 * Electron draws no default context menu for a `<webview>` guest, and the desktop
 * shell's main-process handler only covers the primary window's editable fields
 * and selections, so a remote session's image preview has no menu at all. The
 * guest session (`deepseek-harness/apps/desktop/src/browser-guests.ts`) also denies
 * every permission, so the guest page cannot write the clipboard itself.
 *
 * This module relays at the page level, in two halves:
 *
 *  1. `readGuestImage` evaluates a self-contained capture script in the guest
 *     through `webview.executeJavaScript` (the same embedder→guest channel as the
 *     notification and clipboard relays): the script finds the image under the
 *     context-menu point, re-encodes it to PNG on a canvas, and — when the canvas
 *     is tainted or no matching element exists — fetches the source URL and
 *     re-encodes the blob. It resolves with a `data:image/png;base64,` URL or null.
 *  2. `createImageContextMenu` owns a small self-drawn menu in the application
 *     document (`dsh-app://app` is a secure context and the app session allows the
 *     non-media permissions the guest session denies); activating its item
 *     decodes the captured data URL and writes the image through the app
 *     document's `navigator.clipboard.write`.
 *
 * The caller supplies `write` and `onClosed`, so the view layer keeps ownership
 * of the clipboard and of returning focus to the guest the menu covers.
 */
import type { RemoteWebview } from './webview-host.ts'

/** The prefix every captured image data URL must carry. */
export const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

/** How long a failed copy waits before the item becomes retryable again. */
export const COPY_RETRY_MS = 1500

/** Marks the context-menu root in the application document (styled by styles.ts). */
const MENU_ATTR = 'data-dsh-desktop-tabs-image-menu'
/** Marks the menu's single copy item. */
const COPY_ITEM_ATTR = 'data-dsh-desktop-tabs-image-menu-copy'

/** Keeps the menu fully inside the viewport. */
const VIEWPORT_MARGIN = 4

/** The item label while it is ready to copy. */
const COPY_TEXT = '复制图片'
/** The item label when the guest yielded no image. */
const UNAVAILABLE_TEXT = '无法读取图片'
/** The item label after a refused clipboard write. */
const FAILED_TEXT = '复制失败，请重试'

/**
 * The guest capture script, without its argument list.
 *
 * Written as ES2017 with string concatenation only (no template literals), like
 * `NOTIFY_SHIM_SOURCE`, so the source string stays independent of any bundler
 * transformation. It runs in the guest's main world, finds the image under the
 * point (or a `document.images` entry whose `src`/`currentSrc` matches the
 * reported source), draws it onto a canvas sized by its natural dimensions, and
 * returns `canvas.toDataURL('image/png')`. A tainted canvas (`toDataURL` throws)
 * or a missing element falls back to fetching the source with credentials and
 * re-encoding the fetched blob through an `Image` and the same canvas path.
 *
 * The completion value of the full script is a Promise of a
 * `data:image/png;base64,` URL or null.
 */
const CAPTURE_SCRIPT = [
  '(function captureGuestImage(x, y, srcURL) {',
  '  var PNG_PREFIX = "data:image/png;base64,";',
  '  function isPng(value) {',
  '    return typeof value === "string" && value.indexOf(PNG_PREFIX) === 0;',
  '  }',
  '  function findAt(pointX, pointY) {',
  '    var node = null;',
  '    try { node = document.elementFromPoint(pointX, pointY); } catch (e) { node = null; }',
  '    while (node) {',
  '      if (node.tagName === "IMG" || node.tagName === "CANVAS") return node;',
  '      node = node.parentElement;',
  '    }',
  '    return null;',
  '  }',
  '  function findBySource(url) {',
  '    if (!url || !document.images) return null;',
  '    var images = document.images;',
  '    for (var i = 0; i < images.length; i += 1) {',
  '      if (images[i].currentSrc === url || images[i].src === url) return images[i];',
  '    }',
  '    return null;',
  '  }',
  '  function sourceSize(source) {',
  '    var width = 0;',
  '    var height = 0;',
  '    if (source.tagName === "CANVAS") {',
  '      width = source.width;',
  '      height = source.height;',
  '    } else {',
  '      width = source.naturalWidth || source.width;',
  '      height = source.naturalHeight || source.height;',
  '    }',
  '    if (!width || !height) return null;',
  '    return { width: width, height: height };',
  '  }',
  '  function encode(source) {',
  '    return new Promise(function (resolve) {',
  '      var size = sourceSize(source);',
  '      if (!size) { resolve(null); return; }',
  '      try {',
  '        var canvas = document.createElement("canvas");',
  '        canvas.width = size.width;',
  '        canvas.height = size.height;',
  '        var context = canvas.getContext("2d");',
  '        if (!context) { resolve(null); return; }',
  '        context.drawImage(source, 0, 0, size.width, size.height);',
  '        var dataUrl = canvas.toDataURL("image/png");',
  '        resolve(isPng(dataUrl) ? dataUrl : null);',
  '      } catch (e) {',
  '        resolve(null);',
  '      }',
  '    });',
  '  }',
  '  function loadImage(url) {',
  '    return new Promise(function (resolve) {',
  '      var image = new Image();',
  '      image.onload = function () { resolve(image); };',
  '      image.onerror = function () { resolve(null); };',
  '      image.src = url;',
  '    });',
  '  }',
  '  function fromNetwork(url) {',
  '    if (!url) return Promise.resolve(null);',
  '    return fetch(url, { credentials: "include" })',
  '      .then(function (response) {',
  '        if (!response || !response.ok) return null;',
  '        return response.blob();',
  '      })',
  '      .then(function (blob) {',
  '        if (!blob) return null;',
  '        var objectUrl = URL.createObjectURL(blob);',
  '        return loadImage(objectUrl).then(function (image) {',
  '          URL.revokeObjectURL(objectUrl);',
  '          return image ? encode(image) : null;',
  '        });',
  '      })',
  '      .catch(function () { return null; });',
  '  }',
  '  var target = findAt(x, y) || findBySource(srcURL);',
  '  if (target) {',
  '    return encode(target).then(function (dataUrl) {',
  '      return dataUrl || fromNetwork(srcURL);',
  '    });',
  '  }',
  '  return fromNetwork(srcURL);',
  '})',
].join('\n')

/** Where in the guest the menu was requested, and the source Electron reported. */
export interface ImageContextPoint {
  readonly x: number
  readonly y: number
  readonly srcURL: string
}

/**
 * Build the guest script that captures the image under one context-menu point.
 *
 * The numeric point and the source URL are spliced in as an argument list: the
 * numbers are validated and rounded, the URL goes through `JSON.stringify`, so
 * neither can end the argument list or inject code.
 * @param x - context-menu x relative to the guest viewport.
 * @param y - context-menu y relative to the guest viewport.
 * @param srcURL - image source reported by Electron; empty falls back to the point.
 * @returns one self-contained script whose completion value is the capture promise.
 */
export function guestImageScript(x: number, y: number, srcURL: string): string {
  const pointX = Number.isFinite(x) ? Math.round(x) : 0
  const pointY = Number.isFinite(y) ? Math.round(y) : 0
  const source = typeof srcURL === 'string' ? srcURL : ''
  return CAPTURE_SCRIPT + '(' + pointX + ', ' + pointY + ', ' + JSON.stringify(source) + ')'
}

/** @returns whether `value` is a captured PNG data URL. */
function isPngDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PNG_DATA_URL_PREFIX)
}

/**
 * Read the image under a guest context-menu point.
 *
 * A destroyed, navigating, or cross-origin guest makes `executeJavaScript` reject;
 * that is not an error here — the caller only needs to know there is no image.
 * @param webview - the guest whose image is captured.
 * @param params - the point and source from the guest's `context-menu` event.
 * @returns the captured PNG data URL, or null when the guest yields none.
 */
export async function readGuestImage(
  webview: RemoteWebview,
  params: ImageContextPoint,
): Promise<string | null> {
  try {
    const value = await webview.executeJavaScript(
      guestImageScript(params.x, params.y, params.srcURL),
      false,
    )
    return isPngDataUrl(value) ? value : null
  } catch {
    // A guest that is gone or navigating simply has no image to copy.
    return null
  }
}

/** The application document's image-clipboard surface. */
interface ImageClipboard {
  /** `ClipboardItem`, the constructor `clipboard.write` requires. */
  readonly item: new (items: Record<string, Blob>) => unknown
  /** `navigator.clipboard.write`, bound to its clipboard object. */
  readonly write: (items: unknown[]) => Promise<void>
}

/**
 * Resolve the image-clipboard surface of this document.
 * @returns the constructor and the bound write function.
 * @throws when the document has no async image clipboard (`ClipboardItem` or
 *   `navigator.clipboard.write` is missing) — the caller shows the retry label.
 */
function imageClipboard(): ImageClipboard {
  const scope = globalThis as unknown as {
    ClipboardItem?: new (items: Record<string, Blob>) => unknown
    navigator?: { clipboard?: { write?: (items: unknown[]) => Promise<void> } }
  }
  const item = scope.ClipboardItem
  const clipboard = scope.navigator?.clipboard
  const write = clipboard?.write
  if (typeof item !== 'function' || typeof write !== 'function' || clipboard === undefined) {
    throw new Error('this document cannot write images to the clipboard')
  }
  return { item, write: (items) => write.call(clipboard, items) }
}

/**
 * Write one captured PNG data URL to the system clipboard.
 *
 * Runs in the application document, never in the guest: the app document is a
 * secure context on `dsh-app://app` and its session allows the non-media
 * permissions the guest session denies.
 * @param dataUrl - a `data:image/png;base64,` URL from {@link readGuestImage}.
 * @throws when the data URL is not a PNG, the document lacks the async image
 *   clipboard, decoding fails, or the clipboard write is refused.
 */
export async function copyImageToClipboard(dataUrl: string): Promise<void> {
  if (!isPngDataUrl(dataUrl)) throw new Error('image copy needs a PNG data URL')
  const clipboard = imageClipboard()
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  if (blob.size === 0) throw new Error('image copy decoded an empty image')
  await clipboard.write([new clipboard.item({ 'image/png': blob })])
}

/** What the menu needs from its host. */
export interface ImageContextMenuOptions {
  /** Write one captured PNG data URL; must reject when the copy fails. */
  write(dataUrl: string): Promise<void>
  /** Called after an open menu closes, to hand focus back to its surface. */
  onClosed?(): void
}

/** One menu opening. */
export interface ImageMenuOpenOptions {
  /** Viewport x of the menu's top-left corner (translated by the caller). */
  readonly x: number
  /** Viewport y of the menu's top-left corner (translated by the caller). */
  readonly y: number
  /** The capture whose result the item writes; null disables it. */
  readonly image: Promise<string | null>
}

/** The application-document image context menu. */
export interface ImageContextMenu {
  /** The open menu root, or undefined while closed. */
  readonly element: HTMLElement | undefined
  /** Show the menu, closing any previous one first. */
  open(options: ImageMenuOpenOptions): void
  /** Close the menu and hand focus back; a no-op while closed. */
  close(): void
  /** Close the menu without handing focus back, then refuse later opens. */
  dispose(): void
}

/**
 * Create the image context menu.
 *
 * Nothing touches the document here: the menu DOM is created by `open`, so a
 * layer that never shows an image menu never accesses `document.body`.
 * @param options - clipboard writer and close callback.
 * @returns the menu controller.
 */
export function createImageContextMenu(options: ImageContextMenuOptions): ImageContextMenu {
  /** The open menu root; the only trigger for DOM and listeners. */
  let root: HTMLElement | undefined
  /** The menu's single item, while {@link root} is open. */
  let item: HTMLButtonElement | undefined
  /** The capture the item writes, while {@link root} is open. */
  let pending: Promise<string | null> | undefined
  /** Retry timer after a failed write, while {@link root} is open. */
  let retryTimer: number | undefined
  /** Invalidates a copy that resolves after its menu closed or reopened. */
  let generation = 0
  /** Set by dispose: no DOM is created and no focus is returned afterwards. */
  let disposed = false

  /** @returns whether `target` is inside the open menu. */
  function isInsideMenu(target: EventTarget | null): boolean {
    if (root === undefined || target === null) return false
    try {
      return root.contains(target as Node)
    } catch {
      return false
    }
  }

  /** A pointer anywhere outside the menu dismisses it. */
  function onDocumentPointerDown(event: Event): void {
    if (isInsideMenu(event.target)) return
    closeMenu(true)
  }

  /** Escape dismisses the menu and returns focus to the guest. */
  function onDocumentKeyDown(event: Event): void {
    if ((event as { key?: unknown }).key === 'Escape') closeMenu(true)
  }

  /** Window blur, resize, and scroll dismiss the menu (its anchor moved). */
  function onWindowChange(): void {
    closeMenu(true)
  }

  /**
   * Remove the menu DOM and listeners.
   * @param notify - call `onClosed` (false for `dispose`, which must not move focus).
   */
  function closeMenu(notify: boolean): void {
    if (root === undefined) return
    const menu = root
    const returnFocus = notify ? options.onClosed : undefined
    root = undefined
    item = undefined
    pending = undefined
    generation += 1
    if (retryTimer !== undefined) {
      window.clearTimeout(retryTimer)
      retryTimer = undefined
    }
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
    document.removeEventListener('keydown', onDocumentKeyDown, true)
    window.removeEventListener('blur', onWindowChange)
    window.removeEventListener('resize', onWindowChange)
    window.removeEventListener('scroll', onWindowChange, true)
    menu.remove()
    if (returnFocus !== undefined) returnFocus()
  }

  /** Clamp one axis so the whole menu stays inside the viewport. */
  function clampInViewport(position: number, size: number, viewport: number): number {
    const limit = viewport - size - VIEWPORT_MARGIN
    const maximum = Math.max(VIEWPORT_MARGIN, limit)
    return Math.min(Math.max(VIEWPORT_MARGIN, Math.round(position)), maximum)
  }

  /** Place the appended menu at a viewport point, kept inside the window. */
  function place(menu: HTMLElement, x: number, y: number): void {
    const rect = menu.getBoundingClientRect()
    const width = rect.width || menu.offsetWidth
    const height = rect.height || menu.offsetHeight
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    menu.style.left = clampInViewport(x, width, viewportWidth) + 'px'
    menu.style.top = clampInViewport(y, height, viewportHeight) + 'px'
  }

  /** Re-enable a failed item after the retry delay; stale timers do nothing. */
  function scheduleRetry(token: number, button: HTMLButtonElement): void {
    if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined
      if (token !== generation || item !== button) return
      button.textContent = COPY_TEXT
      button.disabled = false
    }, COPY_RETRY_MS)
  }

  /** Await the capture, then write it; a stale menu result is dropped. */
  function startCopy(token: number, button: HTMLButtonElement, image: Promise<string | null>): void {
    void (async () => {
      if (token !== generation || item !== button || button.disabled) return
      button.disabled = true
      let dataUrl: string | null = null
      try {
        dataUrl = await image
      } catch {
        dataUrl = null
      }
      if (token !== generation || item !== button) return
      if (dataUrl === null) {
        button.textContent = UNAVAILABLE_TEXT
        return
      }
      try {
        await options.write(dataUrl)
      } catch {
        if (token !== generation || item !== button) return
        button.textContent = FAILED_TEXT
        scheduleRetry(token, button)
        return
      }
      if (token !== generation) return
      closeMenu(true)
    })()
  }

  /** Show the menu at a viewport point. */
  function open(openOptions: ImageMenuOpenOptions): void {
    if (disposed) return
    closeMenu(true)
    generation += 1
    const token = generation
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute(MENU_ATTR, '')
    menu.setAttribute('aria-label', '图片操作')
    const button = document.createElement('button')
    button.setAttribute('type', 'button')
    button.setAttribute('role', 'menuitem')
    button.setAttribute(COPY_ITEM_ATTR, '')
    button.textContent = COPY_TEXT
    menu.append(button)
    document.body.append(menu)
    root = menu
    item = button
    pending = openOptions.image
    place(menu, openOptions.x, openOptions.y)
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    document.addEventListener('keydown', onDocumentKeyDown, true)
    window.addEventListener('blur', onWindowChange)
    window.addEventListener('resize', onWindowChange)
    window.addEventListener('scroll', onWindowChange, true)
    button.addEventListener('click', () => {
      const image = pending
      if (image === undefined) return
      startCopy(token, button, image)
    })
    button.focus()
  }

  /** Tear the menu down forever; later opens are ignored. */
  function dispose(): void {
    if (disposed) return
    disposed = true
    closeMenu(false)
  }

  return {
    get element(): HTMLElement | undefined {
      return root
    },
    open,
    close: (): void => closeMenu(true),
    dispose,
  }
}
