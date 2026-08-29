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
 *   5. Output sanitization: tool results are cleaned before entering context.
 *   6. Fallback truncation: if still over budget, oldest messages are dropped.
 *
 * @module dsh-infinite-context/memory-compaction
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig, ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
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
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_INGEST_DENYLIST,
  MemoryCompactionConfigSchema,
  resolveRetrievalOptions,
  type MemoryCompactionConfig,
  type ResolvedRetrievalOptions,
} from './config.ts'
import { estimateTokens } from './token-budget.ts'
import { sanitizeToolResult, type SanitizerConfig } from './OutputSanitizer.ts'
import { VectorRetriever, type VectorRetrieverConfig } from './VectorRetriever.ts'

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
  signal?: AbortSignal,
): Promise<string> {
  const { summarizationProvider: provider, summarizationModel: model } = config
  if (provider.length === 0 || model.length === 0) {
    throw new Error(
      'memory pyramid consolidation requires summarizationProvider and summarizationModel to be configured',
    )
  }
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
}

/** Result of a compression operation. */
export interface CompressResult {
  messages: readonly Message[]
  tokensSaved: number
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

  constructor(
    ctx: Context,
    config: ResolvedConfig,
    compressInterval: number,
    retainRecent: number,
    triggerRatio = 0.85,
    targetRatio = 0.6,
  ) {
    this.ctx = ctx
    this.config = config
    this.compressInterval = compressInterval
    this.retainRecent = retainRecent
    this.triggerRatio = triggerRatio
    this.targetRatio = targetRatio
  }

