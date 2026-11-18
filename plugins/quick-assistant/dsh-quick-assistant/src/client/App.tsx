/**
 * The Quick Assistant settings page.
 *
 * The page loads the Host document once, edits a local copy, and writes that
 * copy only through 保存; the catalog and the helper health are independent
 * reads, so neither a missing catalog nor a stopped native helper blocks
 * editing or saving.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { describeError, loadCatalog, loadHealth, loadSettings, saveSettings, showAssistant } from './api.ts'
import { LanguageFields } from './components/LanguageFields.tsx'
import { ModeCard } from './components/ModeCard.tsx'
import type { CatalogStatus } from './components/ModeCard.tsx'
import { PromptField } from './components/PromptField.tsx'
import { Section, styles } from './components/layout.tsx'
import { SettingsFooter } from './components/SettingsFooter.tsx'
import { ShortcutField } from './components/ShortcutField.tsx'
import type { SummonTestState } from './components/ShortcutField.tsx'
import { MODE_IDS } from './types.ts'
import type {
  HealthPayload, ModeId, ModeModelOverride, ModeSettings, ModelCatalog, QuickAssistantSettings,
  SettingsPayload, TranslationSettings,
} from './types.ts'
import type { QuickAssistantLocaleKey, QuickAssistantTranslate } from './locales.ts'

/** Composed slot props of the settings section. */
export type QuickAssistantAppProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.quick-assistant'>

/** Mode name key of each mode. */
const MODE_LABEL_KEYS: Record<ModeId, QuickAssistantLocaleKey> = {
  ask: 'modeAsk',
  translate: 'modeTranslate',
  summary: 'modeSummary',
  explain: 'modeExplain',
}

/** Mode description key of each mode. */
const MODE_HINT_KEYS: Record<ModeId, QuickAssistantLocaleKey> = {
  ask: 'modeAskHint',
  translate: 'modeTranslateHint',
  summary: 'modeSummaryHint',
  explain: 'modeExplainHint',
}

/** Placeholder-support key of each mode's template. */
const MODE_PLACEHOLDER_KEYS: Record<ModeId, QuickAssistantLocaleKey> = {
  ask: 'promptPlaceholdersText',
  translate: 'promptPlaceholdersTranslate',
  summary: 'promptPlaceholdersText',
  explain: 'promptPlaceholdersText',
}

/** Visible text rows of each mode's template editor. */
const MODE_PROMPT_ROWS: Record<ModeId, number> = { ask: 4, translate: 6, summary: 4, explain: 4 }

/**
 * Serialize a document for the dirty comparison. Every edit spreads the loaded
 * object, so property order stays stable between the draft and its baseline.
 * @param settings - document to serialize.
 * @returns its JSON form.
 */
function serialize(settings: QuickAssistantSettings): string {
  return JSON.stringify(settings)
}

/**
 * Render the Quick Assistant settings page.
 * @param props - the standards seat's `t` (the section supplies no owner data).
 * @returns the page, or its loading/error state.
 */
