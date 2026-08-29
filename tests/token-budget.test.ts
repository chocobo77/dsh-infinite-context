import { describe, expect, it } from 'vitest'
import { TokenBudget, estimateTokens } from '../src/core.ts'
import type { BudgetConfig } from '../src/core.ts'

const BUDGET: BudgetConfig = { short: 10_000, mid: 20_000, long: 5_000, retrieved: 15_000 }

describe('estimateTokens', () => {
  it('counts CJK characters ~1:1 and other characters ~1/4', () => {
    const ascii = estimateTokens('hello world this is a test')
    const cjk = estimateTokens('配置记忆管理')
    expect(ascii).toBe(Math.ceil(28 / 4))
    expect(cjk).toBe(6) // 6 Han characters, ~1 token each
    expect(estimateTokens('')).toBe(0)
  })
})

describe('TokenBudget', () => {
  it('exposes per-tier budgets and total', () => {
    const b = new TokenBudget(BUDGET, 94_000)
    expect(b.total).toBe(50_000)
    expect(b.for('short')).toBe(10_000)
    expect(b.for('retrieved')).toBe(15_000)
    expect(b.maxTotal).toBe(94_000 - Math.floor(94_000 * 0.25))
  })

  it('validates an infeasible budget', () => {
    const big: BudgetConfig = { short: 40_000, mid: 40_000, long: 40_000, retrieved: 40_000 }
    const b = new TokenBudget(big, 94_000)
    expect(() => b.validate()).toThrow(/infeasible/)
  })

  it('accepts a feasible budget', () => {
    const b = new TokenBudget(BUDGET, 94_000)
    expect(() => b.validate()).not.toThrow()
  })

  it('checks whether a text fits a tier budget', () => {
    const b = new TokenBudget(BUDGET, 94_000)
    // 100,000 non-CJK chars ≈ 25,000 tokens > 20,000 mid budget.
    expect(b.fits('mid', 'x'.repeat(100_000))).toBe(false)
    expect(b.fits('mid', 'short text')).toBe(true)
  })

  it('truncates long text to a tier budget, preserving whole lines', () => {
    const tiny: BudgetConfig = { short: 10, mid: 20, long: 5, retrieved: 15 }
    const b = new TokenBudget(tiny, 94_000, 0)
    const text = 'line one\nline two\nline three\nline four'
    const truncated = b.truncateToBudget('mid', text)
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(20)
    expect(truncated.split('\n').every(line => text.includes(line))).toBe(true)
  })
})
