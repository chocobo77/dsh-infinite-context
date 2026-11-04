import { describe, expect, it } from 'vitest'
import {
  COMPRESS_FAILURE_COOLDOWN,
  HISTORY_MIN_BAND,
  HISTORY_TARGET_FLOOR,
  HISTORY_TRIGGER_CEILING,
  HISTORY_TRIGGER_FLOOR,
  SUMMARY_OUTPUT_SHARE,
  SURGE_RATIO,
  decidePressureCompaction,
  dynamicCompactionRatio,
  dynamicHistoryLevels,
  firstFoldableIndex,
  foldTokensForTarget,
  retainedTailStart,
  nextGrowthEma,
  orderFoldedMessages,
  shouldCompressHistory,
  shouldNudgeCompaction,
  type HistoryLevelInput,
  type NudgeInput,
} from '../src/core.ts'

describe('decidePressureCompaction', () => {
  it('delegates when no narrowed window is known', () => {
    expect(decidePressureCompaction({
      declaredWindow: 100_000,
      narrowedWindow: undefined,
      measuredTokens: 999_999,
      thresholdRatio: 0.8,
    })).toEqual({ mode: 'delegate' })
  })

  it('skips while below the narrowed-window threshold', () => {
    // Local model: catalog declares 100K, probe finds the server runs 32K.
    // Threshold = floor(32768 × 0.8) = 26214.
    const decision = decidePressureCompaction({
      declaredWindow: 100_000,
      narrowedWindow: 32_768,
      measuredTokens: 20_000,
      thresholdRatio: 0.8,
    })
    expect(decision.mode).toBe('skip')
    expect(decision.thresholdTokens).toBe(26_214)
  })

  it('forces the balanced reduction once the real ceiling is approached', () => {
    // 27k measured tokens: below the declared threshold (80k) the base policy
    // would wait, but the 32K model cannot hold this conversation.
    const decision = decidePressureCompaction({
      declaredWindow: 100_000,
      narrowedWindow: 32_768,
      measuredTokens: 27_000,
      thresholdRatio: 0.8,
    })
    expect(decision.mode).toBe('force')
    expect(decision.thresholdTokens).toBe(26_214)
  })

  it('forces even when DSH has no declared capacity for the target', () => {
    const decision = decidePressureCompaction({
      declaredWindow: undefined,
      narrowedWindow: 32_768,
      measuredTokens: 27_000,
      thresholdRatio: 0.8,
    })
    expect(decision.mode).toBe('force')
  })

  it('delegates when the narrowed window matches the declared one (base retains a tail)', () => {
    // GLM-style: override == declared (1M). The base pressure path compacts
    // with proper tail retention at the same threshold — prefer it.
    const decision = decidePressureCompaction({
      declaredWindow: 1_000_000,
      narrowedWindow: 1_000_000,
      measuredTokens: 900_000,
      thresholdRatio: 0.8,
    })
    expect(decision.mode).toBe('delegate')
  })

  it('skips when a higher override keeps the base from compacting too early', () => {
    // Override (400K) > declared (128K): between the two thresholds the
    // override is authoritative and no compaction should run.
    const decision = decidePressureCompaction({
      declaredWindow: 131_072,
      narrowedWindow: 400_000,
      measuredTokens: 200_000,
      thresholdRatio: 0.8,
    })
    expect(decision.mode).toBe('skip')
    expect(decision.thresholdTokens).toBe(320_000)
  })

  it('honors a per-target threshold ratio override', () => {
    const decision = decidePressureCompaction({
      declaredWindow: 100_000,
      narrowedWindow: 32_768,
      measuredTokens: 15_000,
      thresholdRatio: 0.5,
    })
    expect(decision.mode).toBe('skip')
    expect(decision.thresholdTokens).toBe(16_384)
  })
})

