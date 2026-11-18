/**
 * Model catalog and request-model resolution.
 *
 * The settings page needs every provider/model/reasoning-effort triple to draw
 * its selectors; a chat request needs exactly one resolved selection. Both are
 * derived from the same LLM service reads, so they live here.
 */

/** One resolved provider/model selection. */
export interface ModelSelection {
  /** Registered provider route id. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort; omitted follows the model default. */
  reasoningEffort?: string
}

/** One reasoning effort shown by the settings page. */
export interface CatalogEffort {
  /** Opaque id sent back in a request. */
  id: string
  /** Human-readable effort name. */
  name: string
}

/** One model row of the catalog. */
export interface CatalogModel {
  /** Model id. */
  id: string
  /** Human-readable model name. */
  name: string
  /** Selectable reasoning efforts, least to greatest. */
  efforts: CatalogEffort[]
  /** Adapter-configured default effort, when the model has one. */
  defaultEffort?: string
}

/** One provider row of the catalog. */
export interface CatalogProvider {
  /** Provider route id. */
  id: string
  /** Human-readable provider name. */
  name: string
  /** Models the provider advertises. */
  models: CatalogModel[]
}

/** A provider or model the catalog could not read. */
export interface CatalogFailure {
  /** Provider id, or `<provider>/<model>` for a model-level failure. */
  id: string
  /** Human-readable name of what failed. */
  name: string
  /** Failure message suitable for the settings page. */
  message: string
}

/** The `/api/catalog` response body. */
export interface CatalogSnapshot {
  /** Selection a request follows when the mode is not pinned to a model. */
  default: ModelSelection
  /** Providers in registration order, each with its models. */
  providers: CatalogProvider[]
  /** Providers or models that could not be read. */
  failures: CatalogFailure[]
}

/** Structural face of one model listing entry. */
export interface LlmModelListing {
  /** Provider route that owns the entry. */
  provider: string
  /** Model id. */
  id: string
  /** Human-readable model name. */
  name: string
}

/** Structural face of one exact-model metadata read. */
export interface LlmResolvedModel {
  /** Provider route that owns the entry. */
  provider: string
  /** Model id. */
  id: string
  /** Human-readable model name. */
  name: string
  /** Reasoning metadata, when the adapter exposes it. */
  reasoning?: {
    /** Selectable efforts, least to greatest. */
    efforts: readonly { id: string; name: string }[]
    /** Adapter-configured default effort. */
    defaultEffort?: string
  }
}

/** Structural face of the LLM service reads this plugin performs. */
export interface LlmCatalogService {
  /** Registered provider routes. */
  listProviders(): readonly { id: string; name: string }[]
  /** Models one provider advertises. */
  listModels(provider: string): Promise<readonly LlmModelListing[]>
  /** Exact metadata of one provider/model route. */
  resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModel>
}

/** Raised when no provider/model can be used at all. */
export class NoModelError extends Error {
  /** Stable code reported over the wire. */
  readonly code = 'NO_MODEL'

  /**
   * @param message - user-facing explanation.
   */
  constructor(message = '没有可用的模型：请先在「模型」页配置一个 provider 和模型') {
    super(message)
    this.name = 'NoModelError'
  }
}

/** Parallel metadata reads during one catalog build. */
const CATALOG_CONCURRENCY = 8

/** How long a built catalog is reused before it is rebuilt. */
const CATALOG_TTL_MS = 30_000

/**
 * Run one asynchronous mapper over a list with bounded concurrency, preserving order.
 * @param items - inputs in result order.
 * @param limit - maximum concurrent calls.
 * @param run - mapper invoked once per item.
 * @returns results in input order.
 */
async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await run(item)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker())
  await Promise.all(workers)
  return results
}

/** Message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a selection names a concrete route. */
function isUsableSelection(selection: ModelSelection | undefined): selection is ModelSelection {
  return selection !== undefined && selection.provider !== '' && selection.model !== ''
}

/** Pick the first model any registered provider advertises. */
async function firstAvailableSelection(llm: LlmCatalogService): Promise<ModelSelection | undefined> {
  for (const provider of llm.listProviders()) {
    let models: readonly LlmModelListing[]
    try {
      models = await llm.listModels(provider.id)
    } catch {
      continue
    }
    const first = models[0]
    if (first !== undefined) return { provider: provider.id, model: first.id }
  }
  return undefined
}

/**
 * Resolve the provider/model one request uses.
 *
 * Order: a complete per-mode override, then the main model
 * (`ctx.agentDefaultModel`), then the first provider/model the catalog offers.
 * @param llm - LLM service catalog reads.
 * @param modeOverride - the mode's model settings.
 * @param defaultSelection - main model selection, or `undefined` when the
 *   service is absent.
 * @returns the resolved selection.
 * @throws {NoModelError} when no provider advertises any model.
 */
