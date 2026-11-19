/**
 * Keyboard-combination capture for the shortcut recorder.
 *
 * A recorded combination always names at least one modifier, because a bare key
 * would fire the assistant while the user types anywhere.
 */

/** Keys that are modifiers themselves and never complete a combination. */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS', 'Super', 'Hyper'])

/** Display names for keys whose `KeyboardEvent.key` is not self-describing. */
const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
}

/**
 * Whether a key press only moves a modifier, so the recorder waits for the key.
 * @param key - `KeyboardEvent.key` of the press.
 * @returns whether the key is a modifier.
 */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

/**
 * Format one key press the way the Host stores it, or report that it cannot be a
 * shortcut. Modifiers are ordered Ctrl, Alt, Shift, Meta.
 * @param event - the press to format.
 * @returns the combination (for example `Ctrl+Alt+Space`), or `null` while the
 * press carries no modifier or only names a modifier.
 */
export function formatShortcut(event: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  if (isModifierKey(event.key) || event.key === '' || event.key === 'Unidentified') return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  if (parts.length === 0) return null
  parts.push(keyLabel(event.key))
  return parts.join('+')
}

/**
 * Display name of one non-modifier key.
 * @param key - `KeyboardEvent.key` of the press.
 * @returns the stored key name.
 */
function keyLabel(key: string): string {
  const known = KEY_LABELS[key]
  if (known !== undefined) return known
  return key.length === 1 ? key.toUpperCase() : key
}
