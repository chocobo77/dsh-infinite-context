/**
 * Configuration for the two Cordis entries of this plugin, validated with
 * schemastery and resolved into the plain core shapes.
 *
 * Schemastery object fields are optional by default, so the schemas below only
 * validate types; every default is applied in the `resolve*` functions using
 * `??` fallbacks. This keeps the schema typing simple and robust.
 *
 * @module dsh-infinite-context/config
 */

import z from '@deepseek-ai/schemastery'
import type {
  BudgetConfig,
  EmbedderConfig,
  ForgettingConfig,
  MemoryConfig,
  PyramidConfig,
} from './types.ts'

/** Default per-tier token budgets (matches the design goal: total <= window). */
export const DEFAULT_BUDGET: BudgetConfig = {
  short: 10_000,
  mid: 20_000,
  long: 5_000,
  retrieved: 15_000,
}

/** Default forgetting policy. */
export const DEFAULT_FORGETTING: ForgettingConfig = {
  halfLifeDays: 30,
  importanceWeight: 0.6,
  recencyWeight: 0.4,
  minScore: 0.25,
  maxMemories: 500,
}

/** Default pyramid consolidation policy. */
export const DEFAULT_PYRAMID: PyramidConfig = {
  mergeThreshold: 4,
  mergeBatch: 3,
  maxLong: 20,
}

/** Default embedder: the dependency-free lightweight one. */
export const DEFAULT_EMBEDDER: EmbedderConfig = {
  kind: 'lightweight',
  dimension: 256,
}

/** Default model context window for a local deployment. */
export const DEFAULT_CONTEXT_WINDOW = 94_000

/** Default headroom (fraction of the window) left for system/tools/input/output. */
export const DEFAULT_HEADROOM_RATIO = 0.25

/** Default store path. */
export const DEFAULT_STORE_PATH = 'dsh-infinite-context.db'

/** Supported live model-context probe endpoints (for local servers). */
export type ModelProbeKind = 'llama' | 'ollama' | 'openai'

/** Raw (config-file) shape of the live model-context probe. */
export interface ModelProbeConfig {
  /** Whether to probe the local server when DSH reports no context window. */
  enabled?: boolean
  /** Which probe protocol to speak. */
  kind?: ModelProbeKind
  /** The local server's base URL (e.g. `http://127.0.0.1:8080`). */
  baseURL?: string
}

/** Resolved (validated) shape of the live model-context probe. */
export interface ResolvedModelProbeConfig {
  readonly enabled: boolean
  readonly kind: ModelProbeKind
  readonly baseURL: string
}

/** Default probe: off, so the plugin works with zero extra config. */
export const DEFAULT_MODEL_PROBE: ResolvedModelProbeConfig = {
  enabled: false,
  kind: 'llama',
  baseURL: '',
}

/** Default retrieval floor and top-K. */
export const DEFAULT_RETRIEVAL_MIN_SCORE = 0.2
export const DEFAULT_RETRIEVAL_TOP_K = 5

/** One explicit per-model context-window override (config-declared truth). */
export interface ModelWindowOverride {
  /** Provider-owned model id the window applies to (exact match). */
  model: string
  /** The model's real context window in tokens. */
  contextWindow: number
}

/**
 * Raw configuration for the `memoryContext` service (from cordis.yml). Every
 * field is optional; defaults produce a working out-of-the-box setup.
 */
export interface MemoryContextConfig {
  /** SQLite file path for persisted memories (`:memory:` for in-process). */
  storePath?: string
  /** The model's total context window in tokens. */
  contextWindow?: number
  /** Fraction of the window reserved for system prompt, tools, input, output. */
  headroomRatio?: number
  /**
   * Explicit per-model context windows. The authoritative per-model truth for
   * models whose declared value is wrong or missing — e.g. a local model whose
   * server runs 32K while the catalog says 100K, or a remote model whose real
   * window differs from the declaration. Overrides feed the per-model registry
   * (a probe result can still narrow them further) and the dynamic compaction
   * threshold.
   */
  modelWindows?: ModelWindowOverride[]
  /**
   * Live model-context probing (fallback for local servers whose model
   * listing does not advertise a context window). The plugin first adopts the
   * context window DSH already resolved from the model catalog / `/models`;
   * this probe only fires when that yields nothing and `enabled` is set.
   */
  modelProbe?: Partial<ModelProbeConfig>
  /** Embedder selection. */
  embedder?: Partial<EmbedderConfig> & { kind?: EmbedderConfig['kind'] }
  /** Per-tier token budgets. */
  budget?: Partial<BudgetConfig>
  /** Forgetting policy. */
  forgetting?: Partial<ForgettingConfig>
  /** Pyramid consolidation policy. */
  pyramid?: Partial<PyramidConfig>
  /** Minimum cosine similarity for a memory to count as relevant. */
  retrievalMinScore?: number
  /** Default top-K for retrieval. */
  retrievalTopK?: number
}

