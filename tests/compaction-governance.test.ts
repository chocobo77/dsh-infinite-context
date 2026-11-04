import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WATER_LEVEL_BOUNDS,
  GOV_TRIGGER_CEILING,
  GOV_TRIGGER_FLOOR,
  GOV_TARGET_FLOOR,
  GOV_TARGET_MEMORY_FLOOR,
  GOV_MIN_BAND,
  GOV_MAX_BAND,
  compactionTriggerRatio,
  compactionWaterLevels,
  dynamicCompactionRatio,
  dynamicHistoryLevels,
  fillPressureOf,
  failureCooldownFor,
  foldPressureBudget,
  completionReserveOf,
  GOV_PLACEHOLDER_COMPLETION_RESERVE,
  GOV_CONFIG_ERROR_COOLDOWN,
  ledgerView,
  minimumFoldTokens,
  isThinFold,
  GOV_MIN_NET_SAVING_RATIO,
  foldIntervalFor,
  thinFoldRatioFor,
  summaryCharBudget,
  planCompaction,
  planFoldCompaction,
  toSurfaceSnapshot,
  nextTargetDeviationEma,
  targetDeviationCorrection,
  GOV_TARGET_DEVIATION_MAX,
  GOV_DEEP_PROBE_MEMORY_FLOOR,
  type FoldPlanInput,
  type GovernanceInput,
  type SessionLedgerEntry,
  type WaterLevelInput,
} from '../src/core.ts'

/** The pre-governance durable curve, kept here as a golden reference. */
function legacyDynamicCompactionRatio(base: number, floor: number, fill: number): number {
  const t = Math.max(0, Math.min(1, (fill - 0.5) / 0.4))
  const boundedFloor = Number.isFinite(floor) && floor > 0 ? Math.min(floor, base) : base
  const effective = base - (base - boundedFloor) * t
  return Math.max(boundedFloor, Math.min(base, effective))
}

/** The pre-governance fold curve, kept here as a golden reference. */
function legacyDynamicHistoryLevels(input: WaterLevelInput) {
  const budget = Number.isFinite(input.budgetTokens) && input.budgetTokens > 0 ? input.budgetTokens : 1
  const minAnchor = 0.25 + 0.08
  const anchor = Math.min(0.92, Math.max(minAnchor, Number.isFinite(input.baseTriggerRatio) ? input.baseTriggerRatio : 0.65))
  const triggerFloor = Math.min(anchor, 0.65)
  const growthRatio = Math.min(0.5, Math.max(0, Number.isFinite(input.growthTokens) ? input.growthTokens / budget : 0))
  const heat = Math.min(1, Math.max(0, growthRatio / 0.05))
  const stage = Math.min(1, Math.max(0, input.compressions / 8))
  const risk = Math.max(heat, stage)
  const triggerRatio = Math.max(triggerFloor, anchor - (anchor - triggerFloor) * risk)
  const baseTarget = Math.min(
    Math.max(0.25, Number.isFinite(input.baseTargetRatio) ? input.baseTargetRatio : 0.25),
    anchor - 0.08,
  )
  const configuredBand = Math.max(0.08, anchor - baseTarget)
  const interval = Number.isFinite(input.compressInterval) ? Math.max(1, input.compressInterval) : 1
  const reserve = growthRatio * interval + 0.03 + 0.08 * stage
  const band = Math.min(0.45, Math.max(0.08, Math.max(configuredBand, reserve)))
  const maxTarget = Math.max(0.25, triggerRatio - 0.08)
  const targetRatio = Math.min(maxTarget, Math.max(0.25, triggerRatio - band))
  const injection = Number.isFinite(input.injectionBudget) ? Math.max(0, input.injectionBudget) : 0
  return {
    triggerRatio,
    targetRatio,
    triggerTokens: Math.max(0, Math.floor(budget * triggerRatio) - injection),
    targetTokens: Math.max(0, Math.floor(budget * targetRatio) - injection),
  }
}

describe('compaction-governance equivalence (behaviour preserved)', () => {
  it('dynamicCompactionRatio equals the pre-governance durable curve', () => {
    for (const base of [0.6, 0.7, 0.8, 0.9]) {
      for (const floor of [0, 0.5, 0.6, base]) {
        for (const fill of [0, 0.2, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.4]) {
          expect(dynamicCompactionRatio(base, floor, fill))
            .toBeCloseTo(legacyDynamicCompactionRatio(base, floor, fill), 9)
        }
      }
    }
  })

  it('the durable view (fill only) matches the shared trigger curve', () => {
    for (const fill of [0.4, 0.5, 0.62, 0.75, 0.9, 1.2]) {
      const viaGovernance = compactionTriggerRatio({
        anchor: 0.8,
        floor: 0.6,
        ceiling: 1,
        fillPressure: fillPressureOf(fill),
        growthPressure: 0,
        stagePressure: 0,
      })
      expect(viaGovernance).toBeCloseTo(dynamicCompactionRatio(0.8, 0.6, fill), 9)
    }
  })

  it('dynamicHistoryLevels equals the pre-governance fold curve', () => {
    const bases = [-1, 0, 0.3, 0.6, 0.75, 0.85, 0.99, Number.NaN]
    const growths = [0, 500, 2_000, 5_000, 20_000, 200_000]
    const stages = [0, 1, 3, 8, 50]
    for (const baseTriggerRatio of bases) {
      for (const baseTargetRatio of [0.3, 0.6, 0.9]) {
        for (const growthTokens of growths) {
          for (const compressions of stages) {
            const input: WaterLevelInput = {
              baseTriggerRatio,
              baseTargetRatio,
              budgetTokens: 100_000,
              growthTokens,
              compressInterval: 7,
              compressions,
              injectionBudget: 3_000,
            }
            const got = dynamicHistoryLevels(input)
            const want = legacyDynamicHistoryLevels(input)
            expect(got.triggerRatio).toBeCloseTo(want.triggerRatio, 9)
            expect(got.targetRatio).toBeCloseTo(want.targetRatio, 9)
            // Token levels: identical UNLESS the legacy injection subtraction
            // would dip below the trigger/target floors — the unified curve
            // floors them in token space (deliberate divergence, the
            // 2026-11-03 tiny-window fix: trigger 1 / target 0 on a 4k window
            // meant fold-every-step with zero verbatim retention).
            expect(got.triggerTokens).toBeGreaterThanOrEqual(want.triggerTokens)
            expect(got.targetTokens).toBeGreaterThanOrEqual(want.targetTokens)
          }
        }
      }
    }
  })
})

