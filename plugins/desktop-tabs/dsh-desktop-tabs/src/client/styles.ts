/**
 * The plugin's own stylesheet, installed as one owned `<style>` tag.
 *
 * The strip lives in the Windows caption band the shell reserves at the top of
 * the page (no layout container of its own): it is `position: fixed`, its `top`
 * is 0, its height follows `--dsh-windows-titlebar-height`, and its `left` is set
 * from the caption menu's right edge by the caller. The `+` panel and the
 * connection settings panel hang below the same edge. The strip, both panels,
 * and the remote-view layer are all `-webkit-app-region: no-drag` so their own
 * clicks are not captured by the window drag region.
 *
 * Colours come from the shared `--dsw-*` tokens the caption menu itself uses.
 */

/** Marks the `<style>` tag this plugin owns. */
const STYLE_ATTR = 'data-dsh-desktop-tabs-style'

const CSS = `
/* Layer order while a remote tab owns the window: the placeholder layer sits
   above the application, and the plugin's own chrome (strip, panels) above the
   layer, so it is never covered by itself. The shell's forced-hint overlay is
   2147483647 and stays above everything here. */
[data-dsh-desktop-tabs] {
  position: fixed;
  top: 0;
  left: 48px;
  height: var(--dsh-windows-titlebar-height, 40px);
  max-width: calc(100vw - 168px);
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 8px;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  -webkit-app-region: no-drag;
  z-index: 2147483001;
  font-family: var(--dsw-font-family);
}
[data-dsh-desktop-tabs][hidden] { display: none; }
[data-dsh-desktop-tabs] button {
  height: 26px;
  max-width: 168px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  -webkit-app-region: no-drag;
}
[data-dsh-desktop-tabs] button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}
/* One tab row reads as one control: the slot paints the whole row, so the label
   and the ✕ sit on the same background. The inner buttons never paint. */
[data-dsh-desktop-tabs] [data-dsh-desktop-tab-slot] {
  display: inline-flex;
  align-items: center;
  height: 26px;
  max-width: 200px;
  border-radius: 6px;
  overflow: hidden;
}
[data-dsh-desktop-tabs] [data-dsh-desktop-tab-slot]:hover,
[data-dsh-desktop-tabs] [data-dsh-desktop-tab-slot]:focus-within,
[data-dsh-desktop-tabs] [data-dsh-desktop-tab-slot][data-dsh-desktop-tab-active] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
[data-dsh-desktop-tabs] [data-dsh-desktop-tab-slot] > button[data-dsh-desktop-tab] {
  min-width: 0;
}
[data-dsh-desktop-tabs] [data-dsh-desktop-tab-close] {
  padding: 0 8px 0 4px;
}
[data-dsh-desktop-tabs] [data-dsh-desktop-tab-close]:hover {
  background: transparent;
  color: var(--dsw-alias-label-primary);
}
/* The `+` is the strip's only standalone button; it keeps the row look. */
[data-dsh-desktop-tabs] > button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
[data-dsh-desktop-tabs] [data-dsh-desktop-tabs-add] {
  padding: 0 8px;
  font-size: 15px;
}
[data-dsh-desktop-tabs] button[data-dsh-desktop-tab-error] {
  color: var(--dsw-alias-state-error-primary);
}
[data-dsh-desktop-tabs-panel] {
  position: fixed;
  top: var(--dsh-windows-titlebar-height, 40px);
  left: 48px;
  width: 320px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - var(--dsh-windows-titlebar-height, 40px) - 20px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 8px 24px rgb(0 0 0 / 24%);
  font-family: var(--dsw-font-family);
  -webkit-app-region: no-drag;
  z-index: 2147483001;
}
[data-dsh-desktop-tabs-panel][hidden] { display: none; }
/* The panel itself is the last resort scroll container: its sections keep their
   natural height so a long list scrolls inside its own box, not by shrinking. */
[data-dsh-desktop-tabs-panel] > * { flex: 0 0 auto; }
[data-dsh-desktop-tabs-panel] [data-dsh-desktop-tabs-panel-close] {
  position: absolute;
  top: 6px;
  right: 6px;
  height: 22px;
  padding: 0 6px;
  color: var(--dsw-alias-label-secondary);
  text-align: center;
}
[data-dsh-desktop-tabs-panel] button {
  height: 26px;
  flex: 0 0 auto;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  -webkit-app-region: no-drag;
}
[data-dsh-desktop-tabs-panel] button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-dsh-desktop-tabs-panel] button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}
[data-dsh-desktop-tabs-panel] input,
[data-dsh-desktop-tabs-config] input {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
[data-dsh-desktop-tabs-panel] input:focus-visible,
[data-dsh-desktop-tabs-config] input:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}
[data-dsh-desktop-tabs-section] {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[data-dsh-desktop-tabs-section-toggle] {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  text-align: left;
}
[data-dsh-desktop-tabs-section-body] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow: auto;
  overscroll-behavior: contain;
}
[data-dsh-desktop-tabs-section-body][hidden] { display: none; }
/* Rows must not shrink: without this, a list taller than max-height is squeezed
   into the box (every row a few pixels) instead of overflowing into a scrollbar. */
[data-dsh-desktop-tabs-section-body] > button,
[data-dsh-desktop-tabs-section-body] > [data-dsh-desktop-tabs-connection] {
  flex: 0 0 auto;
  min-height: 26px;
}
[data-dsh-desktop-tabs-connection] {
  display: flex;
  align-items: center;
}
[data-dsh-desktop-tabs-connection] > [data-dsh-desktop-tabs-connection-open] {
  flex: 1 1 auto;
  min-width: 0;
}
[data-dsh-desktop-tabs-row-actions] {
  display: none;
  align-items: center;
  flex: 0 0 auto;
}
/* Row actions appear on hover (and on keyboard focus), never otherwise. */
[data-dsh-desktop-tabs-connection]:hover [data-dsh-desktop-tabs-row-actions],
[data-dsh-desktop-tabs-connection]:focus-within [data-dsh-desktop-tabs-row-actions] {
  display: flex;
}
/* Row actions are glyphs (✎ edit, ✕ delete): flat, colour-only hover, matching
   the tab row's ✕. */
[data-dsh-desktop-tabs-row-actions] button {
  height: 22px;
  min-width: 22px;
  padding: 0 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 1;
  text-align: center;
  background: transparent;
}
[data-dsh-desktop-tabs-row-actions] button:hover {
  background: transparent;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-desktop-tabs-empty] {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
[data-dsh-desktop-tabs-panel-status] {
  margin: 0;
  padding-right: 24px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
[data-dsh-desktop-tabs-panel-status][hidden] { display: none; }
[data-dsh-desktop-tabs-config] {
  position: fixed;
  top: var(--dsh-windows-titlebar-height, 40px);
  left: 480px;
  width: 300px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - var(--dsh-windows-titlebar-height, 40px) - 20px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 8px 24px rgb(0 0 0 / 24%);
  font-family: var(--dsw-font-family);
  -webkit-app-region: no-drag;
  z-index: 2147483001;
}
[data-dsh-desktop-tabs-config][hidden] { display: none; }
[data-dsh-desktop-tabs-config-title] {
  margin: 0;
  padding-right: 24px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
[data-dsh-desktop-tabs-config-field] {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[data-dsh-desktop-tabs-config-label] {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
[data-dsh-desktop-tabs-command-row] {
  display: flex;
  align-items: center;
  gap: 4px;
}
[data-dsh-desktop-tabs-command-row] input {
  flex: 1 1 auto;
  min-width: 0;
}
[data-dsh-desktop-tabs-presets] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 120px;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
}
[data-dsh-desktop-tabs-presets][hidden] { display: none; }
[data-dsh-desktop-tabs-presets] [role='option'] {
  flex: 0 0 auto;
  min-height: 26px;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}
[data-dsh-desktop-tabs-presets] [role='option'][aria-selected='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-dsh-desktop-tabs-config-status] {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
[data-dsh-desktop-tabs-config-status][hidden] { display: none; }
[data-dsh-desktop-tabs-config-actions] {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
[data-dsh-desktop-tabs-config] button {
  height: 26px;
  flex: 0 0 auto;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  -webkit-app-region: no-drag;
}
[data-dsh-desktop-tabs-config] button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-dsh-desktop-tabs-config] button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}
[data-dsh-desktop-tabs-presets-toggle] {
  padding: 0 8px;
  color: var(--dsw-alias-label-secondary);
}
/* While the layer covers the window the application root is hidden: its own
   surfaces (sidebar, onboarding, a skin's wallpaper) would otherwise paint
   above the layer. Visibility keeps layout and React state intact. */
html[data-dsh-desktop-tabs-cover] #root { visibility: hidden; }
/* Fallback fill for anything painted outside #root by the page or a skin. */
html[data-dsh-desktop-tabs-cover],
html[data-dsh-desktop-tabs-cover] body { background: var(--dsw-alias-bg-base, #151517); }
/* The placeholder and the remote guest share one full-viewport opaque layer:
   it starts at the window's top-left corner so nothing shows through anywhere,
   and pads its content below the caption band. */
[data-dsh-desktop-tabs-view] {
  position: fixed;
  inset: 0;
  padding-top: var(--dsh-windows-titlebar-height, 40px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #151517);
  /* Just under the shell's mandatory-overlay layer (2147483647) and above any
   skin or decoration a theme may paint, so the connecting placeholder is never
   pierced. The strip, panel, and config panel sit one step higher still. */
  z-index: 2147483000;
  -webkit-app-region: no-drag;
}
[data-dsh-desktop-tabs-view][hidden] { display: none; }
[data-dsh-desktop-tabs-view] webview {
  flex: 1 1 auto;
  border: 0;
}
[data-dsh-desktop-tabs-status] {
  flex: 0 0 auto;
  margin: 0;
  padding: 24px 24px 8px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
}
[data-dsh-desktop-tabs-status][hidden] { display: none; }
/* The log carries its own opaque block, so the lines read even before the
   status line above them has settled. */
[data-dsh-desktop-tabs-log] {
  flex: 1 1 auto;
  margin: 0;
  padding: 8px 24px 24px;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--dsw-alias-bg-base, #151517);
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
[data-dsh-desktop-tabs-log][hidden] { display: none; }
`

/** Install the owned stylesheet; idempotent under re-evaluation. */
export function installStyles(): void {
  if (document.querySelector(`style[${STYLE_ATTR}]`) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute(STYLE_ATTR, '')
  tag.textContent = CSS
  document.head.append(tag)
}

/** Remove the stylesheet this plugin installed. */
export function removeStyles(): void {
  document.querySelectorAll(`style[${STYLE_ATTR}]`).forEach((tag) => { tag.remove() })
}
