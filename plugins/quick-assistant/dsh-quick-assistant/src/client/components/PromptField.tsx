/**
 * One mode's prompt template: a monospace textarea, its placeholder hint, and
 * the control that restores the Host-provided default.
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuickAssistantTranslate } from '../locales.ts'
import { Card, styles } from './layout.tsx'

/** Props of one template card. */
export interface PromptFieldProps {
  t: QuickAssistantTranslate
  /** Localized mode name. */
  label: string
  /** Current template text. */
  value: string
  /** Localized list of placeholders the mode supports. */
  hint: string
  /** Visible text rows. */
  rows: number
  /** The next template text. */
  onChange: (value: string) => void
  /** Restore the Host-provided default template. */
  onReset: () => void
}

/**
 * Render one template card.
 * @param props - copy, the current template, and its two actions.
 * @returns the card element.
 */
export function PromptField({ t, label, value, hint, rows, onChange, onReset }: PromptFieldProps) {
  return (
    <Card>
      <div style={styles.promptHeading}>
        <span style={styles.cardTitle}>{label}</span>
        <Button size="sm" variant="ghost" onClick={onReset}>{t('promptReset')}</Button>
      </div>
      <textarea
        style={styles.textarea}
        value={value}
        rows={rows}
        spellCheck={false}
        aria-label={label}
        onChange={(event) => { onChange(event.target.value) }}
      />
      <p style={styles.notice}>{hint}</p>
    </Card>
  )
}
