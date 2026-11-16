/**
 * Plugin info card for the Auto review reviewer route.
 *
 * Presentation only: every value and callback arrives through the derived
 * props shares, so the component never reaches a context or a service.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsForm, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AutoReviewModelCardFace } from './card-controller.ts'
import { formLabels } from './locales.ts'

/** Framework-derived props for the Auto review model card. */
export type AutoReviewModelCardProps = PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'plugins.auto-review-model'>
  & InjectFace<AutoReviewModelCardFace>

/** Layout-only inline styles; every color comes from the surrounding tokens. */
const styles = {
  card: { display: 'flex', flexDirection: 'column' as const, gap: '12px' },
  toggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' },
  heading: { margin: 0, fontSize: '13px', fontWeight: 600 },
  hint: { margin: '4px 0 0', fontSize: '12px', lineHeight: 1.5 },
  fields: { display: 'flex', flexDirection: 'column' as const, gap: '10px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px', fontSize: '12px' },
  label: { fontWeight: 600 },
  notice: { margin: 0, fontSize: '12px', lineHeight: 1.5 },
  errorRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' },
} as const

/**
 * Render the reviewer-route switch and its provider/model pickers.
 * @param props - locale copy, the card snapshot, and its staged actions.
 * @returns the summary line, or the settings form with its save control.
 */
export function AutoReviewModelCard(props: AutoReviewModelCardProps) {
  const { t } = props
  const state = props.useAutoReviewModelCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const modelGroup = state.groups.find(group => group.id === state.provider)
  const models = modelGroup?.models ?? []
  const disabled = !state.writable || state.saving
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div style={styles.card}>
        <div style={styles.toggleRow}>
          <div>
            <p style={styles.heading}>{t('title')}</p>
            <p style={styles.hint}>{t(state.enabled ? 'toggleOn' : 'toggleOff')}</p>
          </div>
          <Switch
            checked={state.enabled}
            label={t('toggle')}
            disabled={disabled}
            onChange={props.toggleEnabled}
          />
        </div>
        {state.enabled
          ? (
            <div style={styles.fields}>
              {state.catalogStatus === 'loading'
                ? <p style={styles.notice} role="status">{t('loading')}</p>
                : null}
              {state.catalogStatus === 'error'
                ? (
                  <div style={styles.errorRow} role="alert">
                    <span>{t('loadFailed')}</span>
                    <button type="button" disabled={state.saving} onClick={props.retryCatalog}>
                      {t('retry')}
                    </button>
                  </div>
                )
                : null}
              {state.catalogStatus === 'ready' && state.groups.length === 0
                ? <p style={styles.notice}>{t('empty')}</p>
                : null}
              {state.catalogPartial ? <p style={styles.notice}>{t('partial')}</p> : null}
              <label style={styles.field}>
                <span style={styles.label}>{t('provider')}</span>
                <select
                  value={state.provider ?? ''}
                  disabled={disabled || state.groups.length === 0}
                  onChange={(event) => { props.selectProvider(event.target.value) }}
                >
                  {state.groups.map(group => (
                    <option key={group.id} value={group.id}>{group.name || group.id}</option>
                  ))}
                </select>
              </label>
              <label style={styles.field}>
                <span style={styles.label}>{t('model')}</span>
                <select
                  value={state.model ?? ''}
                  disabled={disabled || models.length === 0}
                  onChange={(event) => { props.selectModel(event.target.value) }}
                >
                  {models.map(model => (
                    <option key={model.id} value={model.id}>{model.name || model.id}</option>
                  ))}
                </select>
              </label>
              {state.invalid ? <p style={styles.notice} role="alert">{t('required')}</p> : null}
            </div>
          )
          : null}
        {state.conflicted ? <p style={styles.notice} role="alert">{t('conflict')}</p> : null}
      </div>
    </SettingsForm>
  )
}