describe('compactionWaterLevels hard bounds & monotonicity', () => {
  const budget = 100_000
  const base: WaterLevelInput = {
    baseTriggerRatio: 0.85,
    baseTargetRatio: 0.6,
    budgetTokens: budget,
    growthTokens: 0,
    compressInterval: 7,
    compressions: 0,
    injectionBudget: 0,
  }

  it('never crosses the ceiling / floors / min band, even for hostile input', () => {
    const hostile: WaterLevelInput[] = [
      { ...base, baseTriggerRatio: 5, growthTokens: 1e12, compressions: 1e9 },
      { ...base, baseTriggerRatio: -5, baseTargetRatio: 5 },
      { ...base, baseTriggerRatio: Number.NaN, budgetTokens: Number.NaN },
      { ...base, growthTokens: Number.NaN, compressInterval: Number.NaN, compressions: Number.NaN },
    ]
    for (const input of hostile) {
      const l = compactionWaterLevels(input)
      expect(Number.isFinite(l.triggerRatio)).toBe(true)
      expect(Number.isFinite(l.targetRatio)).toBe(true)
      // Ceiling / target floor / band are ABSOLUTE; the trigger floor is
      // anchor-relative (a configured anchor below it is respected).
      expect(l.triggerRatio).toBeLessThanOrEqual(GOV_TRIGGER_CEILING + 1e-9)
      expect(l.triggerRatio).toBeGreaterThanOrEqual(GOV_TARGET_FLOOR - 1e-9)
      expect(l.targetRatio).toBeGreaterThanOrEqual(GOV_TARGET_FLOOR - 1e-9)
      expect(l.targetRatio).toBeLessThanOrEqual(l.triggerRatio + 1e-9)
      expect(l.triggerRatio - l.targetRatio).toBeGreaterThanOrEqual(GOV_MIN_BAND - 1e-9)
    }
  })

  it('respects the trigger floor when the anchor is at or above it', () => {
    const l = compactionWaterLevels({ ...base, baseTriggerRatio: 0.85, growthTokens: 1e6, compressions: 1e6 })
    expect(l.triggerRatio).toBeGreaterThanOrEqual(GOV_TRIGGER_FLOOR - 1e-9)
    // ...but a deliberately lower anchor is respected (config wins).
    const low = compactionWaterLevels({ ...base, baseTriggerRatio: 0.55, growthTokens: 1e6, compressions: 1e6 })
    expect(low.triggerRatio).toBeCloseTo(0.55, 9)
  })

  it('never bands past the maximum', () => {
    const l = compactionWaterLevels({ ...base, growthTokens: 1e9, compressInterval: 100 })
    expect(l.triggerRatio - l.targetRatio).toBeLessThanOrEqual(GOV_MAX_BAND + 1e-9)
  })

  it('is monotonic: more growth / more maturity never raises the trigger or target', () => {
    const quiet = compactionWaterLevels({ ...base, growthTokens: 0, compressions: 0 })
    const hot = compactionWaterLevels({ ...base, growthTokens: 5_000, compressions: 0 })
    const mature = compactionWaterLevels({ ...base, growthTokens: 0, compressions: 100 })
    const both = compactionWaterLevels({ ...base, growthTokens: 5_000, compressions: 100 })
    expect(hot.triggerRatio).toBeLessThanOrEqual(quiet.triggerRatio)
    expect(hot.targetRatio).toBeLessThanOrEqual(quiet.targetRatio)
    expect(mature.triggerRatio).toBeLessThanOrEqual(quiet.triggerRatio)
    expect(mature.targetRatio).toBeLessThanOrEqual(quiet.targetRatio)
    expect(both.triggerRatio).toBeLessThanOrEqual(hot.triggerRatio)
    expect(both.targetRatio).toBeLessThanOrEqual(hot.targetRatio)
  })

  it('fill pressure starts at 0.5 and saturates at 0.9', () => {
    expect(fillPressureOf(0.5)).toBe(0)
    expect(fillPressureOf(0.9)).toBeCloseTo(1, 9)
    expect(fillPressureOf(0.7)).toBeCloseTo(0.5, 9)
    expect(fillPressureOf(0)).toBe(0)
    expect(fillPressureOf(2)).toBe(1)
  })

  it('exposes the shipped bounds as the single source of truth', () => {
    expect(DEFAULT_WATER_LEVEL_BOUNDS.triggerCeiling).toBe(GOV_TRIGGER_CEILING)
    expect(DEFAULT_WATER_LEVEL_BOUNDS.triggerFloor).toBe(GOV_TRIGGER_FLOOR)
    expect(DEFAULT_WATER_LEVEL_BOUNDS.targetFloor).toBe(GOV_TARGET_FLOOR)
    expect(DEFAULT_WATER_LEVEL_BOUNDS.minBand).toBe(GOV_MIN_BAND)
    expect(DEFAULT_WATER_LEVEL_BOUNDS.maxBand).toBe(GOV_MAX_BAND)
  })
})

