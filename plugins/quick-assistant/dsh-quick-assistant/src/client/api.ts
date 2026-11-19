/**
 * Same-origin HTTP client for the Quick Assistant settings routes.
 *
 * The page is served by the same web server as these routes, so requests stay
 * relative to the document base and carry no token: the Host accepts them only
 * from its own origin.
 */

import type {
  HealthPayload, ModelCatalog, QuickAssistantSettings, SettingsPayload,
} from './types.ts'

/** Route prefix the Host serves the plugin API under. */
const API_BASE = '/quick-assistant/api'

/**
 * Resolve one Host route against the document base, so a page served below a
 * base path still reaches its own origin.
 * @param path - route below {@link API_BASE}, starting with `/`.
 * @returns the absolute request URL.
 */
function apiUrl(path: string): string {
  return new URL(`${API_BASE}${path}`, document.baseURI).toString()
}

/**
 * Read the structured error message a Host route may return.
 * @param body - parsed response body, when it parsed at all.
 * @param status - HTTP status of the response.
 * @returns the Host message, or a status-only fallback.
 */
function responseError(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const message = (body as { error?: unknown }).error
    if (typeof message === 'string' && message !== '') return message
  }
  return `HTTP ${String(status)}`
}

/**
 * Perform one JSON request and unwrap its body.
 * @param path - route below {@link API_BASE}.
 * @param init - fetch options for the request.
 * @returns the parsed response body.
 * @throws when the response is not OK or its body is not JSON.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init)
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(responseError(body, response.status))
  return body as T
}

/**
 * Turn a failure into copy the page can show.
 * @param error - the caught value.
 * @returns its message when it has one, otherwise its string form.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** Read the stored settings with their defaults and language table. */
export function loadSettings(): Promise<SettingsPayload> {
  return request<SettingsPayload>('/settings')
}

/**
 * Write the whole settings document.
 * @param settings - the document to store.
 * @returns the stored document, as the Host echoed it back.
 */
export async function saveSettings(settings: QuickAssistantSettings): Promise<QuickAssistantSettings> {
  const body = await request<{ ok?: boolean; settings?: QuickAssistantSettings }>('/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  return body.settings ?? settings
}

/** Read the provider/model/reasoning-effort catalog. */
export function loadCatalog(): Promise<ModelCatalog> {
  return request<ModelCatalog>('/catalog')
}

/** Read whether the native helper is running. */
export function loadHealth(): Promise<HealthPayload> {
  return request<HealthPayload>('/health')
}

/** Ask the native helper to show its window (the settings page's 测试唤起). */
export async function showAssistant(): Promise<void> {
  await request<{ ok?: boolean }>('/show', { method: 'POST' })
}
