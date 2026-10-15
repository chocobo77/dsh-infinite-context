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

import {
  GOV_HOT_GROWTH,
  GOV_MATURE_COMPRESSIONS,
  GOV_MAX_BAND,
  GOV_MIN_BAND,
  GOV_SAFETY_MARGIN,
  GOV_STAGE_BAND,
  GOV_TARGET_FLOOR,
  GOV_TRIGGER_CEILING,
  GOV_TRIGGER_FLOOR,
  clamp01,
  compactionTriggerRatio,
  compactionWaterLevels,
  fillPressureOf,
  type WaterLevelBounds,
} from './compaction-governance.ts'

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
  // The floor may only LOWER the trigger. A floor at/above the base would raise
  // it past the configured threshold, and a non-finite or non-positive floor
  // would collapse it to "always compress"; both are unusable, so the base
  // ratio applies unchanged instead. Then delegate to the ONE shared curve —
  // this function is now the durable lane's view of it.
  const boundedFloor = Number.isFinite(floor) && floor > 0 ? Math.min(floor, baseRatio) : baseRatio
  return compactionTriggerRatio({
    anchor: baseRatio,
    floor: boundedFloor,
    ceiling: 1,
    fillPressure: fillPressureOf(fillRatio),
    growthPressure: 0,
    stagePressure: 0,
  })
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

/**
 * The output share the summarizer is asked for (see
 * {@link summarizationTargetTokens} in memory-compaction): ~30% of its input.
 * Used to invert the compression ratio when planning how much history to fold.
 */
export const SUMMARY_OUTPUT_SHARE = 0.3

/**
 * Tokens of old history to fold so the surface lands ON the target water level
 * after the replacement summary is inserted.
 *
 * The summarizer is asked to emit roughly {@link SUMMARY_OUTPUT_SHARE} of its
 * input, so folding F tokens frees only about F * (1 - share) NET: the summary
 * that replaces the fold consumes the rest. Choosing the fold as exactly
 * before - target (the naive "free the overflow" rule) therefore lands at
 * target + summaryTokens, systematically short of the target. That leftover
 * shrinks the headroom before the next trigger — and with a verbose summarizer
 * the post-compaction surface creeps back up to the trigger, so the compressor
 * re-fires every round and oscillates just under the line.
 *
 * Inverting the ratio here makes the net saving reach the target.
 *
 * @param beforeTokens - estimated tokens on the surface before compression.
 * @param targetTokens - the post-compression water level in tokens.
 * @param summaryShare - expected summary size as a fraction of the folded
 *   input; clamped to [0, 0.9] so a misconfiguration cannot request an
 *   infinite fold.
 * @returns the folded-token budget (>= 0).
 */
export function foldTokensForTarget(
  beforeTokens: number,
  targetTokens: number,
  summaryShare: number = SUMMARY_OUTPUT_SHARE,
): number {
  const gap = beforeTokens - targetTokens
  if (!Number.isFinite(gap) || gap <= 0) return 0
  const share = Number.isFinite(summaryShare) ? Math.min(0.9, Math.max(0, summaryShare)) : 0
  return Math.ceil(gap / (1 - share))
}

/* -------------------------------------------------------------------------- */
/*  Dynamic history water levels                                               */
/*  Turn the trigger/target from fixed fractions into a bounded controller     */
/*  driven by how the session is actually progressing.                         */
/* -------------------------------------------------------------------------- */

