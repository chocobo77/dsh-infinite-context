/**
 * The slow route baseline (cacheHitBaselineEma) must ROUND-TRIP through the
 * cycle close. updateFoldLearning produces it every cycle; the pre-0.9.7
 * applyFoldCycle computed it and threw it away — the baseline stayed at its
 * seed, so cacheUtilityVote permanently fell through to the absolute floor
 * and the relative-to-baseline judgment never engaged (found 2026-11-13 by
 * code exploration; production fold_cycle rows confirm baseline-grown k).
 */
import { describe, expect, it } from 'vitest'
import {
  cacheUtilityVote,
  updateFoldLearning,
  type FoldCycleReport,
} from '../src/fold-scheduler.ts'
import { HistoryCompressor } from '../src/memory-compaction.ts'

const report: FoldCycleReport = {
  runwayTokens: 20000,
  cycleTimeMs: 600_000,
  cycleRequests: 30,
  cycleCacheHit: 0.9,
  recalled: false,
  hadFailure: false,
}

function harness(entryOverrides: Record<string, unknown> = {}) {
  const kv = new Map<string, string>()
  const compressor = Object.create(HistoryCompressor.prototype) as unknown as {
    turnCounters: Map<string, Record<string, unknown>>
    kv: { get(k: string): string | undefined; set(k: string, v: string): void }
    applyFoldCycle: (sessionId: string, report: FoldCycleReport, budget: number, landed: number, teach?: boolean) => unknown
    seedCycleLearning: (sessionId: string, route: string) => void
  }
  compressor.kv = {
    get: (k: string) => kv.get(k),
    set: (k: string, v: string) => { kv.set(k, v) },
  }
  const entry: Record<string, unknown> = { turn: 1, lastActive: Date.now(), ...entryOverrides }
  compressor.turnCounters = new Map([['s1', entry]])
  return { compressor, entry, kv }
}

describe('fold cycle baseline round-trip', () => {
  it('updateFoldLearning produces the slow baseline EMA', () => {
    const first = updateFoldLearning({}, report, 180_000)
    expect(first.cacheHitBaselineEma).toBeCloseTo(0.9, 5)
    const second = updateFoldLearning(first, { ...report, cycleCacheHit: 0.5 }, 180_000)
    // alpha 0.05: 0.9*0.95 + 0.5*0.05
    expect(second.cacheHitBaselineEma).toBeCloseTo(0.9 * 0.95 + 0.5 * 0.05, 5)
  })

  it('applyFoldCycle writes the baseline back into the session entry', () => {
    const { compressor, entry } = harness({ cycleCacheHitEma: 0.95, cacheHitBaselineEma: 0.95 })
    compressor.applyFoldCycle('s1', { ...report, cycleCacheHit: 0.5 }, 180_000, 100_000)
    // The baseline must have MOVED toward the 0.5 sample, not stayed at 0.95.
    expect(entry.cacheHitBaselineEma).toBeDefined()
    expect(entry.cacheHitBaselineEma as number).toBeLessThan(0.95)
  })

  it('a frozen baseline never engages the relative vote — regression shape', () => {
    // With the bug, entry.cacheHitBaselineEma stayed undefined after cycles:
    // cacheUtilityVote then judged by the absolute floor (0.7) instead of the
    // route's own baseline. A route living at 0.95 that dips to 0.8 is the
    // discriminating case: the absolute floor misjudges it healthy, the
    // relative vote (floor of 0.95−0.1=0.85) catches the drop.
    const frozen = cacheUtilityVote(0.8, undefined)
    const engaged = cacheUtilityVote(0.8, 0.95)
    expect(frozen).toBe(false)
    expect(engaged).toBe(true)
  })

  it('seedCycleLearning seeds every prior key, not a partial set', () => {
    const { compressor, entry } = harness()
    compressor.kv.set(
      HistoryCompressor.foldCyclePriorKey('p/m'),
      JSON.stringify({
        runwayRatioEma: 0.1,
        cycleTimeEmaMs: 300_000,
        cycleRequestsEma: 25,
        cycleCacheHitEma: 0.97,
        cacheHitBaselineEma: 0.96,
        recallEma: 0,
        runwayFactor: 1.2,
      }),
    )
    compressor.seedCycleLearning('s1', 'p/m')
    expect(entry.cycleRunwayRatioEma).toBe(0.1)
    expect(entry.cycleTimeEmaMs).toBe(300_000)
    expect(entry.cycleRequestsEma).toBe(25)
    expect(entry.cycleCacheHitEma).toBe(0.97)
    expect(entry.cacheHitBaselineEma).toBe(0.96)
    expect(entry.recallEma).toBe(0)
    expect(entry.runwayFactor).toBe(1.2)
  })
})