describe('toSurfaceSnapshot (unified metering basis)', () => {
  it('preserves the envelope: fixed = total - surface', () => {
    const s = toSurfaceSnapshot({ totalTokens: 10_000, surfaceTokens: 8_000, window: 100_000 })
    expect(s.totalTokens).toBe(10_000)
    expect(s.surfaceTokens).toBe(8_000)
    expect(s.fixedTokens).toBe(2_000)
    expect(s.window).toBe(100_000)
    expect(s.declaredWindow).toBeUndefined()
  })

  it('takes the larger of the two surface estimates (CJK safety)', () => {
    // DSH meter under-counts CJK (CHARS_PER_TOKEN=4, no CJK arm); the plugin's
    // CJK-aware estimate must win, and the total must be lifted by the delta so
    // the system/tools envelope stays intact.
    const s = toSurfaceSnapshot({
      totalTokens: 10_000,
      surfaceTokens: 8_000,
      window: 100_000,
      alternateSurfaceTokens: 20_000,
    })
    expect(s.surfaceTokens).toBe(20_000)
    expect(s.fixedTokens).toBe(2_000)
    expect(s.totalTokens).toBe(22_000)
  })

  it('ignores a smaller / non-finite alternate estimate', () => {
    const small = toSurfaceSnapshot({ totalTokens: 10_000, surfaceTokens: 8_000, window: 100_000, alternateSurfaceTokens: 5_000 })
    expect(small.surfaceTokens).toBe(8_000)
    const nan = toSurfaceSnapshot({ totalTokens: 10_000, surfaceTokens: 8_000, window: 100_000, alternateSurfaceTokens: Number.NaN })
    expect(nan.surfaceTokens).toBe(8_000)
  })

  it('degrades every non-finite field to a finite snapshot', () => {
    const s = toSurfaceSnapshot({
      totalTokens: Number.NaN,
      surfaceTokens: Number.NaN,
      window: Number.NaN,
      declaredWindow: Number.NaN,
    })
    expect(Number.isFinite(s.totalTokens)).toBe(true)
    expect(Number.isFinite(s.surfaceTokens)).toBe(true)
    expect(Number.isFinite(s.fixedTokens)).toBe(true)
    expect(s.window).toBe(1)
    expect(s.declaredWindow).toBeUndefined()
  })

  it('records declaredWindow only when it is a positive finite number', () => {
    const s = toSurfaceSnapshot({ totalTokens: 1, surfaceTokens: 1, window: 10, declaredWindow: 8 })
    expect(s.declaredWindow).toBe(8)
    const bad = toSurfaceSnapshot({ totalTokens: 1, surfaceTokens: 1, window: 10, declaredWindow: -3 })
    expect(bad.declaredWindow).toBeUndefined()
  })

  it('keeps fixedTokens non-negative even when surface exceeds total', () => {
    const s = toSurfaceSnapshot({ totalTokens: 5_000, surfaceTokens: 9_000, window: 100_000 })
    expect(s.totalTokens).toBe(9_000)
    expect(s.surfaceTokens).toBe(9_000)
    expect(s.fixedTokens).toBe(0)
  })
})

