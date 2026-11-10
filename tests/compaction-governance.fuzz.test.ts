import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GOVERNANCE_BOUNDS,
  GOV_MIN_PROMPT_SHARE,
  GOV_PLACEHOLDER_COMPLETION_RESERVE,
  GOV_TARGET_FLOOR,
  GOV_TRIGGER_CEILING,
  GOV_TRIGGER_FLOOR,
  completionReserveOf,
  foldPressureBudget,
  planCompaction,
  type GovernanceInput,
} from '../src/core.ts'

/**
 * Randomized invariant testing for the ONE water-level policy.
 *
 * The planner composes a dozen bounded terms (fill/growth/stage pressures,
 * opportunity swing, intent timing/magnitude, memory floor, deep probe,
 * deviation correction, reserve band). Per-term unit tests pin behaviour;
 * this suite asserts the COMPOSITION can never leave the legal envelope,
 * for a thousand seeded-random inputs including hostile ones (NaN, zeros,
 * negative tokens, inverted windows). Any future tuning that lets two
 * terms conspire past a bound turns this red before it ships.
 */

/** mulberry32: small seeded PRNG, reproducible runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: () => number, values: readonly T[]): T => values[Math.floor(r() * values.length)] as T
const span = (r: () => number, lo: number, hi: number): number => lo + r() * (hi - lo)
const int = (r: () => number, lo: number, hi: number): number => Math.floor(span(r, lo, hi + 1))

const PHASES = ['turn-start', 'turn-end', 'steady', 'tool-loop'] as const

function randomIntent(r: () => number) {
  return {
    timing: r(),
    magnitude: r(),
    profile: {
      messageTokens: int(r, 0, 500_000),
      userShare: r(),
      assistantShare: r(),
      toolShare: r(),
      milestone: r() < 0.3,
      openQuestion: r() < 0.3,
      toolRun: int(r, 0, 9),
      recentErrors: int(r, 0, 5),
      phase: pick(r, PHASES),
    },
    reasons: [],
  }
}

/** One random input; `mode` injects hostile values at a controlled rate. */
function randomInput(r: () => number, hostile: boolean): GovernanceInput {
  const window = pick(r, [8_000, 32_000, 128_000, 512_000, 1_000_000, 2_000_000])
  const surface = r() * window * 1.2
  const fixed = r() * window * 0.4
  const basis = r() < 0.5 ? window : window * span(r, 0.3, 1.1)
  const input: GovernanceInput = {
    snapshot: {
      totalTokens: hostile && r() < 0.05 ? Number.NaN : surface + fixed,
      surfaceTokens: hostile && r() < 0.05 ? -surface : surface,
      fixedTokens: fixed,
      window: hostile && r() < 0.05 ? 0 : window,
      ...(r() < 0.2 ? { declaredWindow: window * span(r, 0.2, 2) } : {}),
    },
    ledger: {
      turn: int(r, 0, 500),
      failureCooldown: int(r, 0, 9),
      compressions: int(r, 0, 40),
      growthTokens: hostile && r() < 0.05 ? Number.NaN : span(r, -5_000, 80_000),
      ...(r() < 0.7 ? { lastCompressedTurn: int(r, 0, 400) } : {}),
      ...(r() < 0.7 ? { lastTokens: span(r, 0, window * 1.2) } : {}),
    },
    capabilities: { fold: r() < 0.8, durable: r() < 0.6 },
    baseTriggerRatio: pick(r, [0.6, 0.7, 0.75, 0.8, 0.85, Number.NaN]),
    baseTargetRatio: pick(r, [0.3, 0.45, 0.6, 0.75, Number.NaN]),
    compressInterval: pick(r, [1, 3, 7, 20, Number.NaN]),
    incomingTrigger: pick(r, ['fold', 'pressure', 'context-overflow', 'none']),
    force: r() < 0.1,
    nudge: r() < 0.5,
    basisTokens: hostile && r() < 0.05 ? -basis : basis,
    measuredTokens: hostile && r() < 0.05 ? Number.NaN : undefined,
    fillRatio: r() < 0.3 ? r() : undefined,
    injectionBudget: int(r, 0, 20_000),
    ...(r() < 0.6 ? { opportunity: { phase: pick(r, PHASES), score: r(), maturity: r() } } : {}),
    ...(r() < 0.6 ? { intent: randomIntent(r) } : {}),
    ...(r() < 0.5 ? { deviationEmaTokens: hostile && r() < 0.1 ? Number.NaN : span(r, -60_000, 400_000) } : {}),
  }
  if (input.measuredTokens === undefined) delete (input as { measuredTokens?: number }).measuredTokens
  return input
}

