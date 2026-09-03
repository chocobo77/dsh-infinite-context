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
 *   4. History compression: every N rounds, old messages are summarized into
 *      a compact background context (recursion-locked to prevent re-entrancy).
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
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
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
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: brings the `ctx.tokenMeter` service declaration into scope.
import type {} from '@deepseek-ai/dsh-token-meter'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_INGEST_DENYLIST,
  MemoryCompactionConfigSchema,
  resolveRetrievalOptions,
  type MemoryCompactionConfig,
  type ResolvedRetrievalOptions,
} from './config.ts'
import { estimateTokens } from './token-budget.ts'
import {
  COMPRESS_FAILURE_COOLDOWN,
  decidePressureCompaction,
  shouldCompressHistory,
} from './compaction-policy.ts'
import { sanitizeToolResult, type SanitizerConfig } from './OutputSanitizer.ts'
import { VectorRetriever, type VectorRetrieverConfig } from './VectorRetriever.ts'
import {
  resolveSummarizationTarget,
  routedTargetOf,
  type SummarizationTarget,
} from './summarization-target.ts'

/* -------------------------------------------------------------------------- */
/*  Summarization types (structural mirrors from dsh-compaction-basic)        */
/* -------------------------------------------------------------------------- */

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
const FORCED_PRESSURE_COOLDOWN_MS = 30_000

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
 * Fixed token cost charged per image block by the heuristic meter. The real
 * cost varies with resolution; this conservative constant keeps image-heavy
 * sessions from being systematically under-measured (which used to delay
 * compression until compaction-basic's overflow recovery had to step in).
 */
const IMAGE_BLOCK_TOKEN_COST = 1500

/**
 * Heuristic token estimate across a message content (string or block array).
 * text blocks are metered normally, image blocks get a fixed cost, and every
 * other block type (reasoning / tool-call / tool-result) contributes either
 * its textual payload when it carries one or a small constant — never its raw
 * JSON, which may embed base64 data that would poison the estimate.
 */
function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text') {
      total += estimateTokens(block.text)
    } else if (block.type === 'image') {
      total += IMAGE_BLOCK_TOKEN_COST
    } else {
      const maybeText = (block as { text?: unknown }).text
      total += typeof maybeText === 'string' ? estimateTokens(maybeText) : 32
    }
  }
  return total
}

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
  return Math.min(cap, Math.max(300, Math.floor(inputTokens * 0.3)))
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
      source: { kind: 'plugin', plugin: PLUGIN },
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
  /** Remaining rounds to wait after a failed (non-shrinking) compression. */
  failureCooldown: number
}

/** Result of a compression operation. */
export interface CompressResult {
  messages: readonly Message[]
  tokensSaved: number
}

/** Options for one {@link HistoryCompressor.compress} call. */
export interface CompressOptions {
  /**
   * The session's effective model window (per-model probe/override or the
   * request context). Defaults to the globally adopted window, which may
   * belong to a different model when several sessions share the runtime.
   */
  window?: number
  /**
   * The session whose summarization is being computed. Used to resolve the
   * summarization target (provider/model) when `summarizationProvider`/
   * `summarizationModel` are not configured — the summarization then follows
   * the session's own routed model.
   */
  session?: Session
}

/**
 * HistoryCompressor: proactively compresses old conversation history every N
 * rounds (configurable) by summarizing via the LLM.
 *
 * Key safety features:
 *   - Recursion lock (KV-based, auto-expiring) prevents re-entrancy during
 *     the summarization LLM call.
 *   - Turn counter persisted per session (in-memory Map; survives within a
 *     process but resets on restart — acceptable since compression is
 *     idempotent and will simply re-trigger on the next interval).
 *
 * @module HistoryCompressor
 */
export class HistoryCompressor {
  // Turn counter resets on process restart. Compression is idempotent so a
  // restart just delays the next trigger. Upgrade path: persist to the existing
  // SQLite store (MemoryStore) as a new table or KV column.
  private readonly turnCounters = new Map<string, SessionCounter>()

