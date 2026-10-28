/**
 * The `memory-compaction` Cordis entry: a compaction backend that also feeds
 * the persistent multi-tier memory system.
 *
 * Extends {@link BasicCompactionEngine} to reuse the battle-tested surface
 * replacement, token-pressure metering, and LLM summarization, and adds:
 *   1. Every compaction summary is persisted as a `mid` memory.
 *   2. After persisting, the memory pyramid is consolidated and low-value
 *      memories are forgotten (via `ctx.memoryContext`).
 *   3. On each new turn, the most relevant memories are retrieved for the
 *      latest user message and spliced into the request as background.
 *   4. Surface folding: a due fold rewrites the session surface through
 *      compaction-basic's `compactRegion` (never the pre-step message delta).
 *   5. Output sanitization: tool results are cleaned before entering the
 *      vector memory (the live tool result still reaches the current turn's
 *      context as-is — tools/result is a post-hoc event and cannot rewrite it).
 *   6. Fallback truncation: if still over budget, oldest messages are dropped.
 *
 * @module dsh-infinite-context/memory-compaction
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig, ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { BlockAssembler, LlmError, contentHasImage, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  TokenUsage,
  ToolSchema,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: brings the `ctx.tokenMeter` service declaration into scope.
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * compaction-basic 0.2.0 起对 BasicCompactionConfig 做「拒绝未知键」的严格校验
 * （validateKeys），而插件自有键经 rest-spread 全量进入 basicConfig，新加插件键
 * （如 fold_ranges）会直接导致插件加载失败。构造引擎前按 0.2.0 的公开键集做
 * 白名单转发：插件键静默留在插件侧，运行时不认识的键也不会再炸。
 */
const BASIC_COMPACT_PUBLIC_KEYS: ReadonlySet<string> = new Set([
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
])

function pickBasicCompactionKeys(raw: Record<string, unknown>): BasicCompactionConfig {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (BASIC_COMPACT_PUBLIC_KEYS.has(key)) out[key] = value
  }
  return out as BasicCompactionConfig
}

import {
  DEFAULT_INGEST_DENYLIST,
  MemoryCompactionConfigSchema,
  resolveAbsorbOptions,
  resolveFoldOptions,
  resolveRetrievalOptions,
  resolveSummarizationTimeoutMs,
  resolveSpeculativeFold,
  resolveTaskStateEnabled,
  scaleSummarizationTimeoutMs,
  resolveToolArchiveOptions,
  resolveUsageOptions,
  type MemoryCompactionConfig,
  type ResolvedRetrievalOptions,
} from './config.ts'
import { extractiveSummary, stripExtractiveHeader, summarizeWithResilience } from './extractive-summary.ts'
import { cosineSimilarity, fnv1a } from './embedder.ts'
import { buildTaskStateBlock } from './task-state.ts'
import { ToolResultArchive, textOfBlocks } from './tool-archive.ts'
import { foldedRangeHeader, type FoldOptions } from './fold-archive.ts'
import { USAGE_KIND, UsageLedger, usageAttribution } from './usage-ledger.ts'
import { estimateContentTokens, estimateTokens } from './token-budget.ts'
import { registerThinkingGuard } from './thinking-guard.ts'
import {
  GOV_GUARD_RESERVE_MIN,
  GOV_MIN_NET_SAVING_RATIO,
  GOV_GUARD_RESERVE_RATIO,
  GOV_TRIGGER_CEILING,
  failureCooldownFor,
  foldPressureBudget,
  GOV_IMPORTANCE_KEEP_COS,
  isThinFold,
  ledgerView,
  minimumFoldTokens,
  nextTargetDeviationEma,
  summaryCharBudget,
  planFoldCompaction,
  toSurfaceSnapshot,
  type CompactionPlan,
  type GovernanceLedger,
  type SurfaceSnapshot,
} from './compaction-governance.ts'
import {
  analyzeContext,
  type CompactionIntent,
  type SurfaceSignal,
} from './compaction-intelligence.ts'
import {
  COMPRESS_FAILURE_COOLDOWN,
  SUMMARY_OUTPUT_SHARE,
  decidePressureCompaction,
  firstFoldableIndex,
  retainedTailStart,
  nextGrowthEma,
} from './compaction-policy.ts'
import { sanitizeToolResult, type SanitizerConfig } from './OutputSanitizer.ts'
import { VectorRetriever, type VectorRetrieverConfig } from './VectorRetriever.ts'
import {
  evaluateOpportunity,
  type CompactionOpportunity,
} from './compaction-opportunity.ts'
import {
  DEFAULT_CONCISE_DIRECTIVE,
  createConciseMessage,
  hasConciseDirective,
} from './conciseness-mode.ts'
import {
  resolveSummarizationTarget,
  routedTargetOf,
  type SummarizationTarget,
} from './summarization-target.ts'

/* -------------------------------------------------------------------------- */
/*  Summarization types (structural mirrors from dsh-compaction-basic)        */
/* -------------------------------------------------------------------------- */

/**
 * The branded seq type {@link Session.eventAt} accepts. The runtime-installed
 * dsh-session package does not export the `SessionSeq` brander, so this is
 * derived from the API surface itself — at runtime it is a plain number.
 */
type SessionSeqOf = Parameters<Session['eventAt']>[0]

interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}
type SummaryResult = {
  readonly summary: ContentBlock[]
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly usage?: TokenUsage
}

/** The plugin label stamped on synthesized messages for provenance. */
const PLUGIN = 'dsh-infinite-context'

/**
 * Minimum delay between two FORCED narrowed-window pressure compactions of the
 * same session. Prevents a summary that barely shrank the surface from
 * triggering a summarization storm on the following steps; the next force is
 * simply deferred, and provider overflow recovery remains the backstop.
 */
const FORCED_PRESSURE_COOLDOWN_MS = 10_000

/**
 * Share of the session's model window the per-turn RAG injection may occupy.
 * The configured `rag_token_budget` stays the ceiling; on short-window local
 * models the injection is additionally capped at this share so retrieved
 * memories cannot crowd out the conversation itself ("续杯" headroom).
 */
const RAG_WINDOW_SHARE = 0.08

/* -------------------------------------------------------------------------- */
/*  Message / text helpers                                                     */
/* -------------------------------------------------------------------------- */

/** Concatenate the text blocks of a message. */
function messageText(message: { role: string; content: unknown }): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('\n')
  }
  return ''
}

/**
 * The folded messages proper: a SummarizationInput leads with the summarizer's
 * own system prompt, which is NOT part of the archived range. Both the
 * degradation fallback and the post-processing digest strip it, and they must
 * agree — a change to the system-message convention happens here once.
 */
function shadowedMessages(input: SummarizationInput): readonly Message[] {
  return input.messages[0]?.role === 'system' ? input.messages.slice(1) : input.messages
}

/** Whether an unknown entry is a content block carrying text. */
function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string'
}

/**
 * Render a sanitized payload to the text stored in memory: strings as-is,
 * content-block arrays as their joined text (no JSON structure noise),
 * anything else as JSON.
 */
function sanitizedPayloadText(sanitized: unknown): string {
  if (typeof sanitized === 'string') return sanitized
  if (Array.isArray(sanitized)) {
    return sanitized.filter(isTextBlock).map(block => block.text).join('\n').trim()
  }
  return JSON.stringify(sanitized)
}

/**
 * Fixed token cost charged per image block by the heuristic meter. The real
 * cost varies with resolution; this conservative constant keeps image-heavy
 * sessions from being systematically under-measured (which used to delay
 * compression until compaction-basic's overflow recovery had to step in).
 * The definition lives in `token-budget.ts` (IMAGE_BLOCK_TOKEN_COST /
 * estimateContentTokens) and is shared with the thinking guard.
 */

/** Map a terminal summarization finish to a fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('memory consolidation truncated at the token cap (incomplete summary)')
    default:
      return undefined
  }
}

/** Serialize messages to readable text for the summarization prompt. */
function serializeMessagesForSummary(messages: readonly { role: string; content: unknown }[]): string {
  const MAX_CHARS_PER_MESSAGE = 16_000
  return messages.map((msg, i) => {
    const text = messageText(msg)
    const hasImage = Array.isArray(msg.content)
      && msg.content.some(block => block.type === 'image')
    const marker = hasImage ? ' (contains image)' : ''
    const body = text.length > MAX_CHARS_PER_MESSAGE
      ? `${text.slice(0, MAX_CHARS_PER_MESSAGE)}\n…[truncated: ${text.length - MAX_CHARS_PER_MESSAGE} more chars]`
      : text
    return `[${i}] ${msg.role}${marker}: ${body}`
  }).join('\n')
}

/**
 * Compute a target output-token budget for a summarization prompt.
 *
 * The model is told to aim for roughly 30% of the input size (dense
 * compression), clamped to a safety margin below `maxTokens` so the
 * summary is never cut off mid-record by the output cap.
 */
function summarizationTargetTokens(config: ResolvedConfig, inputTokens: number): number {
  const cap = Math.max(400, Math.floor((config.maxTokens ?? 4096) * 0.7))
  return Math.min(cap, Math.max(300, Math.floor(inputTokens * SUMMARY_OUTPUT_SHARE)))
}

/** Summarize several memories into one higher-level memory via the LLM. */
async function summarizeMemoriesWithLlm(
  ctx: Context,
  config: ResolvedConfig,
  texts: readonly string[],
  purpose: string,
  target?: SummarizationTarget,
  signal?: AbortSignal,
): Promise<string> {
  const resolved = target ?? resolveSummarizationTarget(config)
  if (resolved === undefined) {
    throw new Error(
      'memory pyramid consolidation requires summarizationProvider/Model configured '
      + 'or a session-routed model',
    )
  }
  const { provider, model } = resolved
  const textsJoined = texts.join('\n')
  const inputTokens = estimateTokens(textsJoined)
  const targetTokens = summarizationTargetTokens(config, inputTokens)
  const instruction = [
    purpose,
    '',
    'Rules:',
    '- PRESERVE verbatim: code snippets, file paths, function names, config values, decisions, goals, and open questions',
    '- DROP stale or redundant detail that is no longer actionable',
    '- De-duplicate facts that appear in multiple memories',
    '- PRESERVE the original language of each memory — do NOT translate',
    '- NEVER invent facts that are not present in the memories',
    '- Keep the summary self-contained: it must make sense without the source memories',
    '',
    `Output budget: the input is ~${inputTokens} tokens. Aim for ~${targetTokens} tokens of`,
    'output (a dense ~30% compression). Stay well under this; do not pad or repeat.',
    '',
    ...texts.map((text, index) => `--- Memory ${index + 1} ---\n${text}`),
  ].join('\n')
  const assembler = new BlockAssembler()
  const messages: Message[] = [
    createUserMessage({
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'plugin:' + PLUGIN } as any,
    }),
  ]
  const options: GenerateOptions = {
    provider,
    model,
    messages,
    maxTokens: config.maxTokens,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  if (contentHasImage(assembler.blocks())) {
    throw new LlmError('memory consolidation cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  const text = assembler.blocks()
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text.length === 0) throw new Error('memory consolidation produced no text content')
  return text
}

/* -------------------------------------------------------------------------- */
/*  HistoryCompressor                                                          */
/*  Strategy 1: per-session turn counter + LLM-based summarization            */
/*  Recursion lock prevents summarization from re-triggering governance.       */
/* -------------------------------------------------------------------------- */

/** Per-session turn counter entry. */
interface SessionCounter {
  turn: number
  lastActive: number
  /** Turn number of the last successful compression (undefined = never). */
  lastCompressedTurn?: number
  /** Estimated tokens observed at the previous check (for surge detection). */
  lastTokens?: number
  /** Smoothed per-step surface growth (tokens), for the early-compression nudge. */
  growthEma?: number
  /** Estimated tokens of the surface at the previous check (growth baseline). */
  lastSizeTokens?: number
  /** Successful history compressions so far (stage signal for dynamic levels). */
  compressions?: number
  /**
   * Epoch ms of the last FORCED narrowed-window pressure compaction. Lives in
   * the session ledger (not a separate map) so it is persisted and garbage-
   * collected with the rest of the session state.
   */
  lastForceAt?: number
  /** Epoch ms of the last successful fold (frequency gate). */
  lastCompressedAt?: number
  /**
   * Signed EMA of `post-fold landing − planned target`, in tokens. Feeds the
   * closed-loop target band: folds land above the plan (summary overhead +
   * unfoldable tail), and the learned shortfall widens the next band. Lives in
   * the session ledger so it is persisted and garbage-collected with it.
   */
  targetDeviationEma?: number
  /**
   * The working-memory task-state block carried from the last fold (bounded
   * by TASK_STATE_MAX_CHARS). Injected fresh every turn via the pre-step
   * splice; learned state that cannot be re-derived from the surface once the
   * folded range is gone, so it persists with the session ledger.
   */
  taskState?: string
  /** Remaining rounds to wait after a failed (non-shrinking) compression. */
  failureCooldown: number
}

/** Persistent KV interface (backed by the SQLite plugin_kv table). */
export interface PersistentKV {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  /**
   * Delete prefixed keys whose last write is older than `cutoffMs`.
   * Optional so lightweight test doubles need not implement retention.
   */
  deleteOlderThan?(prefix: string, cutoffMs: number): number
}

/**
 * HistoryCompressor: proactively compresses old conversation history every N
 * rounds (configurable) by summarizing via the LLM.
 *
 * Key safety features:
 *   - Turn counter persisted per session (in-memory Map; survives within a
 *     process but resets on restart — acceptable since compression is
 *     idempotent and will simply re-trigger on the next interval).
 *
 * @module HistoryCompressor
 */
/**
 * Choose the oldest SURFACE span to fold.
 *
 * The fold runs as a surface rewrite (compaction-basic's `compactRegion`), not
 * as a pre-step message rewrite: `agent/pre-step` only carries the step's inbox
 * delta, so a fold there could never see history (and would drop the step's real
 * messages). The range mirrors compaction-basic's own selector and adds the two
 * billion-context pins: never fold the system head, never fold the first user
 * message (#2733 — the summary must not precede it).
 * @param session - session whose surface is folded.
 * @param measurement - current meter reading (nodes must match the surface).
 * @param retainTokens - tail budget kept verbatim.
 * @returns the inclusive seq range, or null when nothing safe is foldable.
 * @throws when the meter's node list no longer matches the session surface.
 */
export function selectFoldRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
  importanceKeep?: ReadonlySet<SessionSeq>,
): { start: SessionSeq; end: SessionSeq } | null {
  const priced = measurement.nodes
  if (priced.length === 0) return null
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== priced.length
    || surfaceNodes.some((seq, index) => seq !== priced[index]?.seq)) {
    throw new Error('fold: token-meter surface does not match the current session surface')
  }
  const types = surfaceNodes.map(seq => session.eventAt(seq)?.type ?? '')
  const firstIdx = firstFoldableIndex(types)
  let keepFromIdx = retainedTailStart(priced.map(node => node.tokens), retainTokens)
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx) {
    const seq = surfaceNodes[keepFromIdx]
    if (seq === undefined || toolPairingBalancedBefore(session, seq)) break
    keepFromIdx -= 1
  }
  // High-value cut boundary: a user message immediately BEFORE the cut would
  // be folded while the model's response to it stays verbatim — context
  // inversion. Extend the kept tail over trailing user messages, and over
  // nodes the goal-conditioned importance pass marked on-topic
  // (`importanceKeep`), bounded (≤3 messages, ≤15% of the retained budget)
  // so the target cannot balloon; the digest preserves their words, this
  // preserves their ADJACENCY.
  const boundaryBudget = Math.floor(retainTokens * 0.15)
  let walked = 0
  let walkedTokens = 0
  while (keepFromIdx > firstIdx && walked < 3) {
    const node = priced[keepFromIdx - 1]
    if (node === undefined) break
    const isUser = types[keepFromIdx - 1] === 'user/message'
    const boundarySeq = surfaceNodes[keepFromIdx - 1]
    const isImportant = boundarySeq !== undefined && importanceKeep?.has(boundarySeq) === true
    if (!isUser && !isImportant) break
    if (walkedTokens + node.tokens > boundaryBudget) break
    walkedTokens += node.tokens
    walked += 1
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  const start = surfaceNodes[firstIdx]
  const end = surfaceNodes[keepFromIdx - 1]
  return start === undefined || end === undefined ? null : { start, end }
}

