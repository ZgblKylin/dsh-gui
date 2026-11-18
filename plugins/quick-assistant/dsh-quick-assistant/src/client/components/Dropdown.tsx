/**
 * Dropdown over the shared menu primitive.
 *
 * The design system has no select control: a dropdown is a menu whose anchor is
 * the current value. The menu is portaled so a scrolling settings column cannot
 * clip it.
 */

import { useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

/** One selectable value. */
export interface DropdownOption {
  id: string
  label: string
}

/** Style roles of the trigger: the same surface as an input, with a chevron. */
const styles = {
  trigger: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '6px',
    width: '100%',
    height: '32px',
    padding: '0 10px',
    boxSizing: 'border-box',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-md)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    font: 'var(--dsw-font-s-14)',
    textAlign: 'left',
    cursor: 'pointer',
  },
  triggerDisabled: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '6px',
    width: '100%',
    height: '32px',
    padding: '0 10px',
    boxSizing: 'border-box',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-md)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    font: 'var(--dsw-font-s-14)',
    textAlign: 'left',
    cursor: 'default',
  },
  value: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chevron: { flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary)' },
} as const

/** Inline chevron; the menu primitive owns the list, this marks the trigger. */
function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={styles.chevron}>
      <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Props of one dropdown. */
export interface DropdownProps {
  /** Accessible name of the control. */
  label: string
  /** Currently selected option id. */
  value: string
  /** Selectable options, in display order. */
  options: readonly DropdownOption[]
  /** Text shown while no option matches `value`. */
  placeholder?: string | undefined
  /** Whether the control refuses input. */
  disabled?: boolean
  /** Activation with the picked option id. */
  onChange: (id: string) => void
}

/**
 * Render the trigger plus its menu.
 * @param props - accessible name, current value, options, and the pick callback.
 * @returns the dropdown element.
 */
export function Dropdown({ label, value, options, placeholder, disabled = false, onChange }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.id === value)
  const interactive = !disabled && options.length > 0
  const items: MenuEntry[] = options.map(option => ({ id: option.id, label: option.label }))
  const shown = selected?.label ?? placeholder ?? ''
  return (
    <Menu
      open={open && interactive}
      items={items}
      selectedId={value}
      onSelect={(id) => {
        setOpen(false)
        onChange(id)
      }}
      onClose={() => { setOpen(false) }}
      portal
      anchor={(
        <button
          type="button"
          style={interactive ? styles.trigger : styles.triggerDisabled}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open && interactive}
          disabled={!interactive}
          onClick={() => { setOpen(current => !current) }}
        >
          <span style={styles.value}>{shown}</span>
          <Chevron />
        </button>
      )}
    />
  )
}
