/**
 * The `memoryContext` Cordis service: owns the persistent multi-tier memory
 * store, the embedder, the vector index, the token budget, and the forgetting
 * policy, and exposes the {@link MemoryEngine} to the rest of the app.
 *
 * Load this entry before `memory-compaction`; the compaction engine injects
 * this service and supplies the summarizer for pyramid consolidation.
 *
 * @module dsh-infinite-context/memory-context
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  MemoryContextConfigSchema,
  resolveMemoryContextConfig,
  type MemoryContextConfig,
  type ResolvedMemoryContextConfig,
} from './config.ts'
import { createEmbedder, type Embedder } from './embedder.ts'
import { VectorIndex } from './vector-index.ts'
import { MemoryStore } from './memory-store.ts'
import { TokenBudget } from './token-budget.ts'
import { ForgettingPolicy } from './forgetting.ts'
import { MemoryEngine, type StoreMemoryOptions, type SummarizeFn, type SummarizationTarget } from './memory-engine.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { probeModelContext, isLocalHostname } from './model-probe.ts'
import { ModelContextTracker } from './model-context.ts'
import type { ModelContextInfo, ModelContextSource, RetrievalHit, Tier } from './types.ts'

/** Register `ctx.memoryContext` for typed access elsewhere. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryContext: MemoryContext
  }
}

/** The `memoryContext` service. */
export class MemoryContext extends Service {
  static Config: z<MemoryContextConfig> = MemoryContextConfigSchema

  private readonly resolved: ResolvedMemoryContextConfig
  private store: MemoryStore | null = null
  private engine: MemoryEngine | null = null
  private readonly context: Context
  /** Tracks the adopted model context window and probe-once-per-model state. */
  private readonly modelTracker: ModelContextTracker

  /**
   * @param ctx - the plugin context.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: MemoryContextConfig) {
    super(ctx, 'memoryContext')
    this.context = ctx
    this.resolved = resolveMemoryContextConfig(config)
    this.modelTracker = new ModelContextTracker(
      this.resolved.contextWindow,
      this.resolved.modelProbe.enabled,
    )
    // Apply explicit per-model window overrides (config-declared truth, e.g. a
    // local model the catalog misdeclares, or a remote model whose real window
    // differs from the declaration). These feed the per-model registry that
    // compaction triggering and per-session budgets read.
    for (const { model, contextWindow } of this.resolved.modelWindows) {
      this.modelTracker.setModelWindow({ model, contextWindow, source: 'config' })
    }
  }

  /**
   * Asynchronously bring up the store, embedder, index, budget, and engine.
   *
   * Note: the TokenBudget is constructed with the *configured* context window
   * (this.resolved.contextWindow) as a static baseline for `validate()` and
   * `status()`. The actual compression/truncation decisions use the *dynamic*
   * context window from `modelTracker.effectiveWindow` (adopted from DSH's
   * request context or a live probe). This is by design: the budget validates
   * config feasibility; the dynamic window drives runtime behaviour.
   */
  protected async [Service.init](): Promise<void> {
    const embedder = await createEmbedder(this.resolved.memory.embedder)
    const store = new MemoryStore(this.resolved.storePath)
    const budget = new TokenBudget(
      this.resolved.memory.budget,
      this.resolved.contextWindow,
      this.resolved.headroomRatio,
    )
    budget.validate()
    this.store = store
    // Close the SQLite handle when this service fiber unloads (hot reload /
    // plugin update). Without this, the db/WAL files stay locked on Windows
    // and block replacing the plugin directory. This cordis version has no
    // `Service.disconnect` symbol — `ctx.effect` is the lifecycle-sanctioned
    // way to register a disposer that runs during UNLOADING.
    this.context.effect(() => () => store.close(), 'close memory store')
    const index = new VectorIndex()
    this.engine = new MemoryEngine({
      store,
      embedder,
      index,
      budget,
      forgetting: new ForgettingPolicy(this.resolved.memory.forgetting),
      config: this.resolved.memory,
      onWarn: (message) => this.context.logger.warn(`[memoryContext] ${message}`),
    })
    // Hydrate the in-memory index from previously persisted memories so that
    // retrieval works across restarts (not only for memories stored in this
    // process).
    const loaded = this.engine.loadFromStore()
    this.context.logger.info(
      `memoryContext ready: embedder=${embedder.name}(${embedder.dimension}) `
      + `store=${this.resolved.storePath} budget=${budget.total}/${budget.maxTotal} `
      + `loaded=${loaded} memories from disk`,
    )
  }

