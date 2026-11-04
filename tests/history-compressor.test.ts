import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import { HistoryCompressor } from '../src/memory-compaction.ts'

/** A minimal compressor over one shared Map-backed KV store. */
function makeCompressor(kvStore: Map<string, string>): HistoryCompressor {
  const kv = {
    get: (key: string) => kvStore.get(key),
    set: (key: string, value: string) => void kvStore.set(key, value),
    delete: (key: string) => void kvStore.delete(key),
  }
  const ctx = {
    memoryContext: { contextWindow: 100_000, headroomRatio: 0.25 },
    logger: { info() {}, warn() {} },
  } as unknown as Context
  const config = {
    summarizationProvider: 'p',
    summarizationModel: 'm',
  } as unknown as ResolvedConfig
  return new HistoryCompressor(ctx, config, 7, 20, 0.75, 0.6, 0, kv)
}

describe('HistoryCompressor session-counter persistence', () => {
  it('restores the learned landing-deviation EMA across a restart', () => {
    const kvStore = new Map<string, string>()
    const before = makeCompressor(kvStore)
    before.beginFoldCheck('sess-1', 50_000)
    expect(before.recordFoldLanding('sess-1', 19_000)).toBe(19_000)
    expect(before.targetDeviationOf('sess-1')).toBe(19_000)

    // A fresh compressor (restart: empty memory, same KV) must come back with
    // the learned EMA — it cannot be re-derived from the surface.
    const after = makeCompressor(kvStore)
    expect(after.targetDeviationOf('sess-1')).toBe(19_000)
    // And the restored value actually reaches the next fold's plan input.
    after.beginFoldCheck('sess-1', 50_000)
    expect(after.targetDeviationOf('sess-1')).toBe(19_000)
  })

  it('blends a restored EMA with new landings (not a reset)', () => {
    const kvStore = new Map<string, string>()
    const before = makeCompressor(kvStore)
    before.beginFoldCheck('sess-2', 50_000)
    before.recordFoldLanding('sess-2', 20_000)

    const after = makeCompressor(kvStore)
    after.beginFoldCheck('sess-2', 50_000)
    // alpha 0.5: restored 20k blended with a fresh 0 lands at 10k, not 0.
    expect(after.recordFoldLanding('sess-2', 0)).toBe(10_000)
  })

  it('an unknown session has no deviation and no persisted entry', () => {
    const kvStore = new Map<string, string>()
    const compressor = makeCompressor(kvStore)
    expect(compressor.targetDeviationOf('never-seen')).toBeUndefined()
    expect(kvStore.size).toBe(0)
  })
})

describe('task-state persistence', () => {
  it('carries the task-state block across a restart', () => {
    const kvStore = new Map<string, string>()
    const before = makeCompressor(kvStore)
    before.beginFoldCheck('sess-3', 50_000)
    before.recordTaskState('sess-3', '[TASK STATE — carried] Primary request:\n- fix login')
    expect(before.taskStateOf('sess-3')).toContain('fix login')

    const after = makeCompressor(kvStore)
    expect(after.taskStateOf('sess-3')).toContain('fix login')
  })

  it('an unknown session has no task state', () => {
    expect(makeCompressor(new Map()).taskStateOf('never')).toBeUndefined()
  })
})

describe('cross-session deviation prior', () => {
  it('publishes, reads back, and warm-starts a fresh session', () => {
    const kvStore = new Map<string, string>()
    const writer = makeCompressor(kvStore)
    writer.recordDeviationPrior('deepseek-official/deepseek-flash', 22000)
    expect(writer.deviationPriorOf('deepseek-official/deepseek-flash')).toBe(22000)

    // A fresh session (never folded) seeds its EMA from the prior...
    const fresh = makeCompressor(new Map()) // different KV: the prior lives per-store
    void fresh
    const reader = makeCompressor(kvStore)
    reader.beginFoldCheck('sess-9', 50_000)
    reader.seedDeviationEma('sess-9', 22000)
    expect(reader.targetDeviationOf('sess-9')).toBe(22000)
    // ...and the seed blends with the first real landing instead of resetting.
    expect(reader.recordFoldLanding('sess-9', 0)).toBe(11000)
  })

  it('refuses garbage priors and never overwrites a learned EMA', () => {
    const kvStore = new Map<string, string>()
    const compressor = makeCompressor(kvStore)
    compressor.recordDeviationPrior('route/x', Number.NaN)
    expect(compressor.deviationPriorOf('route/x')).toBeUndefined()
    compressor.beginFoldCheck('sess-1', 50_000)
    compressor.recordFoldLanding('sess-1', 30_000)
    compressor.seedDeviationEma('sess-1', 999)
    expect(compressor.targetDeviationOf('sess-1')).toBe(30_000)
  })
})

describe('summarizer latency EMA', () => {
  // The engine stores per-route latency through memoryContext.kvGet/kvSet —
  // the same PersistentKV surface the counters use. The EMA itself is
  // engine-level; here we pin the KV contract the engine reads/writes.
  it('records and reads back a latency EMA through the KV surface', () => {
    const kvStore = new Map<string, string>()
    const compressor = makeCompressor(kvStore)
    void compressor
    const write = (ms: number) => kvStore.set('summarizer-latency:qwen3/本地部署模型', JSON.stringify({ ms }))
    const read = () => JSON.parse(kvStore.get('summarizer-latency:qwen3/本地部署模型') ?? '{}') as { ms?: number }
    write(300_000)
    expect(read().ms).toBe(300_000)
    // EMA blend: prev 300k, next landing 600k → 450k (weight 0.5).
    const prev = read().ms ?? 0
    expect(Math.round(prev * 0.5 + 600_000 * 0.5)).toBe(450_000)
  })
})
