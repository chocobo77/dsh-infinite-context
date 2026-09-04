import { describe, expect, it } from 'vitest'
import { TokenBudget, estimateTokens } from '../src/core.ts'
import { estimateContentTokens, MAX_TOOL_BLOCK_TOKENS } from '../src/token-budget.ts'
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

describe('estimateContentTokens', () => {
  it('meters plain text and image blocks', () => {
    expect(estimateContentTokens('hello')).toBeGreaterThan(0)
    expect(estimateContentTokens([{ type: 'text', text: 'hello' }])).toBeGreaterThan(0)
    expect(estimateContentTokens([{ type: 'image' }])).toBe(1500)
    expect(estimateContentTokens([])).toBe(0)
    expect(estimateContentTokens(42)).toBe(0)
  })

  it('recurses into NESTED tool-result content (file reads / command output)', () => {
    // Regression: a tool-result's payload is nested under content; before the
    // fix a 200-char result was flat-metered as 32 tokens regardless of size.
    const payload = 'x'.repeat(200) // ~50 tokens
    const content = [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: payload }] }]
    const estimate = estimateContentTokens(content)
    expect(estimate).toBeGreaterThan(32)
    expect(estimate).toBe(estimateTokens(payload))
  })

  it('meters tool-call arguments, capped at MAX_TOOL_BLOCK_TOKENS', () => {
    const args = '{"path":"/a/b","opts":' + 'x'.repeat(200) + '}'
    const estimate = estimateContentTokens([{ type: 'tool-call', id: 'c1', name: 'read', arguments: args }])
    // The real argument payload is metered (not a flat 32), and a small call
    // with a short argument estimates BELOW the old flat constant.
    expect(estimate).toBe(estimateTokens(args))
    expect(estimate).toBeGreaterThan(32)
    // A base64-laden monster argument is capped so it cannot poison the meter.
    const huge = estimateContentTokens([{ type: 'tool-call', id: 'c2', name: 'x', arguments: 'y'.repeat(MAX_TOOL_BLOCK_TOKENS * 4 * 4) }])
    expect(huge).toBeLessThanOrEqual(MAX_TOOL_BLOCK_TOKENS)
  })

  it('caps a huge nested tool-result payload', () => {
    const content = [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'y'.repeat(MAX_TOOL_BLOCK_TOKENS * 4 * 4) }] }]
    expect(estimateContentTokens(content)).toBeLessThanOrEqual(MAX_TOOL_BLOCK_TOKENS)
  })

  it('meters reasoning text and unknown blocks with a small constant', () => {
    expect(estimateContentTokens([{ type: 'reasoning', text: '思考中' }])).toBeGreaterThan(0)
    expect(estimateContentTokens([{ type: 'unknown-thing' }])).toBe(32)
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