export function QuickAssistantApp({ t }: QuickAssistantAppProps): ReactElement {
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [draft, setDraft] = useState<QuickAssistantSettings | null>(null)
  const [savedKey, setSavedKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>('loading')
  const [catalogKey, setCatalogKey] = useState(0)
  const [health, setHealth] = useState<HealthPayload | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [healthKey, setHealthKey] = useState(0)
  const [testState, setTestState] = useState<SummonTestState>('idle')
  /** Edit generation: a late background read must not overwrite newer edits. */
  const editSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    loadSettings()
      .then((next) => {
        if (cancelled) return
        editSeq.current += 1
        setPayload(next)
        setDraft(next.settings)
        setSavedKey(serialize(next.settings))
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(describeError(error))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [reloadKey])

  useEffect(() => {
    let cancelled = false
    setCatalogStatus('loading')
    loadCatalog()
      .then((next) => {
        if (cancelled) return
        setCatalog(next)
        setCatalogStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setCatalogStatus('error')
      })
    return () => { cancelled = true }
  }, [catalogKey])

  useEffect(() => {
    let cancelled = false
    setHealthError(false)
    loadHealth()
      .then((next) => {
        if (cancelled) return
        setHealth(next)
      })
      .catch(() => {
        if (cancelled) return
        setHealth(null)
        setHealthError(true)
      })
    return () => { cancelled = true }
  }, [healthKey])

  const update = useCallback((mutate: (current: QuickAssistantSettings) => QuickAssistantSettings): void => {
    editSeq.current += 1
    setSaved(false)
    setSaveError(null)
    setDraft((current) => (current === null ? current : mutate(current)))
  }, [])

  const updateMode = useCallback((mode: ModeId, mutate: (current: ModeSettings) => ModeSettings): void => {
    update((current) => ({ ...current, modes: { ...current.modes, [mode]: mutate(current.modes[mode]) } }))
  }, [update])

  const changeModel = useCallback((mode: ModeId, next: ModeModelOverride): void => {
    updateMode(mode, (current) => ({ ...current, model: next }))
  }, [updateMode])

  const changePrompt = useCallback((mode: ModeId, prompt: string): void => {
    updateMode(mode, (current) => ({ ...current, prompt }))
  }, [updateMode])

  const resetPrompt = useCallback((mode: ModeId): void => {
    const defaults = payload?.defaults
    if (defaults === undefined) return
    updateMode(mode, (current) => ({ ...current, prompt: defaults.modes[mode].prompt }))
  }, [payload, updateMode])

  const changeLanguage = useCallback((field: keyof TranslationSettings, code: string): void => {
    update((current) => ({
      ...current,
      translation: field === 'primaryLanguage'
        ? { ...current.translation, primaryLanguage: code }
        : { ...current.translation, secondaryLanguage: code },
    }))
  }, [update])

  const save = useCallback((): void => {
    if (draft === null || saving) return
    setSaving(true)
    setSaveError(null)
    saveSettings(draft)
      .then((stored) => {
        editSeq.current += 1
        setPayload((current) => (current === null ? current : { ...current, settings: stored }))
        setDraft(stored)
        setSavedKey(serialize(stored))
        setSaved(true)
        // The Host re-reads the document itself when it saves, which is what
        // refreshes the native shortcut; read it back once so a Host-side
        // normalization wins, unless the user edited again in the meantime.
        const seq = editSeq.current
        loadSettings()
          .then((next) => {
            if (editSeq.current !== seq) return
            setPayload(next)
            setDraft(next.settings)
            setSavedKey(serialize(next.settings))
          })
          // The save already succeeded; the PUT response is authoritative.
          .catch(() => undefined)
      })
      .catch((error: unknown) => { setSaveError(describeError(error)) })
      .finally(() => { setSaving(false) })
  }, [draft, saving])

  const discard = useCallback((): void => {
    const stored = payload?.settings
    if (stored === undefined) return
    editSeq.current += 1
    setDraft(stored)
    setSavedKey(serialize(stored))
    setSaveError(null)
    setSaved(false)
  }, [payload])

  const testShow = useCallback((): void => {
    setTestState('sending')
    showAssistant()
      .then(() => { setTestState('sent') })
      .catch(() => { setTestState('failed') })
  }, [])

  if (loading && draft === null) {
    return <p style={styles.notice} role="status">{t('loading')}</p>
  }
  if (draft === null || payload === null) {
    return (
      <div style={styles.errorBlock} role="alert">
        <p style={styles.error}>{t('loadFailed', { message: loadError ?? '' })}</p>
        <Button variant="outline" size="sm" onClick={() => { setReloadKey(key => key + 1) }}>{t('retry')}</Button>
      </div>
    )
  }

  const translate: QuickAssistantTranslate = t
  const dirty = serialize(draft) !== savedKey
  const helperRunning = health?.helperRunning ?? true
  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h2 style={styles.title}>{t('title')}</h2>
        <p style={styles.description}>{t('description')}</p>
      </header>

      <Section title={t('shortcutTitle')} description={t('shortcutDescription')}>
        <div style={styles.card}>
          <ShortcutField
            t={translate}
            value={draft.shortcut}
            canTest={helperRunning}
            testState={testState}
            onChange={(shortcut) => { update(current => ({ ...current, shortcut })) }}
            onTest={testShow}
          />
        </div>
      </Section>

      <Section title={t('modesTitle')} description={t('modesDescription')}>
        <div style={styles.cardStack}>
          {MODE_IDS.map(mode => (
            <ModeCard
              key={mode}
              t={translate}
              title={t(MODE_LABEL_KEYS[mode])}
              hint={t(MODE_HINT_KEYS[mode])}
              model={draft.modes[mode].model}
              catalog={catalog}
              catalogStatus={catalogStatus}
              onRetryCatalog={() => { setCatalogKey(key => key + 1) }}
              onChange={(next) => { changeModel(mode, next) }}
            />
          ))}
        </div>
      </Section>

      <Section title={t('promptTitle')} description={t('promptDescription')}>
        <div style={styles.cardStack}>
          {MODE_IDS.map(mode => (
            <PromptField
              key={mode}
              t={translate}
              label={t(MODE_LABEL_KEYS[mode])}
              value={draft.modes[mode].prompt}
              hint={t(MODE_PLACEHOLDER_KEYS[mode])}
              rows={MODE_PROMPT_ROWS[mode]}
              onChange={(prompt) => { changePrompt(mode, prompt) }}
              onReset={() => { resetPrompt(mode) }}
            />
          ))}
        </div>
      </Section>

      <Section title={t('languageTitle')} description={t('languageDescription')}>
        <div style={styles.card}>
          <LanguageFields
            t={translate}
            languages={payload.languages}
            translation={draft.translation}
            onChange={changeLanguage}
          />
        </div>
      </Section>

      {(health !== null && !health.helperRunning) || healthError
        ? (
          <div style={styles.helperStatus}>
            {health !== null && !health.helperRunning
              ? <p style={styles.warning} role="status">{t('helperNotRunning')}</p>
              : null}
            {healthError
              ? (
                <div style={styles.banner} role="status">
                  <p style={styles.bannerText}>{t('helperUnknown')}</p>
                  <Button size="sm" variant="ghost" onClick={() => { setHealthKey(key => key + 1) }}>{t('helperRetry')}</Button>
                </div>
              )
              : null}
          </div>
        )
        : null}

      <SettingsFooter
        t={translate}
        dirty={dirty}
        saving={saving}
        saved={saved}
        saveError={saveError}
        onSave={save}
        onDiscard={discard}
      />
    </div>
  )
}