/** Schemastery schema for {@link MemoryContextConfig} (validates types only). */
export const MemoryContextConfigSchema: z<MemoryContextConfig> = z.object({
  storePath: z.string(),
  contextWindow: z.number().step(1).min(1),
  headroomRatio: z.number().min(0).max(0.9),
  modelWindows: z.array(z.object({
    model: z.string(),
    contextWindow: z.number().step(1).min(1),
  })),
  embedder: z.object({
    kind: z.union(['lightweight', 'transformers'] as const),
    dimension: z.number().step(1).min(8),
    model: z.string(),
  }),
  modelProbe: z.object({
    enabled: z.boolean(),
    kind: z.union(['llama', 'ollama', 'openai'] as const),
    baseURL: z.string(),
  }),
  budget: z.object({
    short: z.number().step(1).min(0),
    mid: z.number().step(1).min(0),
    long: z.number().step(1).min(0),
    retrieved: z.number().step(1).min(0),
  }),
  forgetting: z.object({
    halfLifeDays: z.number().min(0),
    importanceWeight: z.number().min(0),
    recencyWeight: z.number().min(0),
    minScore: z.number().min(0).max(1),
    maxMemories: z.number().step(1).min(1),
  }),
  pyramid: z.object({
    mergeThreshold: z.number().step(1).min(0),
    mergeBatch: z.number().step(1).min(1),
    maxLong: z.number().step(1).min(1),
  }),
  retrievalMinScore: z.number().min(-1).max(1),
  retrievalTopK: z.number().step(1).min(1),
})

/** Resolved context configuration (the plain shape the core consumes). */
export interface ResolvedMemoryContextConfig {
  readonly storePath: string
  readonly contextWindow: number
  readonly headroomRatio: number
  readonly modelWindows: readonly ModelWindowOverride[]
  readonly modelProbe: ResolvedModelProbeConfig
  readonly memory: MemoryConfig
}

/**
 * Validate raw (possibly partial) config and resolve it into the plain core
 * shape with defaults applied.
 * @param raw - the config from cordis.yml (validated against the schema).
 * @returns the resolved configuration.
 */
export function resolveMemoryContextConfig(raw: MemoryContextConfig): ResolvedMemoryContextConfig {
  const storePath = raw.storePath ?? DEFAULT_STORE_PATH
  const contextWindow = raw.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const headroomRatio = raw.headroomRatio ?? DEFAULT_HEADROOM_RATIO
  const modelProbe: ResolvedModelProbeConfig = {
    enabled: raw.modelProbe?.enabled ?? DEFAULT_MODEL_PROBE.enabled,
    kind: raw.modelProbe?.kind ?? DEFAULT_MODEL_PROBE.kind,
    baseURL: raw.modelProbe?.baseURL ?? DEFAULT_MODEL_PROBE.baseURL,
  }
  const embedderSource = raw.embedder ?? {}
  const kind = embedderSource.kind ?? DEFAULT_EMBEDDER.kind
  const dimension = embedderSource.dimension ?? DEFAULT_EMBEDDER.dimension
  const embedder: EmbedderConfig = kind === 'transformers'
    ? { kind, dimension, ...(embedderSource.model ? { model: embedderSource.model } : {}) }
    : { kind, dimension }
  return {
    storePath,
    contextWindow,
    headroomRatio,
    modelWindows: raw.modelWindows ?? [],
    modelProbe,
    memory: {
      embedder,
      budget: { ...DEFAULT_BUDGET, ...raw.budget },
      forgetting: { ...DEFAULT_FORGETTING, ...raw.forgetting },
      pyramid: { ...DEFAULT_PYRAMID, ...raw.pyramid },
      retrievalMinScore: raw.retrievalMinScore ?? DEFAULT_RETRIEVAL_MIN_SCORE,
      retrievalTopK: raw.retrievalTopK ?? DEFAULT_RETRIEVAL_TOP_K,
    },
  }
}

/**
 * Raw configuration for the `memoryCompaction` entry: the basic compaction
 * policy plus retrieval-injection, history-compression, output-sanitization,
 * and vector-retrieval options.
 */
