import { describe, expect, it } from 'vitest'
import { ForgettingPolicy, recencyFactor, scoreMemory } from '../src/core.ts'
import type { ForgettingConfig, MemoryDoc } from '../src/core.ts'

const CONFIG: ForgettingConfig = {
  halfLifeDays: 10,
  importanceWeight: 0.6,
  recencyWeight: 0.4,
  minScore: 0.2,
  maxMemories: 100,
}

const NOW = Date.now()

function doc(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
  return { id: 'x', tier: 'mid', text: 't', createdAt: NOW, importance: 0.5, ...overrides }
}

describe('recencyFactor', () => {
  it('halves every half-life and is 1 at age 0', () => {
    expect(recencyFactor(0, 10)).toBe(1)
    expect(recencyFactor(10 * 86_400_000, 10)).toBeCloseTo(0.5)
    expect(recencyFactor(2 * 10 * 86_400_000, 10)).toBeCloseTo(0.25)
  })

  it('ignores a non-positive half-life', () => {
    expect(recencyFactor(1_000_000, 0)).toBe(1)
    expect(recencyFactor(1_000_000, -1)).toBe(1)
  })
})

describe('scoreMemory', () => {
  it('blends importance and recency', () => {
    const fresh = doc({ createdAt: NOW - 1000, importance: 1 })
    const stale = doc({ createdAt: NOW - 100 * 86_400_000, importance: 1 })
    expect(scoreMemory(fresh, NOW, CONFIG)).toBeGreaterThan(scoreMemory(stale, NOW, CONFIG))
  })
})

describe('ForgettingPolicy', () => {
  it('drops memories below the score floor', () => {
    const policy = new ForgettingPolicy({ ...CONFIG, minScore: 0.5 })
    const keep = doc({ id: 'keep', createdAt: NOW - 1000, importance: 1 })
    const drop = doc({ id: 'drop', createdAt: NOW - 1000, importance: 0 })
    const toDrop = policy.selectToForget([keep, drop], NOW)
    expect(toDrop.map(d => d.id)).toContain('drop')
    expect(toDrop.map(d => d.id)).not.toContain('keep')
  })

  it('enforces the cap by dropping the worst-scoring extras', () => {
    const policy = new ForgettingPolicy({ ...CONFIG, maxMemories: 2 })
    const a = doc({ id: 'a', importance: 0.9 })
    const b = doc({ id: 'b', importance: 0.5 })
    const c = doc({ id: 'c', importance: 0.1 })
    const toDrop = policy.selectToForget([a, b, c], NOW)
    expect(toDrop.map(d => d.id)).toEqual(['c'])
  })

  it('keeps everything when below the cap and above the floor', () => {
    const policy = new ForgettingPolicy({ ...CONFIG, maxMemories: 100 })
    const docs = [doc({ id: 'a' }), doc({ id: 'b' })]
    expect(policy.selectToForget(docs, NOW)).toEqual([])
  })
})
