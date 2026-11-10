import { describe, expect, it } from 'vitest'
import {
  FOLD_AMPLITUDE_MAX,
  FOLD_AMPLITUDE_MIN,
  FOLD_CACHE_UTILITY_FLOOR,
  FOLD_SERVO_K_MAX,
  FOLD_SERVO_K_MIN,
  learnedAnchorRatio,
  learnedBandScale,
  learnedMinIntervalMs,
  parseFoldPrior,
  serializeFoldPrior,
  shrinkRunwayFactor,
  updateFoldLearning,
  type FoldCycleReport,
  type FoldLearningState,
} from '../src/core.ts'

const BUDGET = 100_000
const report = (overrides: Partial<FoldCycleReport> = {}): FoldCycleReport => ({
  runwayTokens: 40_000,
  cycleTimeMs: 20 * 60_000,
  cycleRequests: 30,
  cycleCacheHit: 0.9,
  recalled: false,
  hadFailure: false,
  ...overrides,
})

describe('updateFoldLearning', () => {
  it('adopts the first cycle raw, then EMAs (alpha 0.5)', () => {
    const s1 = updateFoldLearning({}, report(), BUDGET)
    expect(s1.runwayRatioEma).toBeCloseTo(0.4)
    const s2 = updateFoldLearning(s1, report({ runwayTokens: 20_000 }), BUDGET)
    expect(s2.runwayRatioEma).toBeCloseTo(0.3)
  })

  it('failure shrinks k; never below the floor', () => {
    const s1 = updateFoldLearning({}, report({ hadFailure: true }), BUDGET)
    expect(s1.runwayFactor).toBeCloseTo(0.7)
    let s = s1
    for (let i = 0; i < 10; i++) s = updateFoldLearning(s, report({ hadFailure: true }), BUDGET)
    expect(s.runwayFactor).toBeCloseTo(FOLD_SERVO_K_MIN)
  })

  it('low cache utility on a healthy cycle grows k; capped', () => {
    let s: FoldLearningState = updateFoldLearning({}, report({ cycleCacheHit: 0.2 }), BUDGET)
    expect(s.runwayFactor).toBeGreaterThan(1)
    for (let i = 0; i < 20; i++) s = updateFoldLearning(s, report({ cycleCacheHit: 0.2 }), BUDGET)
    expect(s.runwayFactor).toBeCloseTo(FOLD_SERVO_K_MAX)
  })

  it('healthy comfortable-cache cycles recover k gently toward neutral', () => {
    let s = updateFoldLearning({}, report({ hadFailure: true }), BUDGET)
    const shrunk = s.runwayFactor!
    s = updateFoldLearning(s, report(), BUDGET)
    expect(s.runwayFactor).toBeGreaterThan(shrunk)
    expect(s.runwayFactor).toBeLessThan(1)
  })

  it('recalled cycles shallowen the amplitude; zero-recall deepens it', () => {
    let s: FoldLearningState = {}
    for (let i = 0; i < 10; i++) s = updateFoldLearning(s, report({ recalled: true }), BUDGET)
    const recalledFactor = learnedBandScale(s)
    for (let i = 0; i < 10; i++) s = updateFoldLearning(s, report({ recalled: false }), BUDGET)
    const zeroRecallFactor = learnedBandScale(s)
    expect(recalledFactor).toBeGreaterThanOrEqual(FOLD_AMPLITUDE_MIN)
    expect(recalledFactor).toBeLessThanOrEqual(FOLD_AMPLITUDE_MAX)
    expect(zeroRecallFactor).toBeGreaterThanOrEqual(FOLD_AMPLITUDE_MIN)
    expect(zeroRecallFactor).toBeLessThanOrEqual(FOLD_AMPLITUDE_MAX)
    // High recall = the folded content was still needed = fold SHALLOWER.
    expect(recalledFactor).toBeLessThan(zeroRecallFactor)
  })
})

describe('learnedAnchorRatio', () => {
  it('sits one servo-scaled runway above the last landing', () => {
    const s = updateFoldLearning({}, report({ runwayTokens: 40_000 }), BUDGET)
    // Healthy comfortable-cache cycle: k recovers gently (1.0 × 1.05).
    expect(learnedAnchorRatio(0.5, s)).toBeCloseTo(0.5 + 1.05 * 0.4)
    const failed = shrinkRunwayFactor(s)
    expect(learnedAnchorRatio(0.5, failed)).toBeCloseTo(0.5 + 1.05 * 0.7 * 0.4)
  })

  it('is undefined before the first cycle closes (cold start = configured anchor)', () => {
    expect(learnedAnchorRatio(0.5, {})).toBeUndefined()
  })
})

