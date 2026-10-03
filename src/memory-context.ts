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

import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  IN_MEMORY_STORE,
  MemoryContextConfigSchema,
  resolveMemoryContextConfig,
  type MemoryContextConfig,
  type ResolvedMemoryContextConfig,
} from './config.ts'
import { createEmbedder, type Embedder } from './embedder.ts'
import { VectorIndex } from './vector-index.ts'
import {
  MemoryStore,
  type FoldedRangeMeta,
  type FoldedRangeRecord,
  type ToolResultMeta,
  type ToolResultRecord,
  type UsageDetailTotal,
  type UsageEventRecord,
  type UsageTotal,
} from './memory-store.ts'
import { TokenBudget } from './token-budget.ts'
import { ForgettingPolicy } from './forgetting.ts'
import { MemoryEngine, type StoreMemoryOptions, type SummarizeFn, type SummarizationTarget } from './memory-engine.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  isLocalBaseURL,
  probeModelContext,
  providerBaseURL,
  type ConfigurableProviderSettings,
  type SettingsNamespaceEntry,
} from './model-probe.ts'
import { ModelContextTracker } from './model-context.ts'
import type { SanitizerConfig } from './OutputSanitizer.ts'
import type { ModelContextInfo, ModelContextSource, RetrievalHit, Tier } from './types.ts'
import type { UsageSummary } from './usage-ledger.ts'

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
    const storePath = this.resolved.storePath
    if (storePath !== IN_MEMORY_STORE && !existsSync(storePath)) {
      // Upgrade hazard: earlier builds resolved a relative storePath against
      // the process cwd, so an existing store may still sit there. Say so
      // loudly instead of silently starting from an empty memory store.
      const legacy = resolve(process.cwd(), basename(storePath))
      if (existsSync(legacy)) {
        this.context.logger.warn(
          `[memoryContext] store ${storePath} does not exist yet, but a legacy cwd-relative store `
          + `is present at ${legacy}; move it (with its -wal/-shm siblings) to the resolved path `
          + `to keep those memories`,
        )
      }
    }
    const store = new MemoryStore(storePath)
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
    if (probeModel !== undefined) void this.runProbe(probeModel, route.provider)
  }

  /**
   * Whether the routed provider points at a LOCAL server. Resolves the
   * provider's configured `baseURL` through the host services (see
   * `resolveProviderBaseURL`) and treats loopback / private-LAN hosts as local.
   * Only local models get a live context probe; online models are trusted at the
   * window they declared. A provider with no readable baseURL is treated as
   * non-local (no probe) — the safe default.
   *
   * Public because routing decisions beyond probing depend on it: the
   * local-model conciseness directive is injected only on local routes.
   */
  isLocalRoute(provider: string | undefined): boolean {
    return isLocalBaseURL(this.resolveProviderBaseURL(provider))
  }

  /**
   * Run one background probe for a model's context window and adopt the
   * result. Resolves when the probe settles (success or failure).
   */
  private async runProbe(model: string, provider?: string): Promise<void> {
    try {
      const baseURL = this.resolveProbeBaseURL(provider)
      const window = await probeModelContext({ ...this.resolved.modelProbe, baseURL }, model)
      if (window !== undefined) {
        // A live probe reflects the server's REAL runtime context, which can
        // be far smaller than the declared catalog window. Cap the adoption at
        // the PROBED model's own declared window (per-model registry) — a probe
        // can only LOWER that model's window, never inflate it. The ceiling is
        // never the global "last observed" slot, which may belong to another
        // model (a small local one could otherwise flatten this model's probe).
        //
        // Note: `adopt` also moves the global "last observed" slot to the
        // probed model, so the config-fallback window follows the most
        // recently probed model. That is intentional for single-model local
        // deployments (the fallback then reflects the REAL window, not a wrong
        // declaration); multi-model runtimes always read the per-model
        // registry via windowForModel, which this call also maintains.
        const ceiling = this.modelTracker.probeCeilingFor(model, this.resolved.contextWindow)
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
   * Resolve the base URL for a live model probe. The configured
   * `modelProbe.baseURL` wins when set; otherwise the probe targets the LOCAL
   * server the ROUTED provider points at (read from the DSH `llm-pi-ai`
   * settings), so enabling the probe requires no per-deployment baseURL config
   * — the plugin just probes whatever local model the session is using. An
   * unresolvable target returns `''` and the probe degrades to a no-op.
   */
  private resolveProbeBaseURL(provider: string | undefined): string {
    const configured = this.resolved.modelProbe.baseURL
    if (configured.length > 0) return configured
    return this.resolveProviderBaseURL(provider)
  }

  /**
   * The routed provider's configured `baseURL`, read through the host services:
   * `ctx.llm.listConfigurableProviders()` locates the provider's settings
   * namespace and path, and `ctx.settings.describe()` supplies the live values
   * (`ctx.settings` exposes no `get` — a namespace is read by describing it).
   * Returns '' when the provider or its URL cannot be resolved, which is the
   * safe default for both callers: remote ⇒ no live probe, no conciseness hint.
   */
  private resolveProviderBaseURL(provider: string | undefined): string {
    if (provider === undefined || provider.length === 0) return ''
    try {
      const context = this.context as {
        llm?: { listConfigurableProviders?: () => readonly ConfigurableProviderSettings[] }
        settings?: {
          describe?: (options?: { redactSecrets?: boolean }) => readonly SettingsNamespaceEntry[]
        }
      }
      const entry = context.llm?.listConfigurableProviders?.().find(candidate => candidate.provider === provider)
      const namespaces = context.settings?.describe?.()
      if (entry === undefined || !Array.isArray(namespaces)) return ''
      return providerBaseURL(namespaces, entry) ?? ''
    } catch {
      return ''
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
    // Resolve the provider PER MODEL first: the global "last observed" slot may
    // belong to a different model, and probing through the wrong provider's
    // baseURL would query the wrong server.
    const provider = this.modelTracker.providerFor(target) ?? this.modelTracker.info?.provider
    await this.runProbe(target, provider)
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

  /** Read plugin state from the persistent KV table (survives restarts). */
  kvGet(key: string): string | undefined {
    this.requireEngine()
    return this.store?.kvGet(key)
  }

  /** Write plugin state to the persistent KV table (survives restarts). */
  kvSet(key: string, value: string): void {
    this.requireEngine()
    this.store?.kvSet(key, value)
  }

  /** Delete plugin state from the persistent KV table. */
  kvDelete(key: string): void {
    this.requireEngine()
    this.store?.kvDelete(key)
  }

  /**
   * Archive one oversized tool result verbatim (tool-result CCR).
   * @param record - the archived payload (content-addressed by ref).
   * @returns true when a new row was inserted.
   */
  archiveToolResult(record: ToolResultRecord): boolean {
    this.requireEngine()
    return this.store?.archiveToolResult(record) ?? false
  }

  /**
   * Read an archived tool result back by ref.
   * @param ref - the archive ref.
   * @returns the record, or `undefined` when unknown.
   */
  getToolResult(ref: string): ToolResultRecord | undefined {
    this.requireEngine()
    return this.store?.getToolResult(ref)
  }

  /**
   * Find the newest archived result for one tool call.
   * @param callId - the tool call id.
   * @returns the record, or `undefined` when the call was never archived.
   */
  findToolResultByCallId(callId: string): ToolResultRecord | undefined {
    this.requireEngine()
    return this.store?.findToolResultByCallId(callId)
  }

  /**
   * List archived tool results, newest first, without their full text.
   * @param limit - maximum rows to return.
   * @returns the listing.
   */
  listToolResults(limit?: number): ToolResultMeta[] {
    this.requireEngine()
    return this.store?.listToolResults(limit) ?? []
  }

  /**
   * Search archived tool-result text by substring.
   * @param query - the substring to look for.
   * @param limit - maximum rows to return.
   * @returns matching listings.
   */
  searchToolResults(query: string, limit?: number): ToolResultMeta[] {
    this.requireEngine()
    return this.store?.searchToolResults(query, limit) ?? []
  }

  // --- folded history ranges: reversible compaction (see fold-archive.ts) ---

  /**
   * Archive the exact messages one compression folded into a summary.
   * @param input - the folded payload.
   * @returns the archive ref, or `null` when the store is unavailable.
   */
  archiveFoldedRange(input: {
    readonly messages: number
    readonly chars: number
    readonly tokens: number
    readonly summary: string
    readonly original: string
    readonly sessionId?: string | undefined
  }): string | null {
    this.requireEngine()
    return this.store?.archiveFoldedRange(input) ?? null
  }

  /**
   * Read a folded range back, exact text included.
   * @param ref - the archive ref.
   * @returns the record, or `undefined` when unknown.
   */
  getFoldedRange(ref: string): FoldedRangeRecord | undefined {
    this.requireEngine()
    return this.store?.getFoldedRange(ref)
  }

  /**
   * List folded ranges, newest first, without their original text.
   * @param limit - maximum rows to return.
   * @returns the listing.
   */
  listFoldedRanges(limit?: number): FoldedRangeMeta[] {
    this.requireEngine()
    return this.store?.listFoldedRanges(limit) ?? []
  }

  /**
   * Keyword-search folded ranges (summary and original text).
   * @param query - the substring to look for.
   * @param limit - maximum rows to return.
   * @returns matching listings.
   */
  searchFoldedRanges(query: string, limit?: number): FoldedRangeMeta[] {
    this.requireEngine()
    return this.store?.searchFoldedRanges(query, limit) ?? []
  }

  /** Record that a folded range was read back through `memory_expand`. */
  markFoldedRangeRestored(ref: string): void {
    this.requireEngine()
    this.store?.markFoldedRangeRestored(ref)
  }

  /** @returns the folded-range archive size (rows, chars, tokens). */
  foldedRangeStats(): { count: number; chars: number; tokens: number } {
    this.requireEngine()
    return this.store?.foldedRangeStats() ?? { count: 0, chars: 0, tokens: 0 }
  }

  /**
   * Delete folded ranges older than a timestamp.
   * @param beforeTs - epoch-millisecond cutoff (exclusive).
   * @returns the number of deleted rows.
   */
  pruneFoldedRanges(beforeTs: number): number {
    this.requireEngine()
    return this.store?.pruneFoldedRanges(beforeTs) ?? 0
  }

  /**
   * Keep only the newest N folded ranges.
   * @param maxEntries - the cap.
   * @returns the number of deleted rows.
   */
  trimFoldedRanges(maxEntries: number): number {
    this.requireEngine()
    return this.store?.trimFoldedRanges(maxEntries) ?? 0
  }

  /** @returns the number of archived tool results. */
  countToolResults(): number {
    this.requireEngine()
    return this.store?.countToolResults() ?? 0
  }

  /** @returns the total archived text size in code points. */
  toolResultChars(): number {
    this.requireEngine()
    return this.store?.toolResultChars() ?? 0
  }

  /**
   * Delete archived tool results older than a timestamp.
   * @param timestamp - epoch milliseconds cutoff (exclusive).
   * @returns the number of deleted rows.
   */
  deleteToolResultsBefore(timestamp: number): number {
    this.requireEngine()
    return this.store?.deleteToolResultsBefore(timestamp) ?? 0
  }

  /**
   * Keep only the newest N archived tool results.
   * @param maxEntries - the number of rows to keep.
   * @returns the number of deleted rows.
   */
  trimToolResults(maxEntries: number): number {
    this.requireEngine()
    return this.store?.trimToolResults(maxEntries) ?? 0
  }

  /**
   * Append one context-accounting event (see usage-ledger.ts).
   * @param record - the event to store.
   */
  recordUsageEvent(record: UsageEventRecord): void {
    this.requireEngine()
    this.store?.recordUsageEvent(record)
  }

  /**
   * Sum context-accounting events per kind.
   * @param sinceTs - epoch-millisecond lower bound (inclusive); omit for all time.
   * @returns the per-kind totals.
   */
  usageTotals(sinceTs?: number): UsageTotal[] {
    this.requireEngine()
    return this.store?.usageTotals(sinceTs) ?? []
  }

  /**
   * Read the newest context-accounting events.
   * @param limit - maximum rows.
   * @returns the events, newest first.
   */
  listUsageEvents(limit?: number): UsageEventRecord[] {
    this.requireEngine()
    return this.store?.listUsageEvents(limit) ?? []
  }

  /**
   * Delete context-accounting events older than a timestamp.
   * @param beforeTs - epoch-millisecond cutoff (exclusive).
   * @returns the number of deleted rows.
   */
  pruneUsageEvents(beforeTs: number): number {
    this.requireEngine()
    return this.store?.pruneUsageEvents(beforeTs) ?? 0
  }

  /**
   * Sum ledger values per kind and detail label (per provider/model buckets).
   * @param sinceTs - epoch-millisecond lower bound (inclusive).
   * @returns one row per (kind, detail) pair.
   */
  usageTotalsByDetail(sinceTs?: number): UsageDetailTotal[] {
    this.requireEngine()
    return this.store?.usageTotalsByDetail(sinceTs) ?? []
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
    /** The compaction engine's sanitizer cap, reused by the memory_ingest tool. */
    sanitizerConfig: SanitizerConfig | null
  } | null = null

  /**
   * Back-reference to the compaction engine's VectorRetriever, set after
   * construction. Lets tools.ts reuse the engine's configured retriever
   * (rag_* config) instead of constructing a hard-coded one.
   */
  retriever: { ingest: (text: string, source: string) => Promise<void> } | null = null

  /**
   * Back-reference to the plugin context-accounting ledger, set by
   * MemoryCompactionEngine after construction. Lets `memory_status` report what
   * the plugin did to the context and how the provider billed it.
   */
  usage: {
    summary: (days?: number) => UsageSummary
    totals: (sinceTs?: number) => UsageTotal[]
    recent: (limit?: number) => UsageEventRecord[]
  } | null = null

  /**
   * Context-accounting summary over the last N days.
   * @param days - the window in days (default 7).
   * @returns the summary, or `undefined` when the ledger is not loaded.
   */
  usageSummary(days = 7): UsageSummary | undefined {
    return this.usage?.summary(days)
  }

  /** Hard reset: clear all memories and the index. */
  reset(): void {
    this.requireEngine().reset()
  }
}

export default MemoryContext
