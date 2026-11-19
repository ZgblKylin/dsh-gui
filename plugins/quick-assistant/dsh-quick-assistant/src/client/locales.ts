/**
 * Copy dictionaries for the Quick Assistant settings section.
 *
 * Every product-visible string on the page lives here, keyed by the same
 * identifiers in both shipped languages; the typed registration at the plugin
 * entry rejects a dictionary that misses a key.
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** English copy. Its key set defines the namespace's dictionary union. */
export const en = {
  nav: 'Quick Assistant',
  title: 'Quick Assistant',
  description: 'Summon the assistant from any app with a global shortcut, then ask a question, translate, summarize, or explain.',
  shortcutTitle: 'Shortcut',
  shortcutDescription: 'Click the key display and press a combination. At least one of Ctrl, Alt, Shift, or Meta is required.',
  shortcutRecord: 'Record shortcut',
  shortcutRecording: 'Press a key combination…',
  shortcutCancel: 'Cancel recording',
  shortcutUnset: 'Not set',
  shortcutRecordHint: 'Press Esc to cancel recording.',
  shortcutInvalid: 'Include at least one of Ctrl, Alt, Shift, or Meta.',
  shortcutTest: 'Test summon',
  shortcutTesting: 'Summoning…',
  shortcutTestSent: 'Test request sent. The assistant window should appear.',
  shortcutTestFailed: 'The summon request failed.',
  shortcutTestUnavailable: 'The native helper is not running.',
  helperNotRunning: 'The native helper is not running: the shortcut and summoning are unavailable. Settings can still be saved.',
  helperUnknown: 'The native helper status could not be read.',
  helperRetry: 'Retry',
  modesTitle: 'Modes and models',
  modesDescription: 'Choose a model per mode. With the override off, the mode follows the main model.',
  modeAsk: 'Answer this question',
  modeAskHint: 'Answer the input directly, and continue the conversation with follow-up questions.',
  modeTranslate: 'Translate text',
  modeTranslateHint: 'Translate the input into the target language chosen in the automatic translation settings.',
  modeSummary: 'Summarize content',
  modeSummaryHint: 'Condense the input into its key points.',
  modeExplain: 'Explain',
  modeExplainHint: 'Explain a concept, a term, or a passage in the input.',
  modeUseDefault: 'Use a dedicated model',
  modeFollowDefault: 'Following the main model.',
  modeFollowDefaultDetail: 'Main model: {route}',
  provider: 'Provider',
  model: 'Model',
  reasoningEffort: 'Reasoning effort',
  effortFollowDefault: 'Follow the model default',
  effortOff: 'Off (no thinking)',
  effortUnsupported: 'This model does not expose that level, so the request uses its default effort.',
  effortNone: 'This model exposes no reasoning levels.',
  catalogLoading: 'Loading the model catalog…',
  catalogFailed: 'The model catalog could not be loaded.',
  catalogRetry: 'Retry',
  catalogEmpty: 'This deployment advertises no models, so the override stays unavailable.',
  promptTitle: 'Prompt templates',
  promptDescription: 'The template each mode sends to the model.',
  promptPlaceholdersText: 'Supported placeholders: {{text}}, {{systemLanguage}}',
  promptPlaceholdersTranslate: 'Supported placeholders: {{text}}, {{sourceLanguage}}, {{targetLanguage}}, {{primaryLanguage}}, {{secondaryLanguage}}',
  promptReset: 'Restore default',
  languageTitle: 'Automatic translation languages',
  languageDescription: 'When the target language is automatic, the assistant picks whichever of the two differs from the source language.',
  languagePrimary: 'First language',
  languageSecondary: 'Second language',
  languageSame: 'Both languages are the same; the automatic target cannot differ from the source language.',
  footerSave: 'Save',
  footerSaving: 'Saving…',
  footerDiscard: 'Discard',
  footerDirty: 'Unsaved changes',
  footerSaved: 'Saved',
  footerSaveFailed: 'Saving failed: {message}',
  loading: 'Loading settings…',
  loadFailed: 'Settings could not be loaded: {message}',
  retry: 'Retry',
}

