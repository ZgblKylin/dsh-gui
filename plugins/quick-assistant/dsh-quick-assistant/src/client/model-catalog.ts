/**
 * Catalog lookups and the mode-override transitions the model cards share.
 *
 * A card never mutates an override in place: each transition here returns the
 * next override, so the page's draft keeps one immutable value per mode.
 */

import type {
  CatalogModel, CatalogProvider, ModeModelOverride, ModelCatalog,
} from './types.ts'

/**
 * Look one provider up in the catalog.
 * @param catalog - the loaded catalog, or `null` while it is unavailable.
 * @param id - provider id to find.
 * @returns the provider, or `undefined` when the catalog does not list it.
 */
export function findProvider(catalog: ModelCatalog | null, id: string | undefined): CatalogProvider | undefined {
  if (catalog === null || id === undefined) return undefined
  return catalog.providers.find(provider => provider.id === id)
}

/**
 * Look one model up in a provider.
 * @param provider - the provider to search.
 * @param id - model id to find.
 * @returns the model, or `undefined` when the provider does not list it.
 */
export function findModel(provider: CatalogProvider | undefined, id: string | undefined): CatalogModel | undefined {
  if (provider === undefined || id === undefined) return undefined
  return provider.models.find(model => model.id === id)
}

/**
 * Display label of one provider/model pair.
 * @param catalog - the loaded catalog.
 * @param providerId - provider id.
 * @param modelId - model id.
 * @returns the pair's display names, or `undefined` when either is unknown.
 */
export function routeLabel(
  catalog: ModelCatalog | null,
  providerId: string | undefined,
  modelId: string | undefined,
): string | undefined {
  const provider = findProvider(catalog, providerId)
  const model = findModel(provider, modelId)
  if (provider === undefined || model === undefined) return undefined
  return `${provider.name} / ${model.name}`
}

/**
 * Display label of the main model a mode follows.
 * @param catalog - the loaded catalog, or `null` while it is unavailable.
 * @returns the main model's display names, or `undefined` without a catalog.
 */
export function defaultRouteLabel(catalog: ModelCatalog | null): string | undefined {
  if (catalog === null) return undefined
  const { provider, model } = catalog.default
  return routeLabel(catalog, provider, model) ?? `${provider} / ${model}`
}

/** The first advertised provider/model pair, used when the main model is gone. */
function firstAdvertisedPair(catalog: ModelCatalog): { provider: string; model: string } | undefined {
  for (const provider of catalog.providers) {
    const model = provider.models[0]
    if (model !== undefined) return { provider: provider.id, model: model.id }
  }
  return undefined
}

/**
 * Resolve a pair from the main-model selection, keeping only what the catalog
 * still advertises.
 * @param catalog - the loaded catalog.
 * @returns the resolved pair, or `undefined` when it is no longer listed.
 */
function mainModelPair(catalog: ModelCatalog): { provider: string; model: string } | undefined {
  const provider = findProvider(catalog, catalog.default.provider)
  const model = findModel(provider, catalog.default.model)
  if (provider === undefined || model === undefined) return undefined
  return { provider: provider.id, model: model.id }
}

/**
 * Turn the main-model fallback off: keep the configured pair while the catalog
 * still lists it, otherwise start from the main model, then from the first
 * advertised pair. The reasoning effort is independent of this switch and is
 * preserved.
 * @param catalog - the loaded catalog, or `null` while it is unavailable.
 * @param current - the mode's current override.
 * @returns the override to store.
 */
export function activateOverride(catalog: ModelCatalog | null, current: ModeModelOverride): ModeModelOverride {
  const effort = current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }
  if (catalog === null) return { ...current, useDefault: false }
  const provider = findProvider(catalog, current.provider)
  const model = findModel(provider, current.model)
  if (provider !== undefined && model !== undefined) {
    return { useDefault: false, provider: provider.id, model: model.id, ...effort }
  }
  const pair = mainModelPair(catalog) ?? firstAdvertisedPair(catalog)
  if (pair === undefined) return { useDefault: false, ...effort }
  return { useDefault: false, ...pair, ...effort }
}

/**
 * Switch a mode to another provider: its first model becomes the selection.
 * The reasoning effort stays configured; the Host applies it only on routes that
 * advertise it.
 * @param catalog - the loaded catalog.
 * @param providerId - provider the user picked.
 * @returns the override to store.
 */
export function selectProvider(catalog: ModelCatalog, providerId: string, current: ModeModelOverride): ModeModelOverride {
  const effort = current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }
  const provider = findProvider(catalog, providerId)
  const model = provider?.models[0]
  if (model === undefined) return { useDefault: false, provider: providerId, ...effort }
  return { useDefault: false, provider: providerId, model: model.id, ...effort }
}

/**
 * Switch a mode to another model of the same provider, keeping the reasoning
 * effort.
 * @param current - the mode's current override.
 * @param modelId - model the user picked.
 * @returns the override to store.
 */
export function selectModel(current: ModeModelOverride, modelId: string): ModeModelOverride {
  const next: ModeModelOverride = { useDefault: false }
  if (current.provider !== undefined) next.provider = current.provider
  next.model = modelId
  if (current.reasoningEffort !== undefined) next.reasoningEffort = current.reasoningEffort
  return next
}

/**
 * Set the reasoning effort of a mode without changing which route it uses.
 * @param current - the mode's current override.
 * @param effortId - the picked effort id; `''` follows the model default.
 * @returns the override to store.
 */
export function withEffort(current: ModeModelOverride, effortId: string): ModeModelOverride {
  return { ...current, reasoningEffort: effortId }
}

/**
 * Whether a route advertises one reasoning effort. `off` is always accepted here
 * because the settings page offers it even when the model hides it; the Host
 * drops the level again when the model does not list it.
 * @param catalog - the loaded catalog, or `null` while it is unavailable.
 * @param providerId - provider id of the route.
 * @param modelId - model id of the route.
 * @param effortId - effort id to check.
 * @returns `true` when the model lists the effort, or when it cannot be checked.
 */
export function routeSupportsEffort(
  catalog: ModelCatalog | null,
  providerId: string | undefined,
  modelId: string | undefined,
  effortId: string,
): boolean {
  const provider = findProvider(catalog, providerId)
  const model = findModel(provider, modelId)
  return model === undefined || model.efforts.some(effort => effort.id === effortId)
}

/**
 * Effort choices for a route, including the follow-default entry and an `off`
 * entry the model may not list itself.
 * @param catalog - the loaded catalog, or `null` while it is unavailable.
 * @param providerId - provider id of the route.
 * @param modelId - model id of the route.
 * @param followLabel - localized label of the follow-default entry.
 * @param offLabel - localized label of the `off` entry.
 * @returns the dropdown options; only the follow-default entry when the route is unknown.
 */
export function effortOptions(
  catalog: ModelCatalog | null,
  providerId: string | undefined,
  modelId: string | undefined,
  followLabel: string,
  offLabel: string,
): { id: string; label: string }[] {
  const provider = findProvider(catalog, providerId)
  const model = findModel(provider, modelId)
  const efforts = model?.efforts ?? []
  const options = [{ id: '', label: followLabel }, ...efforts.map(effort => ({ id: effort.id, label: effort.name }))]
  if (!efforts.some(effort => effort.id === 'off')) options.push({ id: 'off', label: offLabel })
  return options
}
