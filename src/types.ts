/**
 * Shared types for the infinite-context memory core.
 *
 * This module is dependency-free (no DSH imports) so the pure core can be
 * unit-tested in isolation. The Cordis integration layer validates and adapts
 * configuration into these plain shapes.
 *
 * @module dsh-infinite-context/types
 */

/** The three memory tiers, from most to least recent. */
export type Tier = 'short' | 'mid' | 'long'

/**
 * Semantic kind of a memory, mirroring the structured-memory taxonomy
 * (user / feedback / project / reference) so memories are locatable and
 * maintainable, not just vector-searchable:
 * - `user`: the user's identity and long-term preferences.
 * - `feedback`: verified corrections / how to work with the user.
 * - `project`: project state, stage conclusions, important decisions.
 * - `reference`: material, commands, paths, resource locations.
 * Absent/undefined means unclassified (legacy rows).
 */
export type MemoryKind = 'user' | 'feedback' | 'project' | 'reference'

/**
 * A single memory document: a summarized fragment of conversation with its
 * tier, importance, and (optionally) its embedding for semantic retrieval.
 */
export interface MemoryDoc {
  /** Stable unique id (uuid). */
  readonly id: string
  /** Which tier this memory belongs to. */
  readonly tier: Tier
  /** The summary text (Markdown). */
  readonly text: string
  /** Unix epoch milliseconds when the memory was created. */
  readonly createdAt: number
  /**
   * Importance score in `[0, 1]`. Drives the forgetting policy. Defaults to a
   * neutral `0.5` when the summarizer does not assign one.
   */
  readonly importance: number
  /** The session id the memory was distilled from, when known. */
  readonly sourceSessionId?: string
  /** The inclusive turn range the memory covers, when known. */
  readonly sourceTurns?: { readonly start: number; readonly end: number }
  /**
   * The embedding vector (L2-normalized) used for semantic retrieval. Absent
   * until the embedder has processed the text.
   */
  readonly embedding?: readonly number[]
  /**
   * Semantic kind (user/feedback/project/reference). Absent for legacy rows.
   */
  readonly kind?: MemoryKind
  /**
   * For `long` memories: the ids of the `mid` memories merged into this one.
   * Enables provenance and re-derivation.
   */
  readonly mergedFrom?: readonly string[]
}

/** A memory document plus its retrieval similarity score. */
export interface RetrievalHit {
  readonly doc: MemoryDoc
  /** Cosine similarity in `[-1, 1]` (typically `[0, 1]` for normalized vectors). */
  readonly score: number
}

/** Token budget allocation across tiers (all values in tokens). */
export interface BudgetConfig {
  /** Short-term: recent turns kept verbatim. */
  readonly short: number
  /** Mid-term: the most recent summaries kept in context. */
  readonly mid: number
  /** Long-term: the consolidated pyramid apex kept in context. */
  readonly long: number
  /** Retrieved: top-K memories spliced in for the current question. */
  readonly retrieved: number
}

/** Forgetting policy parameters. */
export interface ForgettingConfig {
  /**
   * Recency half-life in days: a memory's recency factor halves every
   * `halfLifeDays`. `0` disables the recency decay (recency factor = 1).
   */
  readonly halfLifeDays: number
  /** Weight of importance in the combined score (importance + recency). */
  readonly importanceWeight: number
  /** Weight of recency in the combined score. */
  readonly recencyWeight: number
  /** Drop memories whose combined score falls below this floor. */
  readonly minScore: number
  /** Hard cap on the total number of retained memories (across tiers). */
  readonly maxMemories: number
}

/** Pyramid (long-term consolidation) parameters. */
export interface PyramidConfig {
  /**
   * Number of `mid` memories that triggers a merge of the oldest ones into a
   * single `long` memory. `0` disables pyramid consolidation.
   */
  readonly mergeThreshold: number
  /** How many oldest `mid` memories to fold into one `long` memory per merge. */
  readonly mergeBatch: number
  /** Cap on the number of retained `long` memories (oldest are folded away). */
  readonly maxLong: number
}

/** Embedder selection and parameters. */
export interface EmbedderConfig {
  /** `lightweight` (built-in, no deps) or `transformers` (all-MiniLM-L6-v2). */
  readonly kind: 'lightweight' | 'transformers'
  /** Vector dimension (lightweight default 256; transformers 384). */
  readonly dimension: number
  /** Model name for the transformers embedder. */
  readonly model?: string
}

/** The full pure-core configuration (plain, already-validated shape). */
export interface MemoryConfig {
  readonly embedder: EmbedderConfig
  readonly budget: BudgetConfig
  readonly forgetting: ForgettingConfig
  readonly pyramid: PyramidConfig
  /** Minimum cosine similarity for a memory to be considered "relevant". */
  readonly retrievalMinScore: number
  /** Default top-K for retrieval. */
  readonly retrievalTopK: number
}

/** A point-in-time snapshot of the memory system, for `memory_status`. */
export interface MemoryStatus {
  readonly total: number
  readonly byTier: Record<Tier, number>
  readonly byKind?: Record<MemoryKind, number>
  readonly oldest?: number
  readonly newest?: number
  readonly embedder: string
  readonly dimension: number
  readonly budget: BudgetConfig
  readonly forgetting: ForgettingConfig
  readonly pyramid: PyramidConfig
}

/** Where the model context window value came from. */
export type ModelContextSource = 'config' | 'request-context' | 'probe'

/** Detected model context information, adopted from DSH or a local probe. */
export interface ModelContextInfo {
  /** Registered provider route the window belongs to. */
  readonly provider?: string
  /** Provider-owned model id the window belongs to. */
  readonly model?: string
  /** The effective model context window in tokens. */
  readonly contextWindow: number
  /** Where this value was resolved from. */
  readonly source: ModelContextSource
  /** Epoch millis when this value was detected. */
  readonly detectedAt: number
}

/** Result of a forgetting sweep. */
export interface ForgettingResult {
  readonly dropped: readonly MemoryDoc[]
  readonly retained: number
}

/** Result of a pyramid consolidation. */
export interface PyramidResult {
  readonly merged: MemoryDoc | null
  readonly droppedMids: readonly string[]
}
