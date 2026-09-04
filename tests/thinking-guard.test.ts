import { describe, expect, it, vi } from 'vitest'
import {
  GUARD_MARGIN,
  clampGuardRatio,
  computeGuardLine,
  decideGuardTrigger,
  estimateOutputDelta,
  estimateRequestTokens,
  estimateSummaryOutputTokens,
  estimateSystemToolsTokens,
  guardedStream,
  overflowFinishChunk,
} from '../src/thinking-guard.ts'

function chunks(...items: unknown[]): AsyncIterable<unknown> {
  return (async function* () { for (const item of items) yield item })() as AsyncIterable<unknown>
}

function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => { const out: unknown[] = []; for await (const c of stream) out.push(c); return out })()
}

describe('estimateOutputDelta', () => {
  it('meters text, reasoning, and tool-call deltas', () => {
    expect(estimateOutputDelta({ type: 'text-delta', index: 0, text: 'hello' })).toBeGreaterThan(0)
    expect(estimateOutputDelta({ type: 'reasoning-delta', index: 0, text: '思考' })).toBeGreaterThan(0)
    expect(estimateOutputDelta({ type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{"x":1}' })).toBeGreaterThan(0)
  })

  it('adds nothing for structural chunks', () => {
    expect(estimateOutputDelta({ type: 'block-start', index: 0, blockType: 'text' })).toBe(0)
    expect(estimateOutputDelta({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } })).toBe(0)
    expect(estimateOutputDelta({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } })).toBe(0)
    expect(estimateOutputDelta({ type: 'finish', reason: { kind: 'completed' } })).toBe(0)
  })
})

describe('estimateRequestTokens / estimateSystemToolsTokens', () => {
  it('estimates system + tools + messages', () => {
    const request = {
      system: 'system prompt here',
      tools: [{ name: 'bash', description: 'run' }],
      messages: [{ content: 'hello' }, { content: [{ type: 'text', text: 'world' }] }],
    }
    expect(estimateRequestTokens(request)).toBeGreaterThan(0)
    // system+tools alone is smaller than the full envelope
    expect(estimateSystemToolsTokens(request)).toBeGreaterThan(0)
    expect(estimateSystemToolsTokens(request)).toBeLessThan(estimateRequestTokens(request))
  })

  it('handles empty envelopes', () => {
    expect(estimateRequestTokens({ messages: [] })).toBe(0)
    expect(estimateRequestTokens({ messages: [{ content: '' }] })).toBe(0)
    expect(estimateSystemToolsTokens({})).toBe(0)
  })

  it('counts tool results in the input estimate (file reads the guard must see)', () => {
    // A big file read arrives as a nested tool-result; the guard's input
    // estimate must reflect it so the takeover branch fires on over-budget
    // inputs instead of waiting for the API to error.
    const request = {
      messages: [{ content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'y'.repeat(4000) }] }] }],
    }
    const estimate = estimateRequestTokens(request)
    expect(estimate).toBeGreaterThan(500) // ~1000 tokens, not a flat 32
  })
})

describe('estimateSummaryOutputTokens', () => {
  it('targets ~30% of input, clamped below maxTokens', () => {
    expect(estimateSummaryOutputTokens(1_000)).toBe(300) // floor(1000*0.3)=300, min 300
    expect(estimateSummaryOutputTokens(10_000)).toBe(3_000)
    expect(estimateSummaryOutputTokens(10_000, 4_096)).toBe(2_867) // cap = floor(4096*0.7)
    expect(estimateSummaryOutputTokens(1_000_000, 8_192)).toBe(5_734) // cap = floor(8192*0.7)
  })
})

