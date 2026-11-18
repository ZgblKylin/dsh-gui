/**
 * Browser half of the Quick Assistant plugin: the settings section and its
 * navigation icon.
 *
 * The page reads and writes the Host's own `/quick-assistant/api/*` routes, so
 * the only services this plugin needs are the slot ledger and the dictionary
 * registry.
 */

// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings shell's SlotMap merge (the settings.section entries).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactElement } from 'react'
import { QuickAssistantApp } from './App.tsx'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.quick-assistant'

/** Settings section id; the navigation icon registers under the same id. */
export const SECTION_ID = 'quick-assistant'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Navigation icon of the section: one spark glyph that inherits the row's
 * color (the shell dims unselected rows itself).
 * @param props - requested square edge and selected state.
 * @returns the icon element.
 */
function QuickAssistantIcon({ size, active }: PropsRuntime<'settings.section.icon'>): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.7 }}>
      <path
        d="M8.85 1.4 3.3 8.98h3.62l-1.6 5.62 5.47-7.63H7.48l1.37-5.57Z"
        fill="currentColor"
      />
    </svg>
  )
}

/**
 * Register the dictionaries, the settings page, and its navigation icon.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'quick-assistant: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 60,
    label: () => t('nav'),
    locale: NS,
  }, QuickAssistantApp)), 'quick-assistant: settings section')
  ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: SECTION_ID,
  }, QuickAssistantIcon)), 'quick-assistant: settings icon')
}
