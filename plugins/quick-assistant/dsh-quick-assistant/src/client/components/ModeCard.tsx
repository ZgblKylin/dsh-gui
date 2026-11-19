/**
 * One mode card: its model-route switch, the provider → model pickers, and the
 * reasoning-effort picker.
 *
 * The reasoning effort is independent of the route switch: it applies to the
 * main model while the mode follows it, and to the dedicated route otherwise.
 * Every transition is computed with `model-catalog.ts` helpers, so the card
 * itself only renders and reports the next override.
 */

import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuickAssistantTranslate } from '../locales.ts'
import {
  activateOverride, defaultRouteLabel, effortOptions, findModel, findProvider, routeSupportsEffort, selectModel,
  selectProvider, withEffort,
} from '../model-catalog.ts'
import type { ModeModelOverride, ModelCatalog } from '../types.ts'
import { Dropdown } from './Dropdown.tsx'
import { Card, Field, styles } from './layout.tsx'

/** Where the catalog load currently stands. */
export type CatalogStatus = 'loading' | 'ready' | 'error'

/** Props of one mode card. */
export interface ModeCardProps {
  t: QuickAssistantTranslate
  /** Localized mode name. */
  title: string
  /** Localized one-line description of the mode. */
  hint: string
  /** The mode's current model override. */
  model: ModeModelOverride
  /** The loaded catalog, or `null` while it is unavailable. */
  catalog: ModelCatalog | null
  /** Load state of the catalog. */
  catalogStatus: CatalogStatus
  /** Try the catalog load again. */
  onRetryCatalog: () => void
  /** The next override for this mode. */
  onChange: (next: ModeModelOverride) => void
}

/**
 * Render one mode card.
 * @param props - copy, the mode's override, and the catalog state.
 * @returns the card element.
 */
export function ModeCard({
  t, title, hint, model, catalog, catalogStatus, onRetryCatalog, onChange,
}: ModeCardProps) {
  const provider = findProvider(catalog, model.provider)
  const selectedModel = findModel(provider, model.model)
  const providers = catalog?.providers ?? []
  const models = provider?.models ?? []
  const route = defaultRouteLabel(catalog)
  const followText = route === undefined ? t('modeFollowDefault') : t('modeFollowDefaultDetail', { route })
  // While following the main model the effort applies to that route, so its
  // levels are the ones to offer.
  const effortRoute = model.useDefault
    ? { provider: catalog?.default.provider, model: catalog?.default.model }
    : { provider: model.provider, model: model.model }
  const efforts = effortOptions(
    catalog, effortRoute.provider, effortRoute.model, t('effortFollowDefault'), t('effortOff'),
  )
  const hasEfforts = efforts.length > 1
  const effortValue = model.reasoningEffort ?? ''
  const effortUnsupported = effortValue !== ''
    && !routeSupportsEffort(catalog, effortRoute.provider, effortRoute.model, effortValue)
  const showCatalogFailure = !model.useDefault && catalogStatus === 'error'

  return (
    <Card>
      <div style={styles.cardHeading}>
        <div style={styles.cardText}>
          <p style={styles.cardTitle}>{title}</p>
          <p style={styles.cardHint}>{hint}</p>
        </div>
        <div style={styles.switchRow}>
          <span>{t('modeUseDefault')}</span>
          <Switch
            checked={!model.useDefault}
            label={t('modeUseDefault')}
            onChange={(custom) => {
              onChange(custom ? activateOverride(catalog, model) : { ...model, useDefault: true })
            }}
          />
        </div>
      </div>
      {catalogStatus === 'loading' && !model.useDefault
        ? <p style={styles.notice} role="status">{t('catalogLoading')}</p>
        : null}
      {showCatalogFailure
        ? (
          <div style={styles.inlineRow} role="alert">
            <p style={styles.error}>{t('catalogFailed')}</p>
            <Button size="sm" variant="ghost" onClick={onRetryCatalog}>{t('catalogRetry')}</Button>
          </div>
        )
        : null}
      {!model.useDefault && catalog !== null && catalogStatus === 'ready' && catalog.providers.length === 0
        ? <p style={styles.notice}>{t('catalogEmpty')}</p>
        : null}
      {model.useDefault ? <p style={styles.notice}>{followText}</p> : null}
      <div style={styles.fieldRow}>
        {model.useDefault
          ? null
          : (
            <>
              <Field label={t('provider')}>
                <Dropdown
                  label={t('provider')}
                  value={model.provider ?? ''}
                  options={providers.map(entry => ({ id: entry.id, label: entry.name }))}
                  placeholder={model.provider ?? '—'}
                  disabled={providers.length === 0}
                  onChange={(id) => {
                    if (catalog === null) return
                    onChange(selectProvider(catalog, id, model))
                  }}
                />
              </Field>
              <Field label={t('model')}>
                <Dropdown
                  label={t('model')}
                  value={model.model ?? ''}
                  options={models.map(entry => ({ id: entry.id, label: entry.name }))}
                  placeholder={model.model ?? '—'}
                  disabled={models.length === 0}
                  onChange={(id) => { onChange(selectModel(model, id)) }}
                />
              </Field>
            </>
          )}
        <Field label={t('reasoningEffort')}>
          {hasEfforts
            ? (
              <Dropdown
                label={t('reasoningEffort')}
                value={effortValue}
                options={efforts}
                placeholder={t('effortFollowDefault')}
                onChange={(id) => { onChange(withEffort(model, id)) }}
              />
            )
            : <div style={styles.fieldPlaceholder}>{catalogStatus === 'ready' ? t('effortNone') : '—'}</div>}
        </Field>
      </div>
      {effortUnsupported ? <p style={styles.notice}>{t('effortUnsupported')}</p> : null}
    </Card>
  )
}
