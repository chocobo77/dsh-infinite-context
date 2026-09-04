/**
 * Mid-thinking context guard: intervene in the agent's LLM generation BEFORE
 * the current model's real context window is exhausted — even while the model
 * is deep-thinking.
 *
 * DSH already recovers from a provider-confirmed context overflow: an
 * `agent/request-error` with code `CONTEXT_WINDOW_EXCEEDED` makes the
 * compaction engine durably replace the surface and return `{kind: 'retry'}`
 * so the request restarts from the compacted context. The problem is that the
 * provider error only arrives AFTER the model has already tried (and often
 * failed or silently truncated) against a context it cannot hold — a takeover
 * of a large project or another model's conversation reaches that point
 * before the agent has even produced useful output.
 *
 * This module wraps the `llm/stream` waterfall for AGENT-LOOP requests only
 * (`isAgentLoopRequest` — the plugin's own summarization calls are never
 * marked and are skipped). It estimates the request's input tokens, tracks
 * output tokens as the chunks flow, and when they approach the ceiling injects
 * a terminal `CONTEXT_WINDOW_EXCEEDED` finish chunk. The agent loop then takes
 * the exact same path as a provider overflow: compact durably → retry with
 * room.
 *
 * ## The dynamic trigger line
 *
 * The plugin can only "take a breath" (compact) if the CURRENT model still has
 * enough REMAINING context to run the compression itself: the compaction
 * replays the compactable surface (≈ the request input) through a summarizer
 * call and must fit that input + the summary output + the system/tools prefix
 * in the window. So the guard fires when
 *
 *   input + output >= window − reserve
 *
 * where the reserve is DYNAMIC:
 *
 *   reserve = systemToolsTokens + summaryOutputEstimate + GUARD_MARGIN
 *
 * — it grows with the current request's own system/tools size and with the
 * summary the compaction would need to produce for this input, and it follows
 * whichever model the session is calling right now (live probe for local /
 * settings declaration for online, via the per-model registry). A takeover
 * whose input is ALREADY over the line is compacted before any output, so the
 * agent never wastes a generation it cannot finish.
 *
 * The pure decision helpers are exported for unit testing; the cordis wiring
 * lives in {@link registerThinkingGuard}.
 *
 * @module dsh-infinite-context/thinking-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import { CONTEXT_WINDOW_EXCEEDED_CODE, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { estimateContentTokens, estimateTokens } from './token-budget.ts'

/** Default ceiling: the guard never waits past this fraction of the window. */
export const DEFAULT_GUARD_RATIO = 0.9

/** Fixed safety margin reserved beyond system/tools + the summary output. */
export const GUARD_MARGIN = 2048

/** Minimum summary-output estimate the reserve always carries. */
const MIN_SUMMARY_OUTPUT = 300

/** Clamp a configured guard ratio into the supported range. */
export function clampGuardRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_GUARD_RATIO
  return Math.min(0.99, Math.max(0.5, ratio))
}

/**
 * Output-token delta contributed by one stream chunk. Text / reasoning /
 * tool-call deltas are metered with the plugin's CJK-aware estimator; every
 * other chunk type (block boundaries, usage, finish) adds nothing.
 */
export function estimateOutputDelta(chunk: StreamChunk): number {
  switch (chunk.type) {
    case 'text-delta':
      return estimateTokens(chunk.text)
    case 'reasoning-delta':
      return estimateTokens(chunk.text)
    case 'tool-call-delta':
      return estimateTokens(chunk.argumentsDelta)
    default:
      return 0
  }
}

/**
 * Estimated input tokens of one request envelope: rendered system prompt +
 * serialized tool schemas + every message's content (image blocks included).
 * Deliberately conservative (over-estimates) so the guard fires early.
 */
export function estimateRequestTokens(request: {
  system?: string
  tools?: readonly object[]
  messages: readonly { content: unknown }[]
}): number {
  let total = 0
  if (request.system !== undefined && request.system.length > 0) {
    total += estimateTokens(request.system)
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    total += estimateTokens(JSON.stringify(request.tools)) + 64 * request.tools.length
  }
  for (const message of request.messages) {
    total += estimateContentTokens(message.content)
  }
  return total
}

/**
 * Estimated tokens of the system prompt + tool schemas only (the compaction
 * prefix that is replayed alongside the compactable region).
 */
export function estimateSystemToolsTokens(request: {
  system?: string
  tools?: readonly object[]
}): number {
  let total = 0
  if (request.system !== undefined && request.system.length > 0) {
    total += estimateTokens(request.system)
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    total += estimateTokens(JSON.stringify(request.tools)) + 64 * request.tools.length
  }
  return total
}

/**
 * Estimate the summary the compaction would need to produce for an input of
 * `inputTokens`: a dense ~30% compression, clamped to a safety margin below
 * `maxTokens` (mirrors the plugin's summarization target).
 */
export function estimateSummaryOutputTokens(inputTokens: number, maxTokens = 8192): number {
  const cap = Math.max(400, Math.floor((maxTokens > 0 ? maxTokens : 8192) * 0.7))
  return Math.min(cap, Math.max(MIN_SUMMARY_OUTPUT, Math.floor(inputTokens * 0.3)))
}

/**
 * Compute the dynamic trigger line (in tokens) for one request:
 *
 *   line = min(window − reserve, floor(window × ratio))
 *
 * `window − reserve` guarantees the CURRENT model's remaining context after the
 * trigger is enough to run the plugin's own compression (system/tools + the
 * summary replay + a fixed margin); `floor(window × ratio)` is the ceiling so
 * the guard never waits past `ratio` of the window even when the reserve is
 * tiny. Returns `undefined` when the window is unknown or non-positive.
 */
