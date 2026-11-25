/**
 * Web access for the ask and explain modes: a small tool loop over the harness
 * `ctx.web` service, the same capability seam the built-in `web_search` and
 * `web_fetch` tools execute against.
 *
 * The quick assistant calls the model directly instead of running an agent
 * session, so it declares the two tool schemas itself and executes the calls the
 * model asks for. Provider selection, credentials, cancellation, and error
 * vocabulary stay with `ctx.web`.
 */

/** One citeable search source, as the web seam reports it. */
export interface WebSearchSource {
  url: string
  title?: string
  snippet?: string
  summary?: string
}

/** Normalized search outcome. */
export interface WebSearchOutcome {
  content?: string
  sources: readonly WebSearchSource[]
}

/** Decoded fetch body. */
export interface WebFetchBody {
  kind: 'html' | 'text'
  content: string
}

/** Normalized fetch outcome. */
export interface WebFetchOutcome {
  url: string
  statusCode: number
  body: WebFetchBody
  truncated?: boolean
}

/** The subset of `ctx.web` this plugin consumes. */
export interface WebService {
  search(
    request: { query: string; maxResults?: number; llmProvider?: string },
    signal?: AbortSignal,
  ): Promise<WebSearchOutcome>
  fetch(request: { url: string }, signal?: AbortSignal): Promise<WebFetchOutcome>
  searchReady?(llmProvider?: string): Promise<boolean>
}

/** Tool schema as sent to the model. */
export interface WebToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Bounds of one search call. */
const DEFAULT_SEARCH_RESULTS = 5
const MAX_SEARCH_RESULTS = 8
/** Longest page text handed back to the model. */
const MAX_FETCH_CHARS = 20_000
/** Longest snippet shown per source. */
const MAX_SNIPPET_CHARS = 400
/** Longest tool status line shown by the overlay. */
const MAX_STATUS_CHARS = 160

/** Tool declarations offered to the model by the ask and explain modes. */
export const WEB_TOOL_SCHEMAS: readonly WebToolSchema[] = [
  {
    name: 'web_search',
    description: 'Search the web for current or verifiable information. Use it when the answer depends on recent events, '
      + 'specific facts, or when citing sources would help. Returns titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        max_results: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'How many results to read.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch one web page by URL and return its readable text. Use it after web_search to read a promising '
      + 'source, or when the user supplies a URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to read.' },
      },
      required: ['url'],
    },
  },
]

/** Result of one executed tool call. */
export interface ToolOutcome {
  /** Model-facing tool result text. */
  text: string
  /** Whether the call failed. */
  isError: boolean
  /** Short localized status label shown by the overlay. */
  label: string
  /** Status detail: the query or URL. */
  detail: string
}

/** Tool call the model requested. */
export interface ToolCall {
  id: string
  name: string
  /** Raw JSON arguments as the model produced them. */
  arguments: string
}

/**
 * Whether the web seam can serve searches for one model route.
 * @param web - web service, or `undefined` when the deployment has none.
 * @param provider - provider route of the model request.
 * @returns `true` when tools should be offered.
 */
export async function webToolsReady(web: WebService | undefined, provider: string): Promise<boolean> {
  if (web === undefined) return false
  try {
    return await web.searchReady?.(provider) ?? true
  } catch {
    return false
  }
}

/**
 * Status shown by the overlay while one call runs.
 * @param call - tool name and raw arguments.
 * @returns the localized label and the query or URL being handled.
 */
export function webToolStatus(call: ToolCall): { label: string; detail: string } {
  const args = parseArgs(call.arguments)
  if (call.name === 'web_fetch') {
    const url = typeof args['url'] === 'string' ? args['url'] : ''
    return { label: '读取网页', detail: clip(url, MAX_STATUS_CHARS) }
  }
  const query = typeof args['query'] === 'string' ? args['query'] : ''
  return { label: '联网搜索', detail: clip(query, MAX_STATUS_CHARS) }
}

/** Parse raw tool arguments into an object, tolerating malformed JSON. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * Execute one web tool call.
 * @param web - web service.
 * @param call - tool name and raw JSON arguments.
 * @param provider - provider route of the model request.
 * @param signal - aborts the call with the request.
 * @returns the model-facing result plus the status shown by the overlay.
 */
export async function executeWebTool(
  web: WebService,
  call: ToolCall,
  provider: string,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const args = parseArgs(call.arguments)
  if (call.arguments.trim() !== '' && Object.keys(args).length === 0) {
    return { text: `Invalid JSON arguments for ${call.name}.`, isError: true, label: '联网', detail: call.name }
  }
  try {
    if (call.name === 'web_search') return await runSearch(web, args, provider, signal)
    if (call.name === 'web_fetch') return await runFetch(web, args, signal)
    return { text: `Unknown tool "${call.name}".`, isError: true, label: '联网', detail: call.name }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      text: `Tool "${call.name}" failed: ${message}`,
      isError: true,
      label: call.name === 'web_fetch' ? '读取网页' : '联网搜索',
      detail: call.name,
    }
  }
}

/** Run one search and render it for the model. */
async function runSearch(
  web: WebService,
  args: Record<string, unknown>,
  provider: string,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : ''
  if (query === '') {
    return { text: 'web_search requires a non-empty query.', isError: true, label: '联网搜索', detail: '' }
  }
  const requested = typeof args['max_results'] === 'number' ? Math.round(args['max_results']) : DEFAULT_SEARCH_RESULTS
  const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, requested))
  const result = await web.search({ query, maxResults, llmProvider: provider }, signal)
  const lines: string[] = [`web_search: ${query}`]
  if (result.content !== undefined && result.content.trim() !== '') lines.push('', result.content.trim())
  if (result.sources.length === 0) {
    lines.push('', 'No sources returned.')
  } else {
    lines.push('', 'Sources:')
    result.sources.forEach((source, index) => {
      const title = source.title ?? hostOf(source.url)
      lines.push(`${index + 1}. ${title} — ${source.url}`)
      const excerpt = source.snippet ?? source.summary
      if (excerpt !== undefined && excerpt.trim() !== '') lines.push(`   ${clip(excerpt.trim(), MAX_SNIPPET_CHARS)}`)
    })
  }
  lines.push('', 'Cite the sources you used as Markdown links.')
  return { text: lines.join('\n'), isError: false, label: '联网搜索', detail: clip(query, MAX_STATUS_CHARS) }
}

/** Run one fetch and render it for the model. */
async function runFetch(web: WebService, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
  const url = typeof args['url'] === 'string' ? args['url'].trim() : ''
  if (!/^https?:\/\//i.test(url)) {
    return { text: 'web_fetch requires an absolute http(s) URL.', isError: true, label: '读取网页', detail: clip(url, MAX_STATUS_CHARS) }
  }
  const result = await web.fetch({ url }, signal)
  const text = result.body.kind === 'text' ? result.body.content : htmlToText(result.body.content)
  const clipped = clip(text.trim(), MAX_FETCH_CHARS)
  return {
    text: `web_fetch: ${result.url} (HTTP ${result.statusCode})\n\n${clipped}`,
    isError: false,
    label: '读取网页',
    detail: clip(url, MAX_STATUS_CHARS),
  }
}

/** Hostname shown when a source carries no title. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Cut a string to a maximum length, marking the cut. */
function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

/** Rough readable-text projection of an HTML document. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
