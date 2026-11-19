/**
 * Shortcut recorder: capture a key combination, show it, and test the summon
 * path.
 *
 * The combination is captured on the window's capture phase so the settings
 * panel's own key handling cannot consume it first; the recorder only stops
 * after a usable combination, and Escape cancels.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuickAssistantTranslate } from '../locales.ts'
import { formatShortcut, isModifierKey } from '../shortcut.ts'
import { styles } from './layout.tsx'

/** Where the test-summon request currently stands. */
export type SummonTestState = 'idle' | 'sending' | 'sent' | 'failed'

/** Props of the shortcut row. */
export interface ShortcutFieldProps {
  t: QuickAssistantTranslate
  /** Stored combination; empty while none is set. */
  value: string
  /** Whether the test-summon control can run (the native helper is running). */
  canTest: boolean
  /** State of the last test-summon request. */
  testState: SummonTestState
  /** A captured combination, already formatted for storage. */
  onChange: (shortcut: string) => void
  /** Send one test-summon request. */
  onTest: () => void
}

/** Layout of the row: the key display plus its controls and status lines. */
const layout = {
  root: { display: 'flex', flexDirection: 'column', gap: '8px' },
} as const

/**
 * Render the recorder.
 * @param props - stored combination, test state, and the two actions.
 * @returns the shortcut row.
 */
export function ShortcutField({ t, value, canTest, testState, onChange, onTest }: ShortcutFieldProps) {
  const [recording, setRecording] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const changeRef = useRef(onChange)
  changeRef.current = onChange

  useEffect(() => {
    if (!recording) return
    const stop = (): void => {
      setRecording(false)
      setInvalid(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      const plainEscape = event.key === 'Escape'
        && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
      if (plainEscape) {
        stop()
        return
      }
      if (isModifierKey(event.key)) return
      const shortcut = formatShortcut(event)
      if (shortcut === null) {
        setInvalid(true)
        return
      }
      setInvalid(false)
      setRecording(false)
      changeRef.current(shortcut)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', stop)
    }
  }, [recording])

  const toggleRecording = (): void => {
    setInvalid(false)
    setRecording(current => !current)
  }
  const shown = value === '' ? t('shortcutUnset') : value
  return (
    <div style={layout.root}>
      <div style={styles.inlineRow}>
        <button
          type="button"
          style={recording ? styles.keycapRecording : styles.keycap}
          aria-label={recording ? t('shortcutRecording') : `${t('shortcutRecord')} ${shown}`}
          aria-pressed={recording}
          onClick={toggleRecording}
        >
          {recording ? t('shortcutRecording') : shown}
        </button>
        <Button size="sm" variant="outline" onClick={toggleRecording}>
          {recording ? t('shortcutCancel') : t('shortcutRecord')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canTest || testState === 'sending'}
          title={canTest ? undefined : t('shortcutTestUnavailable')}
          onClick={onTest}
        >
          {testState === 'sending' ? t('shortcutTesting') : t('shortcutTest')}
        </Button>
      </div>
      {recording
        ? <p style={invalid ? styles.warning : styles.notice} role="status">{invalid ? t('shortcutInvalid') : t('shortcutRecordHint')}</p>
        : null}
      {!recording && testState === 'failed' ? <p style={styles.error} role="alert">{t('shortcutTestFailed')}</p> : null}
      {!recording && testState === 'sent' ? <p style={styles.success} role="status">{t('shortcutTestSent')}</p> : null}
    </div>
  )
}