  /** The effective token budget: context window minus headroom. */
  tokenBudget(): number {
    const window = this.ctx.memoryContext.contextWindow
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
   * Increment the turn counter for a session and return the new count.
   * Initializes to 0 if the session has never been seen.
   */
  private incrementAndGetTurn(sessionId: string): number {
    const entry = this.turnCounters.get(sessionId)
    const now = Date.now()
    if (entry === undefined) {
      this.turnCounters.set(sessionId, { turn: 1, lastActive: now })
      return 1
    }
    entry.turn++
    entry.lastActive = now
    return entry.turn
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
  async compress(sessionId: string, messages: readonly Message[], force = false): Promise<CompressResult | null> {
    if (!this.available()) return null

    const currentTurn = this.incrementAndGetTurn(sessionId)
    if (messages.length <= this.retainRecent) return null
    const beforeTokens = this.estimateMessageTokens(messages)

    // Token-pressure trigger: compress only when the round interval has
    // elapsed AND the context is actually over the trigger water level.
    // This delays compression while the context is still roomy, preserving
    // more verbatim history for as long as possible.
    if (!force) {
      if (currentTurn % this.compressInterval !== 0) return null
      const budget = this.tokenBudget()
      if (beforeTokens <= budget * this.triggerRatio) {
        this.ctx.logger.debug(
          `[ContextGovernor] Compression deferred: ${beforeTokens} tokens <= `
          + `${Math.floor(budget * this.triggerRatio)} trigger (interval reached)`,
        )
        return null
      }
    }

    // Acquire recursion lock — blocks re-entrant governance during summarization
    if (!this.acquireLock(sessionId)) {
      this.ctx.logger.info('[ContextGovernor] Skipping compression — lock held (recursive call)')
      return null
    }

    try {
      // Progressive compression: only the OLDEST messages needed to bring the
      // context back down to the target water level are summarized; everything
      // newer stays verbatim so recent context remains fully coherent.
      const budget = this.tokenBudget()
      const targetTokens = Math.floor(budget * this.targetRatio)
      const toFree = beforeTokens - targetTokens

      // Walk from the oldest message forward, accumulating the oldest block
      // whose estimated tokens reach `toFree` (but never compress the recent tail).
      const compressible = messages.slice(0, -this.retainRecent)
      let cutIndex = 0
      let cutTokens = 0
      for (let i = 0; i < compressible.length; i++) {
        cutIndex = i + 1
        cutTokens += estimateTokens(messageText(compressible[i]))
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
        summaryText = await this.extractBatch(oldMessages, false)
      } else {
        // Long block: batch extraction with overlap, then merge
        const BATCH_SIZE = 20
        const OVERLAP = 5
        const batchSummaries: string[] = []

        for (let i = 0; i < oldMessages.length; i += BATCH_SIZE - OVERLAP) {
          const batch = oldMessages.slice(i, i + BATCH_SIZE)
          if (batch.length === 0) break
          const batchSummary = await this.extractBatch(batch, true)
          batchSummaries.push(batchSummary)
        }

        if (batchSummaries.length === 1) {
          summaryText = batchSummaries[0]
        } else {
          summaryText = await this.mergeBatches(batchSummaries)
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
      // only wastes an LLM call — treat it as a failed compression.
      if (saved <= 0) {
        this.ctx.logger.warn(
          `[ContextGovernor] Compression rejected: summary is not smaller `
          + `(Before: ${beforeTokens}, After: ${afterTokens} tokens)`,
        )
        return null
      }

      this.ctx.logger.info(
        `[ContextGovernor] Compressed history: ${oldMessages.length} messages → 1 summary. `
        + `Before: ${beforeTokens} tokens, After: ${afterTokens} tokens, Freed: ${saved} tokens`,
      )

      return { messages: newMessages, tokensSaved: saved }
    } catch (err) {
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
  async compressForce(sessionId: string, messages: readonly Message[]): Promise<CompressResult> {
    if (!this.available()) {
      throw new Error('Summarizer not available (provider/model not configured)')
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
        summaryText = await this.extractBatch(oldMessages, false)
      } else {
        const BATCH_SIZE = 20
        const OVERLAP = 5
        const batchSummaries: string[] = []
        for (let i = 0; i < oldMessages.length; i += BATCH_SIZE - OVERLAP) {
          const batch = oldMessages.slice(i, i + BATCH_SIZE)
          if (batch.length === 0) break
          batchSummaries.push(await this.extractBatch(batch, true))
        }
        summaryText = batchSummaries.length === 1
          ? batchSummaries[0]
          : await this.mergeBatches(batchSummaries)
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
      total += estimateTokens(msg.role)
      const text = messageText(msg)
      total += estimateTokens(text)
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

    return this.llmSummarize(prompt)
  }

  /**
   * Merge multiple batch summaries into a single unified record.
   * De-duplicates across batches and preserves all unique details.
   *
   * @param batchSummaries - the per-batch extracted summaries.
   * @returns merged structured summary.
   */
  private async mergeBatches(batchSummaries: readonly string[]): Promise<string> {
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

    return this.llmSummarize(prompt)
  }

  /**
   * Call the LLM with a prompt and return the text result.
   * Shared by extractBatch and mergeBatches.
   */
  private async llmSummarize(prompt: string): Promise<string> {
    const assembler = new BlockAssembler()
    const options: GenerateOptions = {
      provider: this.config.summarizationProvider,
      model: this.config.summarizationModel,
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
  /** Public so memoryContext can reference it for force-compress. */
  readonly compressor: HistoryCompressor
  private readonly retriever: VectorRetriever
  private readonly sanitizerConfig: SanitizerConfig
  /** Recent messages kept verbatim by compression/truncation. */
  private readonly retainRecent: number

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
    ctx.memoryContext.setSummarizer((texts, purpose) =>
      summarizeMemoriesWithLlm(ctx, this.config, texts, purpose),
    )

    // Initialize the history compressor (Strategy 1).
    // Token-pressure trigger (compress_trigger_ratio) delays compression while
    // the context is roomy; the target water level (compress_target_ratio)
    // makes compression progressive (only the oldest overflow is summarized).
    const compressInterval = compress_round_interval ?? 7
    const retainRecent = retain_recent_messages ?? 4
    this.retainRecent = retainRecent
    this.compressor = new HistoryCompressor(
      ctx,
      this.config,
      compressInterval,
      retainRecent,
      compress_trigger_ratio ?? 0.85,
      compress_target_ratio ?? 0.6,
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

    if (this.retrieval.enabled) this.registerRetrieval(ctx)
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
      const rebalance = await this.ctx.memoryContext.rebalance()
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

  /** Register the per-turn retrieval + compression injection (the governance hook). */
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
        // configured window when DSH has not resolved one yet.
        const requestContext = session.requestContext()
        if (requestContext !== undefined) {
          ctx.memoryContext.observeRequestContext({
            ...requestContext.provider === undefined ? {} : { provider: requestContext.provider },
            ...requestContext.model === undefined ? {} : { model: requestContext.model },
            ...requestContext.contextWindow === undefined ? {} : { contextWindow: requestContext.contextWindow },
          })
        }
        // Deep copy here to avoid side effects.
        // Type is Message[] (not UserMessage[]) because compression injects a
        // user-role summary and fallbackTruncate can reshape the array; the
        // final PreStepDecision cast to UserMessage[] is intentional — every
        // message we keep or inject is user-role by construction.
        let currentMessages: Message[] = decision.messages.map(m => ({ ...m }))

        // --- Strategy 1: History compression (recursion-locked) ---
        const compressResult = await this.compressor.compress(sessionId, currentMessages)
        if (compressResult !== null) {
          currentMessages = [...compressResult.messages]
        }

        // --- Strategy 4: RAG retrieval injection ---
        const userText = this.latestUserText(currentMessages)
        let memoryMessage: UserMessage | undefined
        if (userText !== undefined) {
          const excludeIds = this.lastInjectedIds.get(session)
          const retrieval = await this.retriever.retrieve(userText, excludeIds)
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

        // --- Fallback truncation (Strategy 2 — deterministic last resort) ---
        // Budget: context window minus headroom (same factor as the
        // compressor's tokenBudget()).
        const headroom = ctx.memoryContext.headroomRatio ?? 0.25
        const tokenBudget = Math.floor(ctx.memoryContext.contextWindow * (1 - headroom))
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
