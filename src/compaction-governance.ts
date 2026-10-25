/**
 * Unified compaction governance: ONE bounded water-level curve shared by the
 * durable-region lane (compaction-basic) and the progressive-fold lane
 * (HistoryCompressor).
 *
 * Before this module the two lanes each owned a private curve:
 *   - durable: dynamicCompactionRatio(base, floor, fill) — driven only by how
 *     full the window is;
 *   - fold:    dynamicHistoryLevels(...) — driven only by growth EMA + maturity.
 * They could disagree about the same session at the same moment, and every fix
 * had to be reasoned about twice. Here they become two views of one curve.
 *
 * Dependency-free so it is unit-testable without a Cordis context.
 *
 * @module dsh-infinite-context/compaction-governance
 */

import type { CompactionIntent } from './compaction-intelligence.ts'
import {
  OPP_BONUS_MAX,
  OPP_EARLY_PENALTY,
  OPP_NUDGE_MIN,
  type CompactionOpportunity,
} from './compaction-opportunity.ts'

/** Hard ceiling on the trigger (fraction of the basis). Nothing may raise it. */
export const GOV_TRIGGER_CEILING = 0.92
/**
 * Floor for the trigger slide: a hot/mature session cannot churn earlier than
 * this WHEN the configured anchor is at or above it. A deliberately lower
 * anchor (small-window local model) is respected, because the floor exists to
 * prevent churn, not to override an intentional early-compress setting; the
 * absolute anti-overflow limit is {@link GOV_TRIGGER_CEILING}.
 */
export const GOV_TRIGGER_FLOOR = 0.65
/** Hard floor on the post-compression target. */
export const GOV_TARGET_FLOOR = 0.25
/**
 * Memory floor for the retained tail: never fold the surface below this share
 * of the budget. The tail is what the agent keeps verbatim, and a mature
 * session used to widen its band until the tail was gone.
 */
export const GOV_TARGET_MEMORY_FLOOR = 0.55
/** Minimum trigger-to-target band so every compression creates real headroom. */
export const GOV_MIN_BAND = 0.08
/** Maximum band so a pathological growth estimate cannot empty the context. */
export const GOV_MAX_BAND = 0.45
/** Safety margin added to the measured-growth reserve. */
export const GOV_SAFETY_MARGIN = 0.03
/** Extra band added as the session matures, to amortize compressions. */
export const GOV_STAGE_BAND = 0.08
/**
 * Cap on the maturity (compression-count) term of the trigger curve. Mature
 * sessions used to fold at the floor because stage pressure reached 1; the
 * fold lane now keeps the anchor unless fill/growth actually demand earlier.
 */
export const GOV_STAGE_TRIGGER_CAP = 0
/** Growth (fraction of budget per step) that counts as fully 'hot'. */
export const GOV_HOT_GROWTH = 0.05
/** Successful compressions at which a session counts as fully mature. */
export const GOV_MATURE_COMPRESSIONS = 8
/**
 * Minimum NET saving of a routine fold, as a share of the fold budget: the
 * folded tokens minus the summarizer's own expected output. A fold that nets
 * less costs a summarizer call plus a post-fold cache refill for a sliver of
 * headroom - on a small window the memory floor caps the band so the closed
 * loop cannot deepen its way out, and only this gate stops the churn. Force,
 * surge and the fit-guard bypass it (their occasion is not optional). The
 * opportunity cost of a fold is ≈5-7% of the budget; 8% leaves margin.
 * Set 0 to disable the gate.
 */
export const GOV_MIN_NET_SAVING_RATIO = 0.08

/* -------------------------------------------------------------------------- */
/*  Closed-loop target band (landing-deviation feedback)                       */
/*                                                                              */
/*  Production telemetry (1M-window sessions, 2026-10) showed folds landing    */
/*  systematically ABOVE the target band and drifting worse day over day: the  */
/*  retained tail handed to the range selector is the plan's target, but the   */
/*  summary's own tokens, the pinned head and the unfoldable leftovers are     */
/*  added ON TOP of it, and nothing fed that shortfall back into the next      */
/*  plan. The planner therefore keeps a per-session EMA of                     */
/*  `landing − target` (same meter basis) and pre-compensates the next target  */
/*  by it, so the LANDING — not the retain handed downstream — reaches the     */
/*  nominal band.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * EMA weight of the newest landing observation. Matches the growth EMA's 0.5
 * convention (one-fold half-life), so a day-over-day overhead drift is tracked
 * within a couple of cadences without thrashing on a single outlier fold.
 */
export const GOV_TARGET_DEVIATION_ALPHA = 0.5
/**
 * Cap on the learned correction, as a share of the basis. 0.12 keeps the
 * pre-compensated retain at ≥ 0.43×basis on the normal 0.55 memory floor and
 * bottoms out at {@link GOV_TARGET_FLOOR} (0.25) even on the deep-probe floor
 * (0.35), so the feedback can only WIDEN the effective band inside the hard
 * bounds — it never crosses the watermark envelope or empties the memory.
 */
export const GOV_TARGET_DEVIATION_MAX = 0.12

/**
 * Fold the latest landing observation into the per-session deviation EMA.
 *
 * The delta is SIGNED (landing − planned target): a persistent overshoot grows
 * the correction, and an over-correction (landing below target) shrinks it
 * back, so the loop is a stable negative-feedback controller around zero
 * residual error rather than a ratchet.
 * @param previous - the previous EMA in tokens, `undefined` on first fold.
 * @param landingDelta - `landing − target` of the fold that just committed.
 * @param alpha - EMA weight of the newest observation (default
 *   {@link GOV_TARGET_DEVIATION_ALPHA}).
 * @returns the new EMA in tokens (non-finite input keeps the previous value).
 */
export function nextTargetDeviationEma(
  previous: number | undefined,
  landingDelta: number,
  alpha: number = GOV_TARGET_DEVIATION_ALPHA,
): number {
  if (!Number.isFinite(landingDelta)) return previous === undefined ? 0 : previous
  if (previous === undefined) return landingDelta
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : GOV_TARGET_DEVIATION_ALPHA
  return previous * (1 - a) + landingDelta * a
}

