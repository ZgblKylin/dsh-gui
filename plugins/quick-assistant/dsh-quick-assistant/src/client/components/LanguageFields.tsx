/**
 * Automatic-translation language pair: the first and second language the
 * assistant chooses between when the target language is automatic.
 */

import type { QuickAssistantTranslate } from '../locales.ts'
import type { LanguageOption, TranslationSettings } from '../types.ts'
import { Dropdown } from './Dropdown.tsx'
import { Field, styles } from './layout.tsx'

/** Props of the language pair. */
export interface LanguageFieldsProps {
  t: QuickAssistantTranslate
  /** Language table from `GET /api/settings`. */
  languages: readonly LanguageOption[]
  /** Current pair. */
  translation: TranslationSettings
  /** One side of the pair, already validated against the table. */
  onChange: (field: keyof TranslationSettings, code: string) => void
}

/**
 * Render the two language dropdowns.
 * @param props - copy, the language table, the pair, and the write callback.
 * @returns the pair element.
 */
export function LanguageFields({ t, languages, translation, onChange }: LanguageFieldsProps) {
  const options = languages.map(language => ({ id: language.code, label: language.label }))
  return (
    <>
      <div style={styles.fieldRow}>
        <Field label={t('languagePrimary')}>
          <Dropdown
            label={t('languagePrimary')}
            value={translation.primaryLanguage}
            options={options}
            placeholder={translation.primaryLanguage}
            onChange={(code) => { onChange('primaryLanguage', code) }}
          />
        </Field>
        <Field label={t('languageSecondary')}>
          <Dropdown
            label={t('languageSecondary')}
            value={translation.secondaryLanguage}
            options={options}
            placeholder={translation.secondaryLanguage}
            onChange={(code) => { onChange('secondaryLanguage', code) }}
          />
        </Field>
      </div>
      {translation.primaryLanguage === translation.secondaryLanguage
        ? <p style={styles.warning} role="status">{t('languageSame')}</p>
        : null}
    </>
  )
}
