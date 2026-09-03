/**
 * The memory engine: orchestrates the store, embedder, vector index, token
 * budget, and forgetting policy into the multi-tier "infinite context"
 * behavior.
 *
 * This module is dependency-free (no DSH imports). The only external
 * capability it needs — summarizing several memories into one for pyramid
 * consolidation — is injected as a `summarize` function, so the engine is fully
 * unit-testable with a mock summarizer.
 *
 * @module dsh-infinite-context/memory-engine
 */

import { randomUUID } from 'node:crypto'
import type { Embedder } from './embedder.ts'
import type { VectorIndex } from './vector-index.ts'
import type { MemoryStore } from './memory-store.ts'
import type { TokenBudget } from './token-budget.ts'
import type { ForgettingPolicy } from './forgetting.ts'
import { normalizeForDedup } from './memory-store.ts'
import { oneLine } from './strings.ts'
import type {
  ForgettingResult,
  MemoryConfig,
  MemoryDoc,
  MemoryKind,
  MemoryStatus,
  PyramidResult,
  RetrievalHit,
  Tier,
} from './types.ts'

/** Provider/model pair for an LLM summarization call (explicit config or session route). */
export type SummarizationTarget = {
  readonly provider: string
  readonly model: string
}

/**
 * A summarizer that folds several memory texts into a single consolidated text.
 * `target` is the optional resolved provider/model the caller wants for this
 * consolidation (e.g. the session's routed model); when omitted the summarizer
 * falls back to its configured target.
 */
export type SummarizeFn = (
  texts: readonly string[],
  purpose: string,
  target?: SummarizationTarget,
) => Promise<string>

/** Result of the memory maintenance audit. */
export interface MaintenanceReport {
  readonly total: number
  /** Pairs of memories with near-identical text (>= 0.95 similarity). */
  readonly duplicates: readonly (readonly [MemoryDoc, MemoryDoc])[]
  /** Pairs with similar but distinct content (0.85–0.95) — candidate conflicts. */
  readonly conflicts: readonly { readonly a: MemoryDoc; readonly b: MemoryDoc; readonly score: number }[]
  /** Low-importance entries older than ~30 days. */
  readonly stale: readonly MemoryDoc[]
  readonly byKind: Record<string, readonly MemoryDoc[]>
}

/**
 * Lightweight lexical similarity estimate (0–1) between two memory texts,
 * based on the fraction of normalized shared words. Used by the maintenance
 * audit to flag duplicates/conflicts without embedding work.
 */
function similarityEstimate(a: string, b: string): number {
  const na = normalizeForDedup(a)
  const nb = normalizeForDedup(b)
  if (na.length === 0 || nb.length === 0) return 0
  const tokensA = new Set(na.split(/\s+/))
  const tokensB = new Set(nb.split(/\s+/))
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let overlap = 0
  for (const token of tokensA) if (tokensB.has(token)) overlap++
  return 2 * overlap / (tokensA.size + tokensB.size)
}

/** Dependencies the engine needs; all injected for testability. */
export interface MemoryEngineDeps {
  readonly store: MemoryStore
  readonly embedder: Embedder
  readonly index: VectorIndex
  readonly budget: TokenBudget
  readonly forgetting: ForgettingPolicy
  readonly config: MemoryConfig
  /** Summarizer for pyramid consolidation; required when pyramid merging is enabled. */
  readonly summarize?: SummarizeFn
  /** Clock for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number
  /** Optional warning sink (e.g. the cordis logger) for best-effort failures. */
  readonly onWarn?: (message: string) => void
}

/** Options for storing a new memory. */
export interface StoreMemoryOptions {
  readonly importance?: number
  readonly sourceSessionId?: string
  readonly sourceTurns?: { readonly start: number; readonly end: number }
  /** Semantic kind: user / feedback / project / reference. */
  readonly kind?: MemoryKind
}