/**
 * The bounded correction the planner applies to the target ratio: the learned
 * deviation as a share of the basis, clamped to `[0, max]`.
 *
 * Clamping at 0 (never negative) means the loop can only widen the band — the
 * nominal target stays the shallowest compression the planner will pick, so a
 * stale negative EMA cannot make the planner lazier than its configured band.
 * @param deviationTokens - the per-session deviation EMA in tokens.
 * @param basisTokens - the lane's basis (fold pressure budget / window).
 * @param max - cap as a share of the basis (default
 *   {@link GOV_TARGET_DEVIATION_MAX}).
 * @returns the correction ratio in `[0, max]` (0 for unknown input).
 */
export function targetDeviationCorrection(
  deviationTokens: number | undefined,
  basisTokens: number,
  max: number = GOV_TARGET_DEVIATION_MAX,
): number {
  if (deviationTokens === undefined || !Number.isFinite(deviationTokens)) return 0
  if (!Number.isFinite(basisTokens) || basisTokens <= 0) return 0
  const cap = Number.isFinite(max) ? Math.max(0, max) : GOV_TARGET_DEVIATION_MAX
  return clampRange(deviationTokens / basisTokens, 0, cap)
}

/* -------------------------------------------------------------------------- */
/*  Large-window deep probe (magnitude-driven floor relaxation)                */
/*                                                                              */
/*  On a big window the 0.55 memory floor costs hundreds of thousands of       */
/*  tokens while the window itself is mostly empty: a 1M window whose fold     */
/*  budget is capped by the completion reserve folds at ~35% WINDOW fill,      */
/*  purely on cadence. When the content intent says the bulk is disposable     */
/*  (magnitude ≥ 0.5, i.e. tool-heavy), the memory floor relaxes so the        */
/*  magnitude signal can actually reach a deeper target and the cadence        */
/*  lengthens. The constants below stay BOUNDARIES; the magnitude intent       */
/*  stays the driver — no relaxation without it, none near overflow.           */
/* -------------------------------------------------------------------------- */

/**
 * Minimum window (tokens) that qualifies as "large". 512k is half of a 1M
 * window: below it, the 0.55 floor's absolute cost is small enough that the
 * extra depth is not worth the tail loss.
 */
export const GOV_DEEP_PROBE_MIN_WINDOW = 524_288
/**
 * Deep probe only while the measured quantity is below this share of the
 * WINDOW (not the basis). A fold this early in the window is cadence/seam
 * driven, not overflow driven — going deeper is safe exactly because the
 * window has huge slack. At or above this fill the fold is pressure driven
 * and the normal memory floor applies.
 */
export const GOV_DEEP_PROBE_MAX_WINDOW_FILL = 0.4
/**
 * Minimum content magnitude that may probe past the memory floor. 0.5 is the
 * intelligence module's neutral point (pure-tool ≈ 0.95, half-tool ≈ 0.55),
 * so only a genuinely tool-heavy context unlocks the deeper floor.
 */
export const GOV_DEEP_PROBE_MIN_MAGNITUDE = 0.5
/**
 * Relaxed memory floor for the deep probe. ~0.35 keeps the landing well above
 * the hard {@link GOV_TARGET_FLOOR} (0.25) even after the maximum landing
 * deviation correction (0.35 − 0.12 = 0.23, clamped to 0.25).
 */
export const GOV_DEEP_PROBE_MEMORY_FLOOR = 0.35
/**
 * Fill ratio (measured/basis) at which the fill-driven slide starts; the old
 * dynamicCompactionRatio used 0.5. Kept as a constant so both lanes agree.
 */
export const GOV_FILL_START = 0.5
/** Fill ratio span over which the fill-driven slide runs to the floor (0.4). */
export const GOV_FILL_SPAN = 0.4

