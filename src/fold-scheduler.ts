/**
 * The runway scheduler: the learning layer that decides WHEN to fold and HOW
 * DEEP, from observed fold cycles instead of fixed ratio anchors.
 *
 * One fold CYCLE = one landing → next trigger crossing. Each committed fold
 * closes a cycle and produces a {@link FoldCycleReport}; the EMAs below are
 * the controller state; the control law is:
 *
 *   anchor    = landedPrev + k × runwayEma          (clamped to the hard band)
 *   amplitude = configuredBand × amplitudeFactor(recall)
 *   minInterval = clamp(cycleTimeEma × 0.5, 5min, 60min)
 *
 * k is the failure servo: an agent-lane overflow (400 / guard takeover)
 * SHRINKS it (fold earlier — the band was too wide for this route); healthy
 * cycles with low cache utility GROW it (fold later — frequent folds waste
 * the KV prefix the harness rebuilds after every fold). Recall quality
 * steers amplitude: summaries that get read back mean the folded content
 * was still needed (fold shallower); long stretches without a read-back
 * mean it was safe to forget (fold deeper).
 *
 * Discipline: constants here are COLD-START PRIORS or SERVO STEP SIZES, not
 * operating points — the operating point is always the learned state. All
 * pure functions; the caller owns persistence (SessionCounter JSON for the
 * per-session copy, `fold-cycle:prior:<route>` KV for the route prior).
 *
 * @module dsh-infinite-context/fold-scheduler
 */

/** One completed fold cycle, measured at the commit of its closing fold. */
export interface FoldCycleReport {
  /** Surface tokens at this fold minus the previous fold's landing (≥ 0). */
  readonly runwayTokens: number
  /** ms since the previous fold's commit (≥ 0; 0 for the session's first). */
  readonly cycleTimeMs: number
  /** Agent requests served during the cycle (0 when unknown). */
  readonly cycleRequests: number
  /**
   * Cache hit ratio over the cycle = cacheRead / (cacheRead + input + write),
   * in [0, 1]; `undefined` when the cycle carried no usage rows.
   */
  readonly cycleCacheHit?: number
  /** Whether the folded range was read back (fl_ recall) during the cycle. */
  readonly recalled: boolean
  /** Whether an agent-lane overflow / guard takeover happened in the cycle. */
  readonly hadFailure: boolean
}

/** The controller state; every field optional = "not learned yet". */
export interface FoldLearningState {
  /** EMA of runway/budget — budget-independent so priors port across sessions. */
  readonly runwayRatioEma?: number
  readonly cycleTimeEmaMs?: number
  readonly cycleRequestsEma?: number
  readonly cycleCacheHitEma?: number
  /** EMA of the per-cycle recall indicator (1 = folded range was read back). */
  readonly recallEma?: number
  /** The failure servo's runway factor (cold start 1.0). */
  readonly runwayFactor?: number
}

/** Cold-start priors and servo step sizes. NOT operating points. */
export const FOLD_SCHEDULER_ALPHA = 0.5
export const FOLD_RUNWAY_FACTOR_DEFAULT = 1.0
export const FOLD_SERVO_SHRINK = 0.7
export const FOLD_SERVO_GROW_LOW_CACHE = 1.15
export const FOLD_SERVO_RECOVER = 1.05
export const FOLD_SERVO_K_MIN = 0.5
export const FOLD_SERVO_K_MAX = 2.5
/** A cycle whose cache hit ratio sits below this is a "folds too frequent" vote. */
export const FOLD_CACHE_UTILITY_FLOOR = 0.7
/** amplitudeFactor = clamp(0.5, 2, AMPLITUDE_FROM_RECALL − recallEma). */
export const FOLD_AMPLITUDE_FROM_RECALL = 1.5
export const FOLD_AMPLITUDE_MIN = 0.5
export const FOLD_AMPLITUDE_MAX = 2
/** A runway under one min-band of the budget is noise; floor the EMA input. */
export const FOLD_MIN_RUNWAY_RATIO = 0.04
export const FOLD_MIN_INTERVAL_MS = 5 * 60_000
export const FOLD_MAX_INTERVAL_MS = 60 * 60_000

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value))

/** The state a session/route starts with. */
export function emptyFoldLearningState(): FoldLearningState {
  return {}
}

function ema(prev: number | undefined, sample: number): number {
  return prev === undefined || !Number.isFinite(prev) ? sample : prev * (1 - FOLD_SCHEDULER_ALPHA) + sample * FOLD_SCHEDULER_ALPHA
}

/**
 * Close one fold cycle: fold every measurable into the controller state.
 * Pure — returns the next state; the caller persists it.
 */