/** The multi-tier memory engine. */
export class MemoryEngine {
  private readonly store: MemoryStore
  private readonly embedder: Embedder
  private readonly index: VectorIndex
  private readonly budget: TokenBudget
  private readonly forgetting: ForgettingPolicy
  private readonly config: MemoryConfig
  private summarize: SummarizeFn | undefined
  private readonly now: () => number
  private readonly onWarn: ((message: string) => void) | undefined

  /**
   * @param deps - the injected dependencies.
   */
  constructor(deps: MemoryEngineDeps) {
    this.store = deps.store
    this.embedder = deps.embedder
    this.index = deps.index
    this.budget = deps.budget
    this.forgetting = deps.forgetting
    this.config = deps.config
    this.summarize = deps.summarize
    this.now = deps.now ?? (() => Date.now())
    this.onWarn = deps.onWarn
  }

  /**
   * Load all persisted memories from the store into the in-memory vector index.
   * Call this once after construction (typically during service init) so that
   * memories persisted in earlier sessions are immediately available for
   * retrieval.  Without this call the index starts empty and only memories
   * stored in the current process are searchable.
   *
   * @returns the number of memories loaded into the index.
   */
  loadFromStore(): number {
    const all = this.store.list()
    let loaded = 0
    for (const doc of all) {
      if (doc.embedding !== undefined && doc.embedding.length > 0) {
        this.index.add(doc.id, doc.embedding)
        loaded++
      }
    }
    return loaded
  }

  /**
   * Set (or replace) the summarizer used for pyramid consolidation. The
   * memory context service starts without one; the compaction engine injects
   * it once loaded.
   * @param summarize - a summarizer that folds several memory texts into one.
   */
  setSummarizer(summarize: SummarizeFn): void {
    this.summarize = summarize
  }

  /**
   * Embed and persist a new memory, indexing it for retrieval.
   * @param text - the summary text.
   * @param tier - the tier to file it under.
   * @param options - optional importance and provenance.
   * @returns the stored document.
   */
  async storeMemory(text: string, tier: Tier, options: StoreMemoryOptions = {}): Promise<MemoryDoc> {
    const trimmed = text.trim()
    if (trimmed.length === 0) throw new Error('storeMemory: text must be non-empty')
    const embedding = await this.embedder.embed(trimmed)
    const doc: MemoryDoc = {
      id: randomUUID(),
      tier,
      text: trimmed,
      createdAt: this.now(),
      importance: options.importance ?? 0.5,
      embedding,
      ...(options.sourceSessionId === undefined ? {} : { sourceSessionId: options.sourceSessionId }),
      ...(options.sourceTurns === undefined ? {} : { sourceTurns: options.sourceTurns }),
      ...(options.kind === undefined ? {} : { kind: options.kind }),
    }
    this.store.insert(doc)
    this.index.add(doc.id, embedding)
    return doc
  }

  /**
   * Whether any stored memory has exactly this text (ingest dedup helper).
   * @param text - the exact text to look up.
   * @returns true when a memory with this text already exists.
   */
  hasText(text: string): boolean {
    return this.store.hasText(text)
  }

  /**
   * Whether any stored memory has this text after fuzzy normalization
   * (lowercase, whitespace-collapsed, digit-runs masked). Catches repeats
   * differing only by timestamps/counters.
   * @param text - the raw text to normalize and look up.
   * @returns true when a memory with the same normalized text exists.
   */
  hasTextNormalized(text: string): boolean {
    return this.store.hasTextNormalized(text)
  }

  /**
   * Retrieve the most relevant memories for a query.
   * @param query - the question or context to search against.
   * @param k - maximum hits (defaults to the configured top-K).
   * @param minScore - optional per-call similarity floor; overrides the
   *   configured `retrievalMinScore` when provided.
   * @returns hits sorted by descending similarity, filtered by the floor.
   */
  async retrieve(query: string, k?: number, minScore?: number): Promise<RetrievalHit[]> {
    const topK = k ?? this.config.retrievalTopK
    const floor = minScore ?? this.config.retrievalMinScore
    const queryVector = await this.embedder.embed(query)
    const hits = this.index.search(queryVector, topK, floor)
    const results: RetrievalHit[] = []
    for (const hit of hits) {
      const doc = this.store.get(hit.id)
      if (doc !== undefined) results.push({ doc, score: hit.score })
    }
    return results
  }