describe('learnedMinIntervalMs', () => {
  it('is half the learned cycle time, clamped to the envelope', () => {
    const s = updateFoldLearning({}, report({ cycleTimeMs: 20 * 60_000 }), BUDGET)
    expect(learnedMinIntervalMs(s)).toBe(10 * 60_000)
    // EMA blend of 20min and 1min = 10.5min → half = 5.25min (above floor).
    const fast = updateFoldLearning(s, report({ cycleTimeMs: 60_000 }), BUDGET)
    expect(learnedMinIntervalMs(fast)).toBe(5.25 * 60_000)
    expect(learnedMinIntervalMs({})).toBeUndefined()
  })
})

describe('route prior serialization', () => {
  it('round-trips learned fields and degrades corrupt input to empty', () => {
    const s = updateFoldLearning({}, report(), BUDGET)
    const parsed = parseFoldPrior(serializeFoldPrior(s))
    expect(parsed.runwayRatioEma).toBeCloseTo(s.runwayRatioEma!)
    expect(parsed.runwayFactor).toBeCloseTo(s.runwayFactor!)
    expect(parseFoldPrior('not json')).toEqual({})
    expect(parseFoldPrior(undefined)).toEqual({})
    expect(parseFoldPrior(JSON.stringify({ runwayFactor: 'garbage' }))).toEqual({})
  })
})

describe('cache utility floor', () => {
  it('is the "folds too frequent" vote threshold', () => {
    expect(FOLD_CACHE_UTILITY_FLOOR).toBeGreaterThan(0)
    expect(FOLD_CACHE_UTILITY_FLOOR).toBeLessThan(1)
  })
})

import {
  cacheUtilityVote,
  FOLD_CACHE_DROP_MARGIN,
  FOLD_SPECULATION_LEAD,
  nextGrowthRate,
  speculationDue,
} from '../src/core.ts'

describe('predictive speculative launch (2026-11 intelligence audit)', () => {
  it('growth rate EMA converges to tokens/ms', () => {
    let rate = nextGrowthRate(undefined, 1000, 1000) // 1 tok/ms
    expect(rate).toBeCloseTo(1)
    rate = nextGrowthRate(rate, 1000, 3000) // 0.33 tok/ms
    expect(rate).toBeGreaterThan(0.5)
    expect(rate).toBeLessThan(1)
    expect(nextGrowthRate(undefined, 100, 0)).toBeUndefined() // no time delta
    expect(nextGrowthRate(undefined, -5, 1000)).toBeUndefined() // negative delta
  })

  it('launches by PREDICTED time-to-trigger, not by a fixed distance', () => {
    // 10k distance at 10 tok/ms = 1s to trigger; latency 2s -> launch now.
    expect(speculationDue({
      surfaceTokens: 90_000, triggerTokens: 100_000,
      growthRate: 10, latencyMs: 2000, aheadRatio: 0.8,
    })).toBe(true)
    // Same distance, fast model (200ms): predicted 1s >> latency -> wait.
    expect(speculationDue({
      surfaceTokens: 90_000, triggerTokens: 100_000,
      growthRate: 10, latencyMs: 200, aheadRatio: 0.8,
    })).toBe(false)
    // Idle session (rate 0): never predicts an arrival -> no launch, even
    // past the old 0.8 distance.
    expect(speculationDue({
      surfaceTokens: 95_000, triggerTokens: 100_000,
      growthRate: 0, latencyMs: 2000, aheadRatio: 0.8,
    })).toBe(false)
    // Cold start (no rate/latency): the distance prior still applies.
    expect(speculationDue({
      surfaceTokens: 90_000, triggerTokens: 100_000,
      aheadRatio: 0.8,
    })).toBe(true)
    expect(speculationDue({
      surfaceTokens: 50_000, triggerTokens: 100_000,
      aheadRatio: 0.8,
    })).toBe(false)
  })

  it('the lead margin is the latency multiplier', () => {
    expect(FOLD_SPECULATION_LEAD).toBeGreaterThan(1)
  })
})

describe('relative cache-utility vote (2026-11 intelligence audit)', () => {
  it('judges the hit ratio against the route baseline, not an absolute floor', () => {
    // A route living at 0.3: a 0.28 cycle is NORMAL (no vote) even though
    // the absolute 0.7 floor would call it "too frequent".
    expect(cacheUtilityVote(0.28, 0.3)).toBe(false)
    // A real drop below its own baseline IS the vote.
    expect(cacheUtilityVote(0.1, 0.3)).toBe(true)
    // Cold start: no baseline -> the absolute fallback floor.
    expect(cacheUtilityVote(0.5, undefined)).toBe(true)
    expect(cacheUtilityVote(0.9, undefined)).toBe(false)
  })

  it('the drop margin is the relational threshold', () => {
    expect(FOLD_CACHE_DROP_MARGIN).toBeGreaterThan(0)
    expect(FOLD_CACHE_DROP_MARGIN).toBeLessThan(1)
  })
})