  /** Recursion lock: sessionId → true while LLM summarization is in-flight. */
  private readonly compressLocks = new Set<string>()

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

  constructor(
    ctx: Context,
    config: ResolvedConfig,
    compressInterval: number,
    retainRecent: number,
    triggerRatio = 0.85,
    targetRatio = 0.6,
    injectionBudget = 0,
  ) {
    this.ctx = ctx
    this.config = config
    this.compressInterval = compressInterval
    this.retainRecent = retainRecent
    this.triggerRatio = triggerRatio
    this.targetRatio = targetRatio
    this.injectionBudget = injectionBudget
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
   * Initializes to 0 if the session has never been seen.
   */
  private touchSession(sessionId: string): SessionCounter {
    const entry = this.turnCounters.get(sessionId)
    const now = Date.now()
    if (entry === undefined) {
      const created: SessionCounter = { turn: 1, lastActive: now, failureCooldown: 0 }
      this.turnCounters.set(sessionId, created)
      return created
    }
    entry.turn++
    entry.lastActive = now
    return entry
  }

  /**
   * Acquire the recursion lock for a session.
   * Returns true if acquired (safe to proceed), false if already locked.
   */
  private acquireLock(sessionId: string): boolean {
    if (this.compressLocks.has(sessionId)) return false
    this.compressLocks.add(sessionId)
    return true
  }

  /**
   * Release the recursion lock for a session.
   */
  private releaseLock(sessionId: string): void {
    this.compressLocks.delete(sessionId)
  }

  /**
   * Compress old messages if the turn interval has been reached.
   *
   * Uses a detail-preserving extraction strategy:
   *   - Short conversations (< 20 messages): single-pass with extractive prompt.
   *   - Long conversations (>= 20 messages): batch extraction (20/batch, 5 overlap)
   *     followed by a merge pass to combine batch summaries.
   *
   * CRITICAL: The recursion lock must surround the LLM call. Without it, the
   * summarization call itself would pass through the agent loop and re-trigger
   * governance (including another compression attempt), causing infinite
   * recursion → stack overflow → process crash.
   *
   * @param sessionId - the current session identifier.
   * @param messages  - the full message array (will NOT be mutated).
   * @param force - skip the round-interval check (for manual/force compress).
   * @returns compressed messages + tokens saved, or null if no compression.
   */
  /**
   * Compress old messages when token pressure warrants it.
   *
   * Trigger policy (see {@link shouldCompressHistory}): the token-pressure
   * condition dominates — once over the trigger water level the compression
   * runs as soon as the round rate limit allows, and a single-round token surge
   * (e.g. one very long thinking turn) bypasses the rate limit entirely so a
   * short-window model gets relief on the very next step.
   *
   * Uses a detail-preserving extraction strategy:
   *   - Short conversations (< 20 messages): single-pass with extractive prompt.
   *   - Long conversations (>= 20 messages): batch extraction (20/batch, 5 overlap)
   *     followed by a merge pass to combine batch summaries.
   *
   * CRITICAL: The recursion lock must surround the LLM call. Without it, the
   * summarization call itself would pass through the agent loop and re-trigger
   * governance (including another compression attempt), causing infinite
   * recursion → stack overflow → process crash.
   *
   * @param sessionId - the current session identifier.
   * @param messages  - the full message array (will NOT be mutated).
   * @param force - skip the trigger gates (for manual/force compress).
   * @param options - `window`: the session's effective model window (defaults
   *   to the globally adopted window).
   * @returns compressed messages + tokens saved, or null if no compression.
   */
  async compress(
    sessionId: string,
    messages: readonly Message[],
    force = false,
    options: CompressOptions = {},
  ): Promise<CompressResult | null> {
    const target = resolveSummarizationTarget(this.config, options.session)
    if (target === undefined) {
      this.ctx.logger.info(
        '[ContextGovernor] Compression skipped: no summarization target '
        + '(configure summarizationProvider/Model or route a request first)',
      )
      return null
    }

    const entry = this.touchSession(sessionId)
    const currentTurn = entry.turn
    if (messages.length <= this.retainRecent) return null
    const window = options.window ?? this.ctx.memoryContext.contextWindow
    const beforeTokens = this.estimateMessageTokens(messages)

    // Token-pressure trigger with surge bypass and failure cooldown. The
    // plugin's own per-turn RAG injection (spliced in after this check) is
    // reserved up front so the trigger reflects the REAL request size.
    const budget = this.tokenBudget(window)
    const triggerTokens = Math.max(0, Math.floor(budget * this.triggerRatio) - this.injectionBudget)
    const verdict = shouldCompressHistory({
      force,
      turn: currentTurn,
      lastCompressedTurn: entry.lastCompressedTurn,
      lastTokens: entry.lastTokens,
      tokens: beforeTokens,
      triggerTokens,
      windowTokens: window,
      compressInterval: this.compressInterval,
      failureCooldown: entry.failureCooldown,
    })
    entry.lastTokens = beforeTokens
    if (!verdict.compress) {
      this.ctx.logger.debug(
        `[ContextGovernor] Compression deferred (${verdict.reason}): ${beforeTokens} tokens, `
        + `trigger ${triggerTokens}, window ${window}, interval ${this.compressInterval}`,
      )
      if (verdict.reason === 'cooldown') entry.failureCooldown--
      return null
    }
    if (verdict.reason === 'surge') {
      this.ctx.logger.info(
        `[ContextGovernor] Compression surge trigger: single-round growth reached `
        + `${Math.floor(window * 0.2)}+ tokens of window ${window} — compressing off-interval`,
      )
    }

    // Acquire recursion lock — blocks re-entrant governance during summarization
    if (!this.acquireLock(sessionId)) {
      this.ctx.logger.info('[ContextGovernor] Skipping compression — lock held (recursive call)')
      return null
    }

    try {
      // Progressive compression: only the OLDEST messages needed to bring the
      // context back down to the target water level are summarized; everything
      // newer stays verbatim so recent context remains fully coherent. The
      // injection budget is reserved here too, so after the RAG splice the
      // request still lands at (not above) the target.
      const targetTokens = Math.max(0, Math.floor(budget * this.targetRatio) - this.injectionBudget)
      const toFree = beforeTokens - targetTokens

      // Walk from the oldest message forward, accumulating the oldest block
      // whose estimated tokens reach `toFree` (but never compress the recent tail).
      const compressible = messages.slice(0, -this.retainRecent)
      let cutIndex = 0
      let cutTokens = 0
      for (let i = 0; i < compressible.length; i++) {
        cutIndex = i + 1
        cutTokens += estimateContentTokens(compressible[i].content)
        if (cutTokens >= toFree) break
      }
      const oldMessages = compressible.slice(0, cutIndex)
      const keptMessages = [
        ...compressible.slice(cutIndex),
        ...messages.slice(-this.retainRecent),
      ]
      if (oldMessages.length === 0) {
        this.ctx.logger.info(
          `[ContextGovernor] Compression skipped: nothing over the ${Math.floor(budget * this.targetRatio)}-token target`,
        )
        return null
      }

      let summaryText: string

      if (oldMessages.length <= 20) {
        // Short block: single-pass extraction
        summaryText = await this.extractBatch(oldMessages, false, target)
      } else {
        // Long block: batch extraction with overlap, then merge
        const BATCH_SIZE = 20
        const OVERLAP = 5
        const batchSummaries: string[] = []

        for (let i = 0; i < oldMessages.length; i += BATCH_SIZE - OVERLAP) {
          const batch = oldMessages.slice(i, i + BATCH_SIZE)
          if (batch.length === 0) break
          const batchSummary = await this.extractBatch(batch, true, target)
          batchSummaries.push(batchSummary)
        }

        if (batchSummaries.length === 1) {
          summaryText = batchSummaries[0]
        } else {
          summaryText = await this.mergeBatches(batchSummaries, target)
        }
      }

      if (summaryText.length === 0) {
        this.ctx.logger.warn('[ContextGovernor] History compression produced empty summary')
        return null
      }

      // Build compressed message array:
      //   [summary as user message] + [kept messages verbatim]
      // DSH contract: PreStepDecision.enter requires UserMessage[] and every
      // message must carry id/content(ContentBlock[])/source — construct via
      // createUserMessage (never a bare { role, content: string } object).
      const summaryMessage = createUserMessage({
        content: [{
          type: 'text',
          text: `[Compressed history — ${oldMessages.length} earlier messages, details preserved below]\n\n${summaryText}`,
        }],
        source: { kind: 'plugin', plugin: PLUGIN },
      })
      const newMessages: Message[] = [summaryMessage, ...keptMessages.map(m => ({ ...m }))]

      const afterTokens = this.estimateMessageTokens(newMessages)
      const saved = beforeTokens - afterTokens

      // Hard guard (mirrors compaction-basic's "summary not smaller" check):
      // a summary that does not actually shrink the context is useless and
      // only wastes an LLM call — treat it as a failed compression and cool
      // down so the next steps do not burn an LLM call per turn on the same
      // unshrinkable retained tail.
      if (saved <= 0) {
        entry.failureCooldown = COMPRESS_FAILURE_COOLDOWN
        this.ctx.logger.warn(
          `[ContextGovernor] Compression rejected: summary is not smaller `
          + `(Before: ${beforeTokens}, After: ${afterTokens} tokens); `
          + `cooling down for ${COMPRESS_FAILURE_COOLDOWN} rounds`,
        )
        return null
      }

      entry.lastCompressedTurn = currentTurn
      entry.failureCooldown = 0
      this.ctx.logger.info(
        `[ContextGovernor] Compressed history: ${oldMessages.length} messages → 1 summary. `
        + `Before: ${beforeTokens} tokens, After: ${afterTokens} tokens, Freed: ${saved} tokens `
        + `(trigger reason: ${verdict.reason})`,
      )

      // Persist the compression summary as a mid memory. The live summary
      // message can still be dropped by fallback truncation later, so the
      // compressed span must remain retrievable from the memory system.
      // Best-effort: persistence failure must not fail the compression itself.
      try {
        await this.ctx.memoryContext.storeMemory(summaryText, 'mid', {
          sourceSessionId: sessionId,
          importance: 0.6,
          kind: 'project',
        })
      } catch (persistErr) {
        this.ctx.logger.warn(
          `[ContextGovernor] Compression summary persistence failed: `
          + `${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
        )
      }

      return { messages: newMessages, tokensSaved: saved }
    } catch (err) {
      entry.failureCooldown = COMPRESS_FAILURE_COOLDOWN
      this.ctx.logger.warn(
        `[ContextGovernor] History compression error: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    } finally {
      this.releaseLock(sessionId)
    }
  }

  /**
   * Force-compress with full error propagation (for tool use).
   * Unlike compress(), this never silently returns null — it throws on failure.
   */
  async compressForce(
    sessionId: string,
    messages: readonly Message[],
    options: CompressOptions = {},
  ): Promise<CompressResult> {
    const target = resolveSummarizationTarget(this.config, options.session)
    if (target === undefined) {
      throw new Error(
        'Summarizer not available: configure summarizationProvider/Model or route a request first '
        + '(the summarization target is resolved from the session model otherwise)',
      )
    }
    if (messages.length <= this.retainRecent) {
      throw new Error(`Not enough messages: ${messages.length} <= retainRecent(${this.retainRecent})`)
    }
    if (!this.acquireLock(sessionId)) {
      throw new Error('Compression lock held (another compression in progress)')
    }

    try {
      const beforeTokens = this.estimateMessageTokens(messages)
      const oldMessages = messages.slice(0, -this.retainRecent)
      const recentMessages = messages.slice(-this.retainRecent)

      let summaryText: string
      if (oldMessages.length <= 20) {
        summaryText = await this.extractBatch(oldMessages, false, target)
      } else {
        const BATCH_SIZE = 20
        const OVERLAP = 5
        const batchSummaries: string[] = []
        for (let i = 0; i < oldMessages.length; i += BATCH_SIZE - OVERLAP) {
          const batch = oldMessages.slice(i, i + BATCH_SIZE)
          if (batch.length === 0) break
          batchSummaries.push(await this.extractBatch(batch, true, target))
        }
        summaryText = batchSummaries.length === 1
          ? batchSummaries[0]
          : await this.mergeBatches(batchSummaries, target)
      }

      if (summaryText.length === 0) {
        throw new Error('LLM produced empty summary')
      }

      const summaryMessage = createUserMessage({
        content: [{
          type: 'text',
          text: `[Compressed history — ${oldMessages.length} earlier messages, details preserved below]\n\n${summaryText}`,
        }],
        source: { kind: 'plugin', plugin: PLUGIN },
      })
      const newMessages: Message[] = [summaryMessage, ...recentMessages.map(m => ({ ...m }))]
      const afterTokens = this.estimateMessageTokens(newMessages)
      const saved = beforeTokens - afterTokens

      // Hard guard (mirrors compaction-basic's "summary not smaller" check):
      // a summary that does not actually shrink the context is useless — fail
      // loudly so the caller (tool) sees why compression did not help.
      if (saved <= 0) {
        throw new Error(
          `Compression rejected: summary is not smaller (Before: ${beforeTokens}, After: ${afterTokens} tokens)`,
        )
      }

      this.ctx.logger.info(
        `[ContextGovernor] Force compressed: ${oldMessages.length} msgs → 1 summary. Before: ${beforeTokens}, After: ${afterTokens}, Freed: ${saved}`,
      )
      return { messages: newMessages, tokensSaved: saved }
    } finally {
      this.releaseLock(sessionId)
    }
  }

  /**
   * Estimate total tokens across a message array using the CJK-aware heuristic.
   */
  private estimateMessageTokens(messages: readonly { role: string; content: unknown }[]): number {
    let total = 0
    for (const msg of messages) {
      total += estimateContentTokens(msg.content)
    }
    return total
  }

  /**
   * Periodic cleanup: remove stale session counters (>1 hour inactive).
   * Call from the pre-step hook to prevent unbounded memory growth.
   */
  cleanupStale(): void {
    const now = Date.now()
    const staleThreshold = 3600_000 // 1 hour
    for (const [sessionId, entry] of this.turnCounters) {
      if (now - entry.lastActive > staleThreshold) {
        this.turnCounters.delete(sessionId)
      }
    }
  }

  /**
   * Extract structured information from a batch of messages.
   * Detail-preserving: keeps code, file paths, decisions, and tool results verbatim.
   *
   * @param messages - the messages to extract from.
   * @param isBatch - true if this is one batch of a larger conversation (affects prompt wording).
   * @returns extracted structured text.
   */
  private async extractBatch(
    messages: readonly { role: string; content: unknown }[],
    isBatch: boolean,
    target: SummarizationTarget,
  ): Promise<string> {
    const serialized = serializeMessagesForSummary(messages)
    const inputTokens = estimateTokens(serialized)
    const targetTokens = summarizationTargetTokens(this.config, inputTokens)
    const batchLabel = isBatch ? ' (this is one segment of a longer conversation)' : ''

    const prompt = [
      `You are a detail-preserving conversation archiver${batchLabel}.`,
      'Extract ALL substantive information from this conversation into a structured record.',
      '',
      `Output budget: the input is ~${inputTokens} tokens. Aim for ~${targetTokens} tokens of`,
      'output (a dense ~30% compression). Stay well under this; do not pad or repeat.',
      '',
      'Rules:',
      '- PRESERVE verbatim: code snippets, file paths, function names, variable names, config values, error messages, API responses',
      '- PRESERVE: every decision made and the reasoning behind it',
      '- PRESERVE: every problem encountered and how it was resolved',
      '- PRESERVE: tool call inputs/outputs that contain useful data',
      '- PRESERVE: user requirements and constraints exactly as stated',
      '- PRESERVE the original language of each statement — do NOT translate',
      '- DROP only: greetings/farewells, repetitive phrasing, formatting whitespace',
      '- NEVER paraphrase code or technical terms',
      '- NEVER invent facts that are not present in the conversation',
      '- Use bullet points for scannability',
      '',
      'Format EXACTLY as (use these headings verbatim, in this order; skip a section',
      'entirely if it has no content):',
      '## Goals & Requirements',
      '(what the user wanted, verbatim constraints)',
      '',
      '## Key Decisions',
      '(decision + reasoning, for each)',
      '',
      '## File Changes',
      '(file path: what changed, for each file)',
      '',
      '## Code & Config',
      '(important code snippets, configs, commands — verbatim, wrapped in ``` fences)',
      '',
      '## Problems & Solutions',
      '(problem → root cause → fix, for each)',
      '',
      '## Tool Results',
      '(important outputs from tool calls)',
      '',
      '## Open Questions',
      '(anything unresolved)',
      '',
      'Conversation:',
      '',
      serialized,
    ].join('\n')

    return this.llmSummarize(prompt, target)
  }

  /**
   * Merge multiple batch summaries into a single unified record.
   * De-duplicates across batches and preserves all unique details.
   *
   * @param batchSummaries - the per-batch extracted summaries.
   * @returns merged structured summary.
   */
  private async mergeBatches(
    batchSummaries: readonly string[],
    target: SummarizationTarget,
  ): Promise<string> {
    const combined = batchSummaries
      .map((s, i) => `--- Segment ${i + 1} ---\n${s}`)
      .join('\n\n')
    const inputTokens = estimateTokens(combined)
    const targetTokens = summarizationTargetTokens(this.config, inputTokens)

    const prompt = [
      'You are merging multiple conversation segments into one unified record.',
      'Combine the information below into a SINGLE structured document.',
      '',
      `Output budget: the input is ~${inputTokens} tokens. Aim for ~${targetTokens} tokens of`,
      'output. Merge aggressively to avoid bloat, but keep every unique fact.',
      '',
      'Rules:',
      '- PRESERVE ALL details from every segment — nothing should be dropped',
      '- De-duplicate: if the same fact appears in multiple segments, keep it once',
      '- If segments have overlapping content (from the overlap window), merge them coherently',
      '- When two segments conflict, keep the more specific/later statement and note the discrepancy',
      '- PRESERVE the original language of each statement — do NOT translate',
      '- NEVER invent facts that are not present in the segments',
      '- Maintain the same section structure (Goals, Decisions, Files, Code, Problems, Tools, Questions)',
      '- Order information chronologically within each section',
      '- Use the exact section headings: ## Goals & Requirements, ## Key Decisions, ## File Changes,',
      '  ## Code & Config, ## Problems & Solutions, ## Tool Results, ## Open Questions',
      '',
      'Segments to merge:',
      '',
      combined,
    ].join('\n')

    return this.llmSummarize(prompt, target)
  }

  /**
   * Call the LLM with a prompt and return the text result.
   * Shared by extractBatch and mergeBatches.
   */
  private async llmSummarize(prompt: string, target: SummarizationTarget): Promise<string> {
    const assembler = new BlockAssembler()
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: PLUGIN },
      })],
      maxTokens: this.config.maxTokens,
      purpose: 'compaction',
    }

    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) {
      throw new Error(`LLM summarization failed: ${error.message}`)
    }

    return assembler.blocks()
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim()
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
    let total = 0
    for (const msg of msgs) total += estimateTokens(messageText(msg))
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
    // Last resort: truncate the oldest remaining message's content.
    // Rebuild the message instead of mutating the readonly `content` field,
    // and keep the DSH Message contract (content: ContentBlock[]).
    const oldest = result[0]
    if (oldest !== undefined && result.length > 1) {
      const text = messageText(oldest)
      const overBy = tokens - tokenBudget
      const charsToDrop = overBy * 4 // rough reverse estimate
      if (charsToDrop > 0 && charsToDrop < text.length) {
        const kept = text.slice(charsToDrop)
        result[0] = { ...oldest, content: [{ type: 'text', text: kept }] }
      }
    }
  }

  return result
}

