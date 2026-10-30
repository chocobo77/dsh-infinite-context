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

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type {
  BudgetConfig,
  EmbedderConfig,
  ForgettingConfig,
  MemoryConfig,
  PyramidConfig,
} from './types.ts'
import { DEFAULT_TOOL_ARCHIVE_OPTIONS } from './tool-archive.ts'
import type { ToolArchiveOptions } from './tool-archive.ts'
import { DEFAULT_ABSORB_OPTIONS } from './absorb.ts'
import type { AbsorbOptions } from './absorb.ts'
import { DEFAULT_FOLD_OPTIONS } from './fold-archive.ts'
import type { FoldOptions } from './fold-archive.ts'
import { DEFAULT_USAGE_OPTIONS } from './usage-ledger.ts'
import type { UsageOptions } from './usage-ledger.ts'

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

/** Default store path (relative; see {@link resolveStorePath}). */
export const DEFAULT_STORE_PATH = 'dsh-infinite-context.db'

/** The SQLite in-process sentinel: not a file, so never path-resolved. */
export const IN_MEMORY_STORE = ':memory:'

/** Environment variable naming the Harness home (DSH's own spelling). */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name of the default Harness home below the user's home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Subdirectory of the Harness home that holds plugin-owned databases. */
export const STORE_DIR_NAME = 'storages'

/** Expand a leading `~` (or `~/`, `~\`) to the user's home directory. */
function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  if (/^~[/\\]/.test(path)) return join(homeDir, path.slice(2))
  return path
}

/**
 * Resolve the Harness home directory with DSH's own precedence: a non-blank
 * `$DSH_HOME`, then `~/.dsh`. A blank or whitespace-only `$DSH_HOME` counts as
 * unset, so a stray empty override never redirects persistent state to `/`.
 * @param env - environment to read `DSH_HOME` from (defaults to `process.env`).
 * @param homeDir - the user's home directory (defaults to `os.homedir()`).
 * @returns the absolute Harness home path.
 */
export function resolveDshHome(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
): string {
  const fromEnv = (env[DSH_HOME_ENV] ?? '').trim()
  // Absolute-ize exactly like DSH's own resolver (home-paths): a RELATIVE
  // $DSH_HOME must not leak through, because every relative store path below
  // would then be resolved against the process cwd — the "looks like losing
  // every memory" hazard documented on `resolveStorePath`.
  if (fromEnv.length > 0) return resolve(expandHome(fromEnv, homeDir))
  return join(homeDir, DSH_HOME_DIR_NAME)
}

/**
 * Resolve a configured store path into an absolute filesystem path.
 *
 * `:memory:` passes through untouched and an absolute path is used as given. A
 * RELATIVE path resolves against `<DSH_HOME>/storages` — deliberately NOT the
 * process cwd: the plugin runs inside the Harness, whose cwd is wherever `dsh`
 * happened to be launched (a source checkout, an install directory, a temp
 * dir). A cwd-relative store therefore MOVES whenever that changes, which
 * looks exactly like losing every memory (and leaves the old file orphaned in
 * a directory that a reinstall/re-clone deletes).
 *
 * @param storePath - configured path (`:memory:`, absolute, `~`-relative, or
 *   relative to the Harness home).
 * @param env - environment to read `DSH_HOME` from (defaults to `process.env`).
 * @param homeDir - the user's home directory (defaults to `os.homedir()`).
 * @returns the absolute store path (or `:memory:`).
 */