describe('planCompaction (single policy)', () => {
  const base: GovernanceInput = {
    snapshot: { totalTokens: 50_000, surfaceTokens: 47_000, fixedTokens: 3_000, window: 100_000 },
    ledger: {
      turn: 10,
      lastCompressedTurn: 1,
      lastTokens: 78_000,
      failureCooldown: 0,
      compressions: 0,
      growthTokens: 0,
    },
    capabilities: { fold: true, durable: true },
    baseTriggerRatio: 0.75,
    baseTargetRatio: 0.6,
    compressInterval: 7,
    incomingTrigger: 'fold',
    force: false,
    nudge: true,
  }

  it('stays below the trigger with no nudge', () => {
    const plan = planCompaction(base)
    expect(plan.lane).toBe('none')
    expect(plan.reason).toBe('below-trigger')
    expect(plan.triggerTokens).toBe(75_000)
    // For the fold lane the basis IS the surface, so the trigger needs no
    // envelope subtraction; it equals the water level directly.
    expect(plan.surfaceTriggerTokens).toBe(75_000)
  })

  it('routes an over-trigger step to durable from the base hook and fold elsewhere', () => {
    const heavy = { ...base, snapshot: { ...base.snapshot, totalTokens: 80_000, surfaceTokens: 77_000 } }
    expect(planCompaction({ ...heavy, incomingTrigger: 'pressure' }).lane).toBe('durable')
    expect(planCompaction({ ...heavy, incomingTrigger: 'pressure' }).reason).toBe('pressure')
    expect(planCompaction({ ...heavy, incomingTrigger: 'fold' }).lane).toBe('fold')
  })

  it('forces durable for a narrowed real window and for provider overflow', () => {
    const heavy = { ...base, snapshot: { ...base.snapshot, totalTokens: 80_000, declaredWindow: 120_000 } }
    expect(planCompaction(heavy)).toMatchObject({ lane: 'durable', reason: 'narrowed-window' })
    expect(planCompaction({ ...base, incomingTrigger: 'context-overflow' }))
      .toMatchObject({ lane: 'durable', reason: 'overflow' })
  })

  it('fit-guard bypasses cooldown and rate limit', () => {
    const critical = {
      ...base,
      snapshot: { ...base.snapshot, totalTokens: 95_000, surfaceTokens: 92_000 },
      ledger: { ...base.ledger, failureCooldown: 3, lastCompressedTurn: 9 },
    }
    expect(planCompaction(critical)).toMatchObject({ lane: 'durable', reason: 'fit-guard' })
  })

  it('honours the failure cooldown before the trigger', () => {
    const heavy = {
      ...base,
      snapshot: { ...base.snapshot, totalTokens: 80_000 },
      ledger: { ...base.ledger, failureCooldown: 2 },
    }
    expect(planCompaction(heavy)).toMatchObject({ lane: 'none', reason: 'cooldown' })
  })

  it('rate-limits inside the interval but lets a surge through', () => {
    const inside = {
      ...base,
      snapshot: { ...base.snapshot, totalTokens: 80_000 },
      ledger: { ...base.ledger, turn: 10, lastCompressedTurn: 9, lastTokens: 79_000 },
    }
    expect(planCompaction(inside)).toMatchObject({ lane: 'none', reason: 'rate-limited' })
    const surge = { ...inside, ledger: { ...inside.ledger, lastTokens: 50_000 } }
    expect(planCompaction(surge)).toMatchObject({ lane: 'fold', reason: 'surge' })
  })

  it('nudges one step early when growth would cross the trigger', () => {
    const plan = planCompaction({
      ...base,
      snapshot: { ...base.snapshot, totalTokens: 60_000, surfaceTokens: 57_000 },
      ledger: { ...base.ledger, growthTokens: 20_000, lastTokens: 58_000 },
    })
    expect(plan).toMatchObject({ lane: 'fold', reason: 'nudge' })
  })

  it('downgrades a lane the caller cannot execute', () => {
    const heavy = { ...base, snapshot: { ...base.snapshot, totalTokens: 80_000 } }
    // A fold-only hook cannot do durable: the overflow-style cut downgrades
    // to the fold lane the caller CAN execute (recommend() never returns a
    // lane the capabilities table cannot run).
    expect(planCompaction({ ...heavy, incomingTrigger: 'pressure', capabilities: { fold: true, durable: false } }).lane)
      .toBe('fold')
    // A durable-only hook cannot fold.
    expect(planCompaction({ ...heavy, incomingTrigger: 'fold', capabilities: { fold: false, durable: true } }).lane)
      .toBe('none')
  })

  it('never produces NaN for hostile snapshots', () => {
    const plan = planCompaction({
      ...base,
      snapshot: {
        totalTokens: Number.NaN,
        surfaceTokens: Number.NaN,
        fixedTokens: Number.NaN,
        window: Number.NaN,
      },
      ledger: { ...base.ledger, growthTokens: Number.NaN, turn: Number.NaN },
    })
    expect(Number.isFinite(plan.triggerTokens)).toBe(true)
    expect(Number.isFinite(plan.surfaceTriggerTokens)).toBe(true)
    expect(Number.isFinite(plan.targetSurfaceTokens)).toBe(true)
    expect(Number.isFinite(plan.triggerRatio)).toBe(true)
  })
})

describe('ledgerView (pure wiring)', () => {
  const entry: SessionLedgerEntry = {
    turn: 4,
    lastCompressedTurn: 1,
    lastTokens: 50_000,
    failureCooldown: 2,
    compressions: 3,
    growthEma: 1_000,
    lastSizeTokens: 10_000,
  }

  it('reports the UPCOMING turn so the rate limit matches the executor', () => {
    expect(ledgerView(entry).turn).toBe(5)
  })

  it('carries the stored state through', () => {
    const view = ledgerView(entry)
    expect(view.lastCompressedTurn).toBe(1)
    expect(view.lastTokens).toBe(50_000)
    expect(view.failureCooldown).toBe(2)
    expect(view.compressions).toBe(3)
  })

  it('recomputes the growth EMA exactly like the executor', () => {
    // nextGrowthEma(1000, 13_000 - 10_000) = 1000*0.5 + 3000*0.5 = 2000
    expect(ledgerView(entry, 13_000).growthTokens).toBe(2_000)
    // First EMA observation adopts the raw delta (previous size known).
    const fresh: SessionLedgerEntry = { turn: 0, failureCooldown: 0, lastSizeTokens: 10_000 }
    expect(ledgerView(fresh, 15_000).growthTokens).toBe(5_000)
    // A truly first observation (no previous size) is delta 0, exactly as the
    // executor computes it.
    expect(ledgerView({ turn: 0, failureCooldown: 0 }, 5_000).growthTokens).toBe(0)
    // Without a measurement the stored EMA is kept.
    expect(ledgerView(entry).growthTokens).toBe(1_000)
  })

  it('degrades a non-finite measurement to the stored EMA', () => {
    expect(ledgerView(entry, Number.NaN).growthTokens).toBe(1_000)
  })
})

