/**
 * The cache-dip metric: the FIRST request after a fold pays for the prefix
 * invalidation; noteCycleUsage captures that one request's dip, the cycle
 * report carries it, and the cycle close resets it. It is ledger telemetry
 * (fold_cycle dip=) — never a learned point.
 */
import { describe, expect, it } from 'vitest'
import { HistoryCompressor } from '../src/memory-compaction.ts'

function harness(entryOverrides: Record<string, unknown> = {}) {
  const compressor = Object.create(HistoryCompressor.prototype) as unknown as {
    turnCounters: Map<string, Record<string, unknown>>
    noteCycleUsage: (sessionId: string, input: number, cacheRead: number, cacheWrite: number) => void
    cycleReportInputsOf: (sessionId: string) => Record<string, unknown>
    applyFoldCycle: (sessionId: string, report: unknown, budget: number, landed: number, teach?: boolean) => unknown
  }
  const entry: Record<string, unknown> = { turn: 1, lastActive: Date.now(), ...entryOverrides }
  compressor.turnCounters = new Map([['s1', entry]])
  compressor.kv = { get: () => undefined, set: () => {}, delete: () => {} }
  return { compressor, entry }
}

describe('cache dip measurement', () => {
  it('does not measure a dip on a session that never folded', () => {
    const { compressor, entry } = harness()
    compressor.noteCycleUsage('s1', 100_000, 5_000, 3_000)
    expect(entry.cycleCacheDip).toBeUndefined()
  })

  it('captures the dip on the first request after a fold, once', () => {
    const { compressor, entry } = harness({ lastCompressedAt: Date.now() - 1_000 })
    // First post-fold request: cache nearly gone → deep dip.
    compressor.noteCycleUsage('s1', 140_000, 16_000, 3_000)
    const expected = 1 - 16_000 / (16_000 + 140_000 + 3_000)
    expect(entry.cycleCacheDip).toBeCloseTo(expected, 6)
    // Later requests of the same cycle must not overwrite the opening dip.
    compressor.noteCycleUsage('s1', 49, 161_000, 0)
    expect(entry.cycleCacheDip).toBeCloseTo(expected, 6)
    // The cycle report carries it for the fold_cycle row.
    expect(compressor.cycleReportInputsOf('s1').cacheDip).toBeCloseTo(expected, 6)
  })

  it('skips a degenerate zero-total request and resets at cycle close', () => {
    const { compressor, entry } = harness({ lastCompressedAt: Date.now() - 1_000 })
    compressor.noteCycleUsage('s1', 0, 0, 0)
    expect(entry.cycleCacheDip).toBeUndefined()
    entry.cycleCacheDip = 0.9
    compressor.applyFoldCycle(
      's1',
      { runwayTokens: 10_000, cycleTimeMs: 60_000, cycleRequests: 2, recalled: false, hadFailure: false },
      180_000,
      100_000,
    )
    expect(entry.cycleCacheDip).toBeUndefined()
  })
})