  private requireEngine(): MemoryEngine {
    if (this.engine === null) {
      throw new Error('memoryContext is not initialized yet')
    }
    return this.engine
  }

  /** The resolved model context window for budget checks. */
  get contextWindow(): number {
    return this.modelTracker.effectiveWindow
  }

  /** The resolved headroom ratio (fraction reserved for system/tools/output). */
  get headroomRatio(): number {
    return this.resolved.headroomRatio
  }

  /** The currently adopted model context info, or null. */
  get modelInfo(): ModelContextInfo | null {
    return this.modelTracker.info
  }

  /**
   * The narrowed window recorded for one specific model (probe / per-model
   * override), or undefined when nothing has been observed for it. Callers
   * fall back to the global effective window when undefined.
   */
  windowForModel(model: string | undefined): number | undefined {
    return this.modelTracker.windowFor(model)
  }

  /** All per-model windows currently known (for observability). */
  perModelWindows(): readonly ModelContextInfo[] {
    return this.modelTracker.perModel()
  }

  /**
   * Adopt a model context window resolved from DSH's request context (the
   * model catalog / `/models` listing). Invalid windows are ignored; repeated
   * identical observations are no-ops.
   */
  updateModelContext(info: {
    provider?: string
    model?: string
    contextWindow: number
    source: Exclude<ModelContextSource, 'config'>
  }): void {
    this.modelTracker.adopt(info)
  }

  /**
   * Observe the current request's resolved route metadata. Called by the
   * compaction hook on every step. When DSH resolved a context window, adopt
   * it immediately; otherwise, if a live probe is configured and this model
   * is LOCAL (routed to a loopback/private server, per `llm-pi-ai` settings),
   * kick off a background probe (never blocks the step). Online models are
   * never probed — they are trusted at the window settings/DSH declared.
   */
  observeRequestContext(route: { provider?: string; model?: string; contextWindow?: number }): void {
    const probeModel = this.modelTracker.observe(route, { probe: this.isLocalRoute(route.provider) })
    if (probeModel !== undefined) void this.runProbe(probeModel)
  }

  /**
   * Whether the routed provider points at a LOCAL server. Reads the provider's
   * `baseURL` from the DSH `llm-pi-ai` settings namespace and treats loopback /
   * private-LAN hosts as local. Only local models get a live context probe;
   * online models are trusted at the window they declared. A provider with no
   * readable baseURL is treated as non-local (no probe) — the safe default.
   */
  private isLocalRoute(provider: string | undefined): boolean {
    if (provider === undefined || provider.length === 0) return false
    try {
      const settings = (this.context as { settings?: { get?: (ns: string) => unknown } }).settings
      const ns = settings?.get?.('llm-pi-ai') as { providers?: Record<string, { baseURL?: string }> } | undefined
      const baseURL = ns?.providers?.[provider]?.baseURL
      if (typeof baseURL !== 'string' || baseURL.length === 0) return false
      let host: string
      try {
        host = new URL(baseURL).hostname
      } catch {
        return false
      }
      return isLocalHostname(host)
    } catch {
      return false
    }
  }

