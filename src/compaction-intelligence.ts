/**
 * Content- and stage-driven compaction intent.
 *
 * The water-level constants are safety bounds, not normal drivers. This module
 * reads what the context is made of and where the work stands, then returns
 * two bounded signals:
 *
 * - timing: is now a clean seam? (turn boundary, milestone, no open question)
 * - magnitude: how much can be folded without hurting working memory?
 *   (tool-heavy context folds deep; instruction/decision-heavy context folds
 *   shallow)
 *
 * The fixed weights below only shape the signals; they are fallbacks, not the
 * decision itself.
 */
import type { SessionPhase } from './compaction-opportunity.ts'

/** One surface node reduced to what the intent needs. */
export interface SurfaceSignal {
  readonly type: string
  readonly tokens: number
  readonly text?: string
  readonly hasToolCalls?: boolean
  readonly isError?: boolean
}

/** What the current context is made of and where the turn stands. */
export interface ContextProfile {
  readonly messageTokens: number
  readonly userShare: number
  readonly assistantShare: number
  readonly toolShare: number
  readonly milestone: boolean
  readonly openQuestion: boolean
  readonly toolRun: number
  readonly recentErrors: number
  readonly phase: SessionPhase
}

/** Bounded intent consumed by the planner. */
export interface CompactionIntent {
  /** 0 = defer (bad seam), 1 = fold now (clean seam). */
  readonly timing: number
  /** 0 = keep verbatim, 1 = fold deep (mostly disposable bulk). */
  readonly magnitude: number
  readonly profile: ContextProfile
  readonly reasons: readonly string[]
}

/** Phase score; a fallback prior, not the decision. */
const PHASE_SCORE: Record<SessionPhase, number> = {
  'turn-start': 1,
  'turn-end': 0.9,
  steady: 0.6,
  'tool-loop': 0.15,
}

const COMPLETION = /(^|\n)\s*(done|finished|complete|completed|fixed|resolved|implemented|ready|next steps?|summary)\b/i
const COMPLETION_CN = /(完成|已完成|搞定|修复|已修复|实现了|下一步|总结|可以了|没问题)/
const CONFIRMATION = /^(对|好|好的|行|可以|继续|谢谢|收到|ok|okay|yes|yep|perfect|great|thanks|thank you)[.!。！]?$/i

const clamp01 = (value: number): number => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0

/**
 * Derive the intent from the surface signals.
 * @param signals - surface nodes in head-to-tail order (last = newest).
 * @returns the bounded intent plus the profile it came from.
 */
export function analyzeContext(signals: readonly SurfaceSignal[]): CompactionIntent {
  let total = 0
  let user = 0
  let assistant = 0
  let tool = 0
  for (const signal of signals) {
    const tokens = Number.isFinite(signal.tokens) ? Math.max(0, signal.tokens) : 0
    total += tokens
    if (signal.type === 'user/message') user += tokens
    else if (signal.type === 'assistant/message') assistant += tokens
    else if (signal.type === 'tool/result') tool += tokens
  }
  const div = total > 0 ? total : 1
  const userShare = user / div
  const assistantShare = assistant / div
  const toolShare = tool / div

  let toolRun = 0
  for (let i = signals.length - 1; i >= 0; i -= 1) {
    if (signals[i]?.type !== 'tool/result') break
    toolRun += 1
  }
  const recent = signals.slice(-20)
  const recentErrors = recent.filter(signal => signal.isError === true).length

  const lastAssistant = [...signals].reverse().find(signal => signal.type === 'assistant/message')
  const lastUser = [...signals].reverse().find(signal => signal.type === 'user/message')
  const assistantText = (lastAssistant?.text ?? '').trim()
  const userText = (lastUser?.text ?? '').trim()
  const milestone = COMPLETION.test(assistantText)
    || COMPLETION_CN.test(assistantText)
    || CONFIRMATION.test(userText)
  const openQuestion = /[?？]\s*$/.test(assistantText)

  const last = signals[signals.length - 1]
  const phase: SessionPhase = last === undefined
    ? 'steady'
    : last.type === 'user/message'
      ? 'turn-start'
      : last.type === 'assistant/message'
        ? (last.hasToolCalls === true ? 'tool-loop' : 'turn-end')
        : last.type === 'tool/result'
          ? 'tool-loop'
          : 'steady'

  const timing = clamp01(
    PHASE_SCORE[phase]
    + (milestone ? 0.10 : 0)
    - (openQuestion ? 0.20 : 0)
    - (toolRun >= 2 ? 0.30 : 0)
    - (recentErrors > 0 ? 0.10 : 0),
  )
  const magnitude = clamp01(
    0.5
    + 0.45 * toolShare
    - 0.35 * userShare
    - 0.20 * assistantShare
    + (milestone ? 0.10 : 0)
    - (openQuestion ? 0.20 : 0),
  )

  const reasons: string[] = []
  if (toolShare >= 0.5) reasons.push('tool-heavy')
  if (userShare >= 0.2) reasons.push('instruction-heavy')
  if (assistantShare >= 0.3) reasons.push('decision-heavy')
  if (milestone) reasons.push('milestone')
  if (openQuestion) reasons.push('open-question')
  if (toolRun >= 2) reasons.push('tool-run')
  if (recentErrors > 0) reasons.push('recent-errors')

  return {
    timing,
    magnitude,
    profile: {
      messageTokens: total,
      userShare,
      assistantShare,
      toolShare,
      milestone,
      openQuestion,
      toolRun,
      recentErrors,
      phase,
    },
    reasons,
  }
}
