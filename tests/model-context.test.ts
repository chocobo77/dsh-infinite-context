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
    // The probe reports WIDER than the declaration, and narrow-only says a probe
    // may never inflate capacity (`setModelWindow`), so the effective window
    // stays at the declaration; only the source label moves to the probe (that
    // is what this test is about). A user's `config` override may widen.
    tracker.adopt({ model: 'm', contextWindow: 16_384, source: 'probe' })
    expect(tracker.effectiveWindow).toBe(8192)
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

  it('never probes a non-local model even when probing is enabled', () => {
    const tracker = new ModelContextTracker(94_000, true)
    // Locality gate: online models adopt their declared window but are never probed.
    expect(tracker.observe({ provider: 'glm', model: 'glm-5.3-flash', contextWindow: 1_000_000 }, { probe: false })).toBeUndefined()
    expect(tracker.windowFor('glm-5.3-flash')).toBe(1_000_000)
    // A later attempt still does not probe (no cooldown state is burned either).
    expect(tracker.observe({ model: 'glm-5.3-flash' }, { probe: false })).toBeUndefined()
    // The same model IS probed as soon as locality allows it.
    expect(tracker.observe({ model: 'glm-5.3-flash' }, { probe: true })).toBe('glm-5.3-flash')
  })

  it('rejects a non-positive fallback window at construction', () => {
    expect(() => new ModelContextTracker(0, false)).toThrow(RangeError)
  })
})

describe('ModelContextTracker probe ceiling', () => {
  it('never caps a probe by another model\u2019s window', () => {
    const tracker = new ModelContextTracker(94_000, true)
    // Another model adopts a small window, so the global "last observed" slot is
    // 32K — that must NOT become the ceiling for a different model, or the probe
    // would under-cap it (and narrow-only + markResolved make that permanent).
    tracker.adopt({ model: 'small-local', contextWindow: 32_000, source: 'request-context' })
    expect(tracker.effectiveWindow).toBe(32_000)
    expect(tracker.probeCeilingFor('big-remote', 94_000)).toBe(94_000)
    // A model that declared its own window is capped by that declaration.
    tracker.adopt({ model: 'big-remote', contextWindow: 200_000, source: 'request-context' })
    expect(tracker.probeCeilingFor('big-remote', 94_000)).toBe(200_000)
  })
})

describe('ModelContextTracker global slot narrowing', () => {
  it('does not let a replayed declaration widen the global slot past a probe', () => {
    const tracker = new ModelContextTracker(94_000, true)
    tracker.adopt({ model: 'qwen3', contextWindow: 100_000, source: 'request-context' })
    expect(tracker.effectiveWindow).toBe(100_000)
    // The live probe reveals the server's real runtime window.
    tracker.adopt({ model: 'qwen3', contextWindow: 32_000, source: 'probe' })
    expect(tracker.effectiveWindow).toBe(32_000)
    expect(tracker.windowFor('qwen3')).toBe(32_000)
    // The declared window is re-observed every turn; it must not widen either
    // slot back (the global slot feeds budget math for the routed model).
    tracker.adopt({ model: 'qwen3', contextWindow: 100_000, source: 'request-context' })
    expect(tracker.effectiveWindow).toBe(32_000)
    expect(tracker.windowFor('qwen3')).toBe(32_000)
    // A user's own config override is declared truth and MAY widen.
    tracker.adopt({ model: 'qwen3', contextWindow: 131_072, source: 'config' })
    expect(tracker.effectiveWindow).toBe(131_072)
  })
})

