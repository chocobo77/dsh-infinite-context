import { describe, expect, it } from 'vitest'
import {
  ForgettingPolicy,
  LightweightEmbedder,
  MemoryEngine,
  MemoryStore,
  TokenBudget,
  VectorIndex,
} from '../src/core.ts'
import type { MemoryConfig } from '../src/core.ts'

const CONFIG: MemoryConfig = {
  embedder: { kind: 'lightweight', dimension: 64 },
  budget: { short: 10_000, mid: 20_000, long: 5_000, retrieved: 15_000 },
  forgetting: { halfLifeDays: 10, importanceWeight: 0.6, recencyWeight: 0.4, minScore: 0.15, maxMemories: 100 },
  pyramid: { mergeThreshold: 3, mergeBatch: 3, maxLong: 5 },
  retrievalMinScore: 0.1,
  retrievalTopK: 3,
}

function buildEngine() {
  const store = new MemoryStore(':memory:')
  const embedder = new LightweightEmbedder(64)
  const engine = new MemoryEngine({
    store,
    embedder,
    index: new VectorIndex(),
    budget: new TokenBudget(CONFIG.budget, 94_000),
    forgetting: new ForgettingPolicy(CONFIG.forgetting),
    config: CONFIG,
    summarize: texts => Promise.resolve(`CONSOLIDATED:\n${texts.join('\n---\n')}`),
    now: () => 1000,
  })
  return { store, engine }
}

describe('MemoryEngine', () => {
  it('stores and retrieves the most relevant memory', async () => {
    const { engine } = buildEngine()
    await engine.storeMemory('configure the token budget for the context window', 'mid')
    await engine.storeMemory('deploy the web server over https', 'mid')
    const hits = await engine.retrieve('how do I tune the token budget?')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].doc.text).toContain('token budget')
  })

  it('consolidates enough mid memories into one long memory', async () => {
    const { store, engine } = buildEngine()
    await engine.storeMemory('fact one about persistence', 'mid')
    await engine.storeMemory('fact two about embeddings', 'mid')
    expect(store.count('long')).toBe(0)
    await engine.storeMemory('fact three about retrieval', 'mid')
    const result = await engine.consolidate()
    expect(result).not.toBeNull()
    expect(store.count('mid')).toBe(0)
    expect(store.count('long')).toBe(1)
    const longDoc = store.list('long')[0]!
    expect(longDoc.text).toContain('CONSOLIDATED')
    expect(longDoc.mergedFrom).toHaveLength(3)
  })

  it('does not consolidate below the merge threshold', async () => {
    const { store, engine } = buildEngine()
    await engine.storeMemory('only one', 'mid')
    const result = await engine.consolidate()
    expect(result).toBeNull()
    expect(store.count('mid')).toBe(1)
  })

  it('forgets low-value stale memories', async () => {
    const { store, engine } = buildEngine()
    await engine.storeMemory('stale unimportant detail', 'mid', { importance: 0 })
    const reference = Date.now() + 200 * 86_400_000 // far in the future
    const result = await engine.forget(reference)
    expect(result.dropped.length).toBeGreaterThan(0)
    expect(store.count()).toBe(0)
  })

  it('reports a status snapshot and resets', async () => {
    const { store, engine } = buildEngine()
    await engine.storeMemory('one', 'mid')
    await engine.storeMemory('two', 'long', { importance: 0.9 })
    const status = engine.status()
    expect(status.total).toBe(2)
    expect(status.byTier.mid).toBe(1)
    expect(status.byTier.long).toBe(1)
    engine.reset()
    expect(store.count()).toBe(0)
  })

  it('classifies memories by kind and reports byKind in status', async () => {
    const { engine } = buildEngine()
    await engine.storeMemory('user prefers concise replies', 'short', { kind: 'user', importance: 0.3 })
    await engine.storeMemory('never use the force parameter', 'short', { kind: 'feedback', importance: 0.3 })
    await engine.storeMemory('deployed v2 to prod', 'mid', { kind: 'project', importance: 0.6 })
    await engine.storeMemory('sqlite path is C:/data.db', 'short', { kind: 'reference', importance: 0.3 })
    const status = engine.status()
    expect(status.byKind?.project).toBe(1)
    expect(status.byKind?.reference).toBe(1)
    expect(status.byKind?.feedback).toBe(1)
    expect(status.byKind?.user).toBe(1)
  })

  it('generates a structured MEMORY.md-style index grouped by kind', async () => {
    const { engine } = buildEngine()
    await engine.storeMemory('project decision: use sqlite for persistence', 'mid', { kind: 'project', importance: 0.6 })
    await engine.storeMemory('project decision: keep threshold ratio at 0.8', 'mid', { kind: 'project', importance: 0.6 })
    await engine.storeMemory('reference: restart command is pnpm dev', 'short', { kind: 'reference', importance: 0.3 })
    await engine.storeMemory('legacy unclassified row', 'long', { importance: 0.7 })
    const index = engine.generateIndex(5)
    expect(index).toContain('# Memory index (4 memories')
    expect(index).toContain('## project (2)')
    expect(index).toContain('## reference (1)')
    expect(index).toContain('## unclassified (1)')
    expect(index).toContain('project decision: use sqlite')
  })

  it('audits duplicates, conflicts, and stale entries', async () => {
    const { store, engine } = buildEngine()
    await engine.storeMemory('the api key is read from env var API_KEY at startup', 'mid', { kind: 'reference', importance: 0.6 })
    await engine.storeMemory('the api key is read from env var API_KEY at startup', 'mid', { kind: 'reference', importance: 0.6 })
    await engine.storeMemory('deployment target cluster is the staging environment for testing', 'mid', { kind: 'project', importance: 0.6 })
    await engine.storeMemory('deployment target cluster is the production environment for testing', 'mid', { kind: 'project', importance: 0.6 })
    // Stale entry: 200 days old, low importance. Stored directly so we control createdAt.
    const oldTs = Date.now() - 200 * 86_400_000
    store.insert({
      id: 'stale-entry',
      tier: 'short',
      text: 'stale low-value detail',
      createdAt: oldTs,
      importance: 0.1,
    })
    const report = engine.maintain(Date.now())
    expect(report.duplicates.length).toBeGreaterThanOrEqual(1)
    expect(report.conflicts.length).toBeGreaterThanOrEqual(1)
    expect(report.stale.length).toBeGreaterThanOrEqual(1)
  })
})