  /**
   * Run one background probe for a model's context window and adopt the
   * result. Resolves when the probe settles (success or failure).
   */
  private async runProbe(model: string): Promise<void> {
    try {
      const window = await probeModelContext(this.resolved.modelProbe, model)
      if (window !== undefined) {
        // A live probe reflects the server's REAL runtime context, which can
        // be far smaller than the declared catalog window. Cap the adoption at
        // the current (declared) window so a probe can only LOWER it, never
        // inflate it.
        const ceiling = this.modelTracker.info?.contextWindow ?? this.resolved.contextWindow
        const adopted = Math.min(window, ceiling)
        this.modelTracker.adopt({ model, contextWindow: adopted, source: 'probe' })
        this.modelTracker.markResolved(model)
        this.context.logger.info(
          `[memoryContext] Model probe adopted context window ${adopted} `
          + `(model=${model}, probed=${window}, ceiling=${ceiling}, source=probe)`,
        )
      } else {
        this.context.logger.info(
          `[memoryContext] Model probe for "${model}" reported no context window (will retry)`,
        )
      }
    } catch (error) {
      this.context.logger.warn(
        `[memoryContext] Model probe failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Manually (re)probe the local server for a model's context window.
   * @param model - model id to probe; defaults to the last observed model.
   * @returns the current model context info after the probe attempt.
   */
  async probeModel(model?: string): Promise<ModelContextInfo | null> {
    const target = model ?? this.modelTracker.info?.model
    if (target === undefined) return this.modelInfo
    await this.runProbe(target)
    return this.modelInfo
  }

  /**
   * Provide the summarizer used for pyramid consolidation. Called by the
   * compaction engine once it loads.
   * @param summarize - a summarizer folding several memory texts into one.
   */
  setSummarizer(summarize: SummarizeFn): void {
    this.requireEngine().setSummarizer(summarize)
  }

  /**
   * Store a new memory under a tier.
   * @param text - the summary text.
   * @param tier - the target tier.
   * @param options - optional importance and provenance.
   * @returns the stored document.
   */
  storeMemory(text: string, tier: Tier, options?: StoreMemoryOptions) {
    return this.requireEngine().storeMemory(text, tier, options)
  }

  /**
   * Retrieve the most relevant memories for a query.
   * @param query - the query text.
   * @param k - maximum hits.
   * @param minScore - optional per-call similarity floor.
   * @returns sorted, filtered hits.
   */
  retrieve(query: string, k?: number, minScore?: number): Promise<RetrievalHit[]> {
    return this.requireEngine().retrieve(query, k, minScore)
  }

  /** Whether any stored memory has exactly this text (ingest dedup helper). */
  hasText(text: string): boolean {
    return this.requireEngine().hasText(text)
  }

  /** Whether any stored memory has this text after fuzzy normalization (dedup helper). */
  hasTextNormalized(text: string): boolean {
    return this.requireEngine().hasTextNormalized(text)
  }

  /** Run a forgetting sweep. */
  forget() {
    return this.requireEngine().forget()
  }

  /** Consolidate the pyramid (merge mid memories into long). */
  consolidate(target?: SummarizationTarget) {
    return this.requireEngine().consolidate(target)
  }

  /** Run forgetting then pyramid consolidation. */
  rebalance(target?: SummarizationTarget) {
    return this.requireEngine().rebalance(target)
  }

  /** A point-in-time status snapshot. */
  status() {
    return this.requireEngine().status()
  }

  /** Generate a compact structured index of the memory store. */
  generateIndex(limit?: number) {
    return this.requireEngine().generateIndex(limit)
  }

  /** Audit the store for duplicates, conflicts, and stale entries. */
  maintain() {
    return this.requireEngine().maintain()
  }

  /**
   * Back-reference to the compaction engine, set by MemoryCompactionEngine
   * after construction. Allows tools.ts to reach the compressor for force-
   * compress requests without injecting the compaction entry directly.
   *
   * The type mirrors the HistoryCompressor surface used by tools.ts; the full
   * class lives in memory-compaction.ts (avoiding a circular import here).
   */
  compactionEngine: {
    compressor: {
      compress: (
        sid: string,
        msgs: readonly any[],
        force?: boolean,
        options?: { window?: number },
      ) => Promise<{ messages: readonly any[]; tokensSaved: number } | null>
      compressForce: (
        sid: string,
        msgs: readonly any[],
        options?: { session?: Session },
      ) => Promise<{ messages: readonly any[]; tokensSaved: number }>
    }
  } | null = null

  /**
   * Back-reference to the compaction engine's VectorRetriever, set after
   * construction. Lets tools.ts reuse the engine's configured retriever
   * (rag_* config) instead of constructing a hard-coded one.
   */
  retriever: { ingest: (text: string, source: string) => Promise<void> } | null = null

  /** Hard reset: clear all memories and the index. */
  reset(): void {
    this.requireEngine().reset()
  }
}

export default MemoryContext