describe('ModelContextTracker per-model registry', () => {
  it('records explicit per-model overrides without moving the global slot', () => {
    const tracker = new ModelContextTracker(94_000, false)
    tracker.observe({ provider: 'glm', model: 'glm-5.3-flash', contextWindow: 1_000_000 })
    tracker.setModelWindow({ model: 'Qwen3.8-27B', contextWindow: 32_768, source: 'config' })
    expect(tracker.windowFor('glm-5.3-flash')).toBe(1_000_000)
    expect(tracker.windowFor('Qwen3.8-27B')).toBe(32_768)
    // Global slot still reflects the LAST observed route (glm), not the override.
    expect(tracker.info?.model).toBe('glm-5.3-flash')
    expect(tracker.windowFor('unknown-model')).toBeUndefined()
    expect(tracker.perModel().map(entry => entry.model)).toEqual(['glm-5.3-flash', 'Qwen3.8-27B'])
  })

  it('keeps per-model windows isolated: one model cannot poison another', () => {
    // Regression: the single global slot flip-flopped with whichever model
    // requested last, so a 1M remote chat and an 8K local model shared one
    // budget and one of them was always wrong.
    const tracker = new ModelContextTracker(94_000, false)
    tracker.observe({ model: 'local-qwen', contextWindow: 8192 })
    tracker.observe({ model: 'remote-glm', contextWindow: 1_000_000 })
    expect(tracker.windowFor('local-qwen')).toBe(8192)
    expect(tracker.windowFor('remote-glm')).toBe(1_000_000)
  })

  it('lets a probe narrow a per-model window but never widen it', () => {
    const tracker = new ModelContextTracker(94_000, false)
    tracker.observe({ model: 'local-qwen', contextWindow: 100_000 })
    // Probe finds the server really runs 32K: adopt(min(probed, declared)).
    tracker.adopt({ model: 'local-qwen', contextWindow: 32_768, source: 'probe' })
    expect(tracker.windowFor('local-qwen')).toBe(32_768)
    // A later (re-)declaration cannot raise the narrowed value back.
    tracker.adopt({ model: 'local-qwen', contextWindow: 100_000, source: 'request-context' })
    expect(tracker.windowFor('local-qwen')).toBe(32_768)
  })

  it('lets an EXPLICIT config override widen a window (user declared truth)', () => {
    // Regression (2026-09-05): the narrow-only rule also blocked config
    // overrides, so a user who raised a model's declared window in
    // settings.yaml after a probe had adopted a narrower value found the
    // plugin refusing to use the extra capacity.
    const tracker = new ModelContextTracker(94_000, false)
    tracker.adopt({ model: 'qwen3', contextWindow: 100_000, source: 'request-context' })
    tracker.adopt({ model: 'qwen3', contextWindow: 32_768, source: 'probe' })
    expect(tracker.windowFor('qwen3')).toBe(32_768)
    // User bumps the declared window in settings.yaml: config is authoritative
    // and may WIDEN a previously narrowed value.
    tracker.setModelWindow({ model: 'qwen3', contextWindow: 200_000, source: 'config' })
    expect(tracker.windowFor('qwen3')).toBe(200_000)
    // A probe that is WIDER than the config truth cannot widen it further.
    tracker.adopt({ model: 'qwen3', contextWindow: 250_000, source: 'probe' })
    expect(tracker.windowFor('qwen3')).toBe(200_000)
    // And a probe CAN still narrow it (real runtime is smaller).
    tracker.adopt({ model: 'qwen3', contextWindow: 64_000, source: 'probe' })
    expect(tracker.windowFor('qwen3')).toBe(64_000)
  })

  it('ignores invalid setModelWindow values', () => {
    const tracker = new ModelContextTracker(94_000, false)
    tracker.setModelWindow({ model: 'm', contextWindow: 0, source: 'config' })
    tracker.setModelWindow({ model: 'm', contextWindow: -1, source: 'config' })
    tracker.setModelWindow({ contextWindow: 100, source: 'config' })
    expect(tracker.windowFor('m')).toBeUndefined()
    expect(tracker.perModel()).toEqual([])
  })

  it('resolves the provider PER MODEL (probeModel targets the right server)', () => {
    const tracker = new ModelContextTracker(94_000, false)
    tracker.observe({ provider: 'local-llama', model: 'qwen3', contextWindow: 32_768 })
    tracker.observe({ provider: 'ark', model: 'deepseek-v4', contextWindow: 262_144 })
    expect(tracker.providerFor('qwen3')).toBe('local-llama')
    expect(tracker.providerFor('deepseek-v4')).toBe('ark')
    expect(tracker.providerFor('unknown-model')).toBeUndefined()
  })
})