  /**
   * Run a forgetting sweep: drop low-value memories per the policy.
   * @param now - optional reference time (defaults to the engine clock).
   * @returns the sweep result.
   */
  async forget(now?: number): Promise<ForgettingResult> {
    const reference = now ?? this.now()
    const all = this.store.list()
    const toDrop = this.forgetting.selectToForget(all, reference)
    for (const doc of toDrop) {
      this.store.delete(doc.id)
      this.index.remove(doc.id)
    }
    return { dropped: toDrop, retained: all.length - toDrop.length }
  }

  /**
   * Consolidate the pyramid: when enough `mid` memories have accumulated, fold
   * the oldest batch into a single `long` memory (via the summarizer) and drop
   * the folded mids. Also trims `long` memories beyond the cap.
   * @param target - optional resolved summarization target (e.g. the session's
   *   routed model); forwarded to the summarizer.
   * @returns the consolidation result, or `null` when nothing was merged.
   */
  async consolidate(target?: SummarizationTarget): Promise<PyramidResult | null> {
    const pyramid = this.config.pyramid
    if (pyramid.mergeThreshold <= 0) return null
    const mids = this.store.list('mid').reverse() // oldest first
    if (mids.length < pyramid.mergeThreshold) return null
    const batch = mids.slice(0, Math.max(1, pyramid.mergeBatch))
    if (this.summarize === undefined) {
      throw new Error('pyramid consolidation is enabled but no summarizer was provided')
    }
    const mergedText = await this.summarize(
      batch.map(doc => doc.text),
      'Consolidate the following earlier summaries into one higher-level summary. '
      + 'Preserve decisions, goals, file paths, and open questions; drop stale detail.',
      target,
    )
    const embedding = await this.embedder.embed(mergedText)
    const importance = Math.max(...batch.map(doc => doc.importance))
    const longDoc: MemoryDoc = {
      id: randomUUID(),
      tier: 'long',
      text: mergedText.trim(),
      createdAt: this.now(),
      importance,
      embedding,
      mergedFrom: batch.map(doc => doc.id),
      kind: 'project',
    }
    this.store.insert(longDoc)
    this.index.add(longDoc.id, embedding)
    for (const doc of batch) {
      this.store.delete(doc.id)
      this.index.remove(doc.id)
    }
    this.trimLongMemories()
    return { merged: longDoc, droppedMids: batch.map(doc => doc.id) }
  }

  /** Drop the oldest `long` memories beyond the configured cap. */
  private trimLongMemories(): void {
    const maxLong = this.config.pyramid.maxLong
    if (maxLong <= 0) return
    const longs = this.store.list('long').reverse() // oldest first
    const excess = longs.length - maxLong
    for (let i = 0; i < excess; i++) {
      const doc = longs[i]
      this.store.delete(doc.id)
      this.index.remove(doc.id)
    }
  }

