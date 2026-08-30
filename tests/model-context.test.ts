import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelContextTracker, PROBE_RETRY_MS } from '../src/core.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('ModelContextTracker', () => {
  it('falls back to the configured window before any observation', () => {
    const tracker = new ModelContextTracker(94_000, false)
    expect(tracker.effectiveWindow).toBe(94_000)
    expect(tracker.info).toBeNull()
    expect(tracker.isAdopted).toBe(false)
  })

  it('adopts the request-context window and makes it effective immediately', () => {
    const tracker = new ModelContextTracker(94_000, false)
    const probe = tracker.observe({ provider: 'ollama', model: 'qwen2.5:7b', contextWindow: 8192 })
    expect(probe).toBeUndefined()
    expect(tracker.effectiveWindow).toBe(8192)
    expect(tracker.isAdopted).toBe(true)
    expect(tracker.info?.source).toBe('request-context')
    expect(tracker.info?.model).toBe('qwen2.5:7b')
    expect(tracker.info?.provider).toBe('ollama')
  })

  it('ignores a non-positive window', () => {
    const tracker = new ModelContextTracker(94_000, false)
    tracker.adopt({ contextWindow: 0, source: 'request-context' })
    tracker.observe({ contextWindow: -5 })
    expect(tracker.effectiveWindow).toBe(94_000)
  })

  it('treats an identical observation as a no-op', () => {
    const tracker = new ModelContextTracker(94_000, false)
    tracker.observe({ model: 'm', contextWindow: 8192 })
    const firstDetectedAt = tracker.info?.detectedAt
    tracker.observe({ model: 'm', contextWindow: 8192 })
    expect(tracker.info?.detectedAt).toBe(firstDetectedAt)
  })

  it('probe adoption overrides the request-context source when it changes', () => {
    const tracker = new ModelContextTracker(94_000, false)
    tracker.adopt({ model: 'm', contextWindow: 8192, source: 'request-context' })
    tracker.adopt({ model: 'm', contextWindow: 16_384, source: 'probe' })
    expect(tracker.effectiveWindow).toBe(16_384)
    expect(tracker.info?.source).toBe('probe')
  })

  it('asks for a probe once per model when enabled and the route has no window', () => {
    const tracker = new ModelContextTracker(94_000, true)
    expect(tracker.observe({ model: 'qwen', contextWindow: undefined })).toBe('qwen')
    expect(tracker.observe({ model: 'qwen', contextWindow: undefined })).toBeUndefined()
    expect(tracker.observe({ model: 'other', contextWindow: undefined })).toBe('other')
    expect(tracker.effectiveWindow).toBe(94_000)
  })

  it('never asks for a probe when disabled', () => {
    const tracker = new ModelContextTracker(94_000, false)
    expect(tracker.observe({ model: 'qwen', contextWindow: undefined })).toBeUndefined()
    expect(tracker.effectiveWindow).toBe(94_000)
  })

  it('requests a probe even when a catalog window is declared (the declared value can overstate a local model)', () => {
    // Regression: before the fix, a declared window marked the model as
    // "already probed", so a local model with an inflated catalog window
    // (e.g. 100000 declared vs 8192 real) was never probed and compression
    // never triggered before the real context overflowed.
    const tracker = new ModelContextTracker(94_000, true)
    expect(tracker.observe({ model: 'qwen3.8-27b', contextWindow: 100_000 })).toBe('qwen3.8-27b')
    expect(tracker.effectiveWindow).toBe(100_000) // adopted now; probe refines it shortly after
    expect(tracker.observe({ model: 'qwen3.8-27b', contextWindow: undefined })).toBeUndefined()
  })

  it('does not re-request a probe for a model resolved by a successful probe', () => {
    const tracker = new ModelContextTracker(94_000, true)
    expect(tracker.observe({ model: 'qwen' })).toBe('qwen')
    tracker.markResolved('qwen')
    expect(tracker.observe({ model: 'qwen' })).toBeUndefined()
  })

  it('retries a failed probe after the cooldown, but not before it', () => {
    vi.useFakeTimers()
    const tracker = new ModelContextTracker(94_000, true)
    expect(tracker.observe({ model: 'qwen' })).toBe('qwen')
    vi.advanceTimersByTime(PROBE_RETRY_MS / 2)
    expect(tracker.observe({ model: 'qwen' })).toBeUndefined()
    vi.advanceTimersByTime(PROBE_RETRY_MS)
    expect(tracker.observe({ model: 'qwen' })).toBe('qwen')
  })

  it('rejects a non-positive fallback window at construction', () => {
    expect(() => new ModelContextTracker(0, false)).toThrow(RangeError)
  })
})