export async function resolveRequestSelection(
  llm: LlmCatalogService,
  modeOverride: { useDefault: boolean; provider?: string; model?: string; reasoningEffort?: string },
  defaultSelection: ModelSelection | undefined,
): Promise<ModelSelection> {
  if (!modeOverride.useDefault) {
    const provider = modeOverride.provider
    const model = modeOverride.model
    if (provider !== undefined && provider !== '' && model !== undefined && model !== '') {
      return {
        provider,
        model,
        ...modeOverride.reasoningEffort === undefined || modeOverride.reasoningEffort === ''
          ? {}
          : { reasoningEffort: modeOverride.reasoningEffort },
      }
    }
  }
  if (isUsableSelection(defaultSelection)) return { ...defaultSelection }
  const fallback = await firstAvailableSelection(llm)
  if (fallback === undefined) throw new NoModelError()
  return fallback
}

/**
 * Read the complete catalog: providers, models, and reasoning efforts.
 * @param llm - LLM service catalog reads.
 * @param defaultSelection - main model selection, or `undefined` when absent.
 * @returns the catalog snapshot; unreadable providers/models are reported in
 *   `failures` instead of failing the whole read.
 */
export async function buildCatalog(
  llm: LlmCatalogService,
  defaultSelection: ModelSelection | undefined,
): Promise<CatalogSnapshot> {
  const failures: CatalogFailure[] = []
  const providers = await runLimited(llm.listProviders(), CATALOG_CONCURRENCY, async (provider) => {
    let listings: readonly LlmModelListing[]
    try {
      listings = await llm.listModels(provider.id)
    } catch (error) {
      failures.push({ id: provider.id, name: provider.name, message: messageOf(error) })
      return { id: provider.id, name: provider.name, models: [] }
    }
    const models = await runLimited(listings, CATALOG_CONCURRENCY, async (listing) => {
      try {
        const info = await llm.resolveModelInfo(provider.id, listing.id)
        const efforts = (info.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name }))
        return {
          id: listing.id,
          name: listing.name !== '' ? listing.name : listing.id,
          efforts,
          ...info.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort },
        } satisfies CatalogModel
      } catch (error) {
        failures.push({
          id: `${provider.id}/${listing.id}`,
          name: `${provider.name} / ${listing.name}`,
          message: messageOf(error),
        })
        return { id: listing.id, name: listing.name !== '' ? listing.name : listing.id, efforts: [] } satisfies CatalogModel
      }
    })
    return { id: provider.id, name: provider.name, models }
  })

  let defaultModel: ModelSelection
  if (isUsableSelection(defaultSelection)) {
    defaultModel = { ...defaultSelection }
  } else {
    const firstProvider = providers.find(provider => provider.models.length > 0)
    const firstModel = firstProvider?.models[0]
    defaultModel = firstProvider === undefined || firstModel === undefined
      ? { provider: '', model: '' }
      : { provider: firstProvider.id, model: firstModel.id }
  }
  return { default: defaultModel, providers, failures }
}

/**
 * Cache for one built catalog.
 *
 * A catalog read resolves reasoning metadata for every advertised model, so
 * the overlay bootstrap and the settings page share one build for a short
 * window instead of racing a fresh read each time.
 */
export class CatalogCache {
  private snapshot: CatalogSnapshot | undefined
  private builtAt = 0
  private inFlight: Promise<CatalogSnapshot> | undefined

  /**
   * @param ttlMs - reuse window for a built catalog.
   */
  constructor(private readonly ttlMs: number = CATALOG_TTL_MS) {}

  /**
   * Read the catalog, building it when the cached copy is stale.
   * @param build - producer for a fresh catalog.
   * @returns the catalog snapshot.
   */
  async get(build: () => Promise<CatalogSnapshot>): Promise<CatalogSnapshot> {
    if (this.snapshot !== undefined && Date.now() - this.builtAt < this.ttlMs) return this.snapshot
    if (this.inFlight !== undefined) return this.inFlight
    const inFlight = build()
      .then((snapshot) => {
        this.snapshot = snapshot
        this.builtAt = Date.now()
        return snapshot
      })
      .finally(() => {
        this.inFlight = undefined
      })
    this.inFlight = inFlight
    return inFlight
  }

  /** Drop the cached catalog (used when the plugin reloads its model catalog). */
  clear(): void {
    this.snapshot = undefined
    this.builtAt = 0
  }
}
