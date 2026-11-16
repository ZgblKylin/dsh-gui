/**
 * Locale copy for the Auto review model override card.
 *
 * Every product-visible string on the card lives here so the plugin owns its
 * copy instead of the host shell.
 */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the card renders. */
export type AutoReviewModelLocaleKey =
  | 'title' | 'description'
  | 'toggle' | 'toggleOn' | 'toggleOff'
  | 'provider' | 'model'
  | 'loading' | 'loadFailed' | 'retry' | 'partial' | 'empty'
  | 'required' | 'conflict'
  | 'save' | 'saving' | 'saveFailed' | 'readOnly' | 'unavailable'

/** Chinese copy. */
export const zh: Record<AutoReviewModelLocaleKey, string> = {
  title: '自动审查模型',
  description: '指定 Auto review 审查请求使用的 provider 与模型。',
  toggle: '自定义审查模型',
  toggleOn: '审查请求走下面选中的路由，与被审 agent 的主模型无关。',
  toggleOff: '关闭后审查沿用被审 agent 当前使用的模型；已选路由会保留。',
  provider: 'Provider',
  model: '模型',
  loading: '正在加载模型目录…',
  loadFailed: '模型目录加载失败。',
  retry: '重试',
  partial: '部分 provider 的模型目录加载失败，可选范围可能不完整。',
  empty: '当前部署没有可选的模型。',
  required: '请选择一个 provider 与模型后再保存。',
  conflict: '配置已在别处变更，请放弃草稿后重试。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '部署未接受这些值，草稿已保留以便修正。',
  readOnly: '此部署以只读方式存储设置。',
  unavailable: '该插件当前未加载，无法配置。',
}

/** English copy, keyed by the same identifiers. */
export const en: Record<AutoReviewModelLocaleKey, string> = {
  title: 'Auto review model',
  description: 'Choose the provider and model that Auto review uses for reviewer requests.',
  toggle: 'Use a custom reviewer model',
  toggleOn: 'Reviewer requests use the route selected below instead of the reviewed agent\'s own model.',
  toggleOff: 'Reviewer requests keep using the reviewed agent\'s current model; the saved route is retained.',
  provider: 'Provider',
  model: 'Model',
  loading: 'Loading the model catalog…',
  loadFailed: 'The model catalog could not be loaded.',
  retry: 'Retry',
  partial: 'Some providers could not be listed; the available choices may be incomplete.',
  empty: 'This deployment advertises no models.',
  required: 'Select a provider and model before saving.',
  conflict: 'The configuration changed elsewhere. Discard the draft and try again.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; the draft was kept for correction.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
}

/**
 * Derive the shared form frame's copy from one bound translator.
 * @param t - translator bound to this card's namespace.
 * @returns Labels the settings form frame renders.
 */
export function formLabels(t: (key: AutoReviewModelLocaleKey) => string): SettingsFormLabels {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}