/** In-memory session counters idle this long are evicted (RAM only). */
/** Minimum wall-clock gap between routine folds (force/fit-guard bypass). */
const MIN_FOLD_INTERVAL_MS = 20 * 60_000
/** Speculation launches when the surface is at least this share of the trigger. */
const SPECULATIVE_AHEAD_RATIO = 0.8
/** Minimum wall-clock gap between two speculative launches for one session. */
const SPECULATIVE_MIN_INTERVAL_MS = 3 * 60_000
const SESSION_COUNTER_IDLE_MS = 3600_000
/** Persisted session counters are retained this long across idle gaps. */
const SESSION_COUNTER_RETENTION_MS = 30 * 24 * 3600_000
/** Persisted-retention sweep is throttled to this cadence. */
const SESSION_KV_PRUNE_INTERVAL_MS = 3600_000

export class HistoryCompressor {
  // Persisted to the SQLite KV table (via `kv`) so the turn counters survive
  // process restarts — without persistence a DSH restart reset the counters to
  // zero and triggered an immediate, unnecessary compression on the next turn.
  private readonly turnCounters = new Map<string, SessionCounter>()

  /** Optional persistent KV backing (survives restarts); null disables persistence. */
  /** When the persisted-counter retention sweep last ran (epoch ms). */
  private lastKvPruneAt = 0
  private readonly kv: PersistentKV | null

  private readonly ctx: Context
  private readonly config: ResolvedConfig

  /** Interval (in rounds) between compressions. */
  readonly compressInterval: number
  /** Maximum messages to keep uncompressed (the "recent tail"). */
  readonly retainRecent: number
  /** Trigger when context exceeds this fraction of the token budget. */
  readonly triggerRatio: number
  /** Target water level (fraction of budget) after compression. */
  readonly targetRatio: number
  /**
   * Reserved tokens for the plugin's own per-turn context footprint (the RAG
   * injection spliced in AFTER the compression check). Subtracted from the
   * trigger/target water levels so compression fires before the REAL request
   * — conversation + plugin overhead — overflows the model window.
   */
  readonly injectionBudget: number
  /**
   * Whether the compressor may fire EARLY — before the trigger is crossed —
   * when the smoothed surface growth says the next step would cross it anyway.
   */
  readonly nudge: boolean

  constructor(
    ctx: Context,
    config: ResolvedConfig,
    compressInterval: number,
    retainRecent: number,
    triggerRatio = 0.85,
    targetRatio = 0.6,
    injectionBudget = 0,
    kv: PersistentKV | null = null,
    nudge = false,
  ) {
    this.ctx = ctx
    this.config = config
    this.compressInterval = compressInterval
    this.retainRecent = retainRecent
    this.triggerRatio = triggerRatio
    this.targetRatio = targetRatio
    this.injectionBudget = injectionBudget
    this.kv = kv
    this.nudge = nudge
    this.loadPersistedCounters()
  }

  /** KV prefix shared by every per-session compression counter. */
  private static readonly KV_PREFIX = 'compression:'

  /** KV key under which a session's counter is persisted. */
  private static kvKey(sessionId: string): string {
    return HistoryCompressor.KV_PREFIX + sessionId
  }

  /** Restore persisted counters for all sessions after a restart. */
  private loadPersistedCounters(): void {
    if (this.kv === null) return
    // Enumerate by prefix is not supported by the flat KV API; the entries are
    // loaded lazily per session on first touch instead (see touchSession).
  }

  /**
   * Persist one session's counter. Best-effort: a KV failure must never break
   * the agent loop, so it is swallowed here (the in-memory copy still works).
   */
  private persistCounter(sessionId: string): void {
    if (this.kv === null) return
    const entry = this.turnCounters.get(sessionId)
    if (entry === undefined) {
      this.kv.delete(HistoryCompressor.kvKey(sessionId))
      return
    }
    try {
      this.kv.set(HistoryCompressor.kvKey(sessionId), JSON.stringify(entry))
    } catch {
      // best-effort persistence; the in-memory map remains authoritative
    }
  }

  /**
   * The effective token budget: context window minus headroom.
   * @param windowOverride - the session's effective model window when the
   *   caller resolved one for the routed model; defaults to the globally
   *   adopted window (which may belong to a different model).
   */
  tokenBudget(windowOverride?: number): number {
    const window = windowOverride ?? this.ctx.memoryContext.contextWindow
    const headroom = this.ctx.memoryContext.headroomRatio ?? 0.25
    return Math.floor(window * (1 - headroom))
  }

  /**
   * Check if summarization config is available.
   */
  available(): boolean {
    return this.config.summarizationProvider.length > 0
      && this.config.summarizationModel.length > 0
  }

  /**
   * Increment the turn counter for a session and return the entry.
   * Initializes to 0 if the session has never been seen. Restores a
   * persisted counter across restarts so the round interval survives.
   */
  private touchSession(sessionId: string): SessionCounter {
    let entry = this.turnCounters.get(sessionId)
    if (entry === undefined) {
      entry = this.restoreCounter(sessionId)
      this.turnCounters.set(sessionId, entry)
    }
    entry.turn++
    entry.lastActive = Date.now()
    this.persistCounter(sessionId)
    return entry
  }