/* -------------------------------------------------------------------------- */
/*  MemoryCompactionEngine — the Cordis entry point                            */
/* -------------------------------------------------------------------------- */

/** The multi-tier memory compaction backend. */
export class MemoryCompactionEngine extends BasicCompactionEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions', 'memoryContext']

  static override Config: z<MemoryCompactionConfig> = MemoryCompactionConfigSchema

  private readonly retrieval: ResolvedRetrievalOptions
  private readonly lastInjectedTurn = new WeakMap<Session, number>()
  /**
   * Per-session set of memory ids injected in the most recent turn. Used to
   * avoid re-injecting the same memories every turn (cross-turn de-dup),
   * which would bloat the context and accumulate contradictions.
   */
  private readonly lastInjectedIds = new WeakMap<Session, ReadonlySet<string>>()
  /** Last forced narrowed-window pressure compaction per session (epoch ms). */
  private readonly lastForceAt = new Map<string, number>()
  /** Whether the narrowed-window (probe/override) compaction override is on. */
  private readonly dynamicThreshold: boolean
  /** Public so memoryContext can reference it for force-compress. */
  readonly compressor: HistoryCompressor
  private readonly retriever: VectorRetriever
  private readonly sanitizerConfig: SanitizerConfig
  /** Recent messages kept verbatim by compression/truncation. */
  private readonly retainRecent: number
  /** Reserved tokens for the plugin's own per-turn RAG injection. */
  private readonly injectionBudget: number

  /**
   * @param ctx - the plugin context.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: MemoryCompactionConfig) {
    // Strip ALL plugin-specific fields before passing to BasicCompactionEngine.
    // DSH插件开发经验: unresolved keys cause config validation failure → plugin fails to load.
    const {
      retrieval,
      compress_round_interval,
      compress_trigger_ratio,
      compress_target_ratio,
      compaction_dynamic_threshold,
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
      ...basicConfig
    } = config
    super(ctx, basicConfig as BasicCompactionConfig)
    this.retrieval = resolveRetrievalOptions(config)

    // Provide the pyramid-consolidation summarizer to the memory context.
    ctx.memoryContext.setSummarizer((texts, purpose, target) =>
      summarizeMemoriesWithLlm(ctx, this.config, texts, purpose, target),
    )

    // Initialize the history compressor (Strategy 1).
    // Token-pressure trigger (compress_trigger_ratio) delays compression while
    // the context is roomy; the target water level (compress_target_ratio)
    // makes compression progressive (only the oldest overflow is summarized).
    const compressInterval = compress_round_interval ?? 7
    const retainRecent = retain_recent_messages ?? 4
    const injectionBudget = rag_token_budget ?? 3000
    this.retainRecent = retainRecent
    this.injectionBudget = injectionBudget
    this.dynamicThreshold = compaction_dynamic_threshold ?? true
    this.compressor = new HistoryCompressor(
      ctx,
      this.config,
      compressInterval,
      retainRecent,
      compress_trigger_ratio ?? 0.85,
      compress_target_ratio ?? 0.6,
      injectionBudget,
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
    }
    this.retriever = new VectorRetriever(ctx, retrieverConfig)

    // Register back-reference so tools.ts can reach the compressor for force-compress
    // and reuse the configured retriever for ingestion (single config source).
    ctx.memoryContext.compactionEngine = { compressor: this.compressor }
    ctx.memoryContext.retriever = { ingest: (text, source) => this.retriever.ingest(text, source) }

    // Wire Strategy 3 (output sanitization + ingestion): observe every settled
    // tool call, sanitize its result, and ingest it into the vector memory so
    // useful tool outputs survive for later retrieval. Listener failures are
    // contained by onToolResult's own try/catch.
    ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
      if (exec.signal.aborted) return
      const text = result.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
      if (text.length === 0) return
      void this.onToolResult(exec.name, text)
    })

    // Always register the governance hook: it also drives history compression
    // (Strategy 1) and model-context adoption (G8) — both must keep working
    // when RAG retrieval is disabled. The RAG section gates itself inside.
    this.registerRetrieval(ctx)
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
    if (trigger === 'pressure' && this.dynamicThreshold && !signal.aborted) {
      const handled = await this.forceNarrowedPressure(agent, signal)
      if (handled !== undefined) return handled
    }
    return super.compactIfNeeded(agent, trigger, signal)
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
      const decision = decidePressureCompaction({
        declaredWindow: declared,
        narrowedWindow: narrowed,
        measuredTokens: measurement.totalTokens,
        thresholdRatio: this.thresholdRatioFor(target),
      })
      if (decision.mode === 'skip') {
        this.ctx.logger.debug(
          `[ContextGovernor] Pressure below narrowed threshold: ${measurement.totalTokens} < `
          + `${decision.thresholdTokens} (model=${target.model}, window=${narrowed})`,
        )
        return null
      }
      if (decision.mode !== 'force') return undefined
      const key = String(agent.session.id)
      const now = Date.now()
      if (now - (this.lastForceAt.get(key) ?? 0) < FORCED_PRESSURE_COOLDOWN_MS) return null
      this.lastForceAt.set(key, now)
      this.ctx.logger.info(
        `[ContextGovernor] Narrowed-window pressure: ${measurement.totalTokens} tokens >= `
        + `${decision.thresholdTokens} threshold (model=${target.model}, real window ${narrowed} `
        + `< declared ${declared ?? 'unknown'}); forcing balanced compaction`,
      )
      return await super.compactIfNeeded(agent, 'context-overflow', signal)
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

  /** The compaction threshold ratio the base policy resolves for this target. */
  private thresholdRatioFor(target: { provider: string; model: string }): number {
    const override = this.config.modelPolicies.find(
      policy => policy.provider === target.provider && policy.model === target.model,
    )
    return override?.thresholdRatio ?? this.config.thresholdRatio
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
    const result = await super.summarize(input, agent, signal)
    try {
      const text = result.summary
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
      if (text.length > 0) {
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
          `memory pyramid consolidated ${rebalance.pyramid.droppedMids.length} mid memories into one long memory`,
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
   * Error-isolated: failures never block the main flow.
   */
  async onToolResult(source: string, rawResult: unknown): Promise<void> {
    try {
      const sanitized = sanitizeToolResult(rawResult, source, this.sanitizerConfig)
      const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized)
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
      // Periodic cleanup of stale session counters
      this.compressor.cleanupStale()

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

        // --- Strategy 1: History compression (recursion-locked) ---
        const compressResult = await this.compressor.compress(
          sessionId,
          currentMessages,
          false,
          { window: effectiveWindow, session },
        )
        if (compressResult !== null) {
          currentMessages = [...compressResult.messages]
        }

        // --- Strategy 4: RAG retrieval injection (gated on retrieval config;
        // compression and CTX adoption above stay active regardless) ---
        if (this.retrieval.enabled) {
          // Cap the injection at a share of the session's REAL window so a
          // short-context local model keeps room for the conversation itself
          // (the configured rag_token_budget remains the ceiling for large
          // windows).
          const injectionCap = Math.min(
            this.injectionBudget,
            Math.max(256, Math.floor(effectiveWindow * RAG_WINDOW_SHARE)),
          )
          const userText = this.latestUserText(currentMessages)
          let memoryMessage: UserMessage | undefined
          if (userText !== undefined) {
            const excludeIds = this.lastInjectedIds.get(session)
            const retrieval = await this.retriever.retrieve(userText, excludeIds, injectionCap)
            if (retrieval !== null) {
              memoryMessage = retrieval.message
              this.lastInjectedIds.set(session, new Set(retrieval.ids))
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

          // Insert the memory background BEFORE the latest user message so the
          // model reads it as context, not as a new user input appended after
          // the question (which would break instruction ordering).
          if (memoryMessage !== undefined) {
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
              memoryMessage,
              ...currentMessages.slice(insertAt),
            ]
          }
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