  /**
   * Run a full rebalance: forgetting first, then pyramid consolidation.
   * @param target - optional resolved summarization target for the pyramid
   *   consolidation (e.g. the session's routed model).
   * @returns both results.
   */
  async rebalance(target?: SummarizationTarget): Promise<{ forgetting: ForgettingResult; pyramid: PyramidResult | null }> {
    const forgetting = await this.forget()
    let pyramid: PyramidResult | null = null
    try {
      pyramid = await this.consolidate(target)
    } catch (err) {
      // Consolidation is best-effort; forgetting already applied. But the
      // failure must stay visible (e.g. a misconfigured summarizer would
      // otherwise silently disable pyramid merging forever).
      pyramid = null
      this.onWarn?.(
        `pyramid consolidation failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return { forgetting, pyramid }
  }

  /**
   * A point-in-time snapshot for status reporting.
   * @returns the status.
   */
  status(): MemoryStatus {
    const all = this.store.list()
    const byTier: Record<Tier, number> = { short: 0, mid: 0, long: 0 }
    const byKind: Record<MemoryKind, number> = { user: 0, feedback: 0, project: 0, reference: 0 }
    let oldest: number | undefined
    let newest: number | undefined
    for (const doc of all) {
      byTier[doc.tier]++
      if (doc.kind !== undefined) byKind[doc.kind]++
      if (oldest === undefined || doc.createdAt < oldest) oldest = doc.createdAt
      if (newest === undefined || doc.createdAt > newest) newest = doc.createdAt
    }
    return {
      total: all.length,
      byTier,
      byKind,
      ...(oldest === undefined ? {} : { oldest }),
      ...(newest === undefined ? {} : { newest }),
      embedder: this.embedder.name,
      dimension: this.embedder.dimension,
      budget: this.budget.budget,
      forgetting: this.forgetting.config,
      pyramid: this.config.pyramid,
    }
  }

  /**
   * Generate a compact structured index of the memory store, modeled on a
   * MEMORY.md index: one short line per memory grouped by kind, so a model can
   * see what the store contains and then fetch details on demand. No embedding
   * work, purely a store read.
   * @param limit - maximum entries per kind group (default 10).
   * @returns the rendered index text.
   */
  generateIndex(limit = 10): string {
    const all = this.store.list()
    const order: MemoryKind[] = ['project', 'reference', 'feedback', 'user']
    const lines: string[] = []
    let unclassified = 0
    for (const kind of order) {
      const docs = all.filter(doc => doc.kind === kind)
      if (docs.length === 0) continue
      lines.push(`## ${kind} (${docs.length})`)
      for (const doc of docs.slice(0, limit)) {
        lines.push(`- ${oneLine(doc.text)}`)
      }
      if (docs.length > limit) {
        lines.push(`- … +${docs.length - limit} more (search to fetch)`)
      }
    }
    const rest = all.filter(doc => doc.kind === undefined)
    if (rest.length > 0) {
      unclassified = rest.length
      lines.push(`## unclassified (${rest.length})`)
      for (const doc of rest.slice(0, limit)) {
        lines.push(`- ${oneLine(doc.text)}`)
      }
    }
    if (lines.length === 0) return '(memory store is empty)'
    lines.unshift(`# Memory index (${all.length} memories${unclassified > 0 ? `, ${unclassified} unclassified` : ''})`)
    return lines.join('\n')
  }

  /**
   * Audit the store for maintainability issues (the "curation contract"):
   * near-duplicate groups (repeated decisions), candidate conflicts (same kind,
   * similar text, different content), and stale low-value entries. Read-only.
   * @param now - optional reference time for staleness (defaults to engine clock).
   * @returns the maintenance report.
   */
  maintain(now?: number): MaintenanceReport {
    const all = this.store.list()
    const reference = now ?? this.now()
    const duplicates: [MemoryDoc, MemoryDoc][] = []
    const conflicts: { a: MemoryDoc; b: MemoryDoc; score: number }[] = []
    const seen = new Set<string>()
    const byKind = new Map<MemoryKind | 'unclassified', MemoryDoc[]>()
    for (const doc of all) {
      const key = doc.kind ?? 'unclassified'
      const list = byKind.get(key)
      if (list === undefined) byKind.set(key, [doc])
      else list.push(doc)
    }
    for (const docs of byKind.values()) {
      for (let i = 0; i < docs.length; i++) {
        for (let j = i + 1; j < docs.length; j++) {
          const a = docs[i]
          const b = docs[j]
          const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
          if (seen.has(key)) continue
          const score = similarityEstimate(a.text, b.text)
          if (score >= 0.85) {
            seen.add(key)
            if (score >= 0.95) {
              duplicates.push([a, b])
            } else {
              conflicts.push({ a, b, score })
            }
          }
        }
      }
    }
    const stale = all.filter(doc => doc.importance < 0.4 && reference - doc.createdAt > 30 * 86_400_000)
    return { total: all.length, duplicates, conflicts, stale, byKind: Object.fromEntries(byKind) }
  }

  /**
   * Clear every memory and the index (a hard reset).
   */
  reset(): void {
    this.store.clear()
    this.index.clear()
  }
}