  /** Restore a session's persisted counter (or create a fresh one). */
  private restoreCounter(sessionId: string): SessionCounter {
    if (this.kv !== null) {
      try {
        const raw = this.kv.get(HistoryCompressor.kvKey(sessionId))
        if (raw !== undefined) {
          const parsed = JSON.parse(raw) as Partial<SessionCounter> | null
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.turn === 'number') {
            const restored: SessionCounter = {
              turn: parsed.turn,
              lastActive: Date.now(),
              ...(typeof parsed.lastCompressedTurn === 'number'
                ? { lastCompressedTurn: parsed.lastCompressedTurn } : {}),
              ...(typeof parsed.lastTokens === 'number' ? { lastTokens: parsed.lastTokens } : {}),
              ...(typeof parsed.compressions === 'number' ? { compressions: parsed.compressions } : {}),
              ...(typeof parsed.lastForceAt === 'number' ? { lastForceAt: parsed.lastForceAt } : {}),
              ...(typeof parsed.lastCompressedAt === 'number' ? { lastCompressedAt: parsed.lastCompressedAt } : {}),
              // Learned state that CANNOT be re-derived from the surface
              // (unlike growthEma/lastSizeTokens, which are deliberately
              // re-seeded from live measurement): dropping it here would
              // restart the closed-loop band from zero on every restart or
              // idle eviction.
              ...(typeof parsed.targetDeviationEma === 'number'
                ? { targetDeviationEma: parsed.targetDeviationEma } : {}),
              // Same rationale as the EMA: learned/carried state that cannot
              // be re-derived from the surface after the fold is gone.
              ...(typeof parsed.taskState === 'string' ? { taskState: parsed.taskState } : {}),
              failureCooldown: typeof parsed.failureCooldown === 'number' ? parsed.failureCooldown : 0,
            }
            return restored
          }
        }
      } catch {
        // corrupt entry — fall through to a fresh counter
      }
    }
    return { turn: 0, lastActive: Date.now(), failureCooldown: 0 }
  }

  /**
   * Estimate total tokens across a message array using the CJK-aware heuristic.
   * Public so the engine can build the unified SurfaceSnapshot on the SAME
   * basis the fold executor uses (before/after must not mix meters).
   */
  estimateMessageTokens(messages: readonly { role: string; content: unknown }[]): number {
    let total = 0
    for (const msg of messages) {
      total += estimateContentTokens(msg.content)
    }
    return total
  }

  /**
   * Read-only ledger view for the unified planner. `turn` is the UPCOMING turn
   * (this step) that the fold planner evaluates; beginFoldCheck() advances it.
   * @param sessionId - the session to read.
   * @param surfaceTokens - current surface estimate; omit to keep the stored EMA.
   * @returns the planner's per-session state (never throws).
   */
  ledgerOf(sessionId: string, surfaceTokens?: number): GovernanceLedger {
    let entry = this.turnCounters.get(sessionId)
    if (entry === undefined) {
      entry = this.restoreCounter(sessionId)
      this.turnCounters.set(sessionId, entry)
    }
    return ledgerView(entry, surfaceTokens)
  }

  /**
   * Advance the fold-lane turn for one session and return the planner's view.
   *
   * The fold lane no longer runs `compress()`, so this is what keeps the
   * rate-limit/stage/growth state moving: it increments the turn, folds the
   * current surface into the growth EMA, and persists the entry. Without it the
   * planner would see a frozen turn and re-fold on every step.
   * @param sessionId - the session being checked.
   * @param surfaceTokens - current surface estimate (meter basis).
   * @returns the planner's ledger for THIS turn.
   */
  beginFoldCheck(sessionId: string, surfaceTokens: number): GovernanceLedger {
    const entry = this.touchSession(sessionId)
    // Count the cooldown down on every fold check so a transient failure
    // cannot disable the lane for the rest of the session.
    if (entry.failureCooldown > 0) entry.failureCooldown -= 1
    const delta = entry.lastSizeTokens === undefined ? 0 : surfaceTokens - entry.lastSizeTokens
    entry.growthEma = nextGrowthEma(entry.growthEma, delta)
    entry.lastSizeTokens = surfaceTokens
    this.persistCounter(sessionId)
    return {
      turn: entry.turn,
      ...(entry.lastCompressedTurn === undefined ? {} : { lastCompressedTurn: entry.lastCompressedTurn }),
      ...(entry.lastTokens === undefined ? {} : { lastTokens: entry.lastTokens }),
      failureCooldown: entry.failureCooldown,
      compressions: entry.compressions ?? 0,
      growthTokens: entry.growthEma ?? 0,
    }
  }

  /**
   * Record a successful fold: stamp lastCompressedTurn/lastTokens, reset the
   * growth delta and failure cooldown, and bump the maturity counter.
   * @param sessionId - the folded session.
   * @param beforeTokens - surface size before the fold.
   */
  /**
   * Epoch ms of the session's last successful fold.
   * @param sessionId - the session to query.
   * @returns the timestamp, or undefined when the session never folded.
   */
  lastFoldAt(sessionId: string): number | undefined {
    return this.turnCounters.get(sessionId)?.lastCompressedAt
  }

  recordFold(sessionId: string, beforeTokens: number): void {
    const entry = this.turnCounters.get(sessionId)
    if (entry === undefined) return
    entry.lastCompressedTurn = entry.turn
    entry.lastTokens = beforeTokens
    entry.lastSizeTokens = beforeTokens
    entry.growthEma = 0
    entry.compressions = (entry.compressions ?? 0) + 1
    entry.lastCompressedAt = Date.now()
    entry.failureCooldown = 0
    this.persistCounter(sessionId)
  }

  /**
   * Record a failed fold so the planner backs off instead of retrying every step.
   * @param sessionId - the session whose fold failed.
   */
  recordFoldFailure(sessionId: string, error?: unknown): void {
    const entry = this.turnCounters.get(sessionId)
    if (entry === undefined) return
    const message = error instanceof Error ? error.message : String(error ?? '')
    entry.failureCooldown = failureCooldownFor(entry.failureCooldown, message, COMPRESS_FAILURE_COOLDOWN)
    this.persistCounter(sessionId)
  }

  /**
   * The session's learned landing-deviation EMA, in tokens. `undefined` means
   * no fold has landed yet, so no closed-loop correction applies. Restores the
   * persisted counter lazily (same as {@link ledgerOf}) so a restart or idle
   * eviction does not read as "never folded".
   * @param sessionId - the session to query.
   */
  targetDeviationOf(sessionId: string): number | undefined {
    let entry = this.turnCounters.get(sessionId)
    if (entry === undefined) {
      entry = this.restoreCounter(sessionId)
      this.turnCounters.set(sessionId, entry)
    }
    return entry.targetDeviationEma
  }

  /**
   * The session's carried task-state block (see src/task-state.ts), or
   * `undefined` when no fold has committed one yet. Restores the persisted
   * counter lazily so a restart or idle eviction does not read as "never".
   * @param sessionId - the session to query.
   */
  taskStateOf(sessionId: string): string | undefined {
    let entry = this.turnCounters.get(sessionId)
    if (entry === undefined) {
      entry = this.restoreCounter(sessionId)
      this.turnCounters.set(sessionId, entry)
    }
    return entry.taskState
  }

  /**
   * Store the task-state block built from a committed fold, persisting it
   * with the rest of the session state.
   * @param sessionId - the session that just committed a fold.
   * @param block - the new block (bounded by TASK_STATE_MAX_CHARS).
   */
  recordTaskState(sessionId: string, block: string): void {
    const entry = this.turnCounters.get(sessionId)
    if (entry === undefined) return
    entry.taskState = block
    this.persistCounter(sessionId)
  }

  /**
   * Fold one landing observation into the per-session deviation EMA (signed:
   * `landing − target`), persisting it with the rest of the session state.
   * @param sessionId - the session that just committed a fold.
   * @param landingDelta - `post-fold landing − planned target`, in tokens on
   * the meter's surface basis.
   * @returns the updated EMA (for diagnostics; 0 for an unknown session).
   */
  recordFoldLanding(sessionId: string, landingDelta: number): number {
    const entry = this.turnCounters.get(sessionId)
    if (entry === undefined) return 0
    entry.targetDeviationEma = nextTargetDeviationEma(entry.targetDeviationEma, landingDelta)
    this.persistCounter(sessionId)
    return entry.targetDeviationEma
  }

  /** KV key of one summarizer route's cross-session deviation prior. */
  private static deviationPriorKey(route: string): string {
    return HistoryCompressor.KV_PREFIX + 'deviation-prior:' + route
  }

  /**
   * The converged deviation EMA of this summarizer route's most recent
   * session — the warm-start prior for a fresh session's first folds.
   * @param route - the summarizer route (`provider/model`).
   */
  deviationPriorOf(route: string): number | undefined {
    if (this.kv === null) return undefined
    try {
      const raw = this.kv.get(HistoryCompressor.deviationPriorKey(route))
      if (raw === undefined) return undefined
      const parsed = JSON.parse(raw) as { ema?: unknown }
      return typeof parsed.ema === 'number' && Number.isFinite(parsed.ema) ? parsed.ema : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Publish the route's deviation prior after a routine landing. Degraded
   * (extractive) folds skip: their overhead shape differs and would poison
   * the warm start.
   * @param route - the summarizer route (`provider/model`).
   * @param ema - the session's current EMA.
   */
  recordDeviationPrior(route: string, ema: number): void {
    if (this.kv === null || !Number.isFinite(ema)) return
    try {
      this.kv.set(HistoryCompressor.deviationPriorKey(route), JSON.stringify({ ema: Math.round(ema) }))
    } catch {
      // best-effort persistence; the in-memory session EMA remains authoritative
    }
  }

  /**
   * Warm-start a never-folded session's deviation EMA from the route prior.
   * Without it, every new session re-runs the systematic shortfall for two
   * folds while its EMA re-converges. Only fires when the session has no EMA
   * at all (never folded, or restored from a pre-prior entry).
   * @param sessionId - the session to seed.
   * @param value - the route prior (finite).
   */
  seedDeviationEma(sessionId: string, value: number): void {
    const entry = this.turnCounters.get(sessionId)
    if (entry === undefined || !Number.isFinite(value)) return
    if (entry.targetDeviationEma !== undefined) return
    entry.targetDeviationEma = value
    this.persistCounter(sessionId)
  }

  /**
   * Record (or reject) a FORCED narrowed-window pressure compaction for one
   * session, honouring the cooldown. Keeps the mark in the same ledger entry
   * as the turn/growth state so it survives restarts and is cleaned with it.
   * @param sessionId - the session requesting the force.
   * @param cooldownMs - minimum ms between two forced compactions.
   * @returns true when the force may proceed (and the mark was recorded).
   */
  markForce(sessionId: string, cooldownMs: number): boolean {
    const now = Date.now()
    let entry = this.turnCounters.get(sessionId)
    if (entry === undefined) {
      entry = this.restoreCounter(sessionId)
      this.turnCounters.set(sessionId, entry)
    }
    if (entry.lastForceAt !== undefined && now - entry.lastForceAt < cooldownMs) return false
    entry.lastForceAt = now
    entry.lastActive = now
    this.persistCounter(sessionId)
    return true
  }

  /**
   * Periodic cleanup: evict idle session counters from MEMORY and, far less
   * often, prune PERSISTED counters past their long retention.
   *
   * The two lifetimes are deliberately different. Eviction only bounds RAM
   * after an hour of idleness, but it used to delete the persisted entry too —
   * so a long session with a multi-hour gap lost its lastCompressedTurn,
   * compressions, growth EMA and failure cooldown and recompressed the moment
   * it resumed. Persisted state is now retained for
   * {@link SESSION_COUNTER_RETENTION_MS} and restored lazily by
   * {@link restoreCounter}. Call from the pre-step hook.
   */
  cleanupStale(): void {
    const now = Date.now()
    for (const [sessionId, entry] of this.turnCounters) {
      if (now - entry.lastActive > SESSION_COUNTER_IDLE_MS) {
        this.turnCounters.delete(sessionId)
      }
    }
    if (this.kv?.deleteOlderThan === undefined) return
    if (now - this.lastKvPruneAt < SESSION_KV_PRUNE_INTERVAL_MS) return
    this.lastKvPruneAt = now
    try {
      const removed = this.kv.deleteOlderThan(
        HistoryCompressor.KV_PREFIX,
        now - SESSION_COUNTER_RETENTION_MS,
      )
      if (removed > 0) {
        this.ctx.logger.info(`[ContextGovernor] Pruned ${removed} stale session counter(s)`)
      }
    } catch (err) {
      this.ctx.logger.warn(
        `[ContextGovernor] Session-counter retention sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Archive the exact messages a compression is about to fold into a summary,
   * and return the header that introduces that summary on the surface.
   *
   * Reversibility is the point (upstream `decompress`): the summary costs
   * tokens, the archive costs only disk, and `memory_expand ref=fl_…` brings
   * the literal text back when the model needs the detail. Best-effort — an
   * archive failure degrades to the plain header, it never blocks compaction.
   *
   * @param sessionId - the session whose history is being folded.
   * @param messages - the messages being replaced by the summary.
   * @param summaryText - the summary that will replace them.
   * @returns the header line for the summary message.
   */
  archiveFoldedRange(
    sessionId: string,
    messages: readonly Message[],
    summaryText: string,
  ): string {
    const options = resolveFoldOptions(this.config)
    if (!options.enabled) return foldedRangeHeader(messages.length, 0, null)
    try {
      const original = serializeMessagesForSummary(messages)
      const chars = original.length
      const ref = this.ctx.memoryContext.archiveFoldedRange({
        messages: messages.length,
        chars,
        tokens: this.estimateMessageTokens(messages),
        summary: summaryText,
        original,
        sessionId,
      })
      this.enforceFoldRetention(options)
      return foldedRangeHeader(messages.length, chars, ref)
    } catch (err) {
      this.ctx.logger.warn(
        `[ContextGovernor] Folded-range archive failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return foldedRangeHeader(messages.length, 0, null)
    }
  }

  /**
   * Drop folded ranges past retention, then past the entry cap.
   * @param options - the resolved folded-range policy.
   */
  private enforceFoldRetention(options: FoldOptions): void {
    try {
      if (options.retentionDays > 0) {
        const dayMs = 24 * 60 * 60 * 1000
        this.ctx.memoryContext.pruneFoldedRanges(Date.now() - options.retentionDays * dayMs)
      }
      if (options.maxEntries > 0) this.ctx.memoryContext.trimFoldedRanges(options.maxEntries)
    } catch (err) {
      this.ctx.logger.warn(
        `[ContextGovernor] Folded-range retention sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

}

/* -------------------------------------------------------------------------- */
/*  Fallback Truncation                                                        */
/*  Strategy: if context is still over budget after compression + retrieval,   */
/*  drop messages in priority order: RAG → summaries → tool defs → oldest.    */
/* -------------------------------------------------------------------------- */

/**
 * Fallback truncation: ensure total messages stay within the token budget.
 *
 * Drop priority (first to last):
 *   1. RAG-injected context messages (contain '<retrieved_context>' marker)
 *   2. History compression summaries (contain '[Compressed history —')
 *   3. Oldest conversation messages (preserving the newest `retainRecent`)
 *
 * This function does NOT throw — it silently reduces the array.
 * If even dropping everything except the last user message exceeds the budget,
 * the caller should abort the request with an explicit error.
 *
 * @param messages    - the message array to trim (not mutated; a copy is returned).
 * @param tokenBudget - maximum allowed estimated tokens.
 * @param retainRecent - minimum number of newest messages to preserve (default 4).
 */
function fallbackTruncate(
  messages: Message[],
  tokenBudget: number,
  retainRecent = 4,
): Message[] {
  const estimate = (msgs: readonly Message[]): number => {
    // Meter content the same way the compressor does (estimateContentTokens):
    // image blocks get a fixed cost and non-text blocks count their text
    // payload, so the fallback truncation and the token-pressure trigger
    // cannot disagree on image-heavy sessions.
    let total = 0
    for (const msg of msgs) total += estimateContentTokens(msg.content)
    return total
  }

  // Deep copy here to avoid side effects
  let result: Message[] = messages.map(m => ({ ...m }))
  let tokens = estimate(result)

  if (tokens <= tokenBudget) return result

  // Phase 1: remove RAG-injected messages (highest priority to drop)
  result = result.filter(m => {
    const text = messageText(m)
    return !text.includes('<retrieved_context>')
  })
  tokens = estimate(result)
  if (tokens <= tokenBudget) return result

  // Phase 2: remove history compression summaries
  result = result.filter(m => {
    const text = messageText(m)
    return !text.includes('[Compressed history —')
  })
  tokens = estimate(result)
  if (tokens <= tokenBudget) return result

  // Phase 3: drop oldest messages one by one (preserve the newest retainRecent)
  while (result.length > retainRecent && tokens > tokenBudget) {
    result.shift()
    tokens = estimate(result)
  }

  if (tokens > tokenBudget) {
    // Last resort: trim the oldest remaining message's TEXT payload. Only text
    // blocks are rewritten (preserving images and every other block so the
    // message keeps its modality and the DSH ContentBlock[] contract), and the
    // message object is rebuilt instead of mutating readonly fields.
    const oldest = result[0]
    if (oldest !== undefined && result.length > 1 && Array.isArray(oldest.content)) {
      const overBy = tokens - tokenBudget
      const charsToDrop = overBy * 4 // rough reverse estimate
      if (charsToDrop > 0) {
        let remaining = charsToDrop
        const content = oldest.content.map(block => {
          if (remaining <= 0 || !isTextBlock(block) || block.text.length <= remaining) return block
          const kept = block.text.slice(remaining)
          remaining = 0
          return { ...block, text: kept }
        })
        if (remaining === 0) result[0] = { ...oldest, content }
      }
    }
  }

  return result
}

/* -------------------------------------------------------------------------- */
/*  MemoryCompactionEngine — the Cordis entry point                            */
/* -------------------------------------------------------------------------- */

/**
 * A speculative fold summary awaiting a committing fold. The fingerprint keys
 * the EXACT SummarizationInput the compaction-basic engine will rebuild from
 * the range's seqs; a match at commit time lets the summarizer call be
 * skipped entirely.
 */
interface SpeculativeSummary {
  readonly fingerprint: number
  readonly summary: ContentBlock[]
  readonly start: SessionSeq
  readonly end: SessionSeq
}

/**
 * Fingerprint one SummarizationInput: the roles + TEXT of every message plus
 * the tool-schema names. Two inputs with the same fingerprint get the same
 * summary, which is the whole contract of the speculative precompute. Text
 * only — non-text blocks (images) are not what the summarizer reads.
 * Exported for tests.
 */
export function summarizationFingerprint(input: SummarizationInput): number {
  return fnv1a(JSON.stringify({
    tools: input.tools === undefined ? null : input.tools.map(tool => tool.name),
    messages: input.messages.map(message => [message.role, messageText(message)]),
  }))
}

/** The multi-tier memory compaction backend. */
export class MemoryCompactionEngine extends BasicCompactionEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions', 'memoryContext']

  static override Config: z<MemoryCompactionConfig> = MemoryCompactionConfigSchema

  private readonly retrieval: ResolvedRetrievalOptions
  private readonly lastInjectedTurn = new WeakMap<Session, number>()
  /**
   * Last Agent seen for each session. The manual `memory_force_compress` tool
   * only receives a session id, but the surface-rewrite API needs an Agent.
   */
  private readonly lastAgentBySession = new Map<string, Agent>()
  /** Last time a fold-check diagnostic was sampled per session (epoch ms). */
  private readonly lastFoldCheckAt = new Map<string, number>()
  /** Supported reasoning effort per provider/model (compaction-call fallback). */
  private readonly modelEfforts = new Map<string, NonNullable<GenerateOptions['reasoningEffort']>>()
  /**
   * Per-session set of memory ids injected in the most recent turn. Used to
   * avoid re-injecting the same memories every turn (cross-turn de-dup),
   * which would bloat the context and accumulate contradictions.
   */
  private readonly lastInjectedIds = new WeakMap<Session, ReadonlySet<string>>()
  /**
   * Speculative fold summaries keyed by session. Launched when the surface is
   * close to the fold trigger but the step is not a clean seam: the summary
   * LLM call (the slow part of a fold) runs in the BACKGROUND, and the
   * committing fold consumes it when the region fingerprint still matches —
   * converting fold latency from blocking to hidden. One entry per session;
   * a newer speculation supersedes an older one.
   */
  private readonly speculative = new Map<string, SpeculativeSummary>()
  /** Sessions with a speculative summarization currently running. */
  private readonly speculativeInFlight = new Set<string>()
  /** Last speculative launch per session (launch throttle). */
  private readonly lastSpeculativeAt = new Map<string, number>()
  /** fl_ recall count observed at each session's last fold (quality delta). */
  private readonly lastRecallAtFold = new Map<string, number>()
  /**
   * Whether the most recent summarize() call for this agent degraded to the
   * extractive fallback. CompactionResult carries no provider field, so the
   * resilience wrapper records it here for the fold path (prior learning).
   */
  private readonly lastSummarizeDegraded = new WeakMap<Agent, boolean>()
  /**
   * Master switch for the unified governor (planCompaction). When on, both the
   * durable and fold hooks obey one decision; when off, each lane keeps its
   * legacy trigger (the shared P1 curves still bound both).
   */
  private readonly governance: boolean
  /** Whether the narrowed-window (probe/override) compaction override is on. */
  private readonly dynamicThreshold: boolean
  /** Lower bound of the dynamic trigger ratio as the real window fills. */
  private readonly dynamicThresholdFloor: number
  /** Whether the mid-thinking context guard is enabled. */
  private readonly thinkingGuardEnabled: boolean
  /** Fraction of the real window the thinking guard fires at. */
  private readonly thinkingGuardRatio: number
  /** Public so memoryContext can reference it for force-compress. */
  readonly compressor: HistoryCompressor
  private readonly retriever: VectorRetriever
  private readonly sanitizerConfig: SanitizerConfig
  /** Recent messages kept verbatim by compression/truncation. */
  private readonly retainRecent: number
  /** Reserved tokens for the plugin's own per-turn RAG injection. */
  private readonly injectionBudget: number
  /** Whether the local-model conciseness directive is injected. */
  private readonly conciseLocalMode: boolean
  /** Text of the local-model conciseness directive. */
  private readonly conciseLocalDirective: string
  /**
   * Oversized tool-result archive: exact text kept in the store, with a short
   * ref-bearing stub left on the surface so `memory_expand` can read it back.
   */
  private readonly toolArchive: ToolResultArchive
  /**
   * Context accounting (Strategy 9): what the plugin injected or removed, and
   * what the provider charged for the request.
   */
  private readonly usage: UsageLedger

  /**
   * @param ctx - the plugin context.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: MemoryCompactionConfig) {
    // Strip ALL plugin-specific fields before passing to BasicCompactionEngine.
    // Unknown keys fail config validation, which stops this plugin from loading.
    const {
      retrieval,
      compress_round_interval,
      compress_trigger_ratio,
      compress_target_ratio,
      compaction_governance,
      compaction_dynamic_threshold,
      compaction_dynamic_floor,
      thinking_guard_enabled,
      thinking_guard_ratio,
      retain_recent_messages,
      sanitize_max_chars,
      rag_top_k,
      rag_min_score,
      rag_token_budget,
      rag_chunk_size,
      rag_dedupe_exact,
      rag_dedupe_min_score,
      rag_ingest_denylist,
      rag_ingest_allowlist,
      rag_ingest_importance,
      rag_surface_dedupe,
      concise_local_mode,
      concise_local_directive,
      tool_archive,
      tool_archive_threshold_chars,
      tool_archive_head_chars,
      tool_archive_tail_chars,
      tool_archive_max_entries,
      tool_archive_retention_days,
      tool_absorb,
      tool_absorb_min_chars,
      tool_absorb_max_digest_chars,
      compress_nudge,
      usage_ledger,
      usage_retention_days,
      ...basicConfig
    } = config
    super(ctx, pickBasicCompactionKeys(basicConfig))
    this.retrieval = resolveRetrievalOptions(config)

    // Provide the pyramid-consolidation summarizer to the memory context.
    ctx.memoryContext.setSummarizer((texts, purpose, target) =>
      summarizeMemoriesWithLlm(ctx, this.config, texts, purpose, target),
    )

    // Initialize the history compressor (Strategy 1).
    // Token-pressure trigger (compress_trigger_ratio) delays compression while
    // the context is roomy; the target water level (compress_target_ratio)
    // makes compression progressive (only the oldest overflow is summarized).
    // Inside hard bounds, the unified planner slides both water levels from the
    // measured growth and the session's compression history.
    const compressInterval = compress_round_interval ?? 7
    const retainRecent = retain_recent_messages ?? 4
    const injectionBudget = rag_token_budget ?? 3000
    this.retainRecent = retainRecent
    this.injectionBudget = injectionBudget
    // Explicit opt-in: an existing config without the key keeps the legacy
    // per-lane trigger (the P1 shared curves still bound both). The shipped
    // cordis.yml sets it true so the unified governor is exercised by default
    // for new installs and can be turned off with one key.
    this.governance = compaction_governance ?? false
    if (this.governance) {
      this.ctx.logger.info(
        '[ContextGovernor] Unified compaction governance ON: one planCompaction '
        + 'decision drives the fold lane; compaction_dynamic_threshold still gates '
        + 'the durable lane.',
      )
    }
    this.dynamicThreshold = compaction_dynamic_threshold ?? true
    this.dynamicThresholdFloor = compaction_dynamic_floor ?? 0.6
    this.thinkingGuardEnabled = thinking_guard_enabled ?? true
    this.thinkingGuardRatio = thinking_guard_ratio ?? 0.9
    this.conciseLocalMode = concise_local_mode ?? true
    this.conciseLocalDirective = concise_local_directive ?? DEFAULT_CONCISE_DIRECTIVE
    this.compressor = new HistoryCompressor(
      ctx,
      this.config,
      compressInterval,
      retainRecent,
      compress_trigger_ratio ?? 0.85,
      compress_target_ratio ?? 0.6,
      injectionBudget,
      // Persist turn counters to SQLite so the round interval survives restarts.
      {
        get: (key) => ctx.memoryContext.kvGet(key),
        set: (key, value) => ctx.memoryContext.kvSet(key, value),
        delete: (key) => ctx.memoryContext.kvDelete(key),
        deleteOlderThan: (prefix, cutoffMs) => ctx.memoryContext.kvDeleteOlderThan(prefix, cutoffMs),
      },
      compress_nudge ?? true,
    )

    // Initialize the sanitizer config (Strategy 3)
    this.sanitizerConfig = { maxChars: sanitize_max_chars ?? 2000 }

    // Initialize the vector retriever (Strategy 4).
    // topK/minScore come from the resolved retrieval options (rag_* effective,
    // legacy retrieval.* as fallback); tokenBudget/chunkSize stay rag_*-only.
    // Ingestion guards (dedup + high-value source filter + importance) are
    // configured through the rag_ingest_* fields.
    const retrieverConfig: VectorRetrieverConfig = {
      topK: this.retrieval.topK,
      minScore: this.retrieval.minScore,
      tokenBudget: rag_token_budget ?? 3000,
      chunkSize: rag_chunk_size ?? 500,
      dedupeExact: rag_dedupe_exact ?? true,
      dedupeMinScore: rag_dedupe_min_score ?? 0.92,
      ingestDenylist: rag_ingest_denylist ?? DEFAULT_INGEST_DENYLIST,
      ...(rag_ingest_allowlist === undefined ? {} : { ingestAllowlist: rag_ingest_allowlist }),
      ingestImportance: rag_ingest_importance ?? 0.3,
      dedupeSurface: rag_surface_dedupe ?? true,
    }
    this.retriever = new VectorRetriever(ctx, retrieverConfig)

    // Tool-result archive (exact-text CCR): oversized tool results are copied
    // verbatim into the store and their surface node becomes a small stub with
    // a ref. The built-in pruner deletes the middle of a big result for good;
    // this keeps it retrievable — and fires below the pruner threshold so its
    // lossy marker is not reached first.
    const archiveOptions = resolveToolArchiveOptions(config)
    this.toolArchive = new ToolResultArchive({
      store: {
        archiveToolResult: record => ctx.memoryContext.archiveToolResult(record),
        getToolResult: ref => ctx.memoryContext.getToolResult(ref),
        findToolResultByCallId: callId => ctx.memoryContext.findToolResultByCallId(callId),
        listToolResults: limit => ctx.memoryContext.listToolResults(limit),
        searchToolResults: (query, limit) => ctx.memoryContext.searchToolResults(query, limit),
        countToolResults: () => ctx.memoryContext.countToolResults(),
        toolResultChars: () => ctx.memoryContext.toolResultChars(),
        deleteToolResultsBefore: timestamp => ctx.memoryContext.deleteToolResultsBefore(timestamp),
        trimToolResults: maxEntries => ctx.memoryContext.trimToolResults(maxEntries),
      },
      options: archiveOptions,
      logger: ctx.logger,
      estimateMessage: message => ctx.tokenMeter.estimateMessage(message),
      // Absorb-style distillation (Strategy 7): the stub carries a digest of
      // the signal lines instead of a blind head+tail slice. The digest cap is
      // derived from the archive threshold so the stub always stays under it.
      absorb: resolveAbsorbOptions(config, archiveOptions.thresholdChars),
    })

    // Register back-reference so tools.ts can reach the compressor for force-compress,
    // reuse the configured retriever for ingestion (single config source), and
    // reuse the configured sanitizer cap instead of a hard-coded one.
    ctx.memoryContext.compactionEngine = {
      agentFor: (id: string) => this.agentFor(id),
      foldNow: (agent, signal, force) => this.foldNow(agent, signal, force),
      sanitizerConfig: this.sanitizerConfig,
    }
    ctx.memoryContext.retriever = { ingest: (text, source) => this.retriever.ingest(text, source) }

    // Context accounting (Strategy 9). Append-only and best-effort: it records
    // what the plugin injected/removed and what the provider charged, which is
    // the only way to answer "were those tokens worth it" after the fact.
    this.usage = new UsageLedger({
      store: {
        recordUsageEvent: record => ctx.memoryContext.recordUsageEvent(record),
        usageTotals: sinceTs => ctx.memoryContext.usageTotals(sinceTs),
        listUsageEvents: limit => ctx.memoryContext.listUsageEvents(limit),
        pruneUsageEvents: beforeTs => ctx.memoryContext.pruneUsageEvents(beforeTs),
        usageTotalsByDetail: sinceTs => ctx.memoryContext.usageTotalsByDetail(sinceTs),
      },
      options: resolveUsageOptions(config),
      logger: ctx.logger,
    })
    ctx.memoryContext.usage = {
      summary: days => this.usage.summary(days),
      totals: sinceTs => this.usage.totals(sinceTs),
      recent: limit => this.usage.recent(limit),
    }

    // Wire Strategy 3 (output sanitization + ingestion): observe every settled
    // tool call and hand its STRUCTURED content blocks to the sanitizer — the
    // source strategies (web_search / code_exec / per-field truncation) must
    // see the payload; pre-joining it into a string would bypass them all.
    // Listener failures are contained by onToolResult's own try/catch.
    ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
      if (exec.signal.aborted) return
      const hasText = result.content.some(
        block => block.type === 'text' && block.text.trim().length > 0,
      )
      if (!hasText) return
      // Archive the EXACT text first: the stub written into the surface later
      // carries only a ref, and `memory_expand` resolves it long after the
      // sanitizer has reduced this payload to a summary. Best-effort.
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const captured = this.toolArchive.capture(
        exec.name,
        exec.callId,
        sessionId,
        textOfBlocks(result.content),
      )
      if (captured !== null && captured.digest !== null) {
        // Absorb: the digest is both the surface stub and a memory, so the
        // signal lines outlive the stub itself once compaction drops it.
        this.usage.record(
          USAGE_KIND.absorbChars,
          Array.from(captured.digest).length,
          sessionId === undefined ? {} : { sessionId },
        )
        void this.retriever.ingest(captured.digest, exec.name)
      }
      void this.onToolResult(exec.name, result.content)
    })

    // Always register the governance hook: it also drives history compression
    // (Strategy 1) and model-context adoption (G8) — both must keep working
    // when RAG retrieval is disabled. The RAG section gates itself inside.
    this.registerRetrieval(ctx)
    this.registerUsage(ctx)
    this.registerCompactionEffort(ctx)

    // Mid-thinking context guard: wrap the agent's LLM stream and inject a
    // CONTEXT_WINDOW_EXCEEDED finish when input + output-so-far approaches the
    // CURRENT model's real window, so the engine compacts durably and retries
    // with room — the plugin intervenes even while the model is thinking, and
    // a takeover whose input is already over the line is compacted up front.
    if (this.thinkingGuardEnabled) {
      this.registerThinkingGuard(ctx)
    }
  }

  /**
   * Register the `llm/stream` guard (see {@link thinking-guard}). Only
   * agent-loop requests are guarded; the window is the CURRENT routed model's
   * real context (probe for local / declared for online), resolved through the
   * per-model registry — so the guard follows whichever model the session is
   * calling right now, even mid-turn after a model switch.
   */
  private registerThinkingGuard(ctx: Context): void {
    registerThinkingGuard(ctx, {
      enabled: this.thinkingGuardEnabled,
      ratio: this.thinkingGuardRatio,
      maxTokens: this.config.maxTokens ?? 8192,
      isAgentLoopRequest,
      windowForSession: (sessionId) => {
        const session = ctx.sessions.get(SessionId(sessionId))
        if (session === undefined) return undefined
        const requestContext = session.requestContext()
        const model = requestContext?.model
        if (model === undefined || model.length === 0) return ctx.memoryContext.contextWindow
        return ctx.memoryContext.windowForModel(model) ?? ctx.memoryContext.contextWindow
      },
      log: (message) => ctx.logger.info(message),
    })
  }

  /**
   * Step-boundary compaction entry, overridden to make the trigger track the
   * routed model's REAL context window.
   *
   * The inherited pressure policy scales its threshold off the window DSH
   * declares for the routed model (adapter/catalog). For local servers that
   * declaration is frequently several times larger than the runtime context,
   * so the threshold sits beyond what the model can hold and the conversation
   * overflows before compaction ever fires — a single long thinking turn makes
   * this worse because a whole round of growth lands at once. When a probe or
   * a `modelWindows` override has narrowed the routed model's window below the
   * declared one, this override forces the base overflow-style balanced
   * reduction as soon as the measured conversation crosses a threshold derived
   * from the REAL window (see {@link decidePressureCompaction}); otherwise it
   * delegates unchanged.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    // --- Tool-result archive (exact-text CCR) ---
    // A compaction is about to rewrite the request prefix anyway, so this is
    // the cheap moment for a FULL-surface pass: stub every oversized result
    // BEFORE the base policy runs, so the built-in pruner (which deletes the
    // middle for good) has nothing left to prune, and results that predate this
    // plugin instance become retrievable too. Repeat calls are no-ops once the
    // oversized nodes are stubs, so this never invalidates a prefix twice.
    try {
      const archived = this.toolArchive.rewriteAllResults(agent.session)
      if (archived.replaced > 0) {
        this.usage.record(USAGE_KIND.archiveChars, archived.charsRemoved, {
          sessionId: String(agent.session.id),
        })
        this.ctx.logger.info(
          `[ContextGovernor] Tool-result archive (pre-compaction): stubbed ${archived.replaced} result(s), ${archived.charsRemoved} chars (refs: ${archived.refs.join(', ')})`,
        )
      }
    } catch (error) {
      this.ctx.logger.warn(
        `[ContextGovernor] Tool-result archive full pass failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.lastAgentBySession.set(String(agent.session.id), agent)
    if (trigger === 'pressure' && (this.dynamicThreshold || this.governance) && !signal.aborted) {
      const handled = await this.forceNarrowedPressure(agent, signal)
      if (handled === null) {
        // The narrowed-window override said "skip" (authoritative for the
        // DURABLE lane). It must NOT short-circuit the fold lane: the fold is a
        // separate surface rewrite with its own real-window budget. Try it, but
        // keep the durable lane suppressed.
        return await this.tryFold(agent, signal)
      }
      if (handled !== undefined) return handled
    }
    // Fold FIRST: its trigger is below the durable threshold, so asking the
    // durable lane first starves it forever. The fold is a surface rewrite with
    // the same semantics as durable; only when it is not due does the durable
    // lane (and its overflow path) run.
    if (trigger === 'pressure') {
      const folded = await this.tryFold(agent, signal)
      // Under the unified governor the fold lane is the SOLE pressure
      // executor. Falling through to the durable lane here would compact
      // again at its own (often lower) threshold right after the fold and
      // produce churn. Overflow/context-overflow still delegates below.
      if (this.governance) return folded
      if (folded !== null) return folded
    }
    return await super.compactIfNeeded(agent, trigger, signal)
  }

  /**
   * Run the fold lane with error containment.
   * @param agent - owner of the session.
   * @param signal - cancellation signal.
   * @returns the fold result, or null when not due / failed.
   */
  private async tryFold(agent: Agent, signal: AbortSignal): Promise<CompactionResult | null> {
    if (!this.governance || signal.aborted) return null
    try {
      return await this.foldNow(agent, signal)
    } catch (error) {
      this.ctx.logger.warn(
        `[ContextGovernor] Fold failed: ${error instanceof Error ? error.message : String(error)}; `
        + 'falling through to the durable lane',
      )
      return null
    }
  }

  /**
   * The Agent that last owned a session (manual tool path).
   * @param sessionId - session id to look up.
   * @returns the agent, or undefined before the session ran a step.
   */
  agentFor(sessionId: string): Agent | undefined {
    return this.lastAgentBySession.get(sessionId)
  }

  /**
   * Evaluate whether NOW is a good moment to fold.
   *
   * Compaction timing is not just pressure: a fold rewrites the request
   * prefix, so a mid-tool-loop step pays the summary cost and invalidates the
   * cache for a request that is about to grow again, while a turn boundary
   * lands on a clean seam. The planner receives this score and only modulates
   * its trigger inside the hard water-level bounds.
   * @param session - session whose surface tail is inspected.
   * @returns the phase, opportunity score and session maturity.
   */
  /**
   * Read the current surface into a content/stage intent.
   * @param session - session whose surface is inspected.
   * @param meter - authoritative prices for the same surface.
   * @returns the bounded intent, or undefined for an empty surface.
   */
  private contextIntent(session: Session, meter: TokenMeasurement): CompactionIntent | undefined {
    const nodes = session.surface.nodes
    const priced = meter.nodes
    const from = Math.max(0, nodes.length - 200)
    const signals: SurfaceSignal[] = []
    for (let i = from; i < nodes.length; i += 1) {
      const seq = nodes[i]
      const event = seq === undefined ? undefined : session.eventAt(seq)
      if (event === undefined) continue
      const tokens = priced[i]?.tokens ?? 0
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        const message = (event.data as unknown as { message?: { role: string; content: unknown } }).message
        const text = message === undefined ? '' : messageText(message)
        const hasToolCalls = Array.isArray(message?.content)
          ? message.content.some(block => (block as { type?: string }).type === 'tool-call')
          : false
        signals.push({ type: event.type, tokens, text, hasToolCalls })
      } else if (event.type === 'tool/result') {
        const isError = (event.data as unknown as { isError?: boolean }).isError === true
        signals.push({ type: event.type, tokens, isError })
      } else {
        signals.push({ type: event.type, tokens })
      }
    }
    return signals.length === 0 ? undefined : analyzeContext(signals)
  }

  private compactionOpportunity(session: Session, compressions: number): CompactionOpportunity {
    const nodes = session.surface.nodes
    let turnCount = 0
    let stepsSinceUser = 0
    let lastEventType = ''
    let lastEventHadToolCalls = false
    let toolResults = 0
    let assistantMessages = 0
    let sawUser = false
    const scan = Math.min(nodes.length, 200)
    for (let i = nodes.length - 1; i >= nodes.length - scan; i -= 1) {
      const seq = nodes[i]
      if (seq === undefined) continue
      const event = session.eventAt(seq)
      if (event === undefined) continue
      const type = event.type
      if (type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/end') continue
      if (lastEventType === '') {
        lastEventType = type
        if (type === 'assistant/message') {
          const data = event.data as { message?: { content?: readonly { type?: string }[] } }
          lastEventHadToolCalls = data.message?.content?.some(block => block.type === 'tool-call') === true
        }
      }
      if (type === 'user/message') {
        turnCount += 1
        sawUser = true
      } else {
        if (!sawUser) stepsSinceUser += 1
        if (type === 'tool/result') toolResults += 1
        else if (type === 'assistant/message') assistantMessages += 1
      }
    }
    const toolAndAssistant = toolResults + assistantMessages
    return evaluateOpportunity({
      turnCount,
      stepsSinceUser,
      lastEventType,
      lastEventHadToolCalls,
      recentToolRatio: toolAndAssistant === 0 ? 0 : toolResults / toolAndAssistant,
      compressions,
    })
  }

  /**
   * Fold the session SURFACE to the unified fold target.
   *
   * This is the fold lane's ONLY executor. `agent/pre-step` carries just the
   * step's inbox delta, so folding there could never see history (and would
   * drop the step's real messages). The fold therefore rewrites the surface
   * exactly like the durable lane, via compaction-basic's `compactRegion`,
   * with the system head and first user message pinned (billion-context #2733).
   *
   * GENERATION SAFETY: this runs only from step boundaries (`agent/pre-step`
   * / `compactIfNeeded`), never from `llm/stream` — the waterfall is deep
   * frozen and no fold hook exists there by construction. A fold therefore
   * always waits for the model to FINISH generating (including a long local
   * reasoning phase) before it rewrites anything: the 14:53 production case
   * (a 9m45s reasoning stream, fold committed the moment it ended) is this
   * guarantee working, not a race. Never add a fold trigger on `llm/stream`.
   * @param agent - owner of the session to fold.
   * @param signal - cancellation signal.
   * @param force - bypass the trigger/rate-limit gates (manual tool use).
   * @returns the committed compaction result, or null when no safe fold is due.
   */
  async foldNow(agent: Agent, signal: AbortSignal, force = false): Promise<CompactionResult | null> {
    if (signal.aborted) return null
    const session = agent.session
    const sessionId = String(session.id)
    const requestContext = session.requestContext()
    // Diagnostic channel: the DSH logger sink is not observable from here, so
    // fold outcomes land in the usage ledger (kind=fold_check, detail=outcome).
    const diag = (detail: string): void => {
      try {
        this.usage.record(USAGE_KIND.foldCheck, 1, { sessionId, detail })
      } catch {
        // Diagnostics must never break governance.
      }
    }
    const window = this.ctx.memoryContext.windowForModel(requestContext?.model ?? '')
      ?? requestContext?.contextWindow
      ?? this.ctx.memoryContext.contextWindow
    if (!(Number.isFinite(window) && window > 0)) { diag('no-window'); return null }
    // Use the SAME pressure budget as the durable lane: the window minus the
    // reserved completion tokens (the provider charges them to the same
    // window) minus the plugin headroom. Without the completion reserve the
    // fold trigger sat ABOVE the durable threshold and the durable lane always
    // won the race.
    let reservedCompletion = session.requestHeader()?.config.maxTokens ?? 0
    if (reservedCompletion <= 0) {
      try {
        const info = await this.ctx.llm.resolveModelInfo(
          requestContext?.provider ?? '',
          requestContext?.model ?? '',
          signal,
        )
        reservedCompletion = info.defaultMaxTokens ?? 0
        const effort = info.reasoning?.efforts?.[0]?.id ?? info.reasoning?.defaultEffort
        if (effort !== undefined) {
          this.modelEfforts.set(`${requestContext?.provider ?? ''}/${requestContext?.model ?? ''}`, effort)
        }
      } catch {
        // Unknown reserve: fall back to the headroom-only budget.
      }
    }
    const headroom = Math.max(0, window - this.compressor.tokenBudget(window))
    // A request cap that reserves (almost) the whole window must not collapse
    // the fold budget to one token: clamp the reserve to what the window can
    // spare and keep a minimum prompt share.
    const pressureBudget = foldPressureBudget({ window, reservedCompletion, headroom })
    const meter = this.ctx.tokenMeter.measure(session)
    if (meter.totalTokens <= 0) { diag('no-meter'); return null }
    const snapshot = toSurfaceSnapshot({
      totalTokens: meter.totalTokens,
      surfaceTokens: meter.surfaceTokens,
      window,
    })
    const ledger = this.compressor.beginFoldCheck(sessionId, snapshot.surfaceTokens)
    // Cross-session prior: a session that has never folded warm-starts its
    // deviation EMA from the converged prior of the same summarizer route —
    // without it, every new session re-runs the systematic shortfall for two
    // folds while its EMA re-converges from zero.
    if (ledger.compressions === 0 && this.compressor.targetDeviationOf(sessionId) === undefined) {
      const target = routedTargetOf(session)
      if (target !== undefined) {
        const prior = this.compressor.deviationPriorOf(`${target.provider}/${target.model}`)
        if (prior !== undefined) this.compressor.seedDeviationEma(sessionId, prior)
      }
    }
    const opportunity = this.compactionOpportunity(session, ledger.compressions)
    const intent = this.contextIntent(session, meter)
    const deviationEma = this.compressor.targetDeviationOf(sessionId)
    const plan = planFoldCompaction({
      surfaceTokens: snapshot.surfaceTokens,
      fixedTokens: snapshot.fixedTokens,
      window,
      ledger,
      baseTriggerRatio: this.compressor.triggerRatio,
      baseTargetRatio: this.compressor.targetRatio,
      compressInterval: this.compressor.compressInterval,
      budgetTokens: pressureBudget,
      injectionBudget: this.compressor.injectionBudget,
      nudge: this.compressor.nudge,
      force,
      opportunity,
      ...(deviationEma === undefined ? {} : { deviationEmaTokens: deviationEma }),
      ...(intent === undefined ? {} : { intent }),
    })
    if (plan.lane !== 'fold') {
      const now = Date.now()
      const last = this.lastFoldCheckAt.get(sessionId) ?? 0
      // Sample normally once per 10 min, but always when close to the trigger.
      const near = snapshot.surfaceTokens >= plan.surfaceTriggerTokens * 0.85
      if (near || now - last >= 10 * 60_000) {
        this.lastFoldCheckAt.set(sessionId, now)
        diag(`plan:${plan.lane}:${plan.reason};surf=${snapshot.surfaceTokens};`
          + `trigger=${plan.surfaceTriggerTokens};budget=${pressureBudget};`
          + `phase=${plan.drivers.phase};opp=${plan.drivers.opportunity.toFixed(2)};`
          + `timing=${plan.drivers.timing.toFixed(2)};mag=${plan.drivers.magnitude.toFixed(2)};ms=${plan.drivers.milestone ? 1 : 0}`)
      }
      // Close to the trigger but not a clean seam: precompute the fold
      // summary in the background so the eventual fold does not block.
      void this.maybeSpeculate({ agent, session, sessionId, plan, snapshot, meter, pressureBudget })
      return null
    }
    // Frequency gate: a routine fold must not fire again within a short
    // window. Force, surge and the fit-guard still bypass it.
    if (!force && (plan.reason === 'pressure' || plan.reason === 'nudge')) {
      const last = this.compressor.lastFoldAt(sessionId)
      if (last !== undefined && Date.now() - last < MIN_FOLD_INTERVAL_MS) {
        diag(`min-interval:${Math.round((Date.now() - last) / 1000)}s;surf=${snapshot.surfaceTokens}`)
        return null
      }
    }
    // Goal-conditioned importance: the carried task-state block is the goal
    // reference; nodes in the cut-boundary window (the walk's max reach is 3)
    // that are clearly ON-TOPIC stay verbatim even when they are not user
    // messages. Zero LLM cost - the hash embedder prices each candidate in
    // microseconds. No block or no embedder => empty set => the walk falls
    // back to its user-message-only behaviour.
    const importanceKeep = await this.importanceBoundary(sessionId, session, meter, plan)
    // Prefer a speculative summary when its region is still verbatim-valid
    // (fingerprint over the exact input the base engine will rebuild). A
    // stale region - content replaced, surface drifted - is dropped and the
    // range selected fresh; either way the committing fold is correct.
    const speculation = this.speculative.get(sessionId)
    let range: { start: SessionSeq; end: SessionSeq } | null = null
    if (speculation !== undefined) {
      const fingerprint = summarizationFingerprint(this.buildRegionInput(session, speculation.start, speculation.end))
      if (fingerprint === speculation.fingerprint) {
        range = { start: speculation.start, end: speculation.end }
      } else {
        this.speculative.delete(sessionId)
      }
    }
    if (range === null) range = selectFoldRange(session, meter, Math.max(0, plan.targetSurfaceTokens), importanceKeep)
    if (range === null) {
      diag(`no-range;surf=${snapshot.surfaceTokens};trigger=${plan.surfaceTriggerTokens};`
        + `target=${plan.targetSurfaceTokens};phase=${plan.drivers.phase};opp=${plan.drivers.opportunity.toFixed(2)};`
        + `timing=${plan.drivers.timing.toFixed(2)};mag=${plan.drivers.magnitude.toFixed(2)}`)
      return null
    }
    // A fold that is smaller than the summarizer's own output cannot net a
    // saving (compaction-basic rejects it). Skip it instead of churning.
    let foldTokens = 0
    for (const node of meter.nodes) {
      if (node.seq >= range.start && node.seq <= range.end) foldTokens += node.tokens
    }
    const minFoldTokens = minimumFoldTokens(pressureBudget)
    // A zero sum means the meter priced the range at 0 (e.g. a cached/replay
    // node); treat it as unknown and let compaction-basic's own size check decide.
    if (foldTokens > 0 && foldTokens < minFoldTokens) {
      diag(`small-fold:${foldTokens}<${minFoldTokens};surf=${snapshot.surfaceTokens};target=${plan.targetSurfaceTokens};`
        + `timing=${plan.drivers.timing.toFixed(2)};mag=${plan.drivers.magnitude.toFixed(2)}`)
      return null
    }
    // Thin-fold gate: a ROUTINE fold must net more than its own summarizer
    // output plus the cost of the call and the post-fold cache refill (≈8%
    // of the budget). On a small window the memory floor caps the band so
    // the closed loop cannot deepen its way out - without this gate the
    // session churned at a median 3-minute cadence for a ~6% sliver each
    // time. Force, surge and the fit-guard bypass it: their occasion is not
    // optional, and a thin emergency fold still beats an overflow.
    if (!force && (plan.reason === 'pressure' || plan.reason === 'nudge') && foldTokens > 0
      && isThinFold(foldTokens, summarizationTargetTokens(this.config, foldTokens), pressureBudget)) {
      diag(`thin-fold:fold=${foldTokens};summary~${summarizationTargetTokens(this.config, foldTokens)};`
        + `budget=${pressureBudget};surf=${snapshot.surfaceTokens};timing=${plan.drivers.timing.toFixed(2)};`
        + `mag=${plan.drivers.magnitude.toFixed(2)}`)
      return null
    }
    this.ctx.logger.info(
      `[ContextGovernor] Fold (${plan.reason}): surface ${snapshot.surfaceTokens}/${window}, `
      + `keep tail ${plan.targetSurfaceTokens}, range ${range.start}..${range.end}`,
    )
    try {
      const result = await this.compactRegion(range.start, range.end, agent, signal)
      this.compressor.recordFold(sessionId, snapshot.surfaceTokens)
      // Closed-loop band: observe where the fold actually landed versus the
      // plan's target and feed the signed shortfall into the next plan. The
      // meter re-reads the rewritten surface (measure() re-syncs the session
      // each call), so `landed` shares the target's basis (meter surface
      // tokens on the same estimator). Scope: the FOLD lane feeds the loop —
      // the durable lane shares the same planCompaction targets but its
      // landings are not observed here, so a summary-overhead change seen
      // only by durable compactions reaches this EMA one fold later.
      const landed = this.ctx.tokenMeter.measure(session).surfaceTokens
      // Forced folds (manual tool call) have atypical range shapes and
      // overhead, so they OBSERVE without TEACHING: the diagnosis still
      // reports the current EMA, but the average only learns from routine
      // cadence folds.
      const deviation = plan.reason === 'forced'
        ? (this.compressor.targetDeviationOf(sessionId) ?? 0)
        : this.compressor.recordFoldLanding(
            sessionId,
            landed - plan.targetSurfaceTokens,
          )
      // The route's cross-session prior only learns from LIVE (LLM)
      // summaries: a degraded extractive fold has a different overhead shape
      // and would poison the warm start.
      const degraded = this.lastSummarizeDegraded.get(agent) ?? false
      if (plan.reason !== 'forced' && !degraded) {
        const target = routedTargetOf(session)
        if (target !== undefined) {
          this.compressor.recordDeviationPrior(`${target.provider}/${target.model}`, deviation)
        }
      }
      // Fold-quality recall signal: an fl_ read-back since the last fold
      // means the agent had to HUNT for what the previous fold removed.
      const recallFl = this.ctx.memoryContext.flRecallCount(sessionId)
      if (recallFl > (this.lastRecallAtFold.get(sessionId) ?? 0)) {
        this.usage.record(USAGE_KIND.foldCheck, 1, { sessionId, detail: 'fold_quality:recalled' })
      }
      this.lastRecallAtFold.set(sessionId, recallFl)
      // Savings are recorded centrally in summarize() (both lanes pass there),
      // so the ledger does not double count the fold.
      diag(`folded:${plan.reason};surf=${snapshot.surfaceTokens};target=${plan.targetSurfaceTokens};`
        + `landed=${landed};dev=${Math.round(deviation)};recallFl=${recallFl};`
        + `phase=${plan.drivers.phase};opp=${plan.drivers.opportunity.toFixed(2)};`
        + `timing=${plan.drivers.timing.toFixed(2)};mag=${plan.drivers.magnitude.toFixed(2)};ms=${plan.drivers.milestone ? 1 : 0}`)
      if (plan.reason === 'nudge') this.usage.record(USAGE_KIND.nudge, 1, { sessionId })
      return result
    } catch (error) {
      this.compressor.recordFoldFailure(sessionId, error)
      diag(`error:${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /**
   * Evaluate the narrowed-window pressure override for one step.
   * @returns `undefined` to delegate to the base policy, or the result to
   *   return in its place (`null` = skip, `CompactionResult` = forced run).
   */
  private async forceNarrowedPressure(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<CompactionResult | null | undefined> {
    try {
      const target = routedTargetOf(agent.session)
      if (target === undefined) return undefined
      const narrowed = this.ctx.memoryContext.windowForModel(target.model)
      if (narrowed === undefined) return undefined
      const declared = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal))
        .context?.contextWindow
      if (signal.aborted) return undefined
      const measurement = this.ctx.tokenMeter.measure(agent.session)
      // Hard fit-guard: the request is about to run out of the REAL window.
      // Force the durable path regardless of the dynamic threshold so the
      // plugin's own summarization always gets room — the 'ensure no overflow'
      // backstop, reached whenever the override OR the unified governor is on.
      // If compaction cannot shrink, the provider's own overflow path is the
      // final backstop (the 10s force cooldown prevents a per-step storm).
      const guardReserve = Math.max(GOV_GUARD_RESERVE_MIN, Math.floor(narrowed * GOV_GUARD_RESERVE_RATIO))
      if (measurement.totalTokens >= narrowed - guardReserve) {
        const key = String(agent.session.id)
        if (!this.compressor.markForce(key, FORCED_PRESSURE_COOLDOWN_MS)) return null
        this.ctx.logger.info(
          `[ContextGovernor] Fit-guard: ${measurement.totalTokens} tokens >= real window ${narrowed} `
          + `− reserve ${guardReserve} (model=${target.model}); forcing durable compaction`,
        )
        return await super.compactIfNeeded(agent, 'context-overflow', signal)
      }
      const decision = decidePressureCompaction({
        declaredWindow: declared,
        narrowedWindow: narrowed,
        measuredTokens: measurement.totalTokens,
        thresholdRatio: this.thresholdRatioFor(target),
        dynamicRatio: this.dynamicThreshold,
        dynamicRatioFloor: this.dynamicThresholdFloor,
      })
      if (decision.mode === 'skip') {
        this.ctx.logger.debug(
          `[ContextGovernor] Pressure below narrowed threshold: ${measurement.totalTokens} < `
          + `${decision.thresholdTokens} (model=${target.model}, window=${narrowed})`,
        )
        return null
      }
      if (decision.mode === 'force') {
        const key = String(agent.session.id)
        if (!this.compressor.markForce(key, FORCED_PRESSURE_COOLDOWN_MS)) return null
        this.ctx.logger.info(
          `[ContextGovernor] Narrowed-window pressure: ${measurement.totalTokens} tokens >= `
          + `${decision.thresholdTokens} threshold (model=${target.model}, real window ${narrowed} `
          + `< declared ${declared ?? 'unknown'}); forcing balanced compaction`,
        )
        return await super.compactIfNeeded(agent, 'context-overflow', signal)
      }
      // 'delegate' — narrowed >= declared (override == declared, or the probe
      // matched the declaration). The base pressure path handles this with
      // proper tail retention, BUT it uses the STATIC thresholdRatio. When the
      // dynamic ratio has already pulled the trigger line below the static one,
      // we must NOT wait for the static threshold: a local model whose declared
      // window equals its probed window (e.g. qwen3 at 167936) would otherwise
      // run into the slow long-context zone before the static 0.7 line fires.
      // Fire the base-style balanced compaction at the DYNAMIC line instead.
      // Under the unified governor the fold lane owns routine pressure, so the
      // dynamic-line durable path would be a second compaction at a different
      // threshold (the churn seen on a 64k local model). Only the real-window
      // force/fit-guard above still bypasses the fold.
      if (this.governance) return undefined
      const baseThresholdTokens = Math.max(1, Math.floor(
        (declared ?? narrowed) * this.thresholdRatioFor(target),
      ))
      if (decision.thresholdTokens !== undefined
        && decision.thresholdTokens < baseThresholdTokens
        && measurement.totalTokens >= decision.thresholdTokens) {
        this.ctx.logger.info(
          `[ContextGovernor] Dynamic delegate line: ${measurement.totalTokens} tokens >= `
          + `${decision.thresholdTokens} (below the static base line ${baseThresholdTokens}; `
          + `model=${target.model}); compacting with tail retention`,
        )
        return await this.compactWithDynamicLine(agent, signal, decision.thresholdTokens, narrowed)
      }
      return undefined
    } catch (error) {
      // Unknown route, resolveModelInfo rejection, aborted probe — fall back to
      // the base policy, which produces its own structured diagnostics.
      this.ctx.logger.debug(
        `[ContextGovernor] Dynamic pressure check unavailable: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /**
   * Run ONE balanced compaction (base-style: retains the configured recent
   * tail, never the overflow-style retain-0 full squeeze) once the measured
   * conversation crosses the given dynamic threshold.
   *
   * Mirrors the base pressure path's single attempt (prune → select →
   * compactRegion) so the delegate case honors the dynamic ratio without
   * duplicating the whole retry loop; the next step re-checks if still over.
   */
  private async compactWithDynamicLine(
    agent: Agent,
    signal: AbortSignal,
    thresholdTokens: number,
    window: number,
  ): Promise<CompactionResult | null> {
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    const prune = this.ctx.get('toolResultPruner')
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < thresholdTokens) return null
    // Resolve the retained-tail budget for the effective window, mirroring the
    // base resolveCompactSpec (retainRatio defaults to 0.16 in compaction-basic).
    const retainTokens = this.config.retainTokens === undefined
      ? Math.max(0, Math.floor(window * (this.config.retainRatio ?? 0.16)))
      : this.config.retainTokens
    // Thin-fold gate for the legacy durable routine path. Under the unified
    // governor routine pressure belongs to the fold lane (which has its own
    // gate); this method is the one durable path the plugin owns end-to-end,
    // and it gets the same deal: a region whose net saving does not cover its
    // summary plus the call cost waits for a deeper occasion.
    const regionTokens = Math.max(0, measurement.totalTokens - Math.min(retainTokens, measurement.totalTokens))
    if (isThinFold(regionTokens, summarizationTargetTokens(this.config, regionTokens), window)) {
      this.ctx.logger.info(
        `[ContextGovernor] Thin durable fold skipped: region ~${regionTokens} tokens nets under `
          + `${Math.floor(window * GOV_MIN_NET_SAVING_RATIO)} (window ${window}); waiting for a deeper occasion`,
      )
      return null
    }
    // Head-anchored range selection (mirrors compaction-basic's
    // selectCompactableRange): walk from the tail accumulating prices until the
    // retained tail is covered, then step back to a tool-pairing-balanced cut.
    const nodes = measurement.nodes
    if (nodes.length === 0) return null
    const surfaceNodes = agent.session.surface.nodes
    // Base contract guard #1: the priced nodes must still match the live
    // surface seq-for-seq. A stale measurement (surface mutated between
    // measure and now) would make every positional index below a lie — the
    // base path throws the same error, and the caller falls back to it.
    if (surfaceNodes.length !== nodes.length
      || surfaceNodes.some((seq, index) => seq !== nodes[index]?.seq)) {
      throw new Error(
        'dsh-infinite-context: token-meter surface does not match the current session surface',
      )
    }
    // Base contract guard #2: a leading system/message node is NEVER inside the
    // compactable range — summarizing it would corrupt the system prompt.
    const firstIdx = this.isSystemHeadNode(agent.session, surfaceNodes[0]!) ? 1 : 0
    let accumulated = 0
    let keepFromIdx = nodes.length
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded by length
      accumulated += nodes[index]!.tokens
      keepFromIdx = index
      if (accumulated >= retainTokens) break
    }
    if (keepFromIdx <= firstIdx) return null
    while (keepFromIdx > firstIdx) {
      if (toolPairingBalancedBefore(agent.session, surfaceNodes[keepFromIdx]!)) break
      keepFromIdx -= 1
    }
    if (keepFromIdx <= firstIdx) return null
    // Base contract guard #3: never enter a second compaction transaction while
    // one is still open (the base pressure path asserts the same before its
    // async decision gap; this call has the same gap after resolveModelInfo).
    this.assertNoActiveCompaction(agent.session, 'dynamic-line pressure compaction')
    const start = surfaceNodes[firstIdx]!
    const end = surfaceNodes[keepFromIdx - 1]!
    return await this.compactRegion(start, end, agent, signal)
  }

  /**
   * Whether the surface node at `seq` is the session's system prompt head
   * (mirrors compaction-basic's `systemHead`): the event at that seq must be a
   * `system/message`. Such nodes are never compacted.
   */
  private isSystemHeadNode(session: Session, seq: number): boolean {
    const head = session.eventAt(seq as SessionSeqOf)
    return head !== undefined && (head as { type?: unknown }).type === 'system/message'
  }

  /**
   * Lightweight mirror of compaction-basic's internal compaction-lock check:
   * scan the event log backwards for the most recent `compaction/start` vs
   * `compaction/end` marker. An unmatched start (with no later `session/end-seed`
   * releasing it) means a compaction transaction is already open on this
   * session — entering a second one would interleave two surface replacements.
   */
  private assertNoActiveCompaction(session: Session, stage: string): void {
    let endSeedSeen = false
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq as SessionSeqOf)
      if (event === undefined) break
      if (!endSeedSeen && (event as { type?: unknown }).type === 'session/end-seed') endSeedSeen = true
      const type = (event as { type?: unknown }).type
      if (type === 'compaction/start') {
        if (endSeedSeen) return
        throw new Error(`${stage}: compaction already in progress; the session compaction lock is already active`)
      }
      if (type === 'compaction/end') return
    }
  }

  /** The compaction threshold ratio the base policy resolves for this target. */
  private thresholdRatioFor(target: { provider: string; model: string }): number {
    const override = this.config.modelPolicies.find(
      policy => policy.provider === target.provider && policy.model === target.model,
    )
    const ratio = override?.thresholdRatio ?? this.config.thresholdRatio
    // Hard ceiling: the durable lane can never wait past GOV_TRIGGER_CEILING,
    // even if a hand-written thresholdRatio (or model policy) says to.
    return Math.min(ratio, GOV_TRIGGER_CEILING)
  }

  /**
   * Replicate compaction-basic's `buildSummarizationInput`: the replayed
   * cacheable prefix (system head from surface node 0, the header's tool
   * schemas) followed by the region's derived messages in surface order. The
   * speculative fingerprint is only as good as this replication — any
   * divergence degrades to a fingerprint miss at commit, never to a wrong
   * summary (the fingerprint match is the verification).
   */
  private buildRegionInput(session: Session, start: SessionSeq, end: SessionSeq): SummarizationInput {
    const header = session.requestHeader()
    const headNode = session.surface.nodes[0]
    const headEvent = headNode === undefined ? undefined : session.eventAt(headNode)
    const head = headEvent?.type === 'system/message' ? headEvent : undefined
    const system = head === undefined ? null : session.deriveEventMessage(head)
    const regionMessages: Message[] = []
    for (const nodeSeq of session.surface.nodes) {
      if (nodeSeq < start || nodeSeq > end) continue
      const event = session.eventAt(nodeSeq)
      if (event === undefined) continue
      const message = session.deriveEventMessage(event)
      if (message !== null) regionMessages.push(message)
    }
    return {
      ...(header?.tools === undefined ? {} : { tools: header.tools }),
      messages: system === null ? regionMessages : [system, ...regionMessages],
    }
  }

  /**
   * Goal-conditioned importance for the cut-boundary window: the carried
   * task-state block embedded as the goal reference, and the ≤3 nodes the
   * high-value walk can reach embedded per node. Sequences clearing
   * GOV_IMPORTANCE_KEEP_COS stay verbatim even when they are not user
   * messages. SHARED by the live fold path and the speculative launcher —
   * the two must select ranges under the SAME rule, or a speculative hit
   * would silently bypass the goal-conditioned boundary.
   * @returns the important sequences, or `undefined` when the goal reference
   *   is unavailable (no block yet / no embedder) — the caller then uses the
   *   role-only rule.
   */
  private async importanceBoundary(
    sessionId: string,
    session: Session,
    meter: TokenMeasurement,
    plan: CompactionPlan,
  ): Promise<Set<SessionSeq> | undefined> {
    const taskStateBlock = this.compressor.taskStateOf(sessionId)
    if (taskStateBlock === undefined) return undefined
    const goalVec = await this.ctx.memoryContext.embedText(taskStateBlock.slice(0, 2000))
    if (goalVec === undefined) return undefined
    const important = new Set<SessionSeq>()
    const naive = retainedTailStart(meter.nodes.map(node => node.tokens), Math.max(0, plan.targetSurfaceTokens))
    for (let back = 1; back <= 3; back += 1) {
      const node = meter.nodes[naive - back]
      if (node === undefined) break
      const event = session.eventAt(node.seq)
      const message = event === undefined || event === null ? null : session.deriveEventMessage(event)
      const text = message === null ? '' : messageText(message)
      if (text.length === 0) continue
      const vec = await this.ctx.memoryContext.embedText(text.slice(0, 2000))
      if (vec === undefined) continue
      if (cosineSimilarity(goalVec, vec) >= GOV_IMPORTANCE_KEEP_COS) important.add(node.seq)
    }
    return important
  }

  /**
   * Launch a speculative fold summarization when the surface is CLOSE to the
   * trigger but this step was not a clean seam. The summary LLM call — the
   * slow part of a fold, up to minutes on a local model — then runs in the
   * background while the conversation continues, and the committing fold
   * consumes it if the region fingerprint still matches. Best-effort on every
   * path: a failure or a surface drift simply falls back to the live
   * summarizer at commit (fingerprint miss is recorded in the ledger, so the
   * hit rate is observable).
   */
  private async maybeSpeculate(input: {
    agent: Agent
    session: Session
    sessionId: string
    plan: CompactionPlan
    snapshot: SurfaceSnapshot
    meter: TokenMeasurement
    pressureBudget: number
  }): Promise<void> {
    if (!resolveSpeculativeFold(this.config)) return
    if (input.plan.surfaceTriggerTokens <= 0) return
    if (input.snapshot.surfaceTokens < input.plan.surfaceTriggerTokens * SPECULATIVE_AHEAD_RATIO) return
    if (this.speculativeInFlight.has(input.sessionId)) return
    const now = Date.now()
    if (now - (this.lastSpeculativeAt.get(input.sessionId) ?? 0) < SPECULATIVE_MIN_INTERVAL_MS) return
    const importanceKeep = await this.importanceBoundary(
      input.sessionId,
      input.session,
      input.meter,
      input.plan,
    )
    const range = selectFoldRange(input.session, input.meter, Math.max(0, input.plan.targetSurfaceTokens), importanceKeep)
    if (range === null) return
    let foldTokens = 0
    for (const node of input.meter.nodes) {
      if (node.seq >= range.start && node.seq <= range.end) foldTokens += node.tokens
    }
    if (foldTokens > 0 && foldTokens < minimumFoldTokens(input.pressureBudget)) return
    if (isThinFold(foldTokens, summarizationTargetTokens(this.config, foldTokens), input.pressureBudget)) return
    const specInput = this.buildRegionInput(input.session, range.start, range.end)
    const fingerprint = summarizationFingerprint(specInput)
    const existing = this.speculative.get(input.sessionId)
    if (existing !== undefined && existing.fingerprint === fingerprint) return
    this.lastSpeculativeAt.set(input.sessionId, now)
    this.speculativeInFlight.add(input.sessionId)
    const deadlineMs = resolveSummarizationTimeoutMs(this.config, this.summarizerIsLocal(input.agent))
    void this.runSpeculative(input.agent, input.sessionId, range, specInput, fingerprint, deadlineMs)
  }

  private async runSpeculative(
    agent: Agent,
    sessionId: string,
    range: { start: SessionSeq; end: SessionSeq },
    specInput: SummarizationInput,
    fingerprint: number,
    deadlineMs: number,
  ): Promise<void> {
    try {
      // super.summarize = the RAW summarizer (no resilience fallback, no
      // post-processing): a failed speculation is dropped silently, and the
      // committing fold then runs the live path with its own telemetry.
      const result = await super.summarize(specInput, agent, AbortSignal.timeout(deadlineMs))
      if (result.summary.length === 0) return
      this.speculative.set(sessionId, {
        fingerprint,
        summary: result.summary,
        start: range.start,
        end: range.end,
      })
      this.ctx.logger.info(
        `[ContextGovernor] speculative fold summary prepared (session …${sessionId.slice(-8)}, `
          + `range ${range.start}..${range.end})`,
      )
    } catch {
      // Speculation is opportunistic: any failure defers to the live path.
    } finally {
      this.speculativeInFlight.delete(sessionId)
    }
  }

  /**
   * The summarizer call under a bounded deadline, with a degradation path.
   *
   * Telemetry (2026-10) showed the call hanging until the provider's own
   * 300s stream-idle limit — blocking the whole fold — and local configs
   * failing every call outright; either failure used to ABANDON the fold, so
   * the context kept growing exactly when the model could least afford it.
   * Now: one hard timeout per attempt (a fresh timer each), a single retry,
   * then a deterministic extractive summary. The fold always completes; the
   * degraded path is observable as kind=fold_check detail=degraded:extractive.
   * A CALLER cancellation still rethrows (a cancelled step must not fabricate
   * a result), and `summarization_timeout_ms: 0` disables the wrapper.
   *
   * Known boundary: the race settles the CALL on time, but a backend that
   * ignores the abort signal may keep its underlying stream open — the retry
   * then runs concurrently with the abandoned attempt until the provider's
   * own idle limit reaps it. Worst case is a briefly duplicated in-flight
   * request, never a duplicated summary (the loser's result is discarded).
   */
  /**
   * Whether the session's summarizer route points at a LOCAL server. Shared
   * by the live summarizer deadline and the speculative precompute.
   */
  private summarizerIsLocal(agent: Agent): boolean {
    try {
      const target = resolveSummarizationTarget(this.config, agent.session)
      return target !== undefined && this.ctx.memoryContext.isLocalRoute(target.provider)
    } catch {
      // Locality unreadable — the cloud default is the safe choice.
      return false
    }
  }

  private async summarizeResilient(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    // The default deadline depends on WHERE the summarizer route points: a
    // local model is SLOW (minutes for a 20k-token range on 27B-class
    // hardware — production showed every local-session fold degrading to the
    // extractive fallback at the cloud default), while a cloud model that
    // stalls is HUNG. Unknown locality keeps the tight cloud default — and
    // if that misread causes a timeout, the RETRY runs at double, so one
    // locality miss costs headroom, not the fold.
    const baseMs = resolveSummarizationTimeoutMs(this.config, this.summarizerIsLocal(agent))
    if (baseMs <= 0) return super.summarize(input, agent, signal)
    const inputTokens = estimateTokens(input.messages
      .map(message => messageText(message))
      .join('\n'))
    const timeoutMs = scaleSummarizationTimeoutMs(baseMs, inputTokens)
    const shadowed = shadowedMessages(input)
    const outcome = await summarizeWithResilience(
      combined => super.summarize(input, agent, combined),
      error => {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown')
        const text = extractiveSummary(
          shadowed.map(message => ({ role: message.role, text: messageText(message) })),
          { reason },
        )
        return {
          summary: [{ type: 'text', text }],
          provider: 'extractive',
          model: 'extractive',
        } satisfies SummaryResult
      },
      { timeoutMs, retries: 1, ...(signal === undefined ? {} : { outerSignal: signal }) },
    )
    this.lastSummarizeDegraded.set(agent, outcome.degraded)
    if (outcome.degraded) {
      const reason = outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error ?? 'unknown')
      const brief = reason.replace(/\s+/g, ' ').trim().slice(0, 160)
      this.ctx.logger.warn('[ContextGovernor] summarizer degraded to extractive: ' + brief)
      // Overflow learning: a 400 "exceeds the available context size" on the
      // SUMMARIZER call means the server's real context is smaller than the
      // declared one (production: declared 128k, server answered "available
      // context size (32)"). The summarizer replays the range as a prefix,
      // so inputTokens + slack is a hard UPPER BOUND on the real window —
      // adopt it narrow-only, and the next fold plans against the truth.
      const overflow = reason.match(/exceeds the (?:available )?context(?: size)? \((\d+)\)/i)
        ?? reason.match(/\((\d+) tokens\) exceeds/i)
      if (overflow !== null && inputTokens > 0) {
        try {
          const target = resolveSummarizationTarget(this.config, agent.session)
          if (target !== undefined) {
            this.ctx.memoryContext.updateModelContext({
              provider: target.provider,
              model: target.model,
              contextWindow: inputTokens,
              source: 'overflow',
            })
            this.ctx.logger.warn(
              `[ContextGovernor] summarizer overflow 400: adopting real window <= ${inputTokens} `
                + `for ${target.provider}/${target.model}`,
            )
          }
        } catch {
          // Overflow learning is best-effort; the fold continues degraded.
        }
      }
      try {
        this.usage.record(USAGE_KIND.foldCheck, 1, {
          sessionId: String(agent.session.id),
          detail: 'degraded:extractive:' + brief,
        })
      } catch {
        // Diagnostics must never break the degraded path.
      }
    }
    return outcome.value
  }

  /**
   * Summarize a compacted region and then persist it as a mid-term memory,
   * rebalance the memory pyramid, and run the forgetting sweep.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    // Consume a speculative summary when the input fingerprint matches: the
    // summary LLM call already ran in the background, so the fold commits
    // without blocking on it. One-shot: consumed or mismatched, the entry is
    // gone (a miss falls through to the live summarizer with its telemetry).
    const sessionIdStr = String(agent.session.id)
    const speculation = this.speculative.get(sessionIdStr)
    if (speculation !== undefined) {
      this.speculative.delete(sessionIdStr)
      if (summarizationFingerprint(input) === speculation.fingerprint) {
        this.ctx.logger.info('[ContextGovernor] speculative summary consumed (fingerprint hit)')
        this.usage.record(USAGE_KIND.foldCheck, 1, { sessionId: sessionIdStr, detail: 'speculative:hit' })
        // A precomputed summary is a genuine live-LLM result: record it so the
        // fold path publishes the route prior (the flag would otherwise hold a
        // STALE value from an earlier call and wrongly suppress publishing).
        this.lastSummarizeDegraded.set(agent, false)
        return { summary: speculation.summary, provider: 'precomputed', model: 'speculative' }
      }
      this.usage.record(USAGE_KIND.foldCheck, 1, { sessionId: sessionIdStr, detail: 'speculative:miss' })
    }
    // Spread once: the resilience wrapper's declared type keeps the summary
    // read-only, while the clipping below rewrites it in place.
    const result = { ...(await this.summarizeResilient(input, agent, signal)) }
    try {
      // The summarizer is asked for ~30% of its input, but local models often
      // over-produce; a summary that is not smaller than the folded content is
      // rejected by compaction-basic. Cap the committed summary to the planned
      // share so the fold always nets a saving.
      const shadowed = shadowedMessages(input)
      const shadowedTokens = this.compressor.estimateMessageTokens(shadowed)
      const maxChars = summaryCharBudget(shadowedTokens, SUMMARY_OUTPUT_SHARE)
      let remaining = maxChars
      result.summary = result.summary.map(block => {
        if (block.type !== 'text') return block
        if (remaining <= 0) return { ...block, text: '' }
        if (block.text.length <= remaining) {
          remaining -= block.text.length
          return block
        }
        const clipped = block.text.slice(0, Math.max(0, remaining - 14)) + '\n…[truncated]'
        remaining = 0
        return { ...block, text: clipped }
      })
      const modelText = result.summary
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
      // Working-memory slot: rebuild the carried task-state block from this
      // fold's structured checkpoint (primary request / pending jobs / next
      // step / critical context), falling back per-section to the previous
      // block where the new fold has nothing. Injected fresh every turn by
      // the pre-step splice; persisted here so restarts keep it.
      if (modelText.length > 0) {
        const sessionIdStr = String(agent.session.id)
        const taskState = buildTaskStateBlock({
          summary: modelText,
          previous: this.compressor.taskStateOf(sessionIdStr),
        })
        if (taskState !== undefined && taskState !== this.compressor.taskStateOf(sessionIdStr)) {
          this.compressor.recordTaskState(sessionIdStr, taskState)
        }
      }
      // Keep the user's own words in the folded range. A model summary can
      // drop instructions and identifiers; this digest is deterministic and
      // survives whatever the summarizer decides to keep.
      const userInstructions = shadowed
        .filter(message => message.role === 'user')
        .map(message => messageText(message).trim())
        .filter(value => value.length > 0)
        .slice(-12)
        .map(value => `- ${value.length > 300 ? `${value.slice(0, 300)}…` : value}`)
      const digest = userInstructions.length === 0
        ? ''
        : `## 折叠区用户指令 / User instructions in the folded range\n${userInstructions.join('\n')}`
      // The degradation header stays on the SURFACE copy (result.summary)
      // only: the durable copies must not persist a transient provider error
      // into the folded_ranges summary and the mid-tier memory.
      const text = [digest, stripExtractiveHeader(modelText)].filter(Boolean).join('\n\n')
      if (text.length > 0) {
        // One place records compaction savings for BOTH lanes (durable and
        // fold), using the plugin's CJK-aware surface estimate.
        if (shadowedTokens > 0) {
          this.usage.record(USAGE_KIND.compactionSaved, shadowedTokens, {
            sessionId: String(agent.session.id),
          })
        }
        const header = this.compressor.archiveFoldedRange(
          String(agent.session.id),
          shadowed,
          text,
        )
        const prefix = [header.includes('fl_') ? header : '', digest]
          .filter(Boolean)
          .join('\n\n')
        if (prefix.length > 0) {
          let inserted = false
          result.summary = result.summary.map(block => {
            if (inserted || block.type !== 'text') return block
            inserted = true
            return { ...block, text: `${prefix}\n\n${block.text}` }
          })
          if (!inserted) result.summary = [{ type: 'text', text: prefix }, ...result.summary]
        }
        // Mid-tier summaries are higher-value than raw tool results
        // (importance 0.6 vs 0.3) so the forgetting policy keeps them longer.
        await this.ctx.memoryContext.storeMemory(text, 'mid', {
          sourceSessionId: agent.session.id,
          importance: 0.6,
          kind: 'project',
        })
      }
      const rebalance = await this.ctx.memoryContext.rebalance(
        resolveSummarizationTarget(this.config, agent.session),
      )
      if (rebalance.pyramid?.merged !== null && rebalance.pyramid?.merged !== undefined) {
        this.ctx.logger.info(
          `memory pyramid consolidated ${rebalance.pyramid.demotedMids.length} mid memories into one long memory `
            + `(mids demoted to the short tier)`,
        )
      }
      if (rebalance.forgetting.dropped.length > 0) {
        this.ctx.logger.info(
          `memory forgetting dropped ${rebalance.forgetting.dropped.length} low-value memories`,
        )
      }
    } catch (error) {
      // Persistence and rebalance are best-effort; the compaction itself already
      // produced a usable checkpoint.
      this.ctx.logger.warn(
        `memory persistence/rebalance failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return result
  }

  /**
   * Sanitize a tool result and ingest it into the vector memory.
   * Called from the tool execution callback (onToolResult equivalent).
   *
   * `rawResult` may be the structured `ContentBlock[]` from the `tools/result`
   * event (the automatic path) or any parsed payload (the manual
   * `memory_ingest` tool) — {@link sanitizeToolResult} dispatches per shape.
   *
   * Error-isolated: failures never block the main flow.
   */
  async onToolResult(source: string, rawResult: unknown): Promise<void> {
    try {
      const sanitized = sanitizeToolResult(rawResult, source, this.sanitizerConfig)
      const text = sanitizedPayloadText(sanitized)
      if (text.length === 0) return
      await this.retriever.ingest(text, source)
    } catch (err) {
      this.ctx.logger.warn(
        `[ContextGovernor] Tool result sanitization/ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** Register the per-turn governance hook: CTX adoption + compression + RAG injection. */
  private registerRetrieval(ctx: Context): void {
    ctx.on('agent/pre-step', async (
      payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      // Periodic cleanup of stale session counters + stale forced-pressure marks
      this.compressor.cleanupStale()

      // --- Tool-result archive (exact-text CCR) ---
      // Stub oversized tool results that appeared since the last pass BEFORE the
      // request for this step is assembled, so the model reads a ref instead of
      // the payload and `memory_expand` can hand the full text back later. The
      // pass is cache-safe: it only touches nodes appended after the previous
      // barrier, never a request prefix that was already sent. Isolated so a
      // failed rewrite cannot block compression or retrieval.
      try {
        const archived = this.toolArchive.rewriteNewResults(payload.agent.session)
        if (archived.replaced > 0) {
          this.usage.record(USAGE_KIND.archiveChars, archived.charsRemoved, {
            sessionId: String(payload.agent.session.id),
          })
          ctx.logger.info(
            `[ContextGovernor] Tool-result archive: stubbed ${archived.replaced} result(s), ${archived.charsRemoved} chars off the surface (refs: ${archived.refs.join(', ')})`,
          )
        }
      } catch (error) {
        ctx.logger.warn(
          `[ContextGovernor] Tool-result archive rewrite failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const decision = await next()
      if (payload.signal.aborted || decision.kind !== 'enter' || decision.messages.length === 0) {
        return decision
      }

      const session = payload.agent.session
      if (this.lastInjectedTurn.get(session) === payload.turn) return decision

      try {
        const sessionId = session.id
        // Adopt the ACTUAL model context window resolved by DSH (catalog /
        // `/models`). This is what makes compression track the real model's
        // context length — a 8K local model compresses early, a 128K online
        // model waits — instead of a hard-coded window. Falls back to the
        // configured window when DSH has not resolved one yet. The per-model
        // registry (probe / modelWindows overrides) narrows this to the REAL
        // runtime window for the routed model when one is known.
        let sessionWindow: number | undefined
        const requestContext = session.requestContext()
        if (requestContext !== undefined) {
          ctx.memoryContext.observeRequestContext({
            ...requestContext.provider === undefined ? {} : { provider: requestContext.provider },
            ...requestContext.model === undefined ? {} : { model: requestContext.model },
            ...requestContext.contextWindow === undefined ? {} : { contextWindow: requestContext.contextWindow },
          })
          sessionWindow = ctx.memoryContext.windowForModel(requestContext.model)
        }
        const effectiveWindow = sessionWindow ?? ctx.memoryContext.contextWindow
        // Deep copy here to avoid side effects.
        // Type is Message[] (not UserMessage[]) because compression injects a
        // user-role summary and fallbackTruncate can reshape the array; the
        // final PreStepDecision cast to UserMessage[] is intentional — every
        // message we keep or inject is user-role by construction.
        let currentMessages: Message[] = decision.messages.map(m => ({ ...m }))

        // --- History compression is a SURFACE rewrite, not a pre-step rewrite ---
        // `decision.messages` here is only the step's inbox delta (DSH appends
        // it to the session surface). Folding it could never see history and,
        // if it ever fired, would drop the step's real messages. The fold lane
        // now runs in `compactIfNeeded` via `foldNow()` → compaction-basic's
        // `compactRegion`, exactly like the durable lane.
        // --- Strategy 4: RAG retrieval injection (gated on retrieval config;
        // CTX adoption above stays active regardless) ---
        // The active surface — the text of every message the model is about to
        // read — is materialized lazily: the surface-aware retrieval de-dup and
        // the conciseness directive both need it, but a step where neither
        // applies should not pay for the full concatenation.
        let surfaceCache: string[] | undefined
        const surface = (): string[] => (surfaceCache ??= currentMessages
          .map(message => messageText(message).trim())
          .filter(text => text.length > 0))

        // Messages to splice in BEFORE the latest user message, in order.
        const injections: UserMessage[] = []

        // --- Strategy 3.5: task-state working memory (carried from folds) ---
        // Similarity retrieval structurally misses open-loop state: the next
        // user message is rarely similar to a fifty-turn-old pending job, and
        // production showed memory_search was never called directly. So the
        // loop's working set (primary request / pending jobs / next step /
        // critical context, rebuilt from every fold's checkpoint) is spliced
        // in unconditionally, BEFORE the RAG background. Fresh each turn and
        // never durable - it adds no per-turn surface messages. Its tokens
        // come out of the RAG cap so the reserved injection budget holds.
        let taskStateTokens = 0
        if (resolveTaskStateEnabled(this.config)) {
          const taskState = this.compressor.taskStateOf(sessionId)
          if (taskState !== undefined) {
            injections.push(createUserMessage({
              content: [{ type: 'text', text: taskState }],
              source: { kind: 'plugin:' + PLUGIN } as any,
            }))
            taskStateTokens = estimateTokens(taskState)
            this.usage.record(USAGE_KIND.injectTokens, taskStateTokens, { sessionId })
          }
        }

        if (this.retrieval.enabled) {
          // Cap the injection at a share of the session's REAL window so a
          // short-context local model keeps room for the conversation itself
          // (the configured rag_token_budget remains the ceiling for large
          // windows). The task-state block above is paid first.
          const injectionCap = Math.max(256, Math.min(
            this.injectionBudget,
            Math.max(256, Math.floor(effectiveWindow * RAG_WINDOW_SHARE)),
          ) - taskStateTokens)
          const userText = this.latestUserText(currentMessages)
          if (userText !== undefined) {
            const excludeIds = this.lastInjectedIds.get(session)
            const retrieval = await this.retriever.retrieve(
              userText,
              excludeIds,
              injectionCap,
              surface(),
            )
            if (retrieval !== null) {
              injections.push(retrieval.message)
              this.lastInjectedIds.set(session, new Set(retrieval.ids))
              // Price the injection: tokens actually added to the request, how
              // many memories that bought, and how many were dropped because
              // the model could already see them.
              this.usage.record(
                USAGE_KIND.injectTokens,
                estimateTokens(messageText(retrieval.message)),
                { sessionId },
              )
              this.usage.record(USAGE_KIND.injectMemories, retrieval.hitCount, { sessionId })
              this.usage.record(USAGE_KIND.surfaceSkips, retrieval.skipped, { sessionId })
              ctx.logger.info(
                `[ContextGovernor] RAG injected: ${retrieval.hitCount} memories for query "${userText.slice(0, 60)}…"`,
              )
            } else if (excludeIds !== undefined) {
              // Nothing fresh to inject — drop the exclusion set so the next
              // turn re-attempts the full Top-K instead of permanently
              // excluding the same memories forever.
              this.lastInjectedIds.delete(session)
            }
          }
        }

        // --- Strategy 5: local-model conciseness directive ---
        // A local model's narration is re-sent as input on every later request
        // (and re-paid after each cache expiry), so one short directive that
        // suppresses it usually pays for itself within the same turn. Injected
        // at most once per surface — see the module doc for why the check, and
        // not a turn counter, is what makes this idempotent.
        if (this.conciseLocalMode && ctx.memoryContext.isLocalRoute(requestContext?.provider)) {
          if (!hasConciseDirective(surface())) {
            injections.push(createConciseMessage(this.conciseLocalDirective))
            ctx.logger.info(
              `[ContextGovernor] local conciseness directive injected (provider=${requestContext?.provider ?? 'unknown'})`,
            )
          }
        }

        // Insert the injected messages BEFORE the latest user message so the
        // model reads them as context, not as new user input appended after the
        // question (which would break instruction ordering). The conciseness
        // directive goes LAST so it sits closest to the question and reads as
        // the current turn's rule rather than as ancient background.
        if (injections.length > 0) {
          let insertAt = currentMessages.length
          for (let i = currentMessages.length - 1; i >= 0; i--) {
            const text = messageText(currentMessages[i]).trim()
            if (currentMessages[i].role === 'user' && text.length > 0) {
              insertAt = i
              break
            }
          }
          currentMessages = [
            ...currentMessages.slice(0, insertAt),
            ...injections,
            ...currentMessages.slice(insertAt),
          ]
        }

        // --- Fallback truncation (Strategy 2 — deterministic last resort) ---
        // Budget: the session's effective window minus headroom (same factor
        // as the compressor's tokenBudget()).
        const headroom = ctx.memoryContext.headroomRatio ?? 0.25
        const tokenBudget = Math.floor(effectiveWindow * (1 - headroom))
        const beforeCount = currentMessages.length
        currentMessages = fallbackTruncate(currentMessages, tokenBudget, this.retainRecent)
        if (currentMessages.length < beforeCount) {
          ctx.logger.warn(
            `[ContextGovernor] Fallback truncation: ${beforeCount} → ${currentMessages.length} messages (budget: ${tokenBudget} tokens)`,
          )
        }

        this.lastInjectedTurn.set(session, payload.turn)
        return { kind: 'enter', messages: currentMessages as UserMessage[] }
      } catch (error) {
        ctx.logger.warn(
          `[ContextGovernor] Governance hook error: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return decision
    })
  }

  /**
   * Record the provider's own token accounting (Strategy 9).
   *
   * DSH's {@link TokenUsage} counts are DISJOINT: `inputTokens` is the
   * *uncached* input, so the billed input is input + cacheRead + cacheWrite.
   * They are stored separately (never pre-summed) because summing here would
   * erase the cache-hit ratio — exactly the signal this accounting exists to
   * expose. Steps whose adapter reported nothing are simply not counted.
   *
   * @param ctx - the plugin context.
   */
  /**
   * Make auxiliary compaction calls use the session's own reasoning effort.
   *
   * compaction-basic's summarizer omits `reasoningEffort`, so the LLM service
   * falls back to the model's declared default. Local providers commonly
   * declare a default the served model rejects (e.g. default "high" while the
   * GGUF template only accepts "medium"), which fails every summarization.
   * Wrapping `stream` for `purpose: 'compaction'` passes the routed effort (or
   * the first effort the model actually declares) without forking the base.
   * @param ctx - the plugin context.
   */
  private registerCompactionEffort(ctx: Context): void {
    const llm = ctx.llm
    const marker = Symbol.for('dsh-infinite-context.compaction-effort')
    const record = llm as unknown as Record<PropertyKey, unknown>
    if (record[marker] === true) return
    const original = llm.stream.bind(llm)
    try {
      llm.stream = (options: GenerateOptions) => {
        if (options.purpose === 'compaction' && options.reasoningEffort === undefined) {
          const effort = this.compactionEffortFor(options)
          if (effort !== undefined) return original({ ...options, reasoningEffort: effort })
        }
        return original(options)
      }
      record[marker] = true
    } catch (error) {
      // A frozen/proxied service must not break plugin loading; the
      // summarizer simply keeps the provider default in that case.
      this.ctx.logger.warn(
        `[ContextGovernor] Could not pass reasoning effort to compaction calls: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    // The wrapper is idempotent and the plugin lives for the process.
  }

  /**
   * Resolve the reasoning effort for one auxiliary call.
   * @param options - the outgoing LLM call.
   * @returns the routed session effort, else the first effort the model declares.
   */
  private compactionEffortFor(options: GenerateOptions): NonNullable<GenerateOptions['reasoningEffort']> | undefined {
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const session = sessionId === undefined ? undefined : this.lastAgentBySession.get(sessionId)?.session
    const routed = session?.requestHeader()?.config.reasoningEffort
    if (routed !== undefined) return routed
    return this.modelEfforts.get(`${options.provider}/${options.model}`)
  }

  private registerUsage(ctx: Context): void {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const usage = event.data.usage
      if (usage === undefined) return
      const sessionId = String(session.id)
      // Attribute every count to THIS session's routed provider/model, read from
      // the session itself — the tracker's global "last observed" slot can
      // belong to a concurrent session on another model. A mid-session model
      // switch invalidates the provider prefix cache, so without the per-model
      // split that drop is indistinguishable from TTL expiry.
      const attribution = usageAttribution(sessionId, session.requestContext())
      this.usage.record(USAGE_KIND.llmRequests, 1, attribution)
      if (usage.inputTokens !== undefined) {
        this.usage.record(USAGE_KIND.llmInput, usage.inputTokens, attribution)
      }
      if (usage.outputTokens !== undefined) {
        this.usage.record(USAGE_KIND.llmOutput, usage.outputTokens, attribution)
      }
      if (usage.cacheReadTokens !== undefined) {
        this.usage.record(USAGE_KIND.llmCacheRead, usage.cacheReadTokens, attribution)
      }
      if (usage.cacheWriteTokens !== undefined) {
        this.usage.record(USAGE_KIND.llmCacheWrite, usage.cacheWriteTokens, attribution)
      }
    })
  }

  /** Find the most recent non-empty user text in the request messages. */
  private latestUserText(messages: readonly { role: string; content: unknown }[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== 'user') continue
      const text = messageText(message).trim()
      if (text.length > 0) return text
    }
    return undefined
  }

}

export default MemoryCompactionEngine
