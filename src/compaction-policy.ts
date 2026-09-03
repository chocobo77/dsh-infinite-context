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
  /**
   * Whether to apply the dynamic ratio curve ({@link dynamicCompactionRatio}):
   * as the real window fills, the effective trigger ratio slides from
   * `thresholdRatio` toward `dynamicRatioFloor`, so compaction fires early
   * enough to leave the model enough remaining context to run the
   * summarization pass itself.
   */
  readonly dynamicRatio?: boolean
  /** Lower bound of the dynamic ratio (default 0.6). */
  readonly dynamicRatioFloor?: number
}

/**
 * Dynamic compaction ratio: slide the trigger ratio down as the window fills.
 * At or below 50% fill the base ratio applies unchanged; past 90% fill the
 * ratio bottoms out at `floor`. This guarantees the conversation never fills
 * the real window so completely that the compaction's own summarization pass
 * (which replays the compacted region as its input) cannot fit in the room
 * left before the window. With base 0.8 / floor 0.6 the curve crosses at
 * ~70% fill, reserving ~30% of the window for the compaction call.
 * @param baseRatio - the configured static threshold ratio.
 * @param floor - the ratio floor as the window fills (must be < baseRatio).
 * @param fillRatio - measured tokens / real window (0..1).
 */
export function dynamicCompactionRatio(
  baseRatio: number,
  floor: number,
  fillRatio: number,
): number {
  const t = Math.max(0, Math.min(1, (fillRatio - 0.5) / 0.4))
  const effective = baseRatio - (baseRatio - floor) * t
  return Math.max(floor, Math.min(baseRatio, effective))
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
  const fill = measuredTokens / narrowedWindow
  const ratio = input.dynamicRatio
    ? dynamicCompactionRatio(thresholdRatio, input.dynamicRatioFloor ?? 0.6, fill)
    : thresholdRatio
  const thresholdTokens = Math.max(1, Math.floor(narrowedWindow * Math.min(1, Math.max(0.01, ratio))))
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
  // Surge detection compares the CURRENT round's growth to the previous check.
  // On the very first observation (no baseline) a big history is not a
  // "single-round surge" — fall through to the pressure path, which already
  // fires immediately on a fresh session (lastCompressedTurn is undefined) and
  // carries the honest 'pressure' reason instead of a misleading 'surge'.
  const delta = lastTokens === undefined ? Number.NEGATIVE_INFINITY : tokens - lastTokens
  const surgeThreshold = Math.max(1, Math.floor(windowTokens * SURGE_RATIO))
  if (delta >= surgeThreshold) return { compress: true, reason: 'surge' }
  if (lastCompressedTurn === undefined || turn - lastCompressedTurn >= Math.max(1, compressInterval)) {
    return { compress: true, reason: 'pressure' }
  }
  return { compress: false, reason: 'rate-limited' }
}