export function resolveStorePath(
  storePath: string,
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
): string {
  if (storePath === IN_MEMORY_STORE) return storePath
  const expanded = expandHome(storePath.trim(), homeDir)
  if (isAbsolute(expanded)) return expanded
  return join(resolveDshHome(env, homeDir), STORE_DIR_NAME, expanded)
}

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
  /**
   * SQLite file path for persisted memories (`:memory:` for in-process). A
   * relative path resolves below `<DSH_HOME>/storages`, never against the
   * process cwd — see {@link resolveStorePath}.
   */
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
  const storePath = resolveStorePath(raw.storePath ?? DEFAULT_STORE_PATH)
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
  /**
   * Delegated: provider for the summarization call.
   *
   * LEAVE BOTH summarization* EMPTY (`''`) to make summarization follow the
   * session's routed model (zero-config installs; compaction-basic resolves
   * `configured ?? latest`). Pinning a provider here OVERRIDES the session
   * route — avoid unless you want to force one specific model; a dead endpoint
   * (e.g. an out-of-balance account) silently breaks every compaction.
   */
  summarizationProvider?: string
  /** Delegated: model for the summarization call. See summarizationProvider. */
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
   * Dynamic compaction threshold: lower bound of the effective trigger ratio
   * as the real window fills. The ratio slides from `thresholdRatio` down to
   * this floor once the conversation passes ~50% of the real window, so
   * compaction fires EARLY ENOUGH to leave the model enough remaining context
   * to run the summarization pass itself (which replays the compacted region).
   * With the defaults (0.8 → 0.6) the trigger lands at ~70% of the real
   * window, reserving ~30% for the compaction call. Default 0.6.
   */
  compaction_dynamic_floor?: number
  /**
   * Mid-thinking context guard: wraps the agent's LLM stream and, when the
   * request's estimated input plus output-so-far approaches the CURRENT
   * model's real context window (live probe for local / declared for online),
   * injects a `CONTEXT_WINDOW_EXCEEDED` finish so the engine compacts the
   * durable surface and the request retries with room. This is what lets the
   * plugin intervene even while the model is deep-thinking — and a takeover
   * whose input is already over the line is compacted before any output.
   * The trigger line is DYNAMIC: it fires at `window − reserve`, where the
   * reserve = system/tools + estimated summary output + margin, so the model's
   * REMAINING context is always enough to run the plugin's own compaction.
   * Default true.
   */
  thinking_guard_enabled?: boolean
  /**
   * CEILING for the mid-thinking guard, as a fraction of the real window. The
   * guard never waits past this even when the compression reserve is tiny
   * (e.g. a very large window). Default 0.9 — leaves ~10% so the injected
   * overflow lands before the adapter's own hard limit. The actual trigger is
   * usually earlier: `window − (system/tools + summary output + margin)`.
   * Range 0.5–0.99.
   */
  thinking_guard_ratio?: number
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
  /**
   * @deprecated The unified fold planner (`planFoldCompaction`) always steers
   * within the hard bounds; this key is accepted for backward compatibility
   * and has no effect. Use `compaction_governance` to switch the planner.
   */
  compress_dynamic_levels?: boolean
  /**
   * Master switch for the UNIFIED governor: one policy function
   * (planCompaction) decides lane + water levels for both the durable-region
   * and progressive-fold executors, and the two hooks obey that single
   * decision. When false, each lane keeps its own legacy trigger (the P1
   * shared curves still apply). Defaults to the OR of the two legacy dynamic
   * switches, so existing configs behave as before.
   */
  compaction_governance?: boolean
  /**
   * Hard timeout for ONE summarizer LLM call during a compaction, in ms.
   * Each attempt gets a fresh timer; after one retry the fold degrades to a
   * deterministic extractive summary instead of being abandoned. Production
   * saw the call hang until the provider's own 300s stream-idle limit while
   * the whole fold waited. 0 disables the wrapper (provider defaults apply).
   * Clamped to [15000, 300000] otherwise. Default 90000.
   */
  summarization_timeout_ms?: number
  /**
   * Whether the per-turn TASK-STATE working-memory block is injected (a small
   * carried snapshot of primary request / pending jobs / next step / critical
   * context, rebuilt from every fold's structured checkpoint). It exists
   * because similarity retrieval structurally misses open-loop state and the
   * model never calls memory_search unprompted. Costs ≈400 tokens per turn
   * out of the RAG injection budget. Default true.
   */
  task_state_enabled?: boolean
  /**
   * Whether SPECULATIVE fold summaries are precomputed in the background when
   * the surface approaches the fold trigger: the summary LLM call — the slow
   * part of a fold, up to minutes on a local model — then runs while the
   * conversation continues, and the committing fold consumes it when the
   * region fingerprint still matches (a miss falls back to the live
   * summarizer). Costs at most one extra summarizer call per ~3 minutes per
   * session when close to the trigger. Default true.
   */
  speculative_fold?: boolean
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
  /**
   * RAG retrieval: skip memories whose text is already present in the active
   * context (typically an ingested tool result that has not been compressed
   * away yet). Default true. Suppression is state-dependent: the memory is
   * injected normally once its content leaves the surface.
   */
  rag_surface_dedupe?: boolean
  /**
   * Local-model conciseness mode: when the session is routed to a LOCAL
   * (loopback/private-LAN) provider, inject one short runtime directive that
   * suppresses inter-tool narration and forces batched tool calls. Default
   * true. Injected at most once per surface — re-injected only after
   * compaction drops the previous copy.
   */
  concise_local_mode?: boolean
  /** Local-model conciseness mode: the directive text (defaults to a built-in). */
  concise_local_directive?: string
  /**
   * Tool-result archiving (exact-text CCR). Oversized tool results are copied
   * verbatim into the store and their live surface node is rewritten to a short
   * stub carrying a ref, so `memory_expand` can hand the full text back later —
   * including after the built-in (lossy) pruner or a compaction would have
   * destroyed it. Default true.
   */
  tool_archive?: boolean
  /** Tool-result archiving: code points above which a result is archived. Default 6000. */
  tool_archive_threshold_chars?: number
  /** Tool-result archiving: code points kept from the head of the stub. Default 2048. */
  tool_archive_head_chars?: number
  /** Tool-result archiving: code points kept from the tail of the stub. Default 1024. */
  tool_archive_tail_chars?: number
  /** Tool-result archiving: archived entries retained (newest win). Default 500. */
  tool_archive_max_entries?: number
  /** Tool-result archiving: days to retain an archived entry (0 disables). Default 30. */
  tool_archive_retention_days?: number
  /**
   * Absorb-style distillation of oversized tool results (see absorb.ts): the
   * recoverable stub keeps the error lines, counts, and paths instead of a
   * blind head+tail slice, and the digest is ingested as a memory. Default true.
   */
  tool_absorb?: boolean
  /** Absorb: results at or below this size are left alone. Default 4000. */
  tool_absorb_min_chars?: number
  /** Absorb: hard cap on the digest size. Default 1200. */
  tool_absorb_max_digest_chars?: number
  /**
   * Compress one step EARLY when the measured per-step growth is predicted to
   * cross the trigger water level (see shouldNudgeCompaction). Default true.
   */
  compress_nudge?: boolean
  /** Context-accounting ledger (see usage-ledger.ts). Default true. */
  usage_ledger?: boolean
  /** Ledger: days of events to keep (0 disables pruning). Default 30. */
  usage_retention_days?: number
  /**
   * Reverse compaction (see fold-archive.ts): before a compression replaces a
   * range with a summary, the exact messages are archived so `memory_expand`
   * can read them back. Turning this off makes compaction lossy. Default true.
   */
  fold_ranges?: boolean
  /** Folded-range archive: days to retain a range (0 disables age pruning). Default 30. */
  fold_range_retention_days?: number
  /** Folded-range archive: newest entries kept. Default 300. */
  fold_range_max_entries?: number
}

