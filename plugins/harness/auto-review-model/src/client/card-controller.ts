/**
 * Staged editor for the Auto review reviewer route.
 *
 * The card reads one settings form (the profile entry's volatile Config fields)
 * plus the live adapter catalog. The visible switch means "a route is
 * configured", so it is open only while `enabled`, `provider`, and `model` are
 * all present; the persisted `enabled` flag alone is not enough.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  SettingsFormPathOp, SettingsFormScope, SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Minimal snapshot source the renderer binds as `useAutoReviewModelCard`. */
export interface CardSnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(next: T): void
}

/** Snapshot source over one projection; a render only re-reads after `set`. */
class CardStore<T> implements CardSnapshotStore<T> {
  private value: T
  private readonly listeners = new Set<() => void>()

  constructor(initial: T) {
    this.value = initial
  }

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: T): void {
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** Settings fields the Host stores for this plugin. */
export interface AutoReviewModelSettings {
  /** Whether the override is switched on; missing means on for compatibility. */
  enabled?: boolean
  /** Exact provider route for reviewer requests. */
  provider?: string
  /** Exact model id on that route. */
  model?: string
  /** Optional reasoning effort for reviewer requests. */
  reasoningEffort?: string
}

/** State rendered by the card. */
export interface AutoReviewModelCardState extends SettingsFormShell {
  /** Whether the visible switch is open (`enabled && provider && model`). */
  enabled: boolean
  /** Provider selected in the draft, if any. */
  provider: string | undefined
  /** Model selected in the draft, if any. */
  model: string | undefined
  /** Live adapter directory grouped by provider. */
  groups: readonly ModelProviderGroup[]
  /** Adapter-directory request state. */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Whether any provider-local catalog request failed. */
  catalogPartial: boolean
  /** Whether a newer Host revision invalidated the current draft. */
  conflicted: boolean
}

/** Registration-side face for the Auto review model card. */
export interface AutoReviewModelCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useAutoReviewModelCard. */
    autoReviewModelCard: CardSnapshotStore<AutoReviewModelCardState>
  }
  /** Toggle the visible switch, seeding the first advertised route when opening. */
  toggleEnabled: () => void
  /** Stage a provider route and reset the model to that provider's first entry. */
  selectProvider: (provider: string) => void
  /** Stage one model inside the staged provider. */
  selectModel: (model: string) => void
  /** Retry the adapter directory. */
  retryCatalog: () => void
  /** Persist the switch and route as one revision-fenced mutation. */
  save: () => void
  /** Drop the staged switch and route. */
  discard: () => void
}

/** One staged route, mirroring the persisted fields. */
interface DraftRoute {
  enabled: boolean
  provider: string | undefined
  model: string | undefined
}