describe('planFoldCompaction (pure wiring)', () => {
  const window = 100_000
  const budgetTokens = 75_000 // window × (1 − headroom 0.25)
  const base: FoldPlanInput = {
    surfaceTokens: 60_000,
    fixedTokens: 3_000,
    window,
    ledger: { turn: 10, lastCompressedTurn: 1, lastTokens: 58_000, failureCooldown: 0, compressions: 0, growthTokens: 0 },
    baseTriggerRatio: 0.75,
    baseTargetRatio: 0.6,
    compressInterval: 7,
    budgetTokens,
    injectionBudget: 3_000,
    nudge: true,
  }

  it('folds to the effective-budget target minus the injection reserve', () => {
    const plan = planFoldCompaction(base)
    expect(plan.lane).toBe('fold')
    expect(plan.reason).toBe('pressure')
    // trigger = floor(75_000 × 0.75) − 3_000 = 53_250
    expect(plan.surfaceTriggerTokens).toBe(53_250)
    // target = floor(75_000 × 0.6) − 3_000 = 42_000
    expect(plan.targetSurfaceTokens).toBe(42_000)
  })

  it('never routes the fold lane to durable', () => {
    // Near the window the planner recommends durable (fit-guard), but this
    // capability set can only fold, so it must downgrade.
    const plan = planFoldCompaction({ ...base, surfaceTokens: 90_000, fixedTokens: 10_000 })
    expect(plan.lane).toBe('fold')
    expect(plan.reason).toBe('fit-guard')
  })

  it('stays quiet when below the fold trigger', () => {
    const plan = planFoldCompaction({ ...base, surfaceTokens: 40_000 })
    expect(plan.lane).toBe('none')
    expect(plan.reason).toBe('below-trigger')
  })

  it('a good seam lowers the trigger and a bad one raises it, inside the bounds', () => {
    const neutral = planFoldCompaction(base)
    const good = planFoldCompaction({ ...base, opportunity: { phase: 'turn-start', score: 1, maturity: 1 } })
    const bad = planFoldCompaction({ ...base, opportunity: { phase: 'tool-loop', score: 0.15, maturity: 1 } })
    expect(good.surfaceTriggerTokens).toBeLessThan(neutral.surfaceTriggerTokens)
    expect(bad.surfaceTriggerTokens).toBeGreaterThan(neutral.surfaceTriggerTokens)
    expect(good.surfaceTriggerTokens)
      .toBeGreaterThanOrEqual(Math.floor(budgetTokens * GOV_TRIGGER_FLOOR) - 3_000)
    expect(bad.surfaceTriggerTokens)
      .toBeLessThanOrEqual(Math.floor(budgetTokens * GOV_TRIGGER_CEILING) - 3_000)
  })

  it('an early session compacts later than a mature one', () => {
    const early = planFoldCompaction({ ...base, opportunity: { phase: 'turn-start', score: 1, maturity: 0 } })
    const mature = planFoldCompaction({ ...base, opportunity: { phase: 'turn-start', score: 1, maturity: 1 } })
    expect(early.surfaceTriggerTokens).toBeGreaterThan(mature.surfaceTriggerTokens)
  })

  it('lets the content intent drive the trigger and magnitude', () => {
    const intent = (timing: number, magnitude: number) => ({
      timing,
      magnitude,
      profile: {
        messageTokens: 1000, userShare: 0, assistantShare: 0, toolShare: 0,
        milestone: false, openQuestion: false, toolRun: 0, recentErrors: 0, phase: 'steady' as const,
      },
      reasons: [],
    })
    const now = planFoldCompaction({ ...base, intent: intent(1, 0) })
    const defer = planFoldCompaction({ ...base, intent: intent(0, 0) })
    expect(now.surfaceTriggerTokens).toBeLessThan(defer.surfaceTriggerTokens)
    const deep = planFoldCompaction({ ...base, intent: intent(0.5, 1) })
    const shallow = planFoldCompaction({ ...base, intent: intent(0.5, 0) })
    expect(deep.targetSurfaceTokens).toBeLessThan(shallow.targetSurfaceTokens)
    expect(deep.targetSurfaceTokens)
      .toBeGreaterThanOrEqual(Math.floor(budgetTokens * 0.55) - 3_000)
  })

  it('does not let maturity pin the trigger to the floor', () => {
    const plan = planFoldCompaction({
      ...base,
      ledger: { ...base.ledger, compressions: 8, lastCompressedTurn: 1, lastTokens: 50_000 },
    })
    // The planner caps the maturity term, so the trigger stays near the 0.75 anchor.
    expect(plan.triggerTokens).toBeGreaterThanOrEqual(Math.floor(budgetTokens * 0.72) - 3_000)
  })

  it('never retains less than the memory floor on a mature session', () => {
    const plan = planFoldCompaction({
      ...base,
      ledger: { ...base.ledger, compressions: 8, lastCompressedTurn: 1, lastTokens: 50_000 },
    })
    // floor(75_000 × 0.55) − 3_000 = 38_250
    expect(plan.targetSurfaceTokens).toBeGreaterThanOrEqual(
      Math.floor(budgetTokens * GOV_TARGET_MEMORY_FLOOR) - 3_000,
    )
  })

  it('never nudges mid tool-loop', () => {
    const plan = planFoldCompaction({
      ...base,
      surfaceTokens: 48_000,
      ledger: { ...base.ledger, growthTokens: 2_000 },
      opportunity: { phase: 'tool-loop', score: 0.15, maturity: 1 },
    })
    expect(plan.lane).toBe('none')
  })

  it('honours the round rate limit', () => {
    const plan = planFoldCompaction({
      ...base,
      ledger: { ...base.ledger, turn: 10, lastCompressedTurn: 9, lastTokens: 59_000 },
    })
    expect(plan).toMatchObject({ lane: 'none', reason: 'rate-limited' })
  })

  it('nudges when growth would cross the fold trigger', () => {
    const plan = planFoldCompaction({
      ...base,
      surfaceTokens: 48_000,
      ledger: { ...base.ledger, growthTokens: 2_000 },
    })
    expect(plan).toMatchObject({ lane: 'fold', reason: 'nudge' })
  })

  it('a forced fold bypasses the trigger and reports forced', () => {
    const plan = planFoldCompaction({
      ...base,
      surfaceTokens: 1_000,
      ledger: { ...base.ledger, failureCooldown: 3, turn: 1, lastCompressedTurn: 1 },
      force: true,
    })
    expect(plan).toMatchObject({ lane: 'fold', reason: 'forced' })
  })

  it('is finite for hostile input', () => {
    const plan = planFoldCompaction({
      ...base,
      surfaceTokens: Number.NaN,
      fixedTokens: Number.NaN,
      window: Number.NaN,
      budgetTokens: Number.NaN,
    })
    expect(Number.isFinite(plan.targetSurfaceTokens)).toBe(true)
    expect(Number.isFinite(plan.surfaceTriggerTokens)).toBe(true)
  })
})