/** Schemastery schema for {@link MemoryCompactionConfig} (validates types only). */
export const MemoryCompactionConfigSchema: z<MemoryCompactionConfig> = z.object({
  thresholdRatio: z.number().min(0).max(1),
  retainRatio: z.number().min(0).max(1),
  retainTokens: z.number().step(1).min(0),
  // Summarization target is deliberately EMPTY ('') so the compaction backend
  // and this plugin resolve the provider/model from the SESSION's routed model
  // (`configured ?? latest`). Pinning a provider here overrides the session
  // route and silently breaks every compaction when that endpoint is down or
  // out of balance (Insufficient Balance).
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
  compaction_dynamic_floor: z.number().min(0).max(1),
  thinking_guard_enabled: z.boolean(),
  thinking_guard_ratio: z.number().min(0.5).max(0.99),
  compress_trigger_ratio: z.number().min(0).max(1),
  compress_target_ratio: z.number().min(0).max(1),
  compress_dynamic_levels: z.boolean(),
  compaction_governance: z.boolean(),
  summarization_timeout_ms: z.number().step(1).min(0),
  task_state_enabled: z.boolean(),
  speculative_fold: z.boolean(),
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
  rag_surface_dedupe: z.boolean(),
  concise_local_mode: z.boolean(),
  concise_local_directive: z.string(),
  tool_archive: z.boolean(),
  tool_archive_threshold_chars: z.number().step(1).min(100),
  tool_archive_head_chars: z.number().step(1).min(0),
  tool_archive_tail_chars: z.number().step(1).min(0),
  tool_archive_max_entries: z.number().step(1).min(1),
  tool_archive_retention_days: z.number().min(0),
  tool_absorb: z.boolean(),
  tool_absorb_min_chars: z.number().step(1).min(100),
  tool_absorb_max_digest_chars: z.number().step(1).min(100),
  compress_nudge: z.boolean(),
  usage_ledger: z.boolean(),
  usage_retention_days: z.number().min(0),
  fold_ranges: z.boolean(),
  fold_range_retention_days: z.number().min(0),
  fold_range_max_entries: z.number().step(1).min(1),
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
  'memory_expand',
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

/**
 * Code points reserved for the archive marker inside an archived stub. The
 * marker carries the ref and a short usage hint and is bounded, so this is a
 * safe upper bound used to keep `head + marker + tail` under the threshold.
 */
const ARCHIVE_MARKER_RESERVE_CHARS = 220

/**
 * Resolve the tool-result archive policy.
 * @param raw - the config from cordis.yml.
 * @returns the resolved policy with defaults applied.
 */
export function resolveToolArchiveOptions(raw: MemoryCompactionConfig): ToolArchiveOptions {
  const thresholdChars = raw.tool_archive_threshold_chars ?? DEFAULT_TOOL_ARCHIVE_OPTIONS.thresholdChars
  let headChars = raw.tool_archive_head_chars ?? DEFAULT_TOOL_ARCHIVE_OPTIONS.headChars
  let tailChars = raw.tool_archive_tail_chars ?? DEFAULT_TOOL_ARCHIVE_OPTIONS.tailChars
  // The kept head and tail must leave room for the marker, or the stub would
  // not be smaller than the original. Shrink both in proportion when a user
  // config sets budgets that cannot fit.
  const budget = Math.max(0, thresholdChars - ARCHIVE_MARKER_RESERVE_CHARS)
  if (headChars + tailChars > budget) {
    const scale = headChars + tailChars === 0 ? 0 : budget / (headChars + tailChars)
    headChars = Math.floor(headChars * scale)
    tailChars = Math.floor(tailChars * scale)
  }
  return {
    enabled: raw.tool_archive ?? DEFAULT_TOOL_ARCHIVE_OPTIONS.enabled,
    thresholdChars,
    headChars,
    tailChars,
    maxEntries: raw.tool_archive_max_entries ?? DEFAULT_TOOL_ARCHIVE_OPTIONS.maxEntries,
    retentionDays: raw.tool_archive_retention_days ?? DEFAULT_TOOL_ARCHIVE_OPTIONS.retentionDays,
  }
}

/** Code points reserved for the stub footer (ref hint + whitespace). */
const ABSORB_STUB_RESERVE_CHARS = 600

/**
 * Resolve the absorb-style distillation policy.
 *
 * The digest replaces the whole middle of a result, so it must stay well under
 * the archive threshold: a stub that is itself oversized would be rewritten by
 * the built-in pruner, which knows nothing about the ref and would destroy the
 * read-back path. The cap is therefore clamped against the threshold.
 * @param raw - the config from cordis.yml.
 * @param thresholdChars - the resolved archive threshold (see
 *   {@link resolveToolArchiveOptions}).
 * @returns the resolved policy with defaults applied.
 */
export function resolveAbsorbOptions(
  raw: MemoryCompactionConfig,
  thresholdChars: number = DEFAULT_TOOL_ARCHIVE_OPTIONS.thresholdChars,
): AbsorbOptions {
  const ceiling = Math.max(200, thresholdChars - ABSORB_STUB_RESERVE_CHARS)
  return {
    enabled: raw.tool_absorb ?? DEFAULT_ABSORB_OPTIONS.enabled,
    minChars: raw.tool_absorb_min_chars ?? DEFAULT_ABSORB_OPTIONS.minChars,
    maxDigestChars: Math.min(
      raw.tool_absorb_max_digest_chars ?? DEFAULT_ABSORB_OPTIONS.maxDigestChars,
      ceiling,
    ),
  }
}

/** Default hard timeout for ONE summarizer LLM call, in ms. */
export const DEFAULT_SUMMARIZATION_TIMEOUT_MS = 90_000
/** Smallest useful summarizer timeout; below this a hang outlives the retry. */
export const MIN_SUMMARIZATION_TIMEOUT_MS = 15_000
/** Largest summarizer timeout; the provider's own stream-idle limit is 300s. */
export const MAX_SUMMARIZATION_TIMEOUT_MS = 300_000
/**
 * Largest summarizer timeout on a LOCAL route. A llama.cpp-style server has
 * NO provider-side stream-idle limit — it streams slowly and healthily for
 * as long as the generation takes — so the 300s cloud cap was a calibration
 * error that made slow-but-healthy local summaries permanently unlearnable
 * and unusable. Still a bound (safety), just the right one.
 */
export const LOCAL_MAX_SUMMARIZATION_TIMEOUT_MS = 900_000
/**
 * Default summarizer timeout when the route points at a LOCAL server. A
 * 27B-class quantized model needs minutes, not seconds, to summarize a
 * 20k-token range: production (2026-10) showed 100% of local-session folds
 * degrading to the extractive fallback at the cloud default of 90s. The
 * explicit-config clamp (≤ 300s) still applies.
 */
export const LOCAL_SUMMARIZATION_TIMEOUT_MS = 240_000

/**
 * Resolve `summarization_timeout_ms`. 0 disables the resilience wrapper (the
 * provider's own defaults then bound the call); any other value is clamped
 * into {@link MIN_SUMMARIZATION_TIMEOUT_MS}..{@link MAX_SUMMARIZATION_TIMEOUT_MS}.
 * When the key is UNSET the default depends on the route's locality: local
 * summarizers get {@link LOCAL_SUMMARIZATION_TIMEOUT_MS} (they are slow, not
 * hung), cloud summarizers keep the tight 90s (they hang, not dawdle).
 * Non-finite input takes the default rather than producing a broken timer.
 * @param raw - the config from cordis.yml.
 * @param isLocal - whether the resolved summarizer route points at a local
 *   server; only consulted for the unset default.
 * @returns the resolved timeout in ms (0 = disabled).
 */
export function resolveSummarizationTimeoutMs(raw: MemoryCompactionConfig, isLocal = false): number {
  const value = raw.summarization_timeout_ms
  if (value === undefined || !Number.isFinite(value)) {
    return isLocal ? LOCAL_SUMMARIZATION_TIMEOUT_MS : DEFAULT_SUMMARIZATION_TIMEOUT_MS
  }
  if (value <= 0) return 0
  return Math.min(
    MAX_SUMMARIZATION_TIMEOUT_MS,
    Math.max(MIN_SUMMARIZATION_TIMEOUT_MS, Math.floor(value)),
  )
}

/**
 * Scale a summarizer deadline by the INPUT size: a fixed deadline treats a
 * 3k-token range and a 25k-token range identically, but generation time is
 * dominated by output and a big input shifts where the model spends its
 * budget. The base deadline is the FLOOR; each 40k tokens of input above the
 * first 4k adds 50%, capped at `maxMs`.
 *
 * This is the COLD-START estimator only: once a route has observed
 * summarizer latencies, the learned per-route EMA (see the engine's
 * summarizer resilience) takes over and this function falls back to being
 * the no-data default. Constants bootstrap; measurements decide.
 * @param baseMs - the locality default (cloud 90s / local 240s), or an
 *   explicit config value.
 * @param inputTokens - the summarizer input size.
 * @param maxMs - the locality hard cap (cloud 300s — the provider's own
 *   stream-idle limit; local 900s — no provider idle limit exists on a
 *   llama.cpp-style server, and the cap itself was a calibration error that
 *   made slow-but-healthy local summaries unlearnable).
 * @returns the scaled deadline, still within the locality hard max.
 */
export function scaleSummarizationTimeoutMs(baseMs: number, inputTokens: number, maxMs: number = MAX_SUMMARIZATION_TIMEOUT_MS): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return baseMs
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return baseMs
  const extra = Math.max(0, Math.floor((inputTokens - 4_000) / 40_000)) * 0.5
  return Math.min(maxMs, Math.floor(baseMs * (1 + extra)))
}

/**
 * Combine the cold-start estimate and the LEARNED route latency into the
 * effective deadline. The rule is MONOTONIC in both directions: the learned
 * value refines the estimate upward when the route is slower than the prior
 * assumed, and can never TIGHTEN the deadline below it when the route is
 * faster — production (2026-10-30) had a local route learn ~108s and drop
 * the deadline to 135s, BELOW the 240s cold start, re-degrading a fold whose
 * summary ran slower than the EMA sample.
 * @param baseMs - the cold-start estimate (locality default scaled by input).
 * @param learnedMs - the route's latency EMA, or `undefined` when it has no
 *   successful summary yet.
 * @param minMs - floor for the learned path.
 * @param maxMs - hard cap for both paths.
 * @returns the effective deadline in ms.
 */
export function deadlineFrom(baseMs: number, learnedMs: number | undefined, minMs: number, maxMs: number): number {
  const clamp = (ms: number): number => Math.min(maxMs, Math.max(minMs, Math.floor(ms)))
  // Garbage inputs fail FAST (minMs) rather than blocking the turn or
  // producing a NaN deadline (a NaN setTimeout fires immediately and would
  // kill the attempt for nothing). Garbage LEARNED values ignore the EMA and
  // fall back to the cold-start estimate.
  if (!Number.isFinite(baseMs)) return minMs
  if (learnedMs === undefined) return clamp(baseMs)
  if (!Number.isFinite(learnedMs) || learnedMs <= 0) return clamp(baseMs)
  // max(base, learned x 1.25): the EMA refines upward; never tightens.
  return clamp(Math.max(baseMs, learnedMs * 1.25))
}

/**
 * Resolve the task-state working-memory toggle (default on).
 * @param raw - the config from cordis.yml.
 * @returns whether the per-turn task-state block should be injected.
 */
export function resolveTaskStateEnabled(raw: MemoryCompactionConfig): boolean {
  return raw.task_state_enabled ?? true
}

/**
 * Whether the operator EXPLICITLY pinned a summarizer timeout. The shipped
 * default (90000) is not "explicit" — it is the cold-start prior the learned
 * per-route latency is allowed to refine. Any other finite positive value is
 * an operator decision and pins the deadline (learning stands down); `0`
 * disables the wrapper entirely and is likewise not a learning signal.
 * @param raw - the config from cordis.yml.
 * @returns true when learning must not override the configured deadline.
 */
export function isSummarizationTimeoutExplicit(raw: MemoryCompactionConfig): boolean {
  const value = raw.summarization_timeout_ms
  return value !== undefined
    && Number.isFinite(value)
    && value > 0
    && value !== DEFAULT_SUMMARIZATION_TIMEOUT_MS
}

/**
 * Resolve the speculative fold-summary toggle (default on).
 * @param raw - the config from cordis.yml.
 * @returns whether background precomputation of fold summaries is enabled.
 */
export function resolveSpeculativeFold(raw: MemoryCompactionConfig): boolean {
  return raw.speculative_fold ?? true
}

/**
 * Resolve the context-accounting ledger policy.
 * @param raw - the config from cordis.yml.
 * @returns the resolved policy with defaults applied.
 */
/**
 * Resolve the folded-range (reverse-compaction) archive policy.
 * @param raw - the config from cordis.yml.
 * @returns the resolved policy with defaults applied.
 */
export function resolveFoldOptions(raw: MemoryCompactionConfig): FoldOptions {
  return {
    enabled: raw.fold_ranges ?? DEFAULT_FOLD_OPTIONS.enabled,
    retentionDays: raw.fold_range_retention_days ?? DEFAULT_FOLD_OPTIONS.retentionDays,
    maxEntries: raw.fold_range_max_entries ?? DEFAULT_FOLD_OPTIONS.maxEntries,
  }
}

export function resolveUsageOptions(raw: MemoryCompactionConfig): UsageOptions {
  return {
    enabled: raw.usage_ledger ?? DEFAULT_USAGE_OPTIONS.enabled,
    retentionDays: raw.usage_retention_days ?? DEFAULT_USAGE_OPTIONS.retentionDays,
  }
}