describe('dynamicCompactionRatio', () => {
  it('applies the base ratio unchanged at or below 50% fill', () => {
    expect(dynamicCompactionRatio(0.8, 0.6, 0.4)).toBeCloseTo(0.8)
    expect(dynamicCompactionRatio(0.8, 0.6, 0.5)).toBeCloseTo(0.8)
    expect(dynamicCompactionRatio(0.8, 0.6, 0)).toBeCloseTo(0.8)
  })

  it('slides linearly between base and floor as the window fills past 50%', () => {
    // t = (0.6-0.5)/0.4 = 0.25 → 0.8 - 0.2×0.25 = 0.75
    expect(dynamicCompactionRatio(0.8, 0.6, 0.6)).toBeCloseTo(0.75)
    // t = (0.7-0.5)/0.4 = 0.5 → 0.8 - 0.2×0.5 = 0.7
    expect(dynamicCompactionRatio(0.8, 0.6, 0.7)).toBeCloseTo(0.7)
  })

  it('bottoms out at the floor at 90% fill and stays there', () => {
    expect(dynamicCompactionRatio(0.8, 0.6, 0.9)).toBeCloseTo(0.6)
    expect(dynamicCompactionRatio(0.8, 0.6, 1)).toBeCloseTo(0.6)
  })

  it('honors a custom base/floor pair', () => {
    expect(dynamicCompactionRatio(0.7, 0.5, 0.9)).toBeCloseTo(0.5)
    expect(dynamicCompactionRatio(0.7, 0.5, 0.5)).toBeCloseTo(0.7)
  })

  it('never raises the trigger above the base when the floor is unusable', () => {
    // A misconfigured floor (0.9 > base 0.7) used to win the `Math.max` and
    // push the trigger ABOVE the configured threshold — its exact opposite.
    expect(dynamicCompactionRatio(0.7, 0.9, 1)).toBeCloseTo(0.7)
    expect(dynamicCompactionRatio(0.7, 0.9, 0.6)).toBeCloseTo(0.7)
    expect(dynamicCompactionRatio(0.7, 0.7, 1)).toBeCloseTo(0.7)
    // Non-finite or non-positive floors collapse the curve to "always
    // compress", so they are ignored and the base ratio applies.
    expect(dynamicCompactionRatio(0.8, Number.NaN, 1)).toBeCloseTo(0.8)
    expect(dynamicCompactionRatio(0.8, -1, 1)).toBeCloseTo(0.8)
    expect(dynamicCompactionRatio(0.8, 0, 1)).toBeCloseTo(0.8)
  })
})

describe('decidePressureCompaction with dynamicRatio', () => {
  it('still skips below the (dynamically lowered) threshold', () => {
    const decision = decidePressureCompaction({
      declaredWindow: 100_000,
      narrowedWindow: 32_768,
      measuredTokens: 18_000, // fill ≈ 0.55 → ratio ≈ 0.775 → threshold ≈ 25400
      thresholdRatio: 0.8,
      dynamicRatio: true,
      dynamicRatioFloor: 0.6,
    })
    expect(decision.mode).toBe('skip')
    expect(decision.thresholdTokens ?? 0).toBeLessThan(26_214) // lower than the static 0.8 threshold
  })

  it('forces EARLIER than the static ratio once the real window fills past ~50%', () => {
    // Static (0.8): threshold 26214 → 24000 measured would SKIP.
    // Dynamic: fill 24000/32768 ≈ 0.732 → ratio ≈ 0.684 → threshold ≈ 22411 → FORCE.
    expect(decidePressureCompaction({
      declaredWindow: 100_000,
      narrowedWindow: 32_768,
      measuredTokens: 24_000,
      thresholdRatio: 0.8,
    }).mode).toBe('skip')
    const decision = decidePressureCompaction({
      declaredWindow: 100_000,
      narrowedWindow: 32_768,
      measuredTokens: 24_000,
      thresholdRatio: 0.8,
      dynamicRatio: true,
      dynamicRatioFloor: 0.6,
    })
    expect(decision.mode).toBe('force')
    expect(decision.thresholdTokens ?? 0).toBeLessThan(26_214)
  })

  it('never forces a window equal to the declared one, even when nearly full (online model)', () => {
    // 1M online model: at 90% fill the dynamic ratio drops to 0.6, but since
    // narrowed == declared (1M), the base path must handle it (proper tail
    // retention) rather than the overflow-style forced reduction.
    const decision = decidePressureCompaction({
      declaredWindow: 1_000_000,
      narrowedWindow: 1_000_000,
      measuredTokens: 900_000,
      thresholdRatio: 0.8,
      dynamicRatio: true,
      dynamicRatioFloor: 0.6,
    })
    expect(decision.mode).toBe('delegate')
    expect(decision.thresholdTokens).toBe(600_000)
  })

  it('forces with no declared capacity when over the dynamic threshold', () => {
    const decision = decidePressureCompaction({
      declaredWindow: undefined,
      narrowedWindow: 32_768,
      measuredTokens: 24_000,
      thresholdRatio: 0.8,
      dynamicRatio: true,
      dynamicRatioFloor: 0.6,
    })
    expect(decision.mode).toBe('force')
  })

  it('honors a custom dynamic floor', () => {
    const decision = decidePressureCompaction({
      declaredWindow: 100_000,
      narrowedWindow: 32_768,
      measuredTokens: 31_000,
      thresholdRatio: 0.8,
      dynamicRatio: true,
      dynamicRatioFloor: 0.5, // very aggressive: fires at half the window
    })
    expect(decision.mode).toBe('force')
    expect(decision.thresholdTokens).toBe(16_384)
  })
})