/** Bridges one configuration form and the live adapter directory onto a staged card. */
export class AutoReviewModelCardController {
  private groups: readonly ModelProviderGroup[] = []
  private catalogStatus: AutoReviewModelCardState['catalogStatus'] = 'idle'
  private catalogPartial = false
  private draft: DraftRoute | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private catalogGeneration = 0
  private readonly scope: SettingsFormScope<AutoReviewModelSettings>
  private readonly ctx: ClientContext
  private readonly store: CardSnapshotStore<AutoReviewModelCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `auto-review-model` configuration form.
   * @param ctx - the card plugin's context, whose `remote.session` namespace
   * answers the Host model catalog.
   */
  constructor(scope: SettingsFormScope<AutoReviewModelSettings>, ctx: ClientContext) {
    this.scope = scope
    this.ctx = ctx
    this.store = new CardStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving && this.draft !== undefined
        && this.scope.getSnapshot().revision !== this.draftRevision) {
        if (sameRoute(this.stored(), this.draft)) this.clearDraft()
        else this.conflicted = true
      }
      this.publish()
    })
    void this.loadCatalog()
  }

  /** Stop observing settings and suppress late directory/write settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this card.
   * @returns The snapshot and staged card actions injected into the renderer.
   */
  inject(): AutoReviewModelCardFace {
    return {
      hooks: { autoReviewModelCard: this.store },
      toggleEnabled: () => { this.toggleEnabled() },
      selectProvider: (provider) => { this.selectProvider(provider) },
      selectModel: (model) => { this.selectModel(model) },
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /** Invalidate and reload the adapter directory after a Host model input changes. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    this.catalogPartial = false
    void this.loadCatalog()
  }

  /** Drop Host-specific groups and drafts, then reload after reconnecting. */
  resetConnection(): void {
    if (this.disposed) return
    this.saveGeneration += 1
    this.saving = false
    this.clearDraft()
    this.groups = []
    this.refreshCatalog()
  }

  private stored(): DraftRoute {
    const value = this.scope.getSnapshot().value
    return { enabled: value?.enabled ?? true, provider: value?.provider, model: value?.model }
  }

  private current(): DraftRoute {
    return this.draft ?? this.stored()
  }

  private enabled(): boolean {
    const route = this.current()
    return route.enabled && route.provider !== undefined && route.model !== undefined
  }

  private beginDraft(): DraftRoute {
    if (this.draft === undefined) {
      this.draft = this.stored()
      this.draftRevision = this.scope.getSnapshot().revision
    }
    return this.draft
  }

  private clearDraft(): void {
    this.draft = undefined
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private dirty(): boolean {
    return !sameRoute(this.stored(), this.current())
  }

  private firstRoute(): { provider: string; model: string } | undefined {
    for (const group of this.groups) {
      const model = group.models[0]
      if (model !== undefined) return { provider: group.id, model: model.id }
    }
    return undefined
  }

  private toggleEnabled(): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    const route = this.beginDraft()
    if (this.enabled()) {
      // Keep the stored route so reopening the switch restores the same choice.
      route.enabled = false
    } else {
      route.enabled = true
      if (route.provider === undefined || route.model === undefined) {
        const candidate = this.firstRoute()
        if (candidate !== undefined) {
          route.provider = candidate.provider
          route.model = candidate.model
        }
      }
    }
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private selectProvider(provider: string): void {
    if (this.disposed || this.saving || !this.scope.getSnapshot().writable) return
    const route = this.beginDraft()
    route.provider = provider
    route.model = this.groups.find(group => group.id === provider)?.models[0]?.id
    this.failed = false
    this.publish()
  }

  private selectModel(model: string): void {
    if (this.disposed || this.saving || !this.scope.getSnapshot().writable) return
    this.beginDraft().model = model
    this.failed = false
    this.publish()
  }

  private discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  private async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const route = this.current()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    if (route.enabled && (route.provider === undefined || route.model === undefined)) return
    if (!this.dirty()) return
    if (this.draft !== undefined && snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const ops: SettingsFormPathOp[] = [{ op: 'set', path: ['enabled'], value: route.enabled }]
    if (route.provider !== undefined) ops.push({ op: 'set', path: ['provider'], value: route.provider })
    if (route.model !== undefined) ops.push({ op: 'set', path: ['model'], value: route.model })
    const generation = this.saveGeneration
    const revision = this.draftRevision ?? snapshot.revision
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    try {
      await this.scope.mutate(ops, revision)
    } catch {
      if (generation === this.saveGeneration) {
        this.saving = false
        this.failed = true
        this.publish()
      }
      return
    }
    if (generation !== this.saveGeneration) return
    this.saving = false
    const landed = sameRoute(this.stored(), route)
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    let response: Awaited<ReturnType<ClientContext['remote']['session']['modelCatalog']>>
    try {
      response = await this.ctx.remote.session.modelCatalog()
    } catch {
      if (generation !== this.catalogGeneration) return
      this.catalogStatus = 'error'
      this.publish()
      return
    }
    if (generation !== this.catalogGeneration) return
    if (response.ok) {
      this.groups = response.value.groups
      this.catalogPartial = response.value.failures.length > 0
      this.catalogStatus = 'ready'
      this.seedDraftFromCatalog()
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  /** Fill an already-open draft that has no route once the catalog arrives. */
  private seedDraftFromCatalog(): void {
    const route = this.draft
    if (route === undefined || !route.enabled) return
    if (route.provider !== undefined && route.model !== undefined) return
    const candidate = this.firstRoute()
    if (candidate === undefined) return
    route.provider = candidate.provider
    route.model = candidate.model
  }

  private projection(): AutoReviewModelCardState {
    const snapshot = this.scope.getSnapshot()
    const route = this.current()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.dirty(),
      invalid: route.enabled && (route.provider === undefined || route.model === undefined),
      saving: this.saving,
      failed: this.failed,
      enabled: this.enabled(),
      provider: route.provider,
      model: route.model,
      groups: this.groups,
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      conflicted: this.conflicted,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}

/**
 * One staged-route comparison over the persisted shape.
 * @param left - one route.
 * @param right - the other route.
 * @returns whether every persisted field matches.
 */
function sameRoute(left: DraftRoute, right: DraftRoute): boolean {
  return left.enabled === right.enabled
    && left.provider === right.provider
    && left.model === right.model
}

/**
 * Create the card controller for one registration.
 * @param scope - bound configuration form.
 * @param ctx - the card plugin's client context.
 * @returns the controller whose `inject()` builds the renderer face.
 */
export function createAutoReviewModelCardStore(
  scope: SettingsFormScope<AutoReviewModelSettings>,
  ctx: ClientContext,
): AutoReviewModelCardController {
  return new AutoReviewModelCardController(scope, ctx)
}
