/**
 * The plugin's own stylesheet, installed as one owned `<style>` tag.
 *
 * Layer order (the shell's forced-hint overlay is 2147483647 and stays above
 * everything here):
 *
 *   2147483001  caption-band chrome: the 「更新」 entry button and the toast
 *   2147483002  the update dialog's backdrop and card
 *   2147483003  the changelog dialog (it opens on top of the update dialog)
 *
 * Geometry: the shell reserves a caption band at the top of the page (no layout
 * container of its own), so the entry button is `position: fixed`, `top: 0`,
 * `height: var(--dsh-windows-titlebar-height, 40px)`, and anchored from the
 * right by `--dsh-auto-update-controls-width` (the native window controls are
 * three 46px buttons, 138px together) so it never covers them. Like the tab
 * strip, every interactive element is `-webkit-app-region: no-drag` so its own
 * clicks are not swallowed by the window drag region.
 *
 * Colours come from the shared `--dsw-*` tokens the surrounding chrome uses,
 * with static fallbacks so the dialogs still read if a token is missing.
 */

/** Marks the `<style>` tag this plugin owns. */
const STYLE_ATTR = 'data-dsh-auto-update-style'

const CSS = `
[data-dsh-auto-update-button] {
  position: fixed;
  top: 0;
  right: var(--dsh-auto-update-controls-width, 138px);
  height: var(--dsh-windows-titlebar-height, 40px);
  box-sizing: border-box;
  margin: 0;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-family: var(--dsw-font-family, "Segoe UI", system-ui, sans-serif);
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  cursor: default;
  -webkit-app-region: no-drag;
  z-index: 2147483001;
}
[data-dsh-auto-update-button]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgb(255 255 255 / 8%));
  color: var(--dsw-alias-label-primary, #e6edf3);
}
[data-dsh-auto-update-button]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #2f81f7);
  outline-offset: -2px;
}
[data-dsh-auto-update-button][disabled] {
  opacity: 0.5;
}
/* The badge is a bare dot: it marks "there is something to update" without
   repeating the count the dialog header already carries. */
[data-dsh-auto-update-badge] {
  position: absolute;
  top: 5px;
  right: 3px;
  width: 8px;
  height: 8px;
  box-sizing: border-box;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #2f81f7);
  border: 1.5px solid var(--dsw-alias-bg-base, #0d1117);
  pointer-events: none;
}

[data-dsh-auto-update-toast] {
  position: fixed;
  top: calc(var(--dsh-windows-titlebar-height, 40px) + 10px);
  left: 50%;
  transform: translateX(-50%);
  max-width: min(600px, 84vw);
  padding: 7px 14px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, #161b22);
  color: var(--dsw-alias-label-primary, #e6edf3);
  box-shadow: 0 8px 24px rgb(0 0 0 / 40%);
  font-family: var(--dsw-font-family, "Segoe UI", system-ui, sans-serif);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  -webkit-app-region: no-drag;
  z-index: 2147483004;
}
[data-dsh-auto-update-toast][hidden] { display: none; }

/* ── Modal overlays (update dialog, changelog) ─────────────────────────── */
[data-dsh-auto-update-overlay],
[data-dsh-auto-update-changelog] {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 55%);
  font-family: var(--dsw-font-family, "Segoe UI", system-ui, sans-serif);
  -webkit-app-region: no-drag;
}
[data-dsh-auto-update-overlay] { z-index: 2147483002; }
[data-dsh-auto-update-changelog] { z-index: 2147483003; }
[data-dsh-auto-update-overlay][hidden],
[data-dsh-auto-update-changelog][hidden] { display: none; }

[data-dsh-auto-update-dialog],
[data-dsh-auto-update-changelog-dialog] {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 20px 22px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, #161b22);
  color: var(--dsw-alias-label-primary, #e6edf3);
  box-shadow: 0 16px 48px rgb(0 0 0 / 50%);
}
[data-dsh-auto-update-dialog] { width: min(880px, 94vw); max-height: 84vh; }
[data-dsh-auto-update-changelog-dialog] { width: min(760px, 92vw); max-height: 84vh; }

[data-dsh-auto-update-title],
[data-dsh-auto-update-changelog-title] {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
[data-dsh-auto-update-title] { padding-right: 28px; }
[data-dsh-auto-update-head] {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
[data-dsh-auto-update-head-main] {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
[data-dsh-auto-update-status] {
  margin: 0 0 10px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-auto-update-head-actions] {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  /* Keep clear of the absolutely positioned ✕ in the dialog's top-right. */
  padding-right: 30px;
}
[data-dsh-auto-update-close] {
  position: absolute;
  top: 12px;
  right: 12px;
}
/* The head is the positioning context for the ✕. */
[data-dsh-auto-update-dialog] { position: relative; }

[data-dsh-auto-update-body] {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding-right: 4px;
}
[data-dsh-auto-update-loading] {
  padding: 10px 2px;
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 13px;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}
[data-dsh-auto-update-loading][data-error] { color: var(--dsw-alias-state-error-primary, #f85149); }
[data-dsh-auto-update-summary] {
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

[data-dsh-auto-update-row] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 11px 14px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 8px;
}
[data-dsh-auto-update-row-info] {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[data-dsh-auto-update-row-name] {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
[data-dsh-auto-update-row-name] a {
  color: var(--dsw-alias-state-business-primary, #2f81f7);
  text-decoration: none;
  cursor: pointer;
}
[data-dsh-auto-update-row-name] a:hover { text-decoration: underline; }
[data-dsh-auto-update-row-versions] {
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 12px;
  white-space: normal;
  overflow-wrap: anywhere;
}
[data-dsh-auto-update-row-versions] code,
[data-dsh-auto-update-changelog-sub] code {
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 5px;
  background: var(--dsw-alias-bg-base, #0d1117);
  color: var(--dsw-alias-label-primary, #e6edf3);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
}
/* npm publish gap under the version line (contract §7.2; the shell tints it
   amber). It warns about the plugin install, never about the git update. */
[data-dsh-auto-update-row-npm-note] {
  color: var(--dsw-alias-state-warn-label, #d29922);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[data-dsh-auto-update-row-error] {
  color: var(--dsw-alias-state-error-primary, #f85149);
  font-size: 12px;
  overflow-wrap: anywhere;
}
[data-dsh-auto-update-row-action] {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
[data-dsh-auto-update-ok] {
  color: var(--dsw-alias-state-success-primary, #3fb950);
  font-size: 12px;
}
[data-dsh-auto-update-unavailable] {
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 12px;
}
[data-dsh-auto-update-checking] {
  color: var(--dsw-alias-state-business-primary, #2f81f7);
  font-size: 12px;
}
[data-dsh-auto-update-skeleton] {
  color: transparent !important;
  border-radius: 4px;
  background: linear-gradient(90deg,
    var(--dsw-alias-border-l1, #30363d) 25%,
    var(--dsw-alias-interactive-bg-hover, #30363d) 50%,
    var(--dsw-alias-border-l1, #30363d) 75%);
  background-size: 200% 100%;
  animation: dsh-auto-update-skeleton-pulse 1.4s ease-in-out infinite;
  pointer-events: none;
  user-select: none;
}
[data-dsh-auto-update-skeleton] * { visibility: hidden; }
@keyframes dsh-auto-update-skeleton-pulse {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

/* ── Controls ──────────────────────────────────────────────────────────── */
[data-dsh-auto-update-dialog] button,
[data-dsh-auto-update-changelog-dialog] button {
  box-sizing: border-box;
  height: 28px;
  padding: 0 14px;
  border: 0;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover, #21262d);
  color: var(--dsw-alias-label-primary, #e6edf3);
  font-family: inherit;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  cursor: default;
  -webkit-app-region: no-drag;
}
[data-dsh-auto-update-dialog] button:hover:not([disabled]),
[data-dsh-auto-update-changelog-dialog] button:hover:not([disabled]) {
  background: var(--dsw-alias-interactive-bg-active, #30363d);
}
[data-dsh-auto-update-dialog] button:focus-visible,
[data-dsh-auto-update-changelog-dialog] button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #2f81f7);
  outline-offset: -2px;
}
[data-dsh-auto-update-dialog] button[disabled],
[data-dsh-auto-update-changelog-dialog] button[disabled] { opacity: 0.5; }
[data-dsh-auto-update-dialog] button[data-dsh-auto-update-primary] {
  background: var(--dsw-alias-state-business-primary, #2f81f7);
  color: #fff;
}
[data-dsh-auto-update-dialog] button[data-dsh-auto-update-primary]:hover:not([disabled]) {
  filter: brightness(1.1);
}
/* An AI update on a checkout whose tag must not move: discouraged, like the
   shell's grayed-out button, with the reason in its title. */
[data-dsh-auto-update-dialog] button[data-dsh-auto-update-discouraged] {
  background: var(--dsw-alias-border-l1, #30363d);
  color: var(--dsw-alias-label-secondary, #8b949e);
}
[data-dsh-auto-update-dialog] button[data-dsh-auto-update-close],
[data-dsh-auto-update-changelog-dialog] button[data-dsh-auto-update-close] {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  padding: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 15px;
}
[data-dsh-auto-update-dialog] button[data-dsh-auto-update-close]:hover:not([disabled]),
[data-dsh-auto-update-changelog-dialog] button[data-dsh-auto-update-close]:hover:not([disabled]) {
  background: var(--dsw-alias-interactive-bg-hover, rgb(255 255 255 / 8%));
  color: var(--dsw-alias-label-primary, #e6edf3);
}
[data-dsh-auto-update-dialog] select[data-dsh-auto-update-mode] {
  box-sizing: border-box;
  height: 28px;
  max-width: 220px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base, #0d1117);
  color: var(--dsw-alias-label-primary, #e6edf3);
  font-family: inherit;
  font-size: 12px;
  cursor: default;
  -webkit-app-region: no-drag;
}
[data-dsh-auto-update-dialog] select[data-dsh-auto-update-mode]:disabled { opacity: 0.5; }
[data-dsh-auto-update-dialog] select[data-dsh-auto-update-mode]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #2f81f7);
  outline-offset: -2px;
}
[data-dsh-auto-update-dialog] button[hidden],
[data-dsh-auto-update-dialog] select[hidden] { display: none; }

/* ── Streamed update log and footer note ───────────────────────────────── */
[data-dsh-auto-update-progress] {
  flex: 0 0 auto;
  margin-top: 12px;
  max-height: 220px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #0d1117);
  color: var(--dsw-alias-label-primary, #e6edf3);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}
[data-dsh-auto-update-progress][hidden] { display: none; }
[data-dsh-auto-update-progress] .dsh-auto-update-log-ok { color: var(--dsw-alias-state-success-primary, #3fb950); }
[data-dsh-auto-update-progress] .dsh-auto-update-log-error { color: var(--dsw-alias-state-error-primary, #f85149); }
[data-dsh-auto-update-note] {
  flex: 0 0 auto;
  margin-top: 10px;
  color: var(--dsw-alias-state-warn-label, #d29922);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}
[data-dsh-auto-update-note][hidden] { display: none; }
/* The resident cost-of-click warning: pinned above the build hint, tinted with
   the shared warn tokens so it reads as a caution rather than an error. */
[data-dsh-auto-update-warning] {
  flex: 0 0 auto;
  margin-top: 10px;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary, rgb(210 153 34 / 45%));
  border-radius: 6px;
  background: var(--dsw-alias-state-warn-tertiary, rgb(210 153 34 / 12%));
  color: var(--dsw-alias-state-warn-label, #d29922);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}
[data-dsh-auto-update-footer] {
  flex: 0 0 auto;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, #30363d);
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
[data-dsh-auto-update-footer] code {
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 5px;
  background: var(--dsw-alias-bg-base, #0d1117);
  color: var(--dsw-alias-label-primary, #e6edf3);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
}
[data-dsh-auto-update-footer][hidden] { display: none; }

/* ── Changelog dialog ──────────────────────────────────────────────────── */
[data-dsh-auto-update-changelog-dialog] { position: relative; }
[data-dsh-auto-update-changelog-title] { padding-right: 28px; }
[data-dsh-auto-update-changelog-title] a {
  color: var(--dsw-alias-state-business-primary, #2f81f7);
  text-decoration: none;
  cursor: pointer;
}
[data-dsh-auto-update-changelog-title] a:hover { text-decoration: underline; }
[data-dsh-auto-update-changelog-sub] {
  margin: 0 0 12px;
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}
[data-dsh-auto-update-changelog-loading] {
  padding: 10px 2px;
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 13px;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}
[data-dsh-auto-update-changelog-loading][data-error] { color: var(--dsw-alias-state-error-primary, #f85149); }
[data-dsh-auto-update-changelog-body] {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #0d1117);
  color: var(--dsw-alias-label-primary, #e6edf3);
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}
[data-dsh-auto-update-changelog-body][hidden] { display: none; }
[data-dsh-auto-update-changelog-body] h1,
[data-dsh-auto-update-changelog-body] h2,
[data-dsh-auto-update-changelog-body] h3,
[data-dsh-auto-update-changelog-body] h4,
[data-dsh-auto-update-changelog-body] h5,
[data-dsh-auto-update-changelog-body] h6 {
  margin: 12px 0 6px;
  font-weight: 600;
  line-height: 1.3;
}
[data-dsh-auto-update-changelog-body] h1 { font-size: 16px; }
[data-dsh-auto-update-changelog-body] h2 { font-size: 15px; }
[data-dsh-auto-update-changelog-body] h3 { font-size: 14px; }
[data-dsh-auto-update-changelog-body] h4,
[data-dsh-auto-update-changelog-body] h5,
[data-dsh-auto-update-changelog-body] h6 { font-size: 13px; }
[data-dsh-auto-update-changelog-body] p { margin: 6px 0; }
[data-dsh-auto-update-changelog-body] ul,
[data-dsh-auto-update-changelog-body] ol { margin: 6px 0; padding-left: 22px; }
[data-dsh-auto-update-changelog-body] li { margin: 3px 0; }
[data-dsh-auto-update-changelog-body] li.dsh-auto-update-task { list-style: none; margin-left: -18px; }
[data-dsh-auto-update-changelog-body] code {
  padding: 1px 5px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 4px;
  background: var(--dsw-alias-bg-base, #0d1117);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
}
[data-dsh-auto-update-changelog-body] pre.dsh-auto-update-code {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #0d1117);
  overflow-x: auto;
}
[data-dsh-auto-update-changelog-body] pre.dsh-auto-update-code code {
  border: none;
  padding: 0;
  background: transparent;
  white-space: pre;
}
[data-dsh-auto-update-changelog-body] pre.dsh-auto-update-plain {
  margin: 0;
  white-space: pre-wrap;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
}
[data-dsh-auto-update-changelog-body] blockquote {
  margin: 8px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--dsw-alias-state-business-primary, #2f81f7);
  color: var(--dsw-alias-label-secondary, #8b949e);
}
[data-dsh-auto-update-changelog-body] a { color: var(--dsw-alias-state-business-primary, #2f81f7); }
[data-dsh-auto-update-changelog-body] hr {
  margin: 12px 0;
  border: none;
  border-top: 1px solid var(--dsw-alias-border-l1, #30363d);
}
[data-dsh-auto-update-changelog-body] table { border-collapse: collapse; margin: 8px 0; }
[data-dsh-auto-update-changelog-body] th,
[data-dsh-auto-update-changelog-body] td {
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l1, #30363d);
}
[data-dsh-auto-update-changelog-body] th {
  background: var(--dsw-alias-bg-base, #0d1117);
  font-weight: 600;
}
[data-dsh-auto-update-changelog-body] img { max-width: 100%; border-radius: 6px; }
[data-dsh-auto-update-changelog-commits] {
  margin: 8px 0 0;
  padding-left: 20px;
  list-style: disc;
}
[data-dsh-auto-update-changelog-commits] li {
  margin: 4px 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[data-dsh-auto-update-changelog-commits] code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
}
[data-dsh-auto-update-changelog-commits] .dsh-auto-update-commit-meta {
  color: var(--dsw-alias-label-secondary, #8b949e);
  font-size: 11px;
}
[data-dsh-auto-update-changelog-actions] {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
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