describe('shouldCompressHistory', () => {
  const base = {
    force: false,
    turn: 10,
    lastCompressedTurn: undefined,
    lastTokens: undefined,
    tokens: 0,
    triggerTokens: 700,
    windowTokens: 8_000,
    compressInterval: 7,
    failureCooldown: 0,
  }

  it('always compresses when forced', () => {
    expect(shouldCompressHistory({ ...base, force: true, tokens: 1 }))
      .toEqual({ compress: true, reason: 'forced' })
  })

  it('waits while below the trigger water level', () => {
    expect(shouldCompressHistory({ ...base, tokens: 700 }))
      .toEqual({ compress: false, reason: 'below-trigger' })
  })

  it('compresses on pressure once the interval has elapsed', () => {
    expect(shouldCompressHistory({
      ...base, tokens: 800, lastTokens: 750, turn: 10, lastCompressedTurn: 3,
    })).toEqual({ compress: true, reason: 'pressure' })
  })

  it('rate-limits pressure compression inside the interval', () => {
    expect(shouldCompressHistory({
      ...base, tokens: 800, lastTokens: 750, turn: 5, lastCompressedTurn: 3,
    })).toEqual({ compress: false, reason: 'rate-limited' })
  })

  it('bypasses the interval on a single-round token surge (long thinking turn)', () => {
    // 2_000-token growth ≥ SURGE_RATIO × 8_000 window: compress immediately
    // even though only 1 round passed since the last compression.
    expect(shouldCompressHistory({
      ...base, tokens: 2_800, lastTokens: 800, turn: 4, lastCompressedTurn: 3,
    })).toEqual({ compress: true, reason: 'surge' })
    expect(Math.floor(8_000 * SURGE_RATIO)).toBe(1_600)
  })

  it('does not treat slow growth as a surge', () => {
    expect(shouldCompressHistory({
      ...base, tokens: 1_200, lastTokens: 800, turn: 4, lastCompressedTurn: 3,
    })).toEqual({ compress: false, reason: 'rate-limited' })
  })

  it('waits out the failure cooldown, then compresses again', () => {
    const cooldown = shouldCompressHistory({
      ...base, tokens: 800, turn: 20, lastCompressedTurn: 3, failureCooldown: COMPRESS_FAILURE_COOLDOWN,
    })
    expect(cooldown).toEqual({ compress: false, reason: 'cooldown' })
    const recovered = shouldCompressHistory({
      ...base, tokens: 800, lastTokens: 750, turn: 20, lastCompressedTurn: 3, failureCooldown: 0,
    })
    expect(recovered).toEqual({ compress: true, reason: 'pressure' })
  })

  it('reports the FIRST observation as pressure, not surge, when over the trigger', () => {
    // A restored/imported session with a big history is not a single-round
    // surge — it is plain pressure. Compresses immediately (fresh session),
    // but with the honest reason.
    const first = shouldCompressHistory({
      ...base, tokens: 800, lastTokens: undefined, lastCompressedTurn: undefined,
    })
    expect(first).toEqual({ compress: true, reason: 'pressure' })
  })
})