/** Hard-ceiling alias of the unified governance bound. */
export const HISTORY_TRIGGER_CEILING = GOV_TRIGGER_CEILING
/** Hard-floor alias of the unified governance bound. */
export const HISTORY_TRIGGER_FLOOR = GOV_TRIGGER_FLOOR
/** Target-floor alias of the unified governance bound. */
export const HISTORY_TARGET_FLOOR = GOV_TARGET_FLOOR
/** Minimum-band alias of the unified governance bound. */
export const HISTORY_MIN_BAND = GOV_MIN_BAND
/** Maximum-band alias of the unified governance bound. */
export const HISTORY_MAX_BAND = GOV_MAX_BAND
/** Safety-margin alias of the unified governance bound. */
export const HISTORY_SAFETY_MARGIN = GOV_SAFETY_MARGIN
/** Stage-band alias of the unified governance bound. */
export const HISTORY_STAGE_BAND = GOV_STAGE_BAND
/** Hot-growth alias of the unified governance bound. */
export const HISTORY_HOT_GROWTH = GOV_HOT_GROWTH
/** Mature-compressions alias of the unified governance bound. */
export const HISTORY_MATURE_COMPRESSIONS = GOV_MATURE_COMPRESSIONS

/** Input for {@link dynamicHistoryLevels}. */
export interface HistoryLevelInput {
  /** Configured trigger ratio (the LAZIEST point; dynamic slides down from it). */
  readonly baseTriggerRatio: number
  /** Configured target ratio (the SHALLOWEST compression; dynamic goes deeper). */
  readonly baseTargetRatio: number
  /** Effective token budget (window minus headroom). */
  readonly budgetTokens: number
  /** Smoothed per-step growth in tokens (0 = unknown/steady). */
  readonly growthTokens: number
  /** Rounds between two compressions (cadence the band must cover). */
  readonly compressInterval: number
  /** Successful history compressions so far this session. */
  readonly compressions: number
  /** Tokens reserved for the plugin's own per-turn injection. */
  readonly injectionBudget: number
}

/** Bounded water levels for one compression check. */
export interface HistoryLevels {
  readonly triggerRatio: number
  readonly targetRatio: number
  readonly triggerTokens: number
  readonly targetTokens: number
}

/**
 * Pick the trigger and target water levels for this check, bounded by hard
 * limits and steered by how the session is progressing.
 *
 * Timing: start from the configured trigger (the laziest allowed) and slide
 * DOWN as risk rises, so a hot (fast-growing) or mature (many prior folds)
 * session compresses earlier. The hard ceiling caps the trigger even when the
 * config or the anchor would sit higher.
 *
 * Magnitude: the trigger-to-target band is at least the configured gap, and
 * grows to cover one full cadence of measured growth plus a safety margin and
 * a maturity allowance. That is what keeps a compression from being undone by
 * ordinary progress a round later: the deeper the band, the longer the surface
 * stays under the trigger. It is clamped between {@link HISTORY_MIN_BAND} and
 * {@link HISTORY_MAX_BAND}, and the target never drops below
 * {@link HISTORY_TARGET_FLOOR}.
 *
 * Everything is monotonic and bounded: non-finite inputs degrade to the
 * safest (most conservative) level rather than producing NaN.
 * @param input - configured base ratios, budget, growth, interval, and the
 *   session's compression history.
 * @returns the bounded ratios plus their token forms.
 */
export function dynamicHistoryLevels(input: HistoryLevelInput): HistoryLevels {
  // The fold lane's view of the ONE shared curve. No fill term here: this lane
  // has historically been driven by growth + maturity only, so omitting the
  // fill ratio keeps its behaviour identical while sourcing the math from
  // compactionWaterLevels (which the durable lane also uses).
  const bounds: WaterLevelBounds = {
    triggerCeiling: HISTORY_TRIGGER_CEILING,
    triggerFloor: HISTORY_TRIGGER_FLOOR,
    targetFloor: HISTORY_TARGET_FLOOR,
    minBand: HISTORY_MIN_BAND,
    maxBand: HISTORY_MAX_BAND,
    safetyMargin: HISTORY_SAFETY_MARGIN,
    stageBand: HISTORY_STAGE_BAND,
    hotGrowth: HISTORY_HOT_GROWTH,
    matureCompressions: HISTORY_MATURE_COMPRESSIONS,
  }
  return compactionWaterLevels({
    baseTriggerRatio: input.baseTriggerRatio,
    baseTargetRatio: input.baseTargetRatio,
    budgetTokens: input.budgetTokens,
    growthTokens: input.growthTokens,
    compressInterval: input.compressInterval,
    compressions: input.compressions,
    injectionBudget: input.injectionBudget,
    bounds,
  })
}
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

