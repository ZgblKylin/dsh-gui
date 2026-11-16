/**
 * Browser half: the Auto review model card on this plugin's own page under
 * Plugins → Installed.
 *
 * The card is keyed by the bundle's npm package name in
 * `plugins.bundle.config`, while its settings form is the profile entry's
 * volatile Config fields, whose namespace is the entry id. The card registers
 * only while the Host serves that namespace, so a deployment that never loaded
 * the entry shows no trace of it.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.bundle.config' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { AutoReviewModelCard } from './AutoReviewModelCard.tsx'
import { createAutoReviewModelCardStore } from './card-controller.ts'
import { en, zh, type AutoReviewModelLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Auto review model card copy. */
    'plugins.auto-review-model': AutoReviewModelLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'plugins.auto-review-model'

/** Profile entry id: the settings form namespace the Host serves. */
export const ENTRY_ID = 'auto-review-model'

/** npm package name: the `plugins.bundle.config` contribution key. */
export const BUNDLE_PACKAGE = 'dsh-auto-review-model'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

/**
 * Mount the reviewer-route card on this plugin's bundle page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'auto-review-model: dictionaries')
  const card = createAutoReviewModelCardStore(ctx.configForms.get(ENTRY_ID), ctx)
  const face = card.inject()
  ctx.effect(() => () => { card.dispose() }, 'auto-review-model: form subscription')
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { card.refreshCatalog() }),
    'auto-review-model: adapter invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', () => { card.refreshCatalog() }),
    'auto-review-model: settings invalidations',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { card.resetConnection() }),
    'auto-review-model: connection generation',
  )
  ctx.effect(
    () => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_PACKAGE,
      locale: NS,
      inject: () => face,
    }, AutoReviewModelCard))),
    'auto-review-model: card',
  )
}
