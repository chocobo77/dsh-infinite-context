/**
 * Token budget allocation across memory tiers.
 *
 * The budget guarantees the sum of the per-tier allocations stays within the
 * model's context window, leaving headroom for the system prompt, tools, the
 * current user input, and the model's output. It also provides a CJK-aware
 * token estimator used to decide whether a memory fits a tier's budget.
 *
 * @module dsh-infinite-context/token-budget
 */

import type { BudgetConfig, Tier } from './types.ts'

/**
 * Heuristic token estimate that treats each Han character as ~1 token and
 * each other character as ~1/4 token. Deliberately conservative (over-
 * estimates) so budget checks err on the safe side.
 * @param text - the text to estimate.
 * @returns an estimated token count (>= 0).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0xac00 && code <= 0xd7af)
    if (isCjk) cjk++
    else other++
  }
  return Math.ceil(cjk * 1.0 + other / 4)
}

/** A validated, queryable token budget across tiers. */
export class TokenBudget {
  readonly budget: BudgetConfig
  readonly contextWindow: number
  /** Headroom (tokens) reserved outside the four memory tiers. */
  readonly headroom: number

  /**
   * @param budget - the per-tier token budgets.
   * @param contextWindow - the model's total context window in tokens.
   * @param headroomRatio - fraction of the window reserved for system prompt,
   *   tools, current input, and output (default 0.25).
   */
  constructor(budget: BudgetConfig, contextWindow: number, headroomRatio = 0.25) {
    if (contextWindow <= 0) throw new RangeError('contextWindow must be positive')
    if (headroomRatio < 0 || headroomRatio >= 1) {
      throw new RangeError('headroomRatio must be in [0, 1)')
    }
    this.budget = budget
    this.contextWindow = contextWindow
    this.headroom = Math.floor(contextWindow * headroomRatio)
  }

  /** The sum of the four tier budgets. */
  get total(): number {
    return this.budget.short + this.budget.mid + this.budget.long + this.budget.retrieved
  }

  /** The maximum tokens the four tiers may consume given the headroom. */
  get maxTotal(): number {
    return this.contextWindow - this.headroom
  }

  /**
   * Assert the budget is feasible for the context window.
   * @throws when the tier budgets exceed the available (window - headroom).
   */
  validate(): void {
    if (this.total > this.maxTotal) {
      throw new Error(
        `token budget infeasible: tiers total ${this.total} tokens but only `
        + `${this.maxTotal} are available (window ${this.contextWindow} - headroom ${this.headroom}). `
        + 'Reduce the tier budgets or increase the context window.',
      )
    }
  }

  /**
   * The token budget for a single tier.
   * @param tier - the tier.
   * @returns the tier's token budget.
   */
  for(tier: Tier | 'retrieved'): number {
    switch (tier) {
      case 'short': return this.budget.short
      case 'mid': return this.budget.mid
      case 'long': return this.budget.long
      case 'retrieved': return this.budget.retrieved
    }
  }

  /**
   * Whether a text's estimated size fits a tier's budget.
   * @param tier - the tier (or `retrieved`).
   * @param text - the candidate text.
   * @returns true when the estimate is within the tier budget.
   */
  fits(tier: Tier | 'retrieved', text: string): boolean {
    return estimateTokens(text) <= this.for(tier)
  }

  /**
   * Truncate a text to fit a tier's budget by dropping whole lines from the
   * end until it fits (or it is empty). Line-based truncation keeps the
   * summary structurally intact rather than cutting mid-sentence.
   * @param tier - the tier (or `retrieved`).
   * @param text - the text to truncate.
   * @returns the truncated text (possibly empty).
   */
  truncateToBudget(tier: Tier | 'retrieved', text: string): string {
    if (this.fits(tier, text)) return text
    const limit = this.for(tier)
    const lines = text.split('\n')
    let kept: string[] = []
    let used = 0
    for (const line of lines) {
      const cost = estimateTokens(line) + 1 // +1 for the newline
      if (used + cost > limit && kept.length > 0) break
      kept.push(line)
      used += cost
    }
    return kept.join('\n')
  }
}
