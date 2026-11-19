/**
 * Page footer: the draft's state and the two write actions.
 *
 * Only 保存 writes; 放弃 drops the draft and re-reads the last stored document.
 * The failure line keeps the draft on screen so the user can correct it.
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuickAssistantTranslate } from '../locales.ts'
import { styles } from './layout.tsx'

/** Props of the footer. */
export interface SettingsFooterProps {
  t: QuickAssistantTranslate
  /** Whether the draft differs from the stored document. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save succeeded. */
  saved: boolean
  /** Host-reported failure of the last save, if any. */
  saveError: string | null
  /** Write the draft. */
  onSave: () => void
  /** Drop the draft. */
  onDiscard: () => void
}

/**
 * Render the footer.
 * @param props - draft state and the two actions.
 * @returns the footer element.
 */
export function SettingsFooter({ t, dirty, saving, saved, saveError, onSave, onDiscard }: SettingsFooterProps) {
  let status = ''
  if (dirty) status = t('footerDirty')
  else if (saved) status = t('footerSaved')
  return (
    <footer style={styles.footer}>
      {saveError !== null ? <p style={styles.error} role="alert">{t('footerSaveFailed', { message: saveError })}</p> : null}
      <div style={styles.footerRow}>
        <p style={styles.footerStatus} role="status">{status}</p>
        <div style={styles.footerActions}>
          <Button variant="outline" disabled={!dirty || saving} onClick={onDiscard}>{t('footerDiscard')}</Button>
          <Button variant="primary" disabled={!dirty || saving} onClick={onSave}>
            {saving ? t('footerSaving') : t('footerSave')}
          </Button>
        </div>
      </div>
    </footer>
  )
}