export function computeGuardLine(
  window: number,
  inputTokens: number,
  systemToolsTokens: number,
  maxTokens: number,
  ratio: number,
): number | undefined {
  if (!Number.isFinite(window) || window <= 0) return undefined
  if (inputTokens < 0 || systemToolsTokens < 0) return undefined
  const reserve = systemToolsTokens + estimateSummaryOutputTokens(inputTokens, maxTokens) + GUARD_MARGIN
  const ceiling = Math.floor(window * clampGuardRatio(ratio))
  const dynamicLine = Math.floor(window - reserve)
  return Math.max(1, Math.min(dynamicLine, ceiling))
}

/**
 * Whether the guard should fire: estimated input + output so far reached the
 * dynamic trigger line.
 */
export function decideGuardTrigger(
  inputTokens: number,
  outputTokens: number,
  guardLine: number | undefined,
): boolean {
  if (guardLine === undefined || guardLine <= 0) return false
  if (inputTokens < 0 || outputTokens < 0) return false
  return inputTokens + outputTokens >= guardLine
}

/** The terminal chunk that reuses DSH's context-overflow recovery path. */
export function overflowFinishChunk(message: string): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message },
    },
  }
}

/** Options for {@link guardedStream}. */
export interface GuardedStreamOptions {
  /** Estimated input tokens of the request (included in the trigger line). */
  readonly inputTokens: number
  /** The dynamic trigger line (tokens, input + output) the guard fires at. */
  readonly guardLine: number
  /** Per-chunk output-token estimator (defaults to {@link estimateOutputDelta}). */
  readonly estimateDelta?: (chunk: StreamChunk) => number
  /** Diagnostics hook fired once when the guard triggers. */
  readonly onTrigger?: (outputTokens: number, guardLine: number) => void
}

/**
 * Wrap the adapter's chunk stream: pass chunks through while metering output,
 * and once `input + output` crosses `guardLine`, yield a terminal
 * `CONTEXT_WINDOW_EXCEEDED` finish and stop — dropping only the chunk that
 * crossed the line. The dropped prefix is discarded by the retry anyway
 * (the request restarts from the compacted surface).
 */
export async function* guardedStream(
  inner: AsyncIterable<StreamChunk>,
  options: GuardedStreamOptions,
): AsyncGenerator<StreamChunk> {
  const estimate = options.estimateDelta ?? estimateOutputDelta
  let outputTokens = 0
  for await (const chunk of inner) {
    outputTokens += estimate(chunk)
    if (decideGuardTrigger(options.inputTokens, outputTokens, options.guardLine)) {
      options.onTrigger?.(outputTokens, options.guardLine)
      yield overflowFinishChunk(
        `mid-thinking context guard: input ~${options.inputTokens} + output ~${outputTokens} reached `
          + `the dynamic line ${options.guardLine}; compacting durably and retrying with room`,
      )
      return
    }
    yield chunk
  }
}

/** Dependencies the cordis wiring needs (injected for testability). */
export interface ThinkingGuardDeps {
  /** Whether the guard is enabled by configuration. */
  readonly enabled: boolean
  /** The configured ceiling ratio (clamped internally). */
  readonly ratio: number
  /** The configured summarization max output (for the summary reserve). */
  readonly maxTokens: number
  /** Exact-agent-request test (`isAgentLoopRequest`); false skips the guard. */
  readonly isAgentLoopRequest: (request: GenerateOptions) => boolean
  /**
   * Resolve the CURRENT routed model's real context window for a session id,
   * or `undefined` when it cannot be determined (guard stays silent).
   */
  readonly windowForSession: (sessionId: string) => number | undefined
  /** Warning sink for guard events. */
  readonly log: (message: string) => void
}

/**
 * Register the `llm/stream` waterfall listener that enforces the mid-thinking
 * guard. Returns the cordis dispose function.
 * @param ctx - the plugin context.
 * @param deps - guard configuration and session/window resolution.
 * @returns a dispose function unregistering the listener.
 */
export function registerThinkingGuard(ctx: Context, deps: ThinkingGuardDeps): () => void {
  return ctx.on('llm/stream', (options: GenerateOptions, next) => {
    if (!deps.enabled) return next()
    // Only agent-loop requests are guarded; the plugin's own summarization
    // calls (purpose 'compaction') are never marked and pass through.
    if (!deps.isAgentLoopRequest(options)) return next()
    if (options.sessionId === undefined || options.sessionId.length === 0) return next()
    const window = deps.windowForSession(options.sessionId)
    if (window === undefined || window <= 0) return next()
    const inputTokens = estimateRequestTokens(options)
    const systemToolsTokens = estimateSystemToolsTokens(options)
    const guardLine = computeGuardLine(window, inputTokens, systemToolsTokens, deps.maxTokens, deps.ratio)
    if (guardLine === undefined) return next()
    if (inputTokens >= guardLine) {
      // Takeover backstop: the input ALONE already reaches the dynamic line —
      // force the durable compaction before any generation instead of
      // streaming one useless (and failing) model call.
      deps.log(
        `[ContextGovernor] Thinking guard: input ~${inputTokens} tokens already over the `
          + `dynamic line ${guardLine} (window ${window}); compacting before generation`,
      )
      return (async function* () {
        yield overflowFinishChunk(
          `mid-thinking context guard: input ~${inputTokens} tokens already over the dynamic line `
          + `${guardLine} (window ${window}); compacting durably before generation`,
        )
      })()
    }
    const onTrigger = (outputTokens: number, line: number): void => {
      deps.log(
        `[ContextGovernor] Thinking guard triggered mid-generation: output ~${outputTokens} reached `
          + `the dynamic line ${line} (window ${window}, reserve ${window - line}); compacting durably and retrying`,
      )
    }
    return guardedStream(next(), { inputTokens, guardLine, onTrigger })
  })
}