export interface MemoryCompactionConfig {
  /** Delegated to BasicCompactionConfig: pressure threshold ratio (0-1). */
  thresholdRatio?: number
  /** Delegated: retained recent tail ratio (0-1). */
  retainRatio?: number
  /** Delegated: retained recent tail in tokens. */
  retainTokens?: number
  /** Delegated: provider for the summarization call. */
  summarizationProvider?: string
  /** Delegated: model for the summarization call. */
  summarizationModel?: string
  /** Delegated: max output tokens for the summarization call. */
  maxTokens?: number
  /** Delegated: compaction retries per pressure check. */
  compactionRetries?: number
  /** Delegated: overflow retries after a context-window-exceeded error. */
  maxOverflowRetries?: number
  /** Delegated: whether automatic compaction is enabled. */
  auto?: boolean
  /** Retrieval-injection options. */
  retrieval?: {
    /** Whether to inject retrieved memories on each new turn. */
    enabled?: boolean
    /** Top-K memories to inject. */
    topK?: number
    /** Only inject memories above this similarity. */
    minScore?: number
  }
  /** History compression: number of rounds between compressions (0 disables). */
  compress_round_interval?: number
  /**
   * Dynamic compaction threshold: when the routed model's REAL context window
   * (live probe or an explicit `modelWindows` override) is smaller than the
   * window DSH declares, force the durable-history compaction as soon as the
   * measured conversation crosses a threshold derived from the REAL window —
   * instead of waiting for the declared-window threshold, which a short-context
   * local model can never reach before overflowing. Default true.
   */
  compaction_dynamic_threshold?: boolean
  /**
   * History compression: trigger only when the current context exceeds this
   * fraction of the token budget. Delays compression while context is still
   * roomy even when the round interval has elapsed. Default 0.85.
   */
  compress_trigger_ratio?: number
  /**
   * History compression: target water level after compression, as a fraction
   * of the token budget. Only the oldest messages needed to reach this level
   * are summarized (progressive), keeping recent context verbatim. Default 0.6.
   */
  compress_target_ratio?: number
  /** Number of most recent messages to keep uncompressed. */
  retain_recent_messages?: number
  /** Maximum characters for generic JSON string fields in output sanitization. */
  sanitize_max_chars?: number
  /** RAG retrieval: Top-K similar memories to inject. */
  rag_top_k?: number
  /** RAG retrieval: minimum cosine similarity threshold (0-1). */
  rag_min_score?: number
  /** RAG retrieval: maximum token budget for injected context. */
  rag_token_budget?: number
  /** RAG ingestion: semantic chunk size in characters. */
  rag_chunk_size?: number
  /** RAG ingestion: skip exact-duplicate chunks (default true). */
  rag_dedupe_exact?: boolean
  /** RAG ingestion: skip chunks whose nearest memory scores >= this (0 disables). */
  rag_dedupe_min_score?: number
  /** RAG ingestion: tools excluded from ingestion (low-value sources). */
  rag_ingest_denylist?: string[]
  /** RAG ingestion: when non-empty, ONLY these sources are ingested. */
  rag_ingest_allowlist?: string[]
  /** RAG ingestion: importance score for tool-result memories (default 0.3). */
  rag_ingest_importance?: number
}

/** Schemastery schema for {@link MemoryCompactionConfig} (validates types only). */
export const MemoryCompactionConfigSchema: z<MemoryCompactionConfig> = z.object({
  thresholdRatio: z.number().min(0).max(1),
  retainRatio: z.number().min(0).max(1),
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
  auto: z.boolean(),
  retrieval: z.object({
    enabled: z.boolean(),
    topK: z.number().step(1).min(1),
    minScore: z.number().min(-1).max(1),
  }),
  compress_round_interval: z.number().step(1).min(0),
  compaction_dynamic_threshold: z.boolean(),
  compress_trigger_ratio: z.number().min(0).max(1),
  compress_target_ratio: z.number().min(0).max(1),
  retain_recent_messages: z.number().step(1).min(1),
  sanitize_max_chars: z.number().step(1).min(100),
  rag_top_k: z.number().step(1).min(1),
  rag_min_score: z.number().min(0).max(1),
  rag_token_budget: z.number().step(1).min(100),
  rag_chunk_size: z.number().step(1).min(50),
  rag_dedupe_exact: z.boolean(),
  rag_dedupe_min_score: z.number().min(0).max(1),
  rag_ingest_denylist: z.array(z.string()),
  rag_ingest_allowlist: z.array(z.string()),
  rag_ingest_importance: z.number().min(0).max(1),
})

/** Default low-value tool sources excluded from ingestion. */
export const DEFAULT_INGEST_DENYLIST = [
  'memory_search',
  'memory_status',
  'memory_index',
  'memory_maintain',
  'memory_model_probe',
  'memory_forget',
  'memory_consolidate',
  'memory_reset',
  'memory_ingest',
  'memory_force_compress',
  'todo_write',
  'ask_user_question',
  'interrupt_agent',
  'job_list',
  'job_output',
  'job_kill',
  'list_agents',
  'send_message',
  'subagent',
  'subagent_fork',
  'workflow',
  'ralph',
  'skill',
]

/** The resolved retrieval-injection options. */
export interface ResolvedRetrievalOptions {
  readonly enabled: boolean
  readonly topK: number
  readonly minScore: number
}

/**
 * Validate raw compaction config and resolve the retrieval options.
 *
 * Effective source is the `rag_*` family (calibrated for the lightweight
 * embedder); the legacy `retrieval.topK`/`retrieval.minScore` fields remain
 * as fallbacks so old configs keep working. `retrieval.enabled` stays the
 * on/off switch for per-turn injection.
 * @param raw - the config from cordis.yml.
 * @returns the resolved retrieval options.
 */
export function resolveRetrievalOptions(raw: MemoryCompactionConfig): ResolvedRetrievalOptions {
  const retrieval = raw.retrieval ?? {}
  return {
    enabled: retrieval.enabled ?? true,
    topK: raw.rag_top_k ?? retrieval.topK ?? 3,
    minScore: raw.rag_min_score ?? retrieval.minScore ?? DEFAULT_RETRIEVAL_MIN_SCORE,
  }
}
