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

describe('ForgettingPolicy tie-break', () => {
  it('cap eviction drops the OLDEST memory first among tied scores', () => {
    // halfLifeDays: 0 disables decay, so equal importances tie exactly — and
    // the store lists newest-first. The cap pass must retire the OLDEST,
    // not whatever the input order happens to put first.
    const policy = new ForgettingPolicy({ ...CONFIG, halfLifeDays: 0, maxMemories: 2 })
    const oldest = doc({ id: 'old', createdAt: NOW - 3000, importance: 0.5 })
    const middle = doc({ id: 'mid', createdAt: NOW - 2000, importance: 0.5 })
    const newest = doc({ id: 'new', createdAt: NOW - 1000, importance: 0.5 })
    const toDrop = policy.selectToForget([newest, middle, oldest], NOW)
    expect(toDrop.map(d => d.id)).toEqual(['old'])
  })
})

describe('type-based lifetimes and protected tiers (2026-11 survey absorption)', () => {
  const DAY = 86_400_000
  const TYPED: ForgettingConfig = {
    halfLifeDays: 30,
    importanceWeight: 0.6,
    recencyWeight: 0.4,
    minScore: 0.25,
    maxMemories: 500,
    kindPolicies: { checkpoint: { halfLifeDays: 7, minScore: 0.45 } },
    protectedTiers: ['long'],
  }

  it('a 26-day-old checkpoint digest now falls below its floor (it scored 0.58 vs 0.25 before)', () => {
    const policy = new ForgettingPolicy(TYPED)
    const stale = doc({ id: 'cp-old', kind: 'checkpoint', importance: 0.6, createdAt: NOW - 26 * DAY })
    const fresh = doc({ id: 'cp-new', kind: 'checkpoint', importance: 0.6, createdAt: NOW - 2 * DAY })
    const dropped = policy.selectToForget([stale, fresh], NOW).map(d => d.id)
    expect(dropped).toContain('cp-old')
    expect(dropped).not.toContain('cp-new')
  })

  it('unlisted kinds keep the long default lifetime', () => {
    const policy = new ForgettingPolicy(TYPED)
    const project = doc({ id: 'p', kind: 'project', importance: 0.6, createdAt: NOW - 26 * DAY })
    expect(policy.selectToForget([project], NOW)).toEqual([])
  })

  it('never selects a protected tier — not by floor, not by cap', () => {
    const tight: ForgettingConfig = { ...TYPED, minScore: 0.99, maxMemories: 1 }
    const policy = new ForgettingPolicy(tight)
    const longDoc = doc({ id: 'core', tier: 'long', importance: 0, createdAt: NOW - 400 * DAY })
    const midDoc = doc({ id: 'm', tier: 'mid', importance: 0, createdAt: NOW - 400 * DAY })
    const dropped = policy.selectToForget([longDoc, midDoc], NOW).map(d => d.id)
    expect(dropped).not.toContain('core')
    expect(dropped).toContain('m')
  })
})