describe('nextGrowthEma', () => {
  it('seeds on the first delta, then halves the weight of each new one', () => {
    expect(nextGrowthEma(undefined, 1_000)).toBe(1_000)
    expect(nextGrowthEma(1_000, 2_000)).toBe(1_500)
    expect(nextGrowthEma(1_500, 0)).toBe(750)
  })

  it('never goes negative and ignores a non-finite delta', () => {
    expect(nextGrowthEma(1_000, -500)).toBe(250)
    expect(nextGrowthEma(100, -1_000)).toBe(0)
    expect(nextGrowthEma(1_000, Number.NaN)).toBe(1_000)
    expect(nextGrowthEma(undefined, Number.NaN)).toBe(0)
  })
})

describe('shouldNudgeCompaction', () => {
  const base: NudgeInput = {
    enabled: true,
    tokens: 700,
    growthTokens: 200,
    triggerTokens: 800,
    turn: 10,
    compressInterval: 7,
    failureCooldown: 0,
  }

  it('fires when the next step would cross the trigger anyway', () => {
    expect(shouldNudgeCompaction(base)).toBe(true)
    // Exactly reaching the trigger counts; the regular check stays authoritative.
    expect(shouldNudgeCompaction({ ...base, tokens: 600, growthTokens: 200 })).toBe(true)
  })

  it('stays quiet when growth cannot reach the trigger', () => {
    expect(shouldNudgeCompaction({ ...base, tokens: 100, growthTokens: 100 })).toBe(false)
  })

  it('defers to the regular trigger once over it', () => {
    expect(shouldNudgeCompaction({ ...base, tokens: 800 })).toBe(false)
    expect(shouldNudgeCompaction({ ...base, tokens: 900, growthTokens: 50 })).toBe(false)
  })

  it('is off when disabled, when growth is unknown, or during a cooldown', () => {
    expect(shouldNudgeCompaction({ ...base, enabled: false })).toBe(false)
    expect(shouldNudgeCompaction({ ...base, growthTokens: 0 })).toBe(false)
    expect(shouldNudgeCompaction({ ...base, growthTokens: Number.NaN })).toBe(false)
    expect(shouldNudgeCompaction({ ...base, failureCooldown: COMPRESS_FAILURE_COOLDOWN })).toBe(false)
  })

  it('never asks twice in the same turn', () => {
    expect(shouldNudgeCompaction({ ...base, lastCompressedTurn: 10 })).toBe(false)
  })

  it('honours the compression interval so it cannot nudge every round', () => {
    // Fired last round: still inside the 7-round cadence, so stand down even
    // though the predicted growth crosses the trigger again. Without this the
    // surface would nudge every turn just below the line.
    expect(shouldNudgeCompaction({ ...base, lastCompressedTurn: 9 })).toBe(false)
    expect(shouldNudgeCompaction({ ...base, lastCompressedTurn: 4 })).toBe(false)
    // Interval elapsed (10 - 3 >= 7): the early pre-emption is allowed again.
    expect(shouldNudgeCompaction({ ...base, lastCompressedTurn: 3 })).toBe(true)
  })
})