describe('foldPressureBudget (degenerate reserve guard)', () => {
  it('keeps a minimum prompt share when the request cap equals the window', () => {
    const window = 64_000
    const headroom = 16_000
    const budget = foldPressureBudget({ window, reservedCompletion: 64_000, headroom })
    expect(budget).toBeGreaterThanOrEqual(Math.floor(window * 0.5))
    expect(budget).toBeLessThanOrEqual(window - headroom)
  })

  it('leaves a fitting reserve unchanged', () => {
    // 1M − 131_072 − 250_000 = 618_928
    expect(foldPressureBudget({ window: 1_000_000, reservedCompletion: 131_072, headroom: 250_000 }))
      .toBe(618_928)
  })

  it('never returns zero for impossible reserves', () => {
    expect(foldPressureBudget({ window: 1_000, reservedCompletion: 999_999, headroom: 999 }))
      .toBeGreaterThanOrEqual(1)
  })
})

describe('completionReserveOf (placeholder cap degradation)', () => {
  it('passes a sane declared cap through untouched', () => {
    expect(completionReserveOf(4_096, 128_000)).toBe(4_096)
    expect(completionReserveOf(16_384, 128_000)).toBe(16_384)
    // Honest-aggressive but sub-window caps are the operator's word.
    expect(completionReserveOf(127_999, 128_000)).toBe(127_999)
  })

  it('degrades a cap at (or above) the window to the placeholder reserve', () => {
    // The 2026-11 Ubuntu low-water diagnosis: a maxTokens equal to the whole
    // window is the "never truncate" placeholder, not a completion budget.
    expect(completionReserveOf(128_000, 128_000)).toBe(GOV_PLACEHOLDER_COMPLETION_RESERVE)
    expect(completionReserveOf(200_000, 128_000)).toBe(GOV_PLACEHOLDER_COMPLETION_RESERVE)
  })

  it('degrades an absent or unknown cap and never returns zero', () => {
    expect(completionReserveOf(0, 128_000)).toBe(GOV_PLACEHOLDER_COMPLETION_RESERVE)
    expect(completionReserveOf(Number.NaN, 128_000)).toBe(GOV_PLACEHOLDER_COMPLETION_RESERVE)
    expect(completionReserveOf(Number.POSITIVE_INFINITY, 128_000)).toBe(GOV_PLACEHOLDER_COMPLETION_RESERVE)
  })

  it('a placeholder cap no longer halves the fold budget (regression: budget 64000 → 87808)', () => {
    const window = 128_000
    const headroom = Math.floor(window * 0.25)
    // Raw placeholder input: the clamp still keeps its minimum prompt share…
    expect(foldPressureBudget({ window, reservedCompletion: window, headroom })).toBe(64_000)
    // …but the degraded reserve keeps both the completion room and the budget.
    expect(foldPressureBudget({ window, reservedCompletion: completionReserveOf(window, window), headroom }))
      .toBe(87_808)
  })

  it('degrades sanely at the window-size extremes', () => {
    // Tiny window: the substituted 8192 reserve exceeds what the window can
    // spare — the clamp floors the budget at the minimum prompt share.
    expect(completionReserveOf(4_096, 4_096)).toBe(GOV_PLACEHOLDER_COMPLETION_RESERVE)
    expect(foldPressureBudget({ window: 4_096, reservedCompletion: GOV_PLACEHOLDER_COMPLETION_RESERVE, headroom: 1_024 }))
      .toBe(2_048)
    // Huge window: the reserve stays a small constant, not a window share.
    expect(completionReserveOf(1_000_000, 1_000_000)).toBe(GOV_PLACEHOLDER_COMPLETION_RESERVE)
    expect(foldPressureBudget({ window: 1_000_000, reservedCompletion: GOV_PLACEHOLDER_COMPLETION_RESERVE, headroom: 250_000 }))
      .toBe(741_808)
  })
})

describe('failureCooldownFor', () => {
  it('backs off much longer for configuration errors', () => {
    expect(failureCooldownFor(0, 'UNSUPPORTED_REASONING_EFFORT: does not support reasoning effort "high"'))
      .toBe(GOV_CONFIG_ERROR_COOLDOWN)
    expect(failureCooldownFor(0, 'network timeout', 3)).toBe(3)
  })
})

describe('fold sizing helpers', () => {
  it('requires a fold larger than its own summary', () => {
    expect(minimumFoldTokens(32_000)).toBe(3_200)
    expect(minimumFoldTokens(1_000)).toBe(2_048)
    expect(minimumFoldTokens(1_000_000)).toBe(16_384)
  })

  it('caps a summary to the planned share of the folded input', () => {
    expect(summaryCharBudget(2_324)).toBe(2_788)
    expect(summaryCharBudget(30_000)).toBe(36_000)
    expect(summaryCharBudget(0)).toBe(1_024)
  })
})

