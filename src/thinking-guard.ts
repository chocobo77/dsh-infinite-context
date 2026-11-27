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
 * ## The guard line
 *
 * The line is the request's PHYSICAL fit boundary:
 *
 *   line = min(window − completionReserve − GUARD_MARGIN, floor(window × ratio))
 *
 * The guard is a pre-flight impossibility door, not a routine compactor: it
 * aborts only when input plus the completion the request needs cannot fit the
 * window — the point where sending is guaranteed to fail and the durable lane
 * is the only way out. Routine pressure belongs to the fold lane, whose
 * trigger sits far below this line by design; the guard deliberately does not
 * compete with it. (2026-11-27: the earlier line reserved replay room for the
 * guard's own compaction — system/tools + a 30% summary estimate — and sat at
 * 43% of the window; fresh sessions with a large fixed prefix aborted into an
 * unwinnable compaction spiral: foldable surface 351 tokens against a
 * required removal of 8,271.)
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

/** Fixed safety margin reserved beyond the completion. */
export const GUARD_MARGIN = 2048

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
 * Compute the guard line (in tokens) for one request — the PHYSICAL fit
 * boundary of the current model:
 *
 *   line = min(window − completionReserve − GUARD_MARGIN, floor(window × ratio))
 *
 * The guard is a pre-flight impossibility door, not a routine compactor: it
 * aborts only when input plus the completion the request needs cannot fit the
 * window — the point where sending is guaranteed to fail and the durable lane
 * is the only way out. Routine pressure belongs to the fold lane, whose
 * trigger sits far below this line by design.
 *
 * The completion reserve models the REQUEST's own cap: a `maxTokens` at or
 * above the whole window is the "never truncate" declaration and carries no
 * information about the next completion (placeholder 8192); otherwise it is
 * honored but never above a quarter of the window. The earlier line reserved
 * replay room for the guard's own compaction (system/tools + a 30% summary
 * estimate) — with the summarizer running as its own small request that
 * reserve was obsolete, and on the 2026-11-27 deployment it pushed the line
 * to 27,750 against a 65,536-token server: a perfectly servable 37,731-token
 * opening request was aborted into an unwinnable compaction spiral (foldable
 * surface: 351 tokens; required removal: 8,272). Returns `undefined` when the
 * window is unknown, non-positive, or so small that the line cannot rise
 * above the fixed system/tools prefix (no compaction can rescue such a
 * request, so a trigger would fire forever).
 */
export function computeGuardLine(
  window: number,
  systemToolsTokens: number,
  maxTokens: number,
  ratio: number,
): number | undefined {
  if (!Number.isFinite(window) || window <= 0) return undefined
  if (systemToolsTokens < 0) return undefined
  const requested = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0
  // At/above the window: "never truncate" — the declaration carries no
  // information about how much room the next completion needs; assume a
  // generous agent output instead.
  const placeholder = requested === 0 || requested >= window ? 8192 : requested
  const completionReserve = Math.min(placeholder, Math.floor(window * 0.25))
  const ceiling = Math.floor(window * clampGuardRatio(ratio))
  const line = Math.floor(window - completionReserve - GUARD_MARGIN)
  // A line at or below the fixed prefix is not a trigger, it is a guarantee: no
  // compaction can bring the request under it, so clamping to 1 would fire
  // before EVERY generation until the retry cap and a small-window model could
  // never answer. Stand down and let the provider's own overflow path — which
  // can itself compact — handle the request instead.
  if (line <= systemToolsTokens) return undefined
  return Math.min(line, ceiling)
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
  /**
   * The request completion cap feeding the fit reserve: honored up to 25% of
   * the window, placeholder 8192 when it is 0 or at/above the window.
   */
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
    // Fail-open: this listener sits on EVERY agent request, and the session
    // accessors it calls can throw on partial session objects (the same
    // reason summarization-target.ts wraps requestContext in try/catch). A
    // guard bug must degrade to "no guard", never fail the request itself.
    try {
      if (!deps.enabled) return next()
      // Only agent-loop requests are guarded; the plugin's own summarization
      // calls (purpose 'compaction') are never marked and pass through.
      if (!deps.isAgentLoopRequest(options)) return next()
      if (options.sessionId === undefined || options.sessionId.length === 0) return next()
      const window = deps.windowForSession(options.sessionId)
      if (window === undefined || window <= 0) return next()
      const inputTokens = estimateRequestTokens(options)
      const systemToolsTokens = estimateSystemToolsTokens(options)
      const guardLine = computeGuardLine(window, systemToolsTokens, deps.maxTokens, deps.ratio)
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
    } catch (error) {
      deps.log(
        '[ContextGovernor] Thinking guard skipped after an internal error: '
          + (error instanceof Error ? error.message : String(error)),
      )
      return next()
    }
  })
}