/** The unconditional envelope every plan must stay inside. */
function assertInvariants(plan: ReturnType<typeof planCompaction>): void {
  for (const value of [plan.triggerRatio, plan.targetRatio, plan.triggerTokens,
    plan.surfaceTriggerTokens, plan.targetSurfaceTokens, plan.drivers.urgency,
    plan.drivers.timing, plan.drivers.magnitude, plan.drivers.opportunity]) {
    expect(Number.isFinite(value)).toBe(true)
  }
  expect(plan.triggerRatio).toBeGreaterThanOrEqual(GOV_TRIGGER_FLOOR)
  expect(plan.triggerRatio).toBeLessThanOrEqual(GOV_TRIGGER_CEILING)
  expect(plan.targetRatio).toBeGreaterThanOrEqual(GOV_TARGET_FLOOR)
  // The target never reaches past one minimum band below the trigger; the
  // envelope floor may substitute when the trigger sits that low.
  expect(plan.targetRatio).toBeLessThanOrEqual(Math.max(GOV_TARGET_FLOOR, plan.triggerRatio - DEFAULT_GOVERNANCE_BOUNDS.minBand))
  expect(plan.targetSurfaceTokens).toBeGreaterThanOrEqual(0)
  expect(plan.triggerTokens).toBeGreaterThanOrEqual(1)
}