describe('closed-loop band & large-window deep probe', () => {
  // Production shape (1M-window session, 2026-10 telemetry): the fold budget
  // is capped by the completion reserve (basis 500k < window × 0.75), the
  // surface sits at ~38% of the WINDOW, and folds landed systematically above
  // the planned target.
  const window = 1_000_000
  const budget = 500_000
  const mkIntent = (timing: number, magnitude: number) => ({
    timing,
    magnitude,
    profile: {
      messageTokens: 1000, userShare: 0, assistantShare: 0, toolShare: 0,
      milestone: false, openQuestion: false, toolRun: 0, recentErrors: 0, phase: 'steady' as const,
    },
    reasons: [],
  })
  const bigBase: FoldPlanInput = {
    surfaceTokens: 380_000, // 38% window fill: above the trigger, below the probe cap
    fixedTokens: 20_000,
    window,
    ledger: { turn: 10, lastCompressedTurn: 1, lastTokens: 370_000, failureCooldown: 0, compressions: 0, growthTokens: 0 },
    baseTriggerRatio: 0.75,
    baseTargetRatio: 0.6,
    compressInterval: 7,
    budgetTokens: budget,
    injectionBudget: 0,
    nudge: true,
  }

  it('nextTargetDeviationEma: seeds with the first landing, tracks the mean, rejects garbage', () => {
    expect(nextTargetDeviationEma(undefined, 100)).toBe(100)
    expect(nextTargetDeviationEma(100, 100, 0.5)).toBe(100)
    expect(nextTargetDeviationEma(100, 200, 0.5)).toBe(150)
    // Over-corrections shrink the EMA back: a stable negative-feedback loop.
    expect(nextTargetDeviationEma(150, 0, 0.5)).toBe(75)
    expect(nextTargetDeviationEma(100, Number.NaN)).toBe(100)
    expect(nextTargetDeviationEma(undefined, Number.NaN)).toBe(0)
  })

  it('targetDeviationCorrection: bounded, one-sided, basis-guarded', () => {
    expect(targetDeviationCorrection(undefined, 1000)).toBe(0)
    expect(targetDeviationCorrection(50, 1000)).toBe(0.05)
    // Capped at the default max share of the basis.
    expect(targetDeviationCorrection(500, 1000)).toBe(GOV_TARGET_DEVIATION_MAX)
    expect(targetDeviationCorrection(500, 1000, 0.6)).toBe(0.5)
    // A negative (over-corrected) EMA can never make the planner lazier.
    expect(targetDeviationCorrection(-50, 1000)).toBe(0)
    expect(targetDeviationCorrection(50, 0)).toBe(0)
    expect(targetDeviationCorrection(50, Number.NaN)).toBe(0)
  })

  it('deep probe: a tool-heavy, mostly-empty large window folds to the relaxed floor', () => {
    const plan = planFoldCompaction({ ...bigBase, intent: mkIntent(1, 1) })
    expect(plan.lane).toBe('fold')
    // magnitude 1.0 spends the whole available band, so the target is the
    // relaxed floor itself, independent of minBand.
    expect(plan.targetSurfaceTokens).toBe(Math.floor(budget * GOV_DEEP_PROBE_MEMORY_FLOOR))
  })

  it('no deep probe below the magnitude threshold: the 0.55 floor holds', () => {
    const plan = planFoldCompaction({ ...bigBase, intent: mkIntent(1, 0.3) })
    expect(plan.targetSurfaceTokens)
      .toBeGreaterThanOrEqual(Math.floor(budget * GOV_TARGET_MEMORY_FLOOR))
  })

  it('no deep probe on a small window even at magnitude 1.0', () => {
    const plan = planFoldCompaction({
      ...bigBase,
      window: 100_000,
      budgetTokens: 75_000,
      surfaceTokens: 60_000,
      intent: mkIntent(1, 1),
    })
    expect(plan.targetSurfaceTokens)
      .toBe(Math.floor(75_000 * GOV_TARGET_MEMORY_FLOOR))
  })

  it('no deep probe once the window fill passes the cap: the floor reverts to 0.55', () => {
    const plan = planFoldCompaction({
      ...bigBase,
      surfaceTokens: 500_000, // 50% window fill > 0.4 cap
      intent: mkIntent(1, 1),
    })
    expect(plan.targetSurfaceTokens)
      .toBeGreaterThanOrEqual(Math.floor(budget * GOV_TARGET_MEMORY_FLOOR))
  })

  it('the learned deviation deepens the next target by exactly the shortfall', () => {
    const without = planFoldCompaction({ ...bigBase, intent: mkIntent(1, 0) })
    const withDev = planFoldCompaction({ ...bigBase, intent: mkIntent(1, 0), deviationEmaTokens: 25_000 })
    // 25k on a 500k basis is a 0.05 correction, and both targets stay inside
    // the band, so the delta is exact.
    expect(without.targetSurfaceTokens - withDev.targetSurfaceTokens).toBe(25_000)
  })

  it('the deviation correction is capped by the band and never crosses the memory floor', () => {
    const plan = planFoldCompaction({ ...bigBase, intent: mkIntent(1, 0), deviationEmaTokens: 1_000_000 })
    expect(plan.targetSurfaceTokens)
      .toBe(Math.floor(budget * GOV_TARGET_MEMORY_FLOOR))
  })

  it('a negative deviation EMA (over-correction) leaves the band untouched', () => {
    const without = planFoldCompaction({ ...bigBase, intent: mkIntent(1, 0) })
    const negative = planFoldCompaction({ ...bigBase, intent: mkIntent(1, 0), deviationEmaTokens: -25_000 })
    expect(negative.targetSurfaceTokens).toBe(without.targetSurfaceTokens)
  })
})