/** Clamp to [0, 1]; non-finite input collapses to 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Clamp `value` into `[lo, hi]`; a non-finite value collapses to `lo`. */
export function clampRange(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Map a fill ratio (measured / basis) onto the fill-pressure term in [0, 1].
 * At or below {@link GOV_FILL_START} there is no fill pressure; the curve is
 * fully applied once fill reaches `GOV_FILL_START + GOV_FILL_SPAN`.
 * @param fillRatio - measured tokens divided by the basis (window or budget).
 * @returns fill pressure in [0, 1].
 */
export function fillPressureOf(fillRatio: number): number {
  return clamp01((fillRatio - GOV_FILL_START) / GOV_FILL_SPAN)
}

/** The three pressures that can pull the trigger down. */
export interface TriggerCurveInput {
  /** The configured (laziest) trigger ratio. */
  readonly anchor: number
  /** Hard lower bound the slide may reach. */
  readonly floor: number
  /** Hard upper bound; also the ceiling of the anchor itself. */
  readonly ceiling: number
  /** 0..1 pressure from how full the context already is. */
  readonly fillPressure: number
  /** 0..1 pressure from the measured per-step growth. */
  readonly growthPressure: number
  /** 0..1 pressure from session maturity (prior compressions). */
  readonly stagePressure: number
}

/**
 * The shared trigger curve: start at the anchor and slide toward the floor as
 * the strongest of the three pressures rises. Monotonic and hard-bounded.
 * @param input - anchor/floor/ceiling and the three pressures.
 * @returns the effective trigger ratio in `[floor, anchor]`.
 */
export function compactionTriggerRatio(input: TriggerCurveInput): number {
  const ceiling = Number.isFinite(input.ceiling) ? Math.max(0, input.ceiling) : 1
  const floorRaw = clampRange(input.floor, 0, ceiling)
  const anchor = clampRange(input.anchor, floorRaw, ceiling)
  const floor = Math.min(anchor, floorRaw)
  const pressure = Math.max(
    clamp01(input.fillPressure),
    clamp01(input.growthPressure),
    clamp01(input.stagePressure),
  )
  return Math.max(floor, anchor - (anchor - floor) * pressure)
}

/** Resolved hard bounds for the unified water levels. */
export interface WaterLevelBounds {
  readonly triggerCeiling: number
  readonly triggerFloor: number
  readonly targetFloor: number
  readonly minBand: number
  readonly maxBand: number
  readonly safetyMargin: number
  readonly stageBand: number
  /** Cap on the stage (maturity) pressure; omit for legacy behaviour. */
  readonly stageTriggerCap?: number
  readonly hotGrowth: number
  readonly matureCompressions: number
}

/** Default bounds (the shipped safety envelope). */
export const DEFAULT_WATER_LEVEL_BOUNDS: WaterLevelBounds = {
  triggerCeiling: GOV_TRIGGER_CEILING,
  triggerFloor: GOV_TRIGGER_FLOOR,
  targetFloor: GOV_TARGET_FLOOR,
  minBand: GOV_MIN_BAND,
  maxBand: GOV_MAX_BAND,
  safetyMargin: GOV_SAFETY_MARGIN,
  stageBand: GOV_STAGE_BAND,
  hotGrowth: GOV_HOT_GROWTH,
  matureCompressions: GOV_MATURE_COMPRESSIONS,
}

/** Input for {@link compactionWaterLevels}. */
export interface WaterLevelInput {
  /** Configured trigger ratio (the LAZIEST point). */
  readonly baseTriggerRatio: number
  /** Configured target ratio (the SHALLOWEST compression). */
  readonly baseTargetRatio: number
  /** Effective basis (budget for fold, window for durable). */
  readonly budgetTokens: number
  /**
   * Measured/basis fill ratio for the fill-driven term. Omit (or pass a
   * non-finite value) when the curve is evaluated without a measurement; the
   * fill term then contributes zero pressure, which makes the result identical
   * to the fold lane's pre-governance dynamicHistoryLevels curve.
   */
  readonly fillRatio?: number
  /** Smoothed per-step growth in tokens. */
  readonly growthTokens: number
  /** Rounds between two compressions (cadence the band must cover). */
  readonly compressInterval: number
  /** Successful compressions so far this session. */
  readonly compressions: number
  /** Tokens reserved for the plugin's own per-turn injection. */
  readonly injectionBudget: number
  /** Override the shipped hard bounds (legacy lanes keep their own values). */
  readonly bounds?: Partial<WaterLevelBounds>
}

/** Bounded water levels for one check. */
export interface WaterLevels {
  readonly triggerRatio: number
  readonly targetRatio: number
  readonly triggerTokens: number
  readonly targetTokens: number
}

/**
 * The ONE water-level computation: a bounded trigger (fill + growth + stage)
 * and a target whose band covers one full cadence of measured growth.
 *
 * Hard bounds are always applied. Non-finite inputs degrade to the most
 * conservative level rather than producing NaN.
 * @param input - anchors, basis, growth, interval, maturity, bounds.
 * @returns the bounded ratios plus their token forms.
 */
export function compactionWaterLevels(input: WaterLevelInput): WaterLevels {
  const b: WaterLevelBounds = { ...DEFAULT_WATER_LEVEL_BOUNDS, ...(input.bounds ?? {}) }
  const budget = Number.isFinite(input.budgetTokens) && input.budgetTokens > 0 ? input.budgetTokens : 1

  const minAnchor = b.targetFloor + b.minBand
  const anchor = Math.min(
    b.triggerCeiling,
    Math.max(minAnchor, Number.isFinite(input.baseTriggerRatio) ? input.baseTriggerRatio : b.triggerFloor),
  )
  const floor = Math.min(anchor, b.triggerFloor)

  const growthRatio = Math.min(0.5, Math.max(0,
    Number.isFinite(input.growthTokens) ? input.growthTokens / budget : 0,
  ))
  const mature = Number.isFinite(b.matureCompressions) && b.matureCompressions > 0
    ? b.matureCompressions
    : GOV_MATURE_COMPRESSIONS
  const stageCap = Number.isFinite(b.stageTriggerCap) ? clamp01(b.stageTriggerCap as number) : 1
  const stage = Math.min(clamp01(input.compressions / mature), stageCap)
  const hot = Number.isFinite(b.hotGrowth) && b.hotGrowth > 0 ? b.hotGrowth : GOV_HOT_GROWTH

  const triggerRatio = compactionTriggerRatio({
    anchor,
    floor,
    ceiling: b.triggerCeiling,
    fillPressure: Number.isFinite(input.fillRatio) ? fillPressureOf(input.fillRatio as number) : 0,
    growthPressure: clamp01(growthRatio / hot),
    stagePressure: stage,
  })

  const baseTarget = Math.min(
    Math.max(b.targetFloor, Number.isFinite(input.baseTargetRatio) ? input.baseTargetRatio : b.targetFloor),
    anchor - b.minBand,
  )
  const configuredBand = Math.max(b.minBand, anchor - baseTarget)
  const interval = Number.isFinite(input.compressInterval) ? Math.max(1, input.compressInterval) : 1
  const reserve = growthRatio * interval + b.safetyMargin + b.stageBand * stage
  const band = Math.min(b.maxBand, Math.max(b.minBand, Math.max(configuredBand, reserve)))
  const maxTarget = Math.max(b.targetFloor, triggerRatio - b.minBand)
  const targetRatio = Math.min(maxTarget, Math.max(b.targetFloor, triggerRatio - band))

  const injection = Number.isFinite(input.injectionBudget) ? Math.max(0, input.injectionBudget as number) : 0
  return {
    triggerRatio,
    targetRatio,
    triggerTokens: Math.max(0, Math.floor(budget * triggerRatio) - injection),
    targetTokens: Math.max(0, Math.floor(budget * targetRatio) - injection),
  }
}

/* -------------------------------------------------------------------------- */
/*  Surface snapshot                                                           */
/*  One normalized per-step view of the request, built from the authoritative  */
/*  token meter with an optional CONSERVATIVE correction from a CJK-aware      */
/*  estimator. This is the basis the unified planner reads.                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalized one-step surface snapshot.
 *
 * `totalTokens` is request pressure (system/tools/envelope + surface);
 * `surfaceTokens` is the surface-only sum the fold lane rewrites, and
 * `fixedTokens = totalTokens - surfaceTokens` is the envelope the fold cannot
 * reclaim. The fold lane compares its own `surfaceTokens` against the water
 * levels directly (its basis IS the surface budget); `fixedTokens` is read by
 * the fit-guard, which must see the whole request.
 */
export interface SurfaceSnapshot {
  readonly totalTokens: number
  readonly surfaceTokens: number
  readonly fixedTokens: number
  readonly window: number
  readonly declaredWindow?: number
}

/** Input for {@link toSurfaceSnapshot}. */
export interface SurfaceSnapshotInput {
  /** Request pressure from the token meter (totalTokens). */
  readonly totalTokens: number
  /** Surface-only sum from the token meter (surfaceTokens). */
  readonly surfaceTokens: number
  /** Effective window for the routed model (narrowed ?? declared). */
  readonly window: number
  /** DSH-declared window, when known (to detect narrowed < declared). */
  readonly declaredWindow?: number
  /**
   * Optional second surface estimate. DSH's fixed meter prices text at
   * CHARS_PER_TOKEN=4 with no CJK special-case, so a Chinese-heavy surface can
   * be UNDER-counted by the meter; the plugin's CJK-aware heuristic is passed
   * here so the snapshot takes the CONSERVATIVE (larger) value. Neither
   * estimator may understate the surface.
   */
  readonly alternateSurfaceTokens?: number
}

/**
 * Build a normalized snapshot, guarding every field and taking the larger of
 * the two surface estimates. `totalTokens` is lifted by the same amount the
 * surface estimate is lifted, so `fixedTokens` (envelope) is preserved.
 * @param input - meter values plus the optional CJK-aware correction.
 * @returns a finite, internally consistent snapshot.
 */
export function toSurfaceSnapshot(input: SurfaceSnapshotInput): SurfaceSnapshot {
  const window = Number.isFinite(input.window) && input.window > 0 ? input.window : 1
  const meterTotal = Number.isFinite(input.totalTokens) && input.totalTokens > 0 ? input.totalTokens : 0
  const meterSurface = Number.isFinite(input.surfaceTokens) && input.surfaceTokens > 0 ? input.surfaceTokens : 0
  const alternate = Number.isFinite(input.alternateSurfaceTokens) && (input.alternateSurfaceTokens ?? 0) > 0
    ? (input.alternateSurfaceTokens as number)
    : 0
  const surfaceTokens = Math.max(meterSurface, alternate)
  const totalTokens = Math.max(meterTotal, meterSurface) + Math.max(0, surfaceTokens - meterSurface)
  const declaredWindow = Number.isFinite(input.declaredWindow) && (input.declaredWindow ?? 0) > 0
    ? (input.declaredWindow as number)
    : undefined
  return {
    totalTokens,
    surfaceTokens,
    fixedTokens: Math.max(0, totalTokens - surfaceTokens),
    window,
    ...(declaredWindow === undefined ? {} : { declaredWindow }),
  }
}

/* -------------------------------------------------------------------------- */
/*  Unified planner                                                            */
/*  ONE policy function decides lane + water levels for a step. Each hook      */
/*  calls it with its own capabilities, so the two executors can never use      */
/*  different rules.                                                           */
/* -------------------------------------------------------------------------- */

/** fit-guard reserve as a share of the window (replaces a fixed constant). */
export const GOV_GUARD_RESERVE_RATIO = 0.08
/** Absolute minimum fit-guard reserve. */
export const GOV_GUARD_RESERVE_MIN = 1024

/** Minimum share of the window the fold planner keeps for the prompt. */
export const GOV_MIN_PROMPT_SHARE = 0.5
/** Fold checks to wait after a configuration-class summarization error. */
export const GOV_CONFIG_ERROR_COOLDOWN = 60

export interface FoldBudgetInput {
  readonly window: number
  readonly reservedCompletion: number
  readonly headroom: number
  /** Override the minimum prompt share (default {@link GOV_MIN_PROMPT_SHARE}). */
  readonly minPromptShare?: number
}

/**
 * The fold lane's pressure budget, hardened against degenerate request caps.
 *
 * A request cap that reserves (almost) the whole window would otherwise
 * collapse the budget to one token, which is not a plan: the fold trigger and
 * target both become meaningless. Keep a minimum prompt share, clamp the
 * completion reserve to what the window can actually spare, and never return
 * less than one token.
 * @param input - window, requested completion reserve and plugin headroom.
 * @returns the usable prompt budget in tokens (>= 1).
 */
export function foldPressureBudget(input: FoldBudgetInput): number {
  const window = Number.isFinite(input.window) && input.window > 0 ? input.window : 1
  const headroom = Number.isFinite(input.headroom) ? Math.max(0, input.headroom) : 0
  const share = Number.isFinite(input.minPromptShare)
    ? Math.min(0.9, Math.max(0.1, input.minPromptShare as number))
    : GOV_MIN_PROMPT_SHARE
  const minBudget = Math.max(2048, Math.floor(window * share))
  const maxReserve = Math.max(0, window - headroom - minBudget)
  const requested = Number.isFinite(input.reservedCompletion)
    ? Math.max(0, input.reservedCompletion)
    : 0
  const reserve = Math.min(requested, maxReserve)
  return Math.max(1, Math.floor(window - reserve - headroom))
}

/**
 * Cooldown after a failed summarization, classified by error kind.
 *
 * A configuration error (unsupported reasoning effort, impossible completion
 * reserve) will not heal by retrying every few rounds, so it backs off much
 * longer than a transient failure; the planner still retries eventually.
 * @param current - the session's existing cooldown.
 * @param errorMessage - the failure message.
 * @param transientCooldown - rounds to wait for a transient error.
 * @returns the next cooldown (>= 1).
 */
/**
 * Minimum shadowed tokens worth folding: a fold must be able to beat its own
 * summary, so tiny 1–3 message folds are skipped instead of churning.
 * @param budgetTokens - the fold pressure budget.
 * @returns the minimum fold size in tokens.
 */
export function minimumFoldTokens(budgetTokens: number): number {
  const budget = Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : 1
  // Cap the floor: a 1M window must not demand 50k-token folds (a normal
  // 75k fold would clear it, but a 30k fold is still worth doing).
  return Math.min(16_384, Math.max(2048, Math.floor(budget * 0.1)))
}

/**
 * The thin-fold gate: is this fold's NET saving (folded tokens minus the
 * summarizer's own expected output) below its share of the budget?
 *
 * Complements {@link minimumFoldTokens}: that floor prices the fold against
 * the SUMMARY mechanism, this one prices the fold against the BUDGET it is
 * supposed to relieve. On a small window both floors bind and only a deep
 * occasion (nudge, fit-guard) is worth the summarizer call.
 * @param foldTokens - tokens the range selector would fold.
 * @param expectedSummaryTokens - the summarizer's expected output for them.
 * @param budgetTokens - the fold lane's pressure budget.
 * @param minRatio - minimum net saving as a share of the budget
 *   (default {@link GOV_MIN_NET_SAVING_RATIO}; 0 disables the gate).
 * @returns true when the fold should be skipped as not worth its cost.
 *   Non-finite input conservatively reads as thin (skip).
 */
export function isThinFold(
  foldTokens: number,
  expectedSummaryTokens: number,
  budgetTokens: number,
  minRatio: number = GOV_MIN_NET_SAVING_RATIO,
): boolean {
  // Unknown ANY input term means the saving cannot be priced: conservatively
  // thin (skip) rather than fold blind.
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return true
  if (!Number.isFinite(foldTokens)) return true
  if (!Number.isFinite(expectedSummaryTokens)) return true
  const saving = Math.max(0, foldTokens) - Math.max(0, expectedSummaryTokens)
  const ratio = Number.isFinite(minRatio) ? Math.max(0, minRatio) : GOV_MIN_NET_SAVING_RATIO
  return saving < budgetTokens * ratio
}

/**
 * Character budget for a summary that must stay below the folded content.
 * Local models often over-produce; the commit is capped to the planned share.
 * @param shadowedTokens - tokens in the folded region.
 * @param share - expected summary share of the input (default 0.3).
 * @returns the summary character budget (>= 1024).
 */
export function summaryCharBudget(shadowedTokens: number, share = 0.3): number {
  const tokens = Number.isFinite(shadowedTokens) && shadowedTokens > 0 ? shadowedTokens : 0
  const s = Number.isFinite(share) ? Math.min(0.9, Math.max(0.05, share)) : 0.3
  return Math.max(1024, Math.floor(tokens * s) * 4)
}

export function failureCooldownFor(current: number, errorMessage: string, transientCooldown = 3): number {
  const configError = /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort|TargetPressureConfigError|no message budget|leaving no pressure budget/i
    .test(errorMessage)
  if (configError) return Math.max(Number.isFinite(current) ? current : 0, GOV_CONFIG_ERROR_COOLDOWN)
  return Math.max(1, Math.floor(transientCooldown))
}
/** Single-round growth (share of window) that bypasses the round rate limit. */
export const GOV_SURGE_RATIO = 0.2

/** Executor the plan recommends. */
export type GovernanceLane = 'none' | 'fold' | 'durable'

/** Why the plan recommends what it does. */
export type GovernanceReason =
  | 'below-trigger'
  | 'nudge'
  | 'surge'
  | 'pressure'
  | 'narrowed-window'
  | 'overflow'
  | 'fit-guard'
  | 'cooldown'
  | 'rate-limited'
  | 'forced'

/** Hard bounds for the planner (water-level bounds plus routing margins). */
export interface GovernanceBounds extends WaterLevelBounds {
  /** Minimum retained share of the budget (see {@link GOV_TARGET_MEMORY_FLOOR}). */
  readonly memoryTargetFloor: number
  readonly guardReserveRatio: number
  readonly guardReserveMin: number
  readonly surgeRatio: number
  /** Cap on the learned landing-deviation correction (share of the basis). */
  readonly targetDeviationMax: number
  /** Minimum window (tokens) that qualifies for the deep probe. */
  readonly deepProbeMinWindow: number
  /** Maximum measured/window fill under which the deep probe may relax. */
  readonly deepProbeMaxWindowFill: number
  /** Minimum content magnitude that may probe past the memory floor. */
  readonly deepProbeMinMagnitude: number
  /** Relaxed memory floor used by the deep probe. */
  readonly deepProbeMemoryFloor: number
}

/** Shipped planner bounds. */
export const DEFAULT_GOVERNANCE_BOUNDS: GovernanceBounds = {
  ...DEFAULT_WATER_LEVEL_BOUNDS,
  stageTriggerCap: GOV_STAGE_TRIGGER_CAP,
  memoryTargetFloor: GOV_TARGET_MEMORY_FLOOR,
  guardReserveRatio: GOV_GUARD_RESERVE_RATIO,
  guardReserveMin: GOV_GUARD_RESERVE_MIN,
  surgeRatio: GOV_SURGE_RATIO,
  targetDeviationMax: GOV_TARGET_DEVIATION_MAX,
  deepProbeMinWindow: GOV_DEEP_PROBE_MIN_WINDOW,
  deepProbeMaxWindowFill: GOV_DEEP_PROBE_MAX_WINDOW_FILL,
  deepProbeMinMagnitude: GOV_DEEP_PROBE_MIN_MAGNITUDE,
  deepProbeMemoryFloor: GOV_DEEP_PROBE_MEMORY_FLOOR,
}

/**
 * Per-session state the planner reads. Mirrors the unified SessionCounter.
 * `lastTokens` MUST be in the SAME basis as the caller's `measuredTokens`
 * (fold: surface estimate; durable: whole-request pressure), or the surge
 * comparison is meaningless.
 */
export interface GovernanceLedger {
  readonly turn: number
  readonly lastCompressedTurn?: number
  readonly lastTokens?: number
  readonly failureCooldown: number
  readonly compressions: number
  readonly growthTokens: number
  /**
   * Per-session EMA of `landing − target` in tokens (fold-lane learning). The
   * planner pre-compensates the next target by it, bounded by
   * `bounds.targetDeviationMax`; `undefined` (or a non-finite value) disables
   * the closed loop, preserving the pre-feedback behaviour exactly.
   */
  readonly targetDeviationTokens?: number
}

/** What the calling hook is able to execute. */
export interface GovernanceCapabilities {
  /** The hook can fold the assembled request (agent/pre-step, post-next). */
  readonly fold: boolean
  /** The hook can run the durable-region compaction (compaction-basic path). */
  readonly durable: boolean
}

/** Input for {@link planCompaction}. */
export interface GovernanceInput {
  readonly snapshot: SurfaceSnapshot
  readonly ledger: GovernanceLedger
  readonly capabilities: GovernanceCapabilities
  /** Configured trigger anchor for the lane that owns this hook. */
  readonly baseTriggerRatio: number
  /** Configured target anchor (fold only). */
  readonly baseTargetRatio: number
  /** Rounds between two compressions. */
  readonly compressInterval: number
  /** Incoming base trigger: 'pressure' | 'context-overflow' | 'fold' | ... */
  readonly incomingTrigger: string
  /** Manual/tool force. */
  readonly force: boolean
  /** Whether the growth nudge is enabled. */
  readonly nudge: boolean
  /**
   * Denominator for the water levels. The durable lane measures the whole
   * request against the WINDOW; the fold lane measures the surface against its
   * effective BUDGET (window × (1 − headroom)). Defaults to `snapshot.window`.
   */
  readonly basisTokens?: number
  /**
   * The quantity compared to the trigger, in the SAME basis as
   * {@link basisTokens}. Durable passes the whole-request pressure; fold passes
   * the surface-only estimate. Defaults to `snapshot.totalTokens`.
   */
  readonly measuredTokens?: number
  /**
   * Fill pressure override for the shared curve. The fold lane historically ran
   * with NO fill term, so it passes 0; durable leaves it undefined and lets the
   * planner derive it from measured/basis.
   */
  readonly fillRatio?: number
  /** Tokens reserved for the plugin's own per-turn injection (fold lane). */
  readonly injectionBudget?: number
  /** Session-phase opportunity; omitted means neutral (score 0.5, mature). */
  readonly opportunity?: CompactionOpportunity
  /** Content/stage intent; when present it replaces the phase swing. */
  readonly intent?: CompactionIntent
  /**
   * Per-session EMA of `landing − target` from committed folds, in tokens
   * (same basis as {@link basisTokens}). The closed-loop band deepens the
   * next target by the learned shortfall; undefined leaves it untouched.
   */
  readonly deviationEmaTokens?: number
  readonly bounds?: Partial<GovernanceBounds>
}

/** One bounded plan for a step. */
export interface CompactionPlan {
  readonly lane: GovernanceLane
  readonly reason: GovernanceReason
  readonly triggerRatio: number
  readonly targetRatio: number
  /** Trigger in the CALLER's `measuredTokens` basis. */
  readonly triggerTokens: number
  /** Fold-executor alias of triggerTokens (its basis IS the surface). */
  readonly surfaceTriggerTokens: number
  /** Fold-executor alias of the target in the same basis. */
  readonly targetSurfaceTokens: number
  /** Observability: the three pressures and their max. */
  readonly drivers: {
    readonly fill: number
    readonly growth: number
    readonly stage: number
    readonly urgency: number
    /** Session-phase opportunity score (0..1). */
    readonly opportunity: number
    /** Session phase the score came from. */
    readonly phase: string
    /** Content/stage timing (0 = defer, 1 = clean seam); 0 when absent. */
    readonly timing: number
    /** Content/stage magnitude (0 = keep, 1 = fold deep); 0 when absent. */
    readonly magnitude: number
    /** Whether the last assistant/user message marks a milestone. */
    readonly milestone: boolean
  }
}

/**
 * The ONE compaction policy. Decides whether to compact, which executor should
 * run, and to what water level, inside hard bounds and the caller's
 * capabilities.
 *
 * Priority (mirrors the legacy fold trigger): force > provider overflow >
 * fit-guard > predicted nudge > below-trigger > cooldown > surge >
 * interval-elapsed pressure (narrowed window → durable, else fold) >
 * rate-limited. A lane the caller cannot execute is downgraded (durable → fold
 * when possible) or suppressed.
 * @param input - snapshot, ledger, capabilities, anchors and bounds.
 * @returns the bounded plan (never throws, never NaN).
 */
export function planCompaction(input: GovernanceInput): CompactionPlan {
  const b: GovernanceBounds = { ...DEFAULT_GOVERNANCE_BOUNDS, ...(input.bounds ?? {}) }
  const { snapshot, ledger } = input
  const window = Number.isFinite(snapshot.window) && snapshot.window > 0 ? snapshot.window : 1
  const fixedTokens = Number.isFinite(snapshot.fixedTokens) ? Math.max(0, snapshot.fixedTokens) : 0
  const basis = Number.isFinite(input.basisTokens) && (input.basisTokens ?? 0) > 0
    ? (input.basisTokens as number)
    : window
  const measured = Number.isFinite(input.measuredTokens)
    ? (input.measuredTokens as number)
    : snapshot.totalTokens
  const injection = Number.isFinite(input.injectionBudget) ? Math.max(0, input.injectionBudget ?? 0) : 0
  const fillRatio = Number.isFinite(input.fillRatio)
    ? (input.fillRatio as number)
    : (basis > 0 ? measured / basis : 0)

  const levels = compactionWaterLevels({
    baseTriggerRatio: input.baseTriggerRatio,
    baseTargetRatio: input.baseTargetRatio,
    budgetTokens: basis,
    fillRatio,
    growthTokens: ledger.growthTokens,
    compressInterval: input.compressInterval,
    compressions: ledger.compressions,
    injectionBudget: injection,
    bounds: b,
  })

  // In the caller's basis, 'trigger' and 'target' are exactly the water levels;
  // the surface-basis fields are the same numbers for the fold lane (whose
  // basis IS the surface budget) and are advisory for the durable lane.
  // Opportunity modulation: a good seam lowers the trigger (compact now), a
  // bad one raises it (defer), always inside the hard water-level bounds.
  const opp = input.opportunity
  const oppScore = opp === undefined ? 0.5 : clamp01(opp.score)
  const maturity = opp === undefined ? 1 : clamp01(opp.maturity)
  // Symmetric modulation around a neutral 0.5: a good seam lowers the
  // trigger (compact now), a bad one raises it (defer), and no signal at all
  // (legacy callers/tests) leaves the plan untouched. Hard bounds always win.
  const intent = input.intent
  const intentTiming = intent === undefined ? undefined : clamp01(intent.timing)
  // The content/stage intent already encodes the phase; do not double-count it.
  const swing = intent !== undefined || opp === undefined ? 0 : (0.5 - oppScore) * (OPP_BONUS_MAX * 2)
  const earlyPenalty = opp === undefined ? 0 : (1 - maturity) * OPP_EARLY_PENALTY
  const intentDelta = intentTiming === undefined ? 0 : (0.5 - intentTiming) * 0.10
  const triggerRatio = clampRange(
    levels.triggerRatio + swing + earlyPenalty + intentDelta,
    b.triggerFloor,
    b.triggerCeiling,
  )
  const intentMagnitude = intent === undefined ? undefined : clamp01(intent.magnitude)
  // Deep probe: on a large, mostly-empty window whose bulk is disposable
  // (the intent says tool-heavy), the 0.55 memory floor costs hundreds of
  // thousands of tokens while the window sits idle — a 1M session folded on
  // cadence alone at ~35% window fill. The floor relaxes so the magnitude
  // signal can actually REACH a deeper target. Fill is measured against the
  // WINDOW (not the budget): the probe is about the window's spare room, and
  // the budget already subtracts the completion reserve.
  const deepProbe = window >= b.deepProbeMinWindow
    && snapshot.surfaceTokens / window < b.deepProbeMaxWindowFill
    && intentMagnitude !== undefined
    && intentMagnitude >= b.deepProbeMinMagnitude
  const memoryTargetFloor = deepProbe ? b.deepProbeMemoryFloor : b.memoryTargetFloor
  // Interpolate inside the band the trigger can actually use; a global maxBand
  // would push even a low magnitude into the memory floor.
  const availableBand = Math.max(b.minBand, triggerRatio - memoryTargetFloor)
  const intentBand = intentMagnitude === undefined
    ? 0
    : clampRange(b.minBand + (availableBand - b.minBand) * intentMagnitude, b.minBand, availableBand)
  const rawTargetRatio = clampRange(
    intentMagnitude === undefined
      ? levels.targetRatio - (levels.triggerRatio - triggerRatio)
      : triggerRatio - intentBand,
    intentMagnitude === undefined ? b.targetFloor : memoryTargetFloor,
    Math.max(b.targetFloor, triggerRatio - b.minBand),
  )
  // The retained tail is what the agent keeps verbatim. A mature session used
  // to widen its band until the tail was almost gone, so keep a memory floor.
  const memoryFloor = clampRange(
    memoryTargetFloor,
    b.targetFloor,
    Math.max(b.targetFloor, triggerRatio - b.minBand),
  )
  // Closed-loop band: folds systematically landed ABOVE the planned target
  // (the summary's own tokens, the pinned head and the unfoldable tail sit on
  // top of the retained range), so the planner pre-compensates by the learned
  // shortfall — bounded to targetDeviationMax of the basis and never below
  // the memory floor. The correction is clamped >= 0 upstream: a stale
  // overshoot cannot make the planner lazier than its configured band.
  const deviationCorrection = targetDeviationCorrection(
    input.deviationEmaTokens,
    basis,
    b.targetDeviationMax,
  )
  const targetRatio = Math.max(rawTargetRatio - deviationCorrection, memoryFloor)
  const triggerTokens = Math.max(1, Math.floor(basis * triggerRatio) - injection)
  const targetTokens = Math.max(0, Math.floor(basis * targetRatio) - injection)
  const surfaceTriggerTokens = triggerTokens
  const targetSurfaceTokens = targetTokens

  const fillPressure = fillPressureOf(Number.isFinite(fillRatio) ? fillRatio : 0)
  const growthPressure = clamp01((ledger.growthTokens / Math.max(1, basis)) / Math.max(0.0001, b.hotGrowth))
  const stagePressure = clamp01(ledger.compressions / Math.max(1, b.matureCompressions))
  const urgency = Math.max(fillPressure, growthPressure, stagePressure)

  const recommend = (lane: GovernanceLane, reason: GovernanceReason): CompactionPlan => {
    let effective = lane
    if (effective === 'durable' && !input.capabilities.durable) {
      effective = input.capabilities.fold ? 'fold' : 'none'
    }
    if (effective === 'fold' && !input.capabilities.fold) effective = 'none'
    return {
      lane: effective,
      reason,
      triggerRatio,
      targetRatio,
      triggerTokens,
      surfaceTriggerTokens,
      targetSurfaceTokens,
      drivers: {
        fill: fillPressure,
        growth: growthPressure,
        stage: stagePressure,
        urgency,
        opportunity: oppScore,
        phase: opp?.phase ?? 'unspecified',
        timing: intentTiming ?? 0,
        magnitude: intentMagnitude ?? 0,
        milestone: intent?.profile.milestone ?? false,
      },
    }
  }

  if (input.force) return recommend('fold', 'forced')
  if (input.incomingTrigger === 'context-overflow') return recommend('durable', 'overflow')

  // Fit-guard: the request is about to run out of window. Bypasses every gate.
  const reserve = Math.max(b.guardReserveMin, Math.floor(window * b.guardReserveRatio))
  if (snapshot.totalTokens >= window - reserve) return recommend('durable', 'fit-guard')

  const turn = Number.isFinite(ledger.turn) ? ledger.turn : 0
  const lastTurn = ledger.lastCompressedTurn
  const roundsSince = lastTurn === undefined ? Number.POSITIVE_INFINITY : turn - lastTurn
  const interval = Math.max(1, input.compressInterval)
  const delta = ledger.lastTokens === undefined
    ? Number.NEGATIVE_INFINITY
    : measured - ledger.lastTokens
  // Surge is a share of the WINDOW (legacy semantic), independent of the basis.
  const surgeThreshold = Math.max(1, Math.floor(window * b.surgeRatio))
  const surge = delta >= surgeThreshold

  // Nudge: below the line but predicted to cross it. Pre-empts the gates the
  // same way shouldNudgeCompaction did (positive growth, no cooldown, interval
  // elapsed).
  if (
    input.nudge
    && oppScore >= OPP_NUDGE_MIN
    && ledger.growthTokens > 0
    && measured < triggerTokens
    && measured + ledger.growthTokens >= triggerTokens
    && ledger.failureCooldown <= 0
    && roundsSince >= interval
  ) return recommend('fold', 'nudge')

  // Legacy order: below-trigger is decided BEFORE the cooldown.
  if (measured <= triggerTokens) return recommend('none', 'below-trigger')
  if (ledger.failureCooldown > 0) return recommend('none', 'cooldown')
  if (surge) return recommend(input.incomingTrigger === 'pressure' ? 'durable' : 'fold', 'surge')
  if (roundsSince >= interval) {
    const narrowedShort = snapshot.declaredWindow !== undefined && window < snapshot.declaredWindow
    if (narrowedShort) return recommend('durable', 'narrowed-window')
    return recommend(input.incomingTrigger === 'pressure' ? 'durable' : 'fold', 'pressure')
  }
  return recommend('none', 'rate-limited')
}

/* -------------------------------------------------------------------------- */
/*  Wiring helpers (pure)                                                      */
/*  Extracted so the engine's fold wiring and ledger view are testable        */
/*  without a Cordis context.                                                  */
/* -------------------------------------------------------------------------- */

/** Structural view of one session's persisted ledger entry. */
export interface SessionLedgerEntry {
  readonly turn: number
  readonly lastCompressedTurn?: number
  readonly lastTokens?: number
  readonly failureCooldown: number
  readonly compressions?: number
  readonly growthEma?: number
  readonly lastSizeTokens?: number
}

/**
 * Build the planner's ledger view from a persisted entry.
 *
 * `turn` is the UPCOMING turn (entry.turn + 1), because the executor increments
 * it via touchSession before it acts; without the +1 the planner's rate-limit
 * boundary would be one round off. The growth EMA is recomputed from the
 * current surface exactly like the executor does, so the planner never reads a
 * stale value.
 * @param entry - the persisted per-session entry.
 * @param surfaceTokens - current surface estimate (omitted = keep the stored EMA).
 * @returns the planner's ledger input.
 */
export function ledgerView(entry: SessionLedgerEntry, surfaceTokens?: number): GovernanceLedger {
  const measured = Number.isFinite(surfaceTokens) ? (surfaceTokens as number) : undefined
  let grown: number
  if (measured === undefined) {
    grown = entry.growthEma ?? 0
  } else {
    // Mirrors nextGrowthEma in compaction-policy (kept inline to avoid a cycle).
    const delta = entry.lastSizeTokens === undefined ? 0 : measured - entry.lastSizeTokens
    grown = entry.growthEma === undefined ? Math.max(0, delta) : Math.max(0, entry.growthEma * 0.5 + delta * 0.5)
  }
  return {
    turn: entry.turn + 1,
    ...(entry.lastCompressedTurn === undefined ? {} : { lastCompressedTurn: entry.lastCompressedTurn }),
    ...(entry.lastTokens === undefined ? {} : { lastTokens: entry.lastTokens }),
    failureCooldown: entry.failureCooldown,
    compressions: entry.compressions ?? 0,
    growthTokens: grown,
  }
}

/** Input for {@link planFoldCompaction}. */
export interface FoldPlanInput {
  /** Surface-only estimate on the executor's CJK-aware basis. */
  readonly surfaceTokens: number
  /** Envelope (system/tools/injection) the fold cannot reclaim. */
  readonly fixedTokens: number
  /** Effective model window (for fit-guard and narrowed checks). */
  readonly window: number
  readonly ledger: GovernanceLedger
  readonly baseTriggerRatio: number
  readonly baseTargetRatio: number
  readonly compressInterval: number
  /** Fold basis: the effective budget = window × (1 − headroom). */
  readonly budgetTokens: number
  readonly injectionBudget: number
  readonly nudge: boolean
  /** Manual/forced fold: bypass the trigger and rate-limit gates. */
  readonly force?: boolean
  /** Session-phase opportunity, forwarded to the planner. */
  readonly opportunity?: CompactionOpportunity
  /** Content/stage intent, forwarded to the planner. */
  readonly intent?: CompactionIntent
  /** Learned landing-deviation EMA, forwarded to the planner. */
  readonly deviationEmaTokens?: number
  readonly declaredWindow?: number
  readonly bounds?: Partial<GovernanceBounds>
}

/**
 * Build the fold lane's plan: snapshot on the executor's own (CJK-aware) basis,
 * effective-budget denominator, surface-only measured quantity, and no fill term
 * (matching the fold lane's pre-governance behaviour). The envelope still comes
 * from the authoritative meter so the fit-guard sees the real request size.
 * @param input - fold-lane wiring inputs.
 * @returns the bounded plan (capabilities: fold only).
 */
export function planFoldCompaction(input: FoldPlanInput): CompactionPlan {
  const surface = Number.isFinite(input.surfaceTokens) && input.surfaceTokens > 0 ? input.surfaceTokens : 0
  const fixed = Number.isFinite(input.fixedTokens) && input.fixedTokens > 0 ? input.fixedTokens : 0
  const snapshot = toSurfaceSnapshot({
    totalTokens: surface + fixed,
    surfaceTokens: surface,
    window: input.window,
    ...(input.declaredWindow === undefined ? {} : { declaredWindow: input.declaredWindow }),
  })
  return planCompaction({
    snapshot,
    ledger: input.ledger,
    capabilities: { fold: true, durable: false },
    baseTriggerRatio: input.baseTriggerRatio,
    baseTargetRatio: input.baseTargetRatio,
    compressInterval: input.compressInterval,
    incomingTrigger: 'fold',
    force: input.force === true,
    nudge: input.nudge,
    basisTokens: input.budgetTokens,
    measuredTokens: surface,
    fillRatio: 0,
    injectionBudget: input.injectionBudget,
    ...(input.opportunity === undefined ? {} : { opportunity: input.opportunity }),
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.deviationEmaTokens === undefined ? {} : { deviationEmaTokens: input.deviationEmaTokens }),
    ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
  })
}
