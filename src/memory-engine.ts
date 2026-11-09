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
import { cosineSimilarity, type Embedder } from './embedder.ts'
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
/** Jaccard-style similarity over PRE-TOKENIZED text (see normalizeForDedup). */
function similarityEstimateSets(tokensA: Set<string> | undefined, tokensB: Set<string> | undefined): number {
  if (tokensA === undefined || tokensB === undefined || tokensA.size === 0 || tokensB.size === 0) return 0
  // Iterate the SMALLER set: overlap is symmetric, and the smaller side is
  // usually much shorter than the store's typical memory text.
  const [small, large] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA]
  let overlap = 0
  for (const token of small) if (large.has(token)) overlap++
  return 2 * overlap / (tokensA.size + tokensB.size)
}

function similarityEstimate(a: string, b: string): number {
  return similarityEstimateSets(
    new Set(normalizeForDedup(a).split(/\s+/)),
    new Set(normalizeForDedup(b).split(/\s+/)),
  )
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

/** The embedder identity recorded in the KV store (drives migration). */
const EMBEDDER_SIGNATURE_KEY = 'embedder:signature'
/** Importance bump applied to memories the model actually got shown. */
export const RETRIEVAL_REINFORCE_DELTA = 0.02
/** Ceiling the retrieval reinforcement is clamped to. */
export const RETRIEVAL_IMPORTANCE_MAX = 0.95
/** Ranking boost for memories distilled from the CURRENT session. */
export const SESSION_RECENCY_BOOST = 0.05
/**
 * A failed migration retries in-process after this delay (up to
 * {@link MIGRATION_RETRY_MAX} attempts) instead of stranding retrieval on an
 * empty index until the next restart. The timer is unref'd so it never holds
 * the process open.
 */
const MIGRATION_RETRY_MS = 60_000
const MIGRATION_RETRY_MAX = 5

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
  /** Set when the stored vectors were built by a different embedder. */
  private pendingMigration = false
  /** Failed in-process migration attempts (reset on success / service start). */
  private migrationRetries = 0

  /** Whether loadFromStore found a signature mismatch awaiting migration. */
  get needsEmbedderMigration(): boolean {
    return this.pendingMigration
  }

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
    // Embedder identity gate: the stored vectors only mean something under
    // the embedder that produced them (tokenizer/hashing changes silently
    // corrupt every score otherwise). On a mismatch the index stays EMPTY —
    // retrieval degrades gracefully for the migration window — and
    // migrateEmbeddings() rebuilds everything under the current embedder.
    const signature = `${this.embedder.name}:${this.embedder.dimension}`
    const recorded = this.store.kvGet(EMBEDDER_SIGNATURE_KEY)
    if (recorded !== signature) {
      this.pendingMigration = true
      this.onWarn?.(
        `embedder signature changed (${recorded ?? 'none'} → ${signature}): `
        + `${all.length} memories will be re-embedded in the background`,
      )
      return 0
    }
    let loaded = 0
    let dimensionMismatches = 0
    for (const doc of all) {
      // Superseded memories (Zep-style invalidation) stay in the store for
      // audit but are not indexed — retrieval must never serve them.
      if (doc.supersededBy !== undefined) continue
      if (doc.embedding !== undefined && doc.embedding.length > 0) {
        // An embedder kind/dimension switch (lightweight-256 → transformers-384)
        // makes old-dimension vectors score 0 against everything: silently
        // indexing them would make those memories permanently un-retrievable
        // AND defeat semantic dedup (the same content re-ingests under the new
        // dimension). Skip and say so instead.
        if (doc.embedding.length !== this.embedder.dimension) {
          dimensionMismatches++
          continue
        }
        this.index.add(doc.id, doc.embedding)
        loaded++
      }
    }
    if (dimensionMismatches > 0) {
      this.onWarn?.(
        `${dimensionMismatches} stored memor${dimensionMismatches === 1 ? 'y' : 'ies'} have `
          + `${this.embedder.dimension}-mismatched embedding vectors (embedder was switched?) — `
          + 'skipped from the index; re-ingest or reset to rebuild them',
      )
    }
    this.store.kvSet(EMBEDDER_SIGNATURE_KEY, signature)
    return loaded
  }

  /**
   * Rebuild every stored embedding under the CURRENT embedder and rehydrate
   * the index. Scheduled (fire-and-forget) by the service constructor when
   * {@link loadFromStore} detected a signature mismatch — an embedder or
   * tokenizer upgrade without a migration would otherwise leave the store
   * scoring garbage forever. Lightweight hash embedding re-builds hundreds
   * of memories in milliseconds; a model-backed embedder takes as long as
   * the model needs, and retrieval simply stays empty until it finishes.
   * @returns the number of memories re-embedded.
   */
  async migrateEmbeddings(): Promise<number> {
    if (!this.pendingMigration) return 0
    this.pendingMigration = false
    const all = this.store.list()
    const started = Date.now()
    try {
      let count = 0
      for (const doc of all) {
        const vector = await this.embedder.embed(doc.text)
        this.store.updateEmbedding(doc.id, vector)
        this.index.add(doc.id, vector)
        count += 1
        if (count % 100 === 0) {
          this.onWarn?.(`embedder migration: ${count}/${all.length} memories re-embedded`)
        }
      }
      this.store.kvSet(EMBEDDER_SIGNATURE_KEY, `${this.embedder.name}:${this.embedder.dimension}`)
      this.migrationRetries = 0
      this.onWarn?.(
        `embedder migration complete: ${count} memories re-embedded `
        + `in ${Date.now() - started}ms`,
      )
      return count
    } catch (error) {
      // Leave the pending flag set and retry IN-PROCESS (bounded): stranding
      // retrieval on an empty index until the next restart is worse than a
      // bounded background retry. A model-backed embedder that is still
      // downloading its weights recovers within a couple of attempts.
      this.pendingMigration = true
      const attempt = this.migrationRetries + 1
      this.migrationRetries = attempt
      const retry = attempt <= MIGRATION_RETRY_MAX
      this.onWarn?.(
        `embedder migration failed (attempt ${attempt}/${MIGRATION_RETRY_MAX + 1}); `
        + (retry ? `retrying in ${MIGRATION_RETRY_MS / 1000}s: ` : 'giving up until the next start: ')
        + (error instanceof Error ? error.message : String(error)),
      )
      if (retry) {
        const timer = setTimeout(() => void this.migrateEmbeddings(), MIGRATION_RETRY_MS)
        timer.unref()
      }
      return 0
    }
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
   * Supersede a memory family: every memory of the same kind from the same
   * session (except the new one) is marked superseded by `keepId` — Zep-style
   * invalidation. Superseded rows leave the index and retrieval but stay in
   * the store for audit; the forgetting policy may physically retire them
   * later under their kind's short half-life. The supersede chain is what
   * makes per-fold checkpoint digests "forget cleanly": the newest digest
   * speaks for the session, the older ones stop polluting retrieval the
   * moment the new one lands.
   * @param sessionId - the session whose prior checkpoints are replaced.
   * @param kind - the family kind (the fold digest uses 'checkpoint').
   * @param keepId - the id of the NEW memory that supersedes the family.
   * @returns how many prior memories were marked superseded.
   */
  supersedePrior(sessionId: string, kind: MemoryKind, keepId: string): number {
    const prior = this.store
      .list()
      .filter(doc =>
        doc.id !== keepId
        && doc.supersededBy === undefined
        && doc.kind === kind
        && doc.sourceSessionId === sessionId,
      )
      .map(doc => doc.id)
    const marked = this.store.markSuperseded(prior, keepId)
    for (const id of prior) this.index.remove(id)
    return marked
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
  async retrieve(
    query: string,
    k?: number,
    minScore?: number,
    options?: { reinforce?: boolean; currentSessionId?: string },
  ): Promise<RetrievalHit[]> {
    const topK = k ?? this.config.retrievalTopK
    const floor = minScore ?? this.config.retrievalMinScore
    const queryVector = await this.embedder.embed(query)
    // With a session boost in play, search a WIDER candidate pool: the boost
    // can only re-rank what the raw-score search returned, so a current-
    // session memory sitting at raw rank topK+1 would never be rescued.
    const poolSize = options?.currentSessionId !== undefined ? topK * 3 + 5 : topK
    const hits = this.index.search(queryVector, poolSize, floor)
    const results: RetrievalHit[] = []
    for (const hit of hits) {
      const doc = this.store.get(hit.id)
      // Superseded memories (Zep-style invalidation) stay in the store for
      // audit but never come back from retrieval.
      if (doc !== undefined && doc.supersededBy === undefined) results.push({ doc, score: hit.score })
    }
    // Same-session recency: for the RAG use case ("context for THIS turn") a
    // memory distilled from the current session is disproportionately likely
    // to be the one the user means — a flat additive boost re-ranks those
    // above equally-scoring entries from older sessions without needing
    // semantics the lexical embedder does not have.
    if (options?.currentSessionId !== undefined) {
      for (let i = 0; i < results.length; i += 1) {
        const hit = results[i]!
        if (hit.doc.sourceSessionId === options.currentSessionId) {
          results[i] = { doc: hit.doc, score: hit.score + SESSION_RECENCY_BOOST }
        }
      }
      results.sort((a, b) => b.score - a.score)
    }
    // Now cut to the caller's topK (post-boost), and reinforce only the
    // survivors — a memory crowded out of the final answer was not used.
    const top = (options?.currentSessionId !== undefined ? results.slice(0, topK) : results)
      .map(hit => {
        if (options?.reinforce === false) return hit
        const importance = Math.min(
          RETRIEVAL_IMPORTANCE_MAX,
          hit.doc.importance + RETRIEVAL_REINFORCE_DELTA,
        )
        if (importance > hit.doc.importance) {
          this.store.bumpImportance(hit.doc.id, RETRIEVAL_REINFORCE_DELTA, RETRIEVAL_IMPORTANCE_MAX)
        }
        return { doc: { ...hit.doc, importance }, score: hit.score }
      })
    return top
  }

  /**
   * Run a forgetting sweep: drop low-value memories per the policy.
   * @param now - optional reference time (defaults to the engine clock).
   * @returns the sweep result.
   */
  async forget(now?: number): Promise<ForgettingResult> {
    const reference = now ?? this.now()
    const all = this.store.list(undefined, { withEmbeddings: false })
    const toDrop = this.forgetting.selectToForget(all, reference)
    for (const doc of toDrop) {
      this.store.delete(doc.id)
      this.index.remove(doc.id)
    }
    return { dropped: toDrop, retained: all.length - toDrop.length }
  }

  /**
   * Consolidate the pyramid: when enough `mid` memories have accumulated, fold
   * the oldest batch into a single `long` memory (via the summarizer) and
   * demote the folded mids to the short tier. Also trims `long` memories
   * beyond the cap.
   * @param target - optional resolved summarization target (e.g. the session's
   *   routed model); forwarded to the summarizer.
   * @returns the consolidation result, or `null` when nothing was merged.
   */
  async consolidate(target?: SummarizationTarget): Promise<PyramidResult | null> {
    const pyramid = this.config.pyramid
    if (pyramid.mergeThreshold <= 0) return null
    const mids = this.store.list('mid').reverse() // oldest first
    if (mids.length < pyramid.mergeThreshold) return null
    const batch = this.selectConsolidationBatch(mids, Math.max(1, pyramid.mergeBatch))
    if (this.summarize === undefined) {
      throw new Error('pyramid consolidation is enabled but no summarizer was provided')
    }
    const mergedText = await this.summarize(
      batch.map(doc => doc.text),
      'Consolidate the following earlier summaries into one higher-level summary. '
      + 'Preserve decisions, goals, file paths, and open questions; drop stale detail.',
      target,
    )
    // A whitespace-only response must not become a blank long memory
    // (storeMemory rejects empty text; consolidation holds itself to the same bar).
    if (mergedText.trim().length === 0) {
      throw new Error('pyramid consolidation: the summarizer returned an empty summary')
    }
    const embedding = await this.embedder.embed(mergedText)
    const importance = Math.max(...batch.map(doc => doc.importance))
    // Carry the batch's MAJORITY kind: merging user/feedback mids into a
    // hardcoded 'project' misfiled them in generateIndex groups and in
    // maintain()'s by-kind pairwise scans.
    const kindCounts = new Map<MemoryKind, number>()
    for (const doc of batch) {
      if (doc.kind === undefined) continue
      kindCounts.set(doc.kind, (kindCounts.get(doc.kind) ?? 0) + 1)
    }
    let mergedKind: MemoryKind = 'project'
    let bestCount = -1
    for (const [kind, count] of kindCounts) {
      if (count > bestCount) { mergedKind = kind; bestCount = count }
    }
    const longDoc: MemoryDoc = {
      id: randomUUID(),
      tier: 'long',
      text: mergedText.trim(),
      createdAt: this.now(),
      importance,
      embedding,
      mergedFrom: batch.map(doc => doc.id),
      kind: mergedKind,
    }
    // DEMOTE FIRST, insert the long memory second: the two writes are
    // separate autocommit statements, and a crash between them must leave a
    // BENIGN state. Demoted-first means a crash loses the merge but leaves
    // nothing re-mergeable; insert-first (the old order) left a long memory
    // whose source mids were still mid-tier — re-merged later into duplicated
    // long content.
    for (const doc of batch) {
      this.store.upsert({ ...doc, tier: 'short', importance: Math.min(doc.importance, 0.3) })
    }
    this.store.insert(longDoc)
    this.index.add(longDoc.id, embedding)
    // The demoted mids keep their full text at a LOW importance so the
    // forgetting policy retires them naturally before the long memory —
    // while still being retrievable until then.
    this.trimLongMemories()
    return { merged: longDoc, demotedMids: batch.map(doc => doc.id) }
  }

  /**
   * Pick the consolidation batch: the OLDEST mid seeds it (staleness ordering
   * is preserved — the pyramid still retires age first), and the remaining
   * seats go to its most SIMILAR siblings rather than the merely-next-oldest.
   * Merging five summaries of the same subsystem yields one coherent long
   * memory; merging the five chronologically-oldest yields an arbitrary
   * mixture. Falls back to plain oldest-first when the seed has no embedding
   * (nothing to rank by).
   * @param pool - the mid memories, oldest first.
   * @param size - the configured batch size.
   * @returns the batch to consolidate.
   */
  private selectConsolidationBatch(pool: MemoryDoc[], size: number): MemoryDoc[] {
    const seed = pool[0]
    if (seed === undefined) return []
    const seedEmbedding = seed.embedding
    if (size <= 1 || pool.length === 1 || seedEmbedding === undefined) {
      return pool.slice(0, size)
    }
    const ranked = pool.slice(1)
      .map(doc => ({
        doc,
        similarity: doc.embedding === undefined
          ? -1
          : cosineSimilarity(seedEmbedding, doc.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, size - 1)
      .map(entry => entry.doc)
    return [seed, ...ranked]
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
    const byKind: Record<MemoryKind, number> = { user: 0, feedback: 0, project: 0, reference: 0, checkpoint: 0 }
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
    const all = this.store.list(undefined, { withEmbeddings: false })
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
    // The unclassified group gets the same overflow hint as the kind groups.
    if (unclassified > 0) {
      const unclassifiedDocs = all.filter(doc => doc.kind === undefined)
      lines.push(`## unclassified (${unclassified})`)
      for (const doc of unclassifiedDocs.slice(0, limit)) {
        lines.push(`- ${oneLine(doc.text)} (id: ${doc.id})`)
      }
      if (unclassifiedDocs.length > limit) {
        lines.push(`- … +${unclassifiedDocs.length - limit} more (search to fetch)`)
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
    const all = this.store.list(undefined, { withEmbeddings: false })
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
    // Normalize once per doc: the pairwise loop below used to re-run the
    // regex-heavy normalizeForDedup on BOTH texts for every pair (O(n²) full
    // passes over whole memory texts).
    // Pre-tokenize once per doc: the pairwise loop used to build token Sets
    // from full texts for BOTH sides of every pair (O(n²) Set constructions).
    const tokenSets = new Map(all.map(doc => [doc.id, new Set(normalizeForDedup(doc.text).split(/\s+/))]))
    for (const docs of byKind.values()) {
      for (let i = 0; i < docs.length; i++) {
        for (let j = i + 1; j < docs.length; j++) {
          const a = docs[i]
          const b = docs[j]
          const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
          if (seen.has(key)) continue
          const score = similarityEstimateSets(tokenSets.get(a.id), tokenSets.get(b.id))
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
