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

/**
 * Fixed token cost charged per image block by the heuristic meter. The real
 * cost varies with resolution; this conservative constant keeps image-heavy
 * sessions from being systematically under-measured.
 */
export const IMAGE_BLOCK_TOKEN_COST = 1500

/**
 * Per tool-result / tool-call block, the estimated tokens are capped at this
 * value. Tool payloads can be huge or base64-laden; bounding a single block
 * keeps the conversation estimate honest without letting one monster result
 * dominate (and skew) the compression and thinking-guard metering.
 */
export const MAX_TOOL_BLOCK_TOKENS = 8192

/** Meter ONE content block (recursing into nested content where present). */
function estimateBlockTokens(block: { type?: unknown } & Record<string, unknown>): number {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? estimateTokens(block.text) : 0
    case 'image':
      return IMAGE_BLOCK_TOKEN_COST
    case 'reasoning':
      return typeof block.text === 'string' ? estimateTokens(block.text) : 32
    case 'tool-result':
      // The real payload is NESTED (content: [{type:'text', text: fileContents}]).
      // Recursing is what makes file reads and command output count — without
      // it a 50K-token read was metered as a flat 32 tokens.
      if (Array.isArray(block.content)) {
        return Math.min(MAX_TOOL_BLOCK_TOKENS, estimateContentTokens(block.content))
      }
      return typeof block.text === 'string' ? estimateTokens(block.text) : 32
    case 'tool-call':
      // `arguments` is raw JSON (may embed base64) — count it, capped, so a
      // giant call payload cannot poison the estimate.
      if (typeof block.arguments === 'string' && block.arguments.length > 0) {
        return Math.min(MAX_TOOL_BLOCK_TOKENS, estimateTokens(block.arguments))
      }
      return 32
    default:
      return typeof block.text === 'string' ? estimateTokens(block.text) : 32
  }
}

/**
 * Heuristic token estimate across a message content (string or block array).
 * Text blocks are metered normally, image blocks get a fixed cost, and every
 * other block type (reasoning / tool-call / tool-result) contributes either
 * its textual payload when it carries one or a small constant. Tool results
 * and tool calls are metered from their NESTED payload (content / arguments)
 * with a per-block cap — never the raw wire JSON's base64 image data.
 */
export function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) total += estimateBlockTokens(block)
  return total
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
