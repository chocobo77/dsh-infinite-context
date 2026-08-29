import { describe, expect, it } from 'vitest'
import {
  LightweightEmbedder,
  cosineSimilarity,
  createEmbedder,
  fnv1a,
  normalize,
  tokenize,
} from '../src/core.ts'

describe('tokenize', () => {
  it('splits ASCII words and individual Han characters', () => {
    expect(tokenize('Hello world')).toEqual(['hello', 'world'])
    expect(tokenize('Hello World, 你好世界')).toEqual(['hello', 'world', '你', '好', '世', '界'])
  })
})

describe('fnv1a', () => {
  it('is deterministic and differs across distinct tokens', () => {
    const a = fnv1a('alpha')
    const b = fnv1a('beta')
    expect(a).toBe(fnv1a('alpha'))
    expect(a).not.toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(0x1_0000_0000)
  })
})

describe('normalize', () => {
  it('L2-normalizes a non-zero vector', () => {
    const v = normalize([3, 4])
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1)
  })

  it('leaves a zero vector as-is', () => {
    const z = normalize([0, 0])
    expect(z).toEqual([0, 0])
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('returns 0 when lengths differ', () => {
    expect(cosineSimilarity([1], [1, 0])).toBe(0)
  })
})

describe('LightweightEmbedder', () => {
  it('produces a fixed-dimension normalized vector deterministically', async () => {
    const e = new LightweightEmbedder(64)
    const a = await e.embed('setup sqlite schema and index')
    const b = await e.embed('setup sqlite schema and index')
    expect(a).toHaveLength(64)
    expect(a).toEqual(b)
    const norm = Math.hypot(...a)
    expect(norm).toBeCloseTo(1)
  })

  it('gives lexically-similar texts a higher cosine than dissimilar ones', async () => {
    const e = new LightweightEmbedder(256)
    const q = await e.embed('how to configure the token budget')
    const related = await e.embed('configure token budget thresholds')
    const unrelated = await e.embed('deploy the web server over https')
    expect(cosineSimilarity(q, related)).toBeGreaterThan(cosineSimilarity(q, unrelated))
  })

  it('rejects a too-small dimension', () => {
    expect(() => new LightweightEmbedder(4)).toThrow(RangeError)
  })

  it('supports CJK text', async () => {
    const e = new LightweightEmbedder(256)
    const v = await e.embed('配置 token 预算和记忆管理')
    expect(v.some(x => x !== 0)).toBe(true)
  })
})

describe('createEmbedder', () => {
  it('builds a lightweight embedder by default', async () => {
    const e = await createEmbedder({ kind: 'lightweight', dimension: 128 })
    expect(e.name).toContain('lightweight')
    expect(e.dimension).toBe(128)
  })

  it('rejects an unknown kind', async () => {
    await expect(createEmbedder({ kind: 'bogus' as never, dimension: 128 })).rejects.toThrow()
  })
})