describe('foldTokensForTarget', () => {
  it('folds enough that the net saving reaches the target after the summary', () => {
    // 10_000 -> target 6_000: a naive fold of 4_000 would leave ~4_000 + a
    // 1_200-token summary at 7_200; inverting the 30% output share asks for
    // ~5_715 folded tokens so the net saving is the full 4_000.
    const folded = foldTokensForTarget(10_000, 6_000)
    expect(folded).toBeGreaterThan(4_000)
    expect(folded - folded * SUMMARY_OUTPUT_SHARE).toBeGreaterThanOrEqual(4_000)
  })

  it('is a no-op when the surface is already at or under the target', () => {
    expect(foldTokensForTarget(5_000, 6_000)).toBe(0)
    expect(foldTokensForTarget(6_000, 6_000)).toBe(0)
  })

  it('clamps a nonsense share instead of exploding the fold', () => {
    // share >= 1 cannot invert; clamp to 0.9 so the fold stays finite and at
    // least the naive gap (allow the clamp's float rounding to add one token).
    const clamped = foldTokensForTarget(10_000, 6_000, 5)
    expect(Number.isFinite(clamped)).toBe(true)
    expect(clamped).toBeGreaterThanOrEqual(40_000)
    expect(clamped).toBeLessThan(40_002)
    expect(Number.isFinite(foldTokensForTarget(10_000, 6_000, Number.NaN))).toBe(true)
  })
})

describe('dynamicHistoryLevels', () => {
  const budget = 100_000
  const base: HistoryLevelInput = {
    baseTriggerRatio: 0.85,
    baseTargetRatio: 0.6,
    budgetTokens: budget,
    growthTokens: 0,
    compressInterval: 7,
    compressions: 0,
    injectionBudget: 0,
  }

  it('keeps the configured anchor for a quiet, fresh session', () => {
    const levels = dynamicHistoryLevels(base)
    expect(levels.triggerRatio).toBeCloseTo(0.85, 6)
    expect(levels.targetRatio).toBeCloseTo(0.6, 6)
    expect(levels.triggerTokens).toBe(85_000)
    expect(levels.targetTokens).toBe(60_000)
  })

  it('never lets the trigger cross the hard ceiling', () => {
    const levels = dynamicHistoryLevels({
      ...base,
      baseTriggerRatio: 0.99,
      growthTokens: 20_000,
      compressions: 99,
    })
    expect(levels.triggerRatio).toBeLessThanOrEqual(HISTORY_TRIGGER_CEILING)
    expect(levels.triggerTokens).toBeLessThanOrEqual(Math.floor(budget * HISTORY_TRIGGER_CEILING))
  })

  it('still clamps a hand-written static trigger to the ceiling with steering off', () => {
    // Feature-off semantics: zero growth + zero maturity. The hard ceiling must
    // still hold so a config like 0.99 cannot overflow the window.
    const levels = dynamicHistoryLevels({
      ...base,
      baseTriggerRatio: 0.99,
      growthTokens: 0,
      compressions: 0,
    })
    expect(levels.triggerRatio).toBeCloseTo(HISTORY_TRIGGER_CEILING, 6)
    expect(levels.targetRatio).toBeCloseTo(0.6, 6)
    expect(levels.triggerRatio - levels.targetRatio).toBeGreaterThanOrEqual(HISTORY_MIN_BAND)
  })

  it('never compresses below the hard trigger/target floors or the min band', () => {
    const levels = dynamicHistoryLevels({
      ...base,
      growthTokens: 50_000,
      compressions: 100,
    })
    expect(levels.triggerRatio).toBeGreaterThanOrEqual(HISTORY_TRIGGER_FLOOR)
    expect(levels.targetRatio).toBeGreaterThanOrEqual(HISTORY_TARGET_FLOOR)
    expect(levels.triggerRatio - levels.targetRatio).toBeGreaterThanOrEqual(HISTORY_MIN_BAND - 1e-9)
    expect(levels.targetRatio).toBeLessThan(levels.triggerRatio)
  })

  it('compresses earlier and deeper as growth rises', () => {
    const calm = dynamicHistoryLevels({ ...base, growthTokens: 0 })
    const hot = dynamicHistoryLevels({ ...base, growthTokens: 5_000 })
    expect(hot.triggerRatio).toBeLessThan(calm.triggerRatio)
    expect(hot.targetRatio).toBeLessThan(calm.targetRatio)
  })

  it('compresses earlier and deeper as the session matures', () => {
    const fresh = dynamicHistoryLevels({ ...base, compressions: 0 })
    const mature = dynamicHistoryLevels({ ...base, compressions: 100 })
    expect(mature.triggerRatio).toBeLessThan(fresh.triggerRatio)
    expect(mature.targetRatio).toBeLessThan(fresh.targetRatio)
  })

  it('keeps a minimum band when the configured target is at the trigger', () => {
    const levels = dynamicHistoryLevels({ ...base, baseTargetRatio: 0.85 })
    expect(levels.triggerRatio - levels.targetRatio).toBeGreaterThanOrEqual(HISTORY_MIN_BAND - 1e-9)
  })

  it('reserves the injection budget from both water levels', () => {
    const levels = dynamicHistoryLevels({ ...base, injectionBudget: 5_000 })
    expect(levels.triggerTokens).toBe(85_000 - 5_000)
    expect(levels.targetTokens).toBe(60_000 - 5_000)
  })

  it('degrades non-finite input to a finite, bounded level', () => {
    const levels = dynamicHistoryLevels({
      ...base,
      growthTokens: Number.NaN,
      compressInterval: Number.NaN,
      compressions: Number.NaN,
    })
    expect(Number.isFinite(levels.triggerRatio)).toBe(true)
    expect(Number.isFinite(levels.targetRatio)).toBe(true)
    expect(Number.isFinite(levels.triggerTokens)).toBe(true)
    expect(Number.isFinite(levels.targetTokens)).toBe(true)
  })
})