describe('closed-loop band on the durable lane', () => {
  const mkIntent = (timing: number, magnitude: number) => ({
    timing,
    magnitude,
    profile: {
      messageTokens: 1000, userShare: 0, assistantShare: 0, toolShare: 0,
      milestone: false, openQuestion: false, toolRun: 0, recentErrors: 0, phase: 'steady' as const,
    },
    reasons: [],
  })
  const durable: GovernanceInput = {
    snapshot: { totalTokens: 80_000, surfaceTokens: 77_000, fixedTokens: 3_000, window: 100_000 },
    ledger: { turn: 10, lastCompressedTurn: 1, lastTokens: 78_000, failureCooldown: 0, compressions: 0, growthTokens: 0 },
    capabilities: { fold: true, durable: true },
    baseTriggerRatio: 0.75,
    baseTargetRatio: 0.6,
    compressInterval: 7,
    incomingTrigger: 'pressure',
    force: false,
    nudge: true,
    intent: mkIntent(1, 0.5),
  }

  it('the learned deviation deepens the durable target down to the memory floor', () => {
    expect(planCompaction(durable).lane).toBe('durable')
    const without = planCompaction(durable)
    const withDev = planCompaction({ ...durable, deviationEmaTokens: 10_000 })
    expect(withDev.targetRatio).toBeLessThan(without.targetRatio)
    // 10k on a 100k basis pushes the raw target below 0.55, so the floor holds.
    expect(withDev.targetRatio).toBe(GOV_TARGET_MEMORY_FLOOR)
    // A huge EMA is capped and still cannot go below the memory floor.
    const capped = planCompaction({ ...durable, deviationEmaTokens: 50_000 })
    expect(capped.targetRatio).toBe(GOV_TARGET_MEMORY_FLOOR)
  })

  it('a negative durable EMA (over-correction) leaves the target untouched', () => {
    const without = planCompaction(durable)
    const negative = planCompaction({ ...durable, deviationEmaTokens: -10_000 })
    expect(negative.targetRatio).toBe(without.targetRatio)
  })
})

describe('thin-fold gate', () => {
  it('skips folds whose net saving is under 8% of the budget', () => {
    // 32k window shape: 2400-token fold, ~800-token summary, 24k budget.
    expect(isThinFold(2400, 800, 24_000)).toBe(true)
    // A deeper occasion clears it.
    expect(isThinFold(3000, 800, 24_000)).toBe(false)
    // 1M shape: well clear.
    expect(isThinFold(60_000, 18_000, 500_000)).toBe(false)
  })

  it('is conservative on garbage and honours the disable switch', () => {
    expect(isThinFold(Number.NaN, 800, 24_000)).toBe(true)
    expect(isThinFold(2400, Number.NaN, 24_000)).toBe(true)
    expect(isThinFold(-500, 800, 24_000)).toBe(true)
    expect(isThinFold(2400, 800, Number.NaN)).toBe(true)
    expect(isThinFold(2400, 800, 24_000, 0)).toBe(false)
  })
})

describe('cost-aware fold cadence (learned latency drives rhythm and bar)', () => {
  it('foldIntervalFor: unknown latency keeps the shipped 20 minutes', () => {
    expect(foldIntervalFor(undefined)).toBe(20 * 60_000)
    expect(foldIntervalFor(Number.NaN)).toBe(20 * 60_000)
  })

  it('foldIntervalFor scales with the learned latency, clamped to [5min, 60min]', () => {
    // Fast route (~15s summaries): 4x = 60s, clamped up to the 5min floor —
    // folds as often as the interval allows.
    expect(foldIntervalFor(15_000)).toBe(5 * 60_000)
    // The reference route (~5min summaries): 4x = exactly the shipped 20min.
    expect(foldIntervalFor(5 * 60_000)).toBe(20 * 60_000)
    // Slow local route (~10min summaries): 4x = 40min, under the 60min cap.
    expect(foldIntervalFor(10 * 60_000)).toBe(40 * 60_000)
    expect(foldIntervalFor(60 * 60_000)).toBe(60 * 60_000)
  })

  it('thinFoldRatioFor: cost-driven, not latency-driven — local 0, paid 0.08', () => {
    // Local routes run on the operator's own hardware: the call is free, so
    // the bar drops to zero (the dynamic fold interval is the churn guard).
    expect(thinFoldRatioFor(true)).toBe(0)
    // Paid routes keep the shipped 8% regardless of speed.
    expect(thinFoldRatioFor(false)).toBe(GOV_MIN_NET_SAVING_RATIO)
  })
})

describe('hostile-input hardening (2026-11-03 review)', () => {
  // A minimal GovernanceInput: fresh session, no ledger history, standard
  // ratios, 100k window — the hostile field is patched per case.
  const hostileBase: GovernanceInput = {
    snapshot: { totalTokens: 90_000, surfaceTokens: 88_000, fixedTokens: 2_000, window: 100_000 },
    ledger: {
      turn: 0,
      lastCompressedTurn: undefined,
      lastTokens: undefined,
      failureCooldown: 0,
      compressions: 0,
      growthTokens: 0,
    },
    capabilities: { fold: true, durable: true },
    baseTriggerRatio: 0.75,
    baseTargetRatio: 0.6,
    compressInterval: 7,
    incomingTrigger: 'fold',
    force: false,
    nudge: false,
  }

  it('a transient error never shortens an in-force longer cooldown', () => {
    expect(failureCooldownFor(60, 'network timeout', 3)).toBe(60)
    expect(failureCooldownFor(0, 'network timeout', 3)).toBe(3)
    expect(failureCooldownFor(60, 'UNSUPPORTED_REASONING_EFFORT: nope', 3)).toBe(60)
  })

  it('a NaN compressInterval degrades to 1 instead of dead-triggering the planner', () => {
    // roundsSince=Infinity >= NaN is false: without the guard a fresh,
    // nearly-full session planned `rate-limited` forever.
    const plan = planCompaction({
      ...hostileBase,
      compressInterval: Number.NaN,
    })
    expect(plan.reason).not.toBe('rate-limited')
  })

  it('a non-finite measurement degrades to below-trigger instead of a positive plan', () => {
    const plan = planCompaction({
      ...hostileBase,
      snapshot: { ...hostileBase.snapshot, totalTokens: Number.NaN, surfaceTokens: Number.NaN },
    })
    expect(plan.reason).toBe('below-trigger')
    expect(plan.lane).toBe('none')
  })
})