/**
 * Exponentially weighted per-step growth of the projected request size.
 *
 * The RAW delta is fed in (not a ratio), so a post-compaction shrink decays the
 * estimate instead of pinning it; the result is floored at zero because a
 * shrinking context has no "negative growth" to reserve for. First observation
 * adopts the raw delta, so a session that starts already large is not treated as
 * having grown.
 * @param previous - the previous estimate, or `undefined` on first observation.
 * @param delta - tokens gained since the previous observation.
 * @returns the new estimate.
 */
export function nextGrowthEma(previous: number | undefined, delta: number): number {
  if (!Number.isFinite(delta)) return previous === undefined ? 0 : previous
  if (previous === undefined) return Math.max(0, delta)
  return Math.max(0, previous * 0.5 + delta * 0.5)
}

/** Input for {@link shouldNudgeCompaction}. */
export interface NudgeInput {
  /** Whether scheduled (nudged) compression is enabled. */
  readonly enabled: boolean
  /** The estimated request size right now. */
  readonly tokens: number
  /** The predicted growth of the NEXT step (see {@link nextGrowthEma}). */
  readonly growthTokens: number
  /** Trigger water level in tokens. */
  readonly triggerTokens: number
  /** Current check index for the session. */
  readonly turn: number
  /** Index of the last successful compression (undefined = never). */
  readonly lastCompressedTurn?: number | undefined
  /**
   * Minimum rounds between compressions (the same rate limit the ordinary
   * pressure path honours). A nudge forces the trigger, which bypasses the
   * interval inside {@link shouldCompressHistory}, so it must gate itself on
   * this or a surface that keeps landing just under the trigger would nudge
   * every single round.
   */
  readonly compressInterval: number
  /** Remaining failure-cooldown rounds; a nudge must never bypass it. */
  readonly failureCooldown: number
}

/**
 * Decide whether to compress NOW because the NEXT step is predicted to cross the
 * trigger water level.
 *
 * The point is scheduling, not thresholding. The ordinary trigger only looks at
 * the size that already exists and is further gated by the round rate limit, so
 * a step that adds one large tool result can cross the line between two checks
 * and be compacted one step late — after the oversized request was already sent
 * and paid for. A nudge forces the compression at the step boundary BEFORE that
 * request, using the measured per-step growth as the reserve.
 *
 * Deliberately narrow: it never fires without measured growth, never while
 * already over the line (the ordinary pressure path owns that case), never
 * during a failure cooldown, and never inside the round rate limit. It forces
 * the trigger only to pull one round forward; it must not become a second,
 * unthrottled trigger that re-fires every round on a surface sitting just below
 * the line (the pathological "compress every turn" loop).
 * @param input - sizes, growth, and session state.
 * @returns true when the compressor should treat this step as forced.
 */
export function shouldNudgeCompaction(input: NudgeInput): boolean {
  const {
    enabled, tokens, growthTokens, triggerTokens, turn, lastCompressedTurn,
    compressInterval, failureCooldown,
  } = input
  if (!enabled) return false
  if (!Number.isFinite(growthTokens) || growthTokens <= 0) return false
  if (tokens >= triggerTokens) return false
  if (tokens + growthTokens < triggerTokens) return false
  if (failureCooldown > 0) return false
  // The nudge FORCES the compression, which skips the ordinary interval inside
  // shouldCompressHistory. Gate it on the same interval here, otherwise a
  // surface that settles just under the trigger nudges on every single round
  // instead of once per cadence — the pathological "compress every turn just
  // below the line" loop.
  if (lastCompressedTurn !== undefined
    && turn - lastCompressedTurn < Math.max(1, compressInterval)) return false
  return true
}
