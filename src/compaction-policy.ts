/**
 * Pure decision policies for compaction triggering.
 *
 * Both decisions here are deliberately dependency-free so they are unit-testable
 * without a Cordis context:
 *
 *  1. {@link decidePressureCompaction} — whether the durable-history compaction
 *     (inherited from compaction-basic) should run for the current step, and
 *     whether it must be FORCED because the base policy is blind to the model's
 *     real context window.
 *  2. {@link shouldCompressHistory} — whether the plugin's own per-step history
 *     compression should fire this turn.
 *
 * @module dsh-infinite-context/compaction-policy
 */

/** How a pressure check should be routed. */
export type PressureDecisionMode =
  /** Run the base compaction-basic pressure policy unchanged. */
  | 'delegate'
  /** Below threshold — no compaction this step. */
  | 'skip'
  /**
   * Force the base overflow-style balanced reduction: the routed model's real
   * window (probe / per-model override) is SMALLER than the declared window,
   * so the base pressure threshold scales off a capacity the model does not
   * have and would not fire before the request overflows.
   */
  | 'force'

/** Result of {@link decidePressureCompaction}. */
export interface PressureDecision {
  readonly mode: PressureDecisionMode
  /** The threshold (tokens) the decision was evaluated against, when computed. */
  readonly thresholdTokens?: number
}

/** Input for {@link decidePressureCompaction}. */
export interface PressureDecisionInput {
  /**
   * The context window DSH resolves for the routed model (adapter/catalog
   * declaration). `undefined` when DSH has no capacity for the target.
   */
  readonly declaredWindow?: number | undefined
  /**
   * The narrowed window for the routed model from a live probe or an explicit
   * per-model config override. `undefined` when nothing narrowed it.
   */
  readonly narrowedWindow?: number | undefined
  /** Estimated durable-conversation tokens for the current step. */
  readonly measuredTokens: number
  /** Compaction threshold ratio for the routed target (base policy semantics). */
  readonly thresholdRatio: number
}

/**
 * Decide how the step-boundary pressure check should route.
 *
 * Semantics (narrowed ≤ declared always holds for probes; overrides are the
 * user's declared truth and may sit either side):
 *
 *  - No narrowed window → delegate (base behavior, unchanged).
 *  - Measured below the narrowed threshold → skip. This ALSO skips when a
 *    per-model override is HIGHER than the declared window and the base would
 *    have compacted earlier: the override is authoritative.
 *  - Measured over the narrowed threshold while the real window is smaller
 *    than the declared one (or DSH has no declared capacity) → force the
 *    overflow-style reduction; waiting for the base threshold would overflow.
 *  - Measured over the narrowed threshold but the declared window is the
 *    smaller/equal one → delegate; the base pressure path compacts with proper
 *    tail retention.
 */
export function decidePressureCompaction(input: PressureDecisionInput): PressureDecision {
  const { declaredWindow, narrowedWindow, measuredTokens, thresholdRatio } = input
  if (narrowedWindow === undefined || !Number.isFinite(narrowedWindow) || narrowedWindow <= 0) {
    return { mode: 'delegate' }
  }
  const thresholdTokens = Math.max(1, Math.floor(narrowedWindow * Math.min(1, Math.max(0.01, thresholdRatio))))
  if (measuredTokens < thresholdTokens) return { mode: 'skip', thresholdTokens }
  if (declaredWindow === undefined || narrowedWindow < declaredWindow) {
    return { mode: 'force', thresholdTokens }
  }
  return { mode: 'delegate', thresholdTokens }
}

/**
 * Fraction of the model window a single round may grow before the history
 * compression treats it as a "surge" (e.g. one very long thinking turn) and
 * bypasses the round-interval rate limit.
 */
export const SURGE_RATIO = 0.2

/** Rounds to wait after a failed (non-shrinking) history compression. */
export const COMPRESS_FAILURE_COOLDOWN = 3

/** Why the history compression trigger decided the way it did. */
export type HistoryTriggerReason =
  | 'forced'
  | 'surge'
  | 'pressure'
  | 'below-trigger'
  | 'cooldown'
  | 'rate-limited'

/** Input for {@link shouldCompressHistory}. */
export interface HistoryTriggerInput {
  /** Manual/forced compress bypasses every gate. */
  readonly force: boolean
  /** Current turn number for the session (1-based, incremented this call). */
  readonly turn: number
  /** Turn number of the last successful compression (undefined = never). */
  readonly lastCompressedTurn?: number | undefined
  /** Estimated tokens observed at the previous check (undefined = first). */
  readonly lastTokens?: number | undefined
  /** Estimated tokens at this check. */
  readonly tokens: number
  /** Trigger water level in tokens (budget × ratio − injection reserve). */
  readonly triggerTokens: number
  /** The effective model window in tokens (surge scale). */
  readonly windowTokens: number
  /** Minimum rounds between compressions (rate limit, not a gate). */
  readonly compressInterval: number
  /** Remaining failure-cooldown rounds. */
  readonly failureCooldown: number
}

/** Result of {@link shouldCompressHistory}. */
export interface HistoryTriggerResult {
  readonly compress: boolean
  readonly reason: HistoryTriggerReason
}

/**
 * Decide whether the per-step history compression should fire this turn.
 *
 * The token-pressure condition dominates: once over the trigger water level the
 * compression runs as soon as the rate limit allows, and a single-round token
 * surge (one very long thinking/tool turn) bypasses the rate limit entirely so
 * a short-window model gets relief on the very next step.
 */
export function shouldCompressHistory(input: HistoryTriggerInput): HistoryTriggerResult {
  const {
    force, turn, lastCompressedTurn, lastTokens,
    tokens, triggerTokens, windowTokens, compressInterval, failureCooldown,
  } = input
  if (force) return { compress: true, reason: 'forced' }
  if (tokens <= triggerTokens) return { compress: false, reason: 'below-trigger' }
  if (failureCooldown > 0) return { compress: false, reason: 'cooldown' }
  const delta = lastTokens === undefined ? Number.POSITIVE_INFINITY : tokens - lastTokens
  const surgeThreshold = Math.max(1, Math.floor(windowTokens * SURGE_RATIO))
  if (delta >= surgeThreshold) return { compress: true, reason: 'surge' }
  if (lastCompressedTurn === undefined || turn - lastCompressedTurn >= Math.max(1, compressInterval)) {
    return { compress: true, reason: 'pressure' }
  }
  return { compress: false, reason: 'rate-limited' }
}