describe('computeGuardLine (dynamic reserve)', () => {
  it('fires at window − reserve when the reserve dominates', () => {
    // window 100k, systemTools 10k, input 60k → reserve = 10k + max(300,18k→5.7k capped?) 
    // summary(60000) = min(5734, max(300, 18000)) = 5734; reserve = 10000 + 5734 + 2048 = 17782
    const line = computeGuardLine(100_000, 60_000, 10_000, 8_192, 0.9)!
    expect(line).toBe(100_000 - (10_000 + estimateSummaryOutputTokens(60_000) + GUARD_MARGIN))
    expect(line).toBeLessThan(90_000) // the reserve line (82k) beats the 0.9 ceiling
  })

  it('caps at the ratio ceiling when the reserve is tiny (large window)', () => {
    // window 1M, tiny system/tools: reserve is small → ceiling 0.9M wins
    const line = computeGuardLine(1_000_000, 800_000, 2_000, 8_192, 0.9)!
    expect(line).toBe(900_000)
  })

  it('returns undefined for an unknown or non-positive window', () => {
    expect(computeGuardLine(0, 60_000, 10_000, 8_192, 0.9)).toBeUndefined()
    expect(computeGuardLine(-1, 60_000, 10_000, 8_192, 0.9)).toBeUndefined()
    expect(computeGuardLine(Number.NaN, 60_000, 10_000, 8_192, 0.9)).toBeUndefined()
  })
})

describe('decideGuardTrigger', () => {
  it('fires at or above the line, stays silent below it', () => {
    expect(decideGuardTrigger(80_000, 9_999, 90_000)).toBe(false)
    expect(decideGuardTrigger(80_000, 10_000, 90_000)).toBe(true)
    expect(decideGuardTrigger(95_000, 0, 90_000)).toBe(true) // input alone over
  })

  it('never fires on an undefined or non-positive line', () => {
    expect(decideGuardTrigger(80_000, 20_000, undefined)).toBe(false)
    expect(decideGuardTrigger(80_000, 20_000, 0)).toBe(false)
  })
})

describe('clampGuardRatio', () => {
  it('clamps out-of-range and non-finite ratios to defaults', () => {
    expect(clampGuardRatio(0.9)).toBe(0.9)
    expect(clampGuardRatio(2)).toBe(0.99)
    expect(clampGuardRatio(0.1)).toBe(0.5)
    expect(clampGuardRatio(Number.NaN)).toBe(0.9)
  })
})

describe('overflowFinishChunk', () => {
  it('carries the CONTEXT_WINDOW_EXCEEDED code DSH recovers from', () => {
    const chunk = overflowFinishChunk('boom')
    expect(chunk.type).toBe('finish')
    if (chunk.type === 'finish') {
      expect(chunk.reason.kind).toBe('error')
      if (chunk.reason.kind === 'error') {
        expect(chunk.reason.failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
        expect(chunk.reason.failure.message).toContain('boom')
      }
    }
  })
})

describe('guardedStream', () => {
  it('passes every chunk through while input + output is below the line', async () => {
    const inner = chunks(
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'text-delta', index: 0, text: 'b' },
      { type: 'finish', reason: { kind: 'completed' } },
    )
    const onTrigger = vi.fn()
    const out = await collect(guardedStream(inner, {
      inputTokens: 10,
      guardLine: 1_000, // far above: no trigger
      onTrigger,
    }))
    expect(out).toHaveLength(3)
    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('injects a CONTEXT_WINDOW_EXCEEDED finish and stops at the line', async () => {
    const inner = chunks(
      { type: 'reasoning-delta', index: 0, text: 'long thinking that crosses the line' },
      { type: 'text-delta', index: 1, text: 'never reached' },
      { type: 'finish', reason: { kind: 'completed' } },
    )
    const onTrigger = vi.fn()
    const out = await collect(guardedStream(inner, {
      inputTokens: 0,
      guardLine: 1, // the first delta already crosses
      onTrigger,
    }))
    expect(out).toHaveLength(1)
    const chunk = out[0] as { type: string; reason?: { kind?: string; failure?: { code?: string } } }
    expect(chunk.type).toBe('finish')
    expect(chunk.reason?.kind).toBe('error')
    expect(chunk.reason?.failure?.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  it('yields chunks before the crossing delta, then the finish, then stops', async () => {
    // 'ok' ≈ 1 token (input 0 + 1 < 2), 'big' ≈ 1 token → 2 ≥ guardLine 2 → fires
    const inner = chunks(
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'text-delta', index: 0, text: 'big' },
      { type: 'finish', reason: { kind: 'completed' } },
    )
    const out = await collect(guardedStream(inner, {
      inputTokens: 0,
      guardLine: 2,
    }))
    expect(out).toHaveLength(2)
    expect((out[0] as { type: string }).type).toBe('text-delta')
    expect((out[1] as { type: string }).type).toBe('finish')
  })
})
