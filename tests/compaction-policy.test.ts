import { describe, expect, it } from 'vitest'
import {
  COMPRESS_FAILURE_COOLDOWN,
  SURGE_RATIO,
  decidePressureCompaction,
  shouldCompressHistory,
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
})