describe('planCompaction randomized invariants (seeded fuzz)', () => {
  it('a thousand default-bounds inputs stay inside the envelope, NaN included', () => {
    const r = rng(0xC0FFEE)
    for (let i = 0; i < 1000; i += 1) {
      let plan
      try {
        plan = planCompaction(randomInput(r, i % 10 === 0))
      } catch (error) {
        throw new Error(`input #${i} threw: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        assertInvariants(plan)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`input #${i}: ${message}\ninput=${JSON.stringify(randomInputSeed(i))}`)
      }
    }
  })

  it('random custom bounds keep their own envelope', () => {
    const r = rng(0xB055)
    for (let i = 0; i < 300; i += 1) {
      const triggerFloor = span(r, 0.4, 0.7)
      const bounds = {
        triggerFloor,
        triggerCeiling: Math.min(0.99, triggerFloor + span(r, 0.1, 0.3)),
        targetFloor: span(r, 0.05, 0.5),
        minBand: span(r, 0.02, 0.2),
        maxBand: span(r, 0.2, 0.6),
        memoryTargetFloor: span(r, 0.2, 0.6),
        deepProbeMemoryFloor: span(r, 0.15, 0.45),
      }
      const plan = planCompaction({ ...randomInput(r, i % 7 === 0), bounds })
      expect(Number.isFinite(plan.triggerRatio) && Number.isFinite(plan.targetRatio)).toBe(true)
      expect(plan.triggerRatio).toBeGreaterThanOrEqual(bounds.triggerFloor)
      expect(plan.triggerRatio).toBeLessThanOrEqual(bounds.triggerCeiling)
      expect(plan.targetRatio).toBeGreaterThanOrEqual(bounds.targetFloor)
      expect(plan.targetRatio).toBeLessThanOrEqual(Math.max(bounds.targetFloor, plan.triggerRatio - bounds.minBand))
    }
  })
})

/** Reproduce an input deterministically when a fuzz case fails. */
function randomInputSeed(i: number): string {
  const r = rng(0xC0FFEE)
  for (let k = 0; k < i; k += 1) randomInput(r, k % 10 === 0)
  return JSON.stringify(randomInput(r, i % 10 === 0))
}

describe('foldPressureBudget / completionReserveOf property invariants', () => {
  it('the budget stays finite, >= 1, and keeps the min prompt share when headroom allows', () => {
    const r = rng(0xB12D)
    for (let i = 0; i < 500; i += 1) {
      const window = Math.max(1, Math.floor(span(r, 1, 2_000_000)))
      const headroom = Math.floor(span(r, 0, window))
      const reserve = span(r, 0, window * 2)
      const budget = foldPressureBudget({ window, reservedCompletion: reserve, headroom })
      expect(Number.isFinite(budget)).toBe(true)
      expect(budget).toBeGreaterThanOrEqual(1)
      // The min-prompt-share holds whenever the caller's headroom leaves
      // room for it (a headroom >= window - minBudget is the caller's own
      // misconfiguration and owns the shortfall).
      const minBudget = Math.max(2048, Math.floor(window * GOV_MIN_PROMPT_SHARE))
      if (headroom < window - minBudget) {
        expect(budget).toBeGreaterThanOrEqual(minBudget)
      }
    }
  })

  it('completionReserveOf is total: finite, positive, and sane-cap preserving', () => {
    const r = rng(0xC0DE)
    for (let i = 0; i < 500; i += 1) {
      const window = Math.max(2, Math.floor(span(r, 2, 2_000_000)))
      const declared = r() < 0.5 ? span(r, 0, window * 2) : (r() < 0.5 ? Number.NaN : window)
      const reserve = completionReserveOf(declared, window)
      expect(Number.isFinite(reserve)).toBe(true)
      expect(reserve).toBeGreaterThan(0)
      const sane = Number.isFinite(declared) && declared > 0 && declared < window
      if (sane) expect(reserve).toBe(declared)
      else expect(reserve).toBe(GOV_PLACEHOLDER_COMPLETION_RESERVE)
    }
  })
})

describe('learned-tempo invariants (runway scheduler, 2026-11 redesign)', () => {
  it('tempoLearned plans stay inside the hard envelope for a thousand hostile inputs', () => {
    const r = rng(0xBEEF)
    for (let i = 0; i < 1000; i += 1) {
      const base = randomInput(r, r() < 0.3)
      const anchor = r() < 0.15 ? Number.NaN : span(r, -0.2, 1.4) // hostile anchors included
      const bandScale = r() < 0.15 ? Number.NaN : span(r, 0.3, 3)
      const input: GovernanceInput = {
        ...base,
        baseTriggerRatio: anchor,
        ...(r() < 0.8 ? { tempoLearned: true } : {}),
        ...(r() < 0.8 ? { bandScale } : {}),
      }
      const plan = planCompaction(input)
      const b = { ...DEFAULT_GOVERNANCE_BOUNDS }
      expect(plan.triggerRatio).toBeGreaterThanOrEqual(GOV_TRIGGER_FLOOR - 1e-9)
      expect(plan.triggerRatio).toBeLessThanOrEqual(GOV_TRIGGER_CEILING + 1e-9)
      expect(plan.targetRatio).toBeGreaterThanOrEqual(GOV_TARGET_FLOOR - 1e-9)
      // Band invariant: target never closer than minBand to the trigger…
      const anchorClamped = Math.min(b.triggerCeiling, Math.max(b.targetFloor + b.minBand, anchor))
      const floor = Math.min(anchorClamped, GOV_TRIGGER_FLOOR)
      // …except the memory floor may compress the band from below (the
      // floors can squeeze the band to nothing on tiny budgets — same
      // behavior as the legacy path).
      if (plan.targetRatio > plan.triggerRatio - b.minBand + 1e-9) {
        expect(plan.targetRatio).toBeGreaterThanOrEqual(b.memoryTargetFloor - 1e-9)
      }
      void floor
      expect(Number.isFinite(plan.triggerTokens)).toBe(true)
      expect(Number.isFinite(plan.targetSurfaceTokens)).toBe(true)
    }
  })
})