export function updateFoldLearning(
  state: FoldLearningState,
  report: FoldCycleReport,
  budgetTokens: number,
): FoldLearningState {
  const budget = Number.isFinite(budgetTokens) && (budgetTokens as number) > 0 ? (budgetTokens as number) : 1
  const runwayRatio = Number.isFinite(report.runwayTokens) && report.runwayTokens >= 0
    ? clamp(report.runwayTokens / budget, FOLD_MIN_RUNWAY_RATIO, 0.9)
    : undefined
  const cycleTime = Number.isFinite(report.cycleTimeMs) && (report.cycleTimeMs as number) > 0
    ? Math.min(report.cycleTimeMs as number, 24 * 60 * 60_000)
    : undefined
  const requests = Number.isFinite(report.cycleRequests) && (report.cycleRequests as number) >= 0
    ? report.cycleRequests as number
    : undefined
  const cacheHit = report.cycleCacheHit !== undefined && Number.isFinite(report.cycleCacheHit)
    ? clamp(report.cycleCacheHit as number, 0, 1)
    : undefined
  const k = state.runwayFactor ?? FOLD_RUNWAY_FACTOR_DEFAULT
  // Failure servo lives HERE too: a failed cycle is evidence the band was
  // too wide, whatever the cache says.
  const kAfterFailure = report.hadFailure
    ? Math.max(FOLD_SERVO_K_MIN, k * FOLD_SERVO_SHRINK)
    : k
  // Utility servo: healthy + low cache utility = folds were too frequent —
  // lengthen the runway. Healthy + comfortable cache = gentle recovery
  // toward neutral (a one-off transient server failure must not depress k
  // forever). Unhealthy cycles already shrank above.
  const kNext = report.hadFailure
    ? kAfterFailure
    : cacheHit !== undefined && cacheHit < FOLD_CACHE_UTILITY_FLOOR
      ? Math.min(FOLD_SERVO_K_MAX, kAfterFailure * FOLD_SERVO_GROW_LOW_CACHE)
      : Math.min(FOLD_SERVO_K_MAX, kAfterFailure * FOLD_SERVO_RECOVER)
  return {
    ...(runwayRatio === undefined ? {} : { runwayRatioEma: ema(state.runwayRatioEma, runwayRatio) }),
    ...(cycleTime === undefined ? {} : { cycleTimeEmaMs: ema(state.cycleTimeEmaMs, cycleTime) }),
    ...(requests === undefined ? {} : { cycleRequestsEma: ema(state.cycleRequestsEma, requests) }),
    ...(cacheHit === undefined ? {} : { cycleCacheHitEma: ema(state.cycleCacheHitEma, cacheHit) }),
    recallEma: ema(state.recallEma, report.recalled ? 1 : 0),
    runwayFactor: kNext,
  }
}

/** An agent-lane overflow / guard takeover: fold earlier on this route. */
export function shrinkRunwayFactor(state: FoldLearningState): FoldLearningState {
  const k = state.runwayFactor ?? FOLD_RUNWAY_FACTOR_DEFAULT
  return { ...state, runwayFactor: Math.max(FOLD_SERVO_K_MIN, k * FOLD_SERVO_SHRINK) }
}

/**
 * The learned trigger anchor for the NEXT fold, as a share of the budget:
 * one delivered runway (scaled by the failure servo) above the last landing.
 * `undefined` until the first cycle has been observed — the caller then
 * falls back to the configured cold-start anchor. Clamping to the hard band
 * happens in the planner (the anchor is a request, the bounds are the law).
 */
export function learnedAnchorRatio(
  landedRatio: number,
  state: FoldLearningState,
): number | undefined {
  const runway = state.runwayRatioEma
  if (runway === undefined || !Number.isFinite(runway)) return undefined
  const landed = Number.isFinite(landedRatio) ? clamp(landedRatio as number, 0, 1) : 0
  const k = state.runwayFactor ?? FOLD_RUNWAY_FACTOR_DEFAULT
  return landed + k * runway
}

/**
 * The learned amplitude: summaries that get read back were still needed —
 * fold shallower; long zero-recall stretches mean the content was safely
 * forgotten — fold deeper. Multiplies the configured band; the planner
 * clamps the result into [minBand, maxBand].
 */
export function learnedBandScale(state: FoldLearningState): number | undefined {
  const recall = state.recallEma
  if (recall === undefined || !Number.isFinite(recall)) return undefined
  return clamp(FOLD_AMPLITUDE_FROM_RECALL - (recall as number), FOLD_AMPLITUDE_MIN, FOLD_AMPLITUDE_MAX)
}

/**
 * The learned pacing floor for the frequency gate: half the observed cycle
 * time, clamped to the same envelope the latency-based prior uses.
 * `undefined` before the first cycle closes (caller falls back to
 * `foldIntervalFor(latencyEma)`).
 */
export function learnedMinIntervalMs(state: FoldLearningState): number | undefined {
  const cycle = state.cycleTimeEmaMs
  if (cycle === undefined || !Number.isFinite(cycle) || (cycle as number) <= 0) return undefined
  return clamp((cycle as number) * 0.5, FOLD_MIN_INTERVAL_MS, FOLD_MAX_INTERVAL_MS)
}

const PRIOR_KEYS = ['runwayRatioEma', 'cycleTimeEmaMs', 'cycleRequestsEma', 'cycleCacheHitEma', 'recallEma', 'runwayFactor'] as const

/**
 * Serialize the ROUTE-level prior (KV `fold-cycle:prior:<route>`): numbers
 * only, each independently guarded — a corrupt field degrades to "not
 * learned yet" instead of poisoning the controller (the restoreCounter
 * whitelist lesson).
 */
export function serializeFoldPrior(state: FoldLearningState): string {
  const out: Record<string, number> = {}
  for (const key of PRIOR_KEYS) {
    const value = state[key]
    if (value !== undefined && Number.isFinite(value)) out[key] = value
  }
  return JSON.stringify(out)
}

/** Parse a route prior; unknown shapes degrade to an empty state. */
export function parseFoldPrior(raw: string | undefined): FoldLearningState {
  if (raw === undefined || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const key of PRIOR_KEYS) {
      const value = parsed[key]
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out as FoldLearningState
  } catch {
    return {}
  }
}
