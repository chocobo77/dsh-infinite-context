/**
 * Session-phase opportunity for compaction timing.
 *
 * The water levels answer "is there pressure?"; this module answers "is NOW a
 * good moment to rewrite the prefix?". A fold rewrites the request prefix, so
 * compacting mid tool-loop pays the summary cost and invalidates the cache for
 * a request that is about to grow again. A turn boundary is the opposite: the
 * loop is between work units, the next request starts a fresh prefix, and the
 * fold lands on a clean seam.
 *
 * The score is deliberately bounded and only MODULATES the planner's trigger
 * inside its hard water-level bounds; overflow, the fit-guard and an explicit
 * force still bypass it. Maturity keeps very young sessions from compacting
 * before the task is even clear.
 *
 * @module dsh-infinite-context/compaction-opportunity
 */

/** Where in a turn the session currently sits. */
export type SessionPhase = 'turn-start' | 'turn-end' | 'steady' | 'tool-loop'

/** Observable signals the engine derives from the session surface. */
export interface SessionPhaseSignals {
  /** Committed user turns in the scanned surface (a lower bound for long sessions). */
  readonly turnCount: number
  /** Surface events since the last user message. */
  readonly stepsSinceUser: number
  /** Type of the most recent non-compaction surface event, or '' when unknown. */
  readonly lastEventType: string
  /** Whether a trailing assistant message carried tool calls. */
  readonly lastEventHadToolCalls?: boolean
  /** Share of tool results among recent assistant/tool events (0..1). */
  readonly recentToolRatio?: number
  /** Successful compressions in the ledger (maturity survives surface folding). */
  readonly compressions?: number
}

/** The planner's view of the current moment. */
export interface CompactionOpportunity {
  readonly phase: SessionPhase
  /** 0..1: how good this moment is for a prefix-rewriting fold. */
  readonly score: number
  /** 0..1: how mature the session is (young sessions compact later). */
  readonly maturity: number
}

/** Trigger-ratio swing granted to a perfect opportunity. */
export const OPP_BONUS_MAX = 0.1
/** Extra trigger headroom demanded while the session is still young. */
export const OPP_EARLY_PENALTY = 0.08
/** Turns at which a session counts as fully mature. */
export const OPP_MATURE_TURNS = 12
/** Minimum opportunity for a growth nudge (never nudge mid tool-loop). */
export const OPP_NUDGE_MIN = 0.5

/** Clamp to [0, 1]; non-finite values become 0. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Score the current moment from the session's phase signals.
 * @param signals - phase signals derived from the surface tail.
 * @returns the phase, its 0..1 opportunity score and the session maturity.
 */
export function evaluateOpportunity(signals: SessionPhaseSignals): CompactionOpportunity {
  const last = signals.lastEventType
  let phase: SessionPhase
  if (last === 'user/message') phase = 'turn-start'
  else if (last === 'tool/result') phase = 'tool-loop'
  else if (last === 'assistant/message') phase = signals.lastEventHadToolCalls === true ? 'tool-loop' : 'turn-end'
  else phase = 'steady'

  const base = phase === 'turn-start' ? 1
    : phase === 'turn-end' ? 0.9
      : phase === 'steady' ? 0.6
        : 0.15
  // A steady step inside a tool-heavy stretch is less of a seam than a quiet
  // one. Turn boundaries already know their shape, so they are not penalized.
  const penalty = phase === 'steady' ? clamp01(signals.recentToolRatio ?? 0) * 0.35 : 0
  const score = clamp01(base - penalty)
  // A fold replaces the oldest user messages with a summary, so the surface
  // turn count can drop after a compaction. Ledger compressions are the
  // durable maturity signal; take the stronger of the two.
  const turnMaturity = clamp01((signals.turnCount - 2) / Math.max(1, OPP_MATURE_TURNS - 2))
  const compressionMaturity = clamp01((signals.compressions ?? 0) / 8)
  const maturity = Math.max(turnMaturity, compressionMaturity)
  return { phase, score, maturity }
}