describe('orderFoldedMessages (billion-context #2733 aligned fold layout)', () => {
  const messages = ['m0', 'm1', 'm2', 'm3', 'm4']

  it('keeps the pinned prefix first and inserts the summary at the fold cut', () => {
    expect(orderFoldedMessages({ messages, summary: 'S', cutIndex: 3, retainRecent: 1, pinCount: 1 }))
      .toEqual(['m0', 'S', 'm3', 'm4'])
  })

  it('preserves the very first message byte-for-byte (the prefix-cache anchor)', () => {
    const out = orderFoldedMessages({ messages, summary: 'S', cutIndex: 4, retainRecent: 1, pinCount: 1 })
    expect(out[0]).toBe('m0')
  })

  it('reproduces the legacy prepend when nothing is pinned', () => {
    expect(orderFoldedMessages({ messages, summary: 'S', cutIndex: 3, retainRecent: 1, pinCount: 0 }))
      .toEqual(['S', 'm3', 'm4'])
  })

  it('handles retainRecent=0 instead of collapsing through the -0 footgun', () => {
    expect(orderFoldedMessages({ messages, summary: 'S', cutIndex: 3, retainRecent: 0, pinCount: 1 }))
      .toEqual(['m0', 'S', 'm3', 'm4'])
  })

  it('clamps a cut beyond the recent tail so the summary lands at the boundary', () => {
    expect(orderFoldedMessages({ messages: ['a', 'b', 'c'], summary: 'S', cutIndex: 99, retainRecent: 1, pinCount: 1 }))
      .toEqual(['a', 'S', 'c'])
  })

  it('never drops the pinned prefix when the cut is behind it', () => {
    expect(orderFoldedMessages({ messages, summary: 'S', cutIndex: 0, retainRecent: 1, pinCount: 1 })[0]).toBe('m0')
  })
})

describe('fold-range helpers (surface rewrite)', () => {
  it('pins a system head AND the first user message (#2733)', () => {
    expect(firstFoldableIndex(['system/message', 'user/message', 'assistant/message'])).toBe(2)
  })

  it('pins the first user message when there is no system head', () => {
    expect(firstFoldableIndex(['user/message', 'assistant/message'])).toBe(1)
  })

  it('starts at 0 when the surface has no system head or user message', () => {
    expect(firstFoldableIndex(['assistant/message'])).toBe(0)
    expect(firstFoldableIndex([])).toBe(0)
  })

  it('keeps the priced tail that covers the retain budget', () => {
    expect(retainedTailStart([100, 100, 100, 100], 150)).toBe(2)
    expect(retainedTailStart([100, 100, 100, 100], 1000)).toBe(0)
    expect(retainedTailStart([], 100)).toBe(0)
  })
})