/** Dictionary key union of this namespace. */
export type QuickAssistantLocaleKey = keyof typeof en

/** Chinese copy, complete over the English key set. */
export const zh: Record<QuickAssistantLocaleKey, string> = {
  nav: '快捷助手',
  title: '快捷助手',
  description: '在任意应用中按下全局快捷键唤起助手，然后提问、翻译、总结或解释。',
  shortcutTitle: '快捷键',
  shortcutDescription: '点击按键显示后按下组合键；组合键至少包含 Ctrl、Alt、Shift、Meta 之一。',
  shortcutRecord: '录制快捷键',
  shortcutRecording: '请按下组合键…',
  shortcutCancel: '取消录制',
  shortcutUnset: '未设置',
  shortcutRecordHint: '按 Esc 取消录制。',
  shortcutInvalid: '组合键至少包含 Ctrl、Alt、Shift、Meta 之一。',
  shortcutTest: '测试唤起',
  shortcutTesting: '正在唤起…',
  shortcutTestSent: '已发送唤起请求，助手窗口应会出现。',
  shortcutTestFailed: '唤起请求失败。',
  shortcutTestUnavailable: '原生助手未运行。',
  helperNotRunning: '原生助手未运行：快捷键与唤起暂不可用，设置仍可保存。',
  helperUnknown: '无法读取原生助手状态。',
  helperRetry: '重试',
  modesTitle: '模式与模型',
  modesDescription: '为每个模式单独选择模型；关闭后该模式跟随主模型。',
  modeAsk: '回答此问题',
  modeAskHint: '直接回答输入内容，并可继续追问。',
  modeTranslate: '文本翻译',
  modeTranslateHint: '把输入文本翻译成自动翻译语言设置中的目标语言。',
  modeSummary: '内容总结',
  modeSummaryHint: '提炼输入文本的要点。',
  modeExplain: '解释说明',
  modeExplainHint: '解释输入内容中的概念、术语或段落。',
  modeUseDefault: '单独配置模型',
  modeFollowDefault: '跟随主模型',
  modeFollowDefaultDetail: '主模型：{route}',
  provider: 'Provider',
  model: '模型',
  reasoningEffort: '思考等级',
  effortFollowDefault: '跟随模型默认',
  effortOff: '关闭思考（off）',
  effortUnsupported: '当前模型不提供该等级，请求将使用模型默认等级。',
  effortNone: '该模型不支持思考等级。',
  catalogLoading: '正在加载模型目录…',
  catalogFailed: '模型目录加载失败。',
  catalogRetry: '重试',
  catalogEmpty: '当前部署没有可选的模型，暂时无法单独配置。',
  promptTitle: '提示词模板',
  promptDescription: '各模式发送给模型的提示词模板。',
  promptPlaceholdersText: '支持占位符：{{text}}、{{systemLanguage}}',
  promptPlaceholdersTranslate: '支持占位符：{{text}}、{{sourceLanguage}}、{{targetLanguage}}、{{primaryLanguage}}、{{secondaryLanguage}}',
  promptReset: '恢复默认',
  languageTitle: '自动翻译语言',
  languageDescription: '目标语言为「自动」时，从第一语言和第二语言中选择一种与源语言不同的语言。',
  languagePrimary: '第一语言',
  languageSecondary: '第二语言',
  languageSame: '两种语言相同，自动目标语言无法与源语言区分。',
  footerSave: '保存',
  footerSaving: '保存中…',
  footerDiscard: '放弃',
  footerDirty: '有未保存的更改',
  footerSaved: '已保存',
  footerSaveFailed: '保存失败：{message}',
  loading: '正在加载设置…',
  loadFailed: '设置加载失败：{message}',
  retry: '重试',
}

/** Translate face of this namespace, as the slot locale seat renders it. */
export type QuickAssistantTranslate = Translate<QuickAssistantLocaleKey>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Quick Assistant settings page copy. */
    'settings.quick-assistant': QuickAssistantLocaleKey
  }
}
