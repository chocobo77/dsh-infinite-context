import { describe, expect, it } from 'vitest'
import { LightweightEmbedder, VectorIndex, cosineSimilarity } from '../src/core.ts'

async function indexWith(texts: string[], embedder: LightweightEmbedder): Promise<VectorIndex> {
  const index = new VectorIndex()
  for (let i = 0; i < texts.length; i++) {
    index.add(`m${i}`, await embedder.embed(texts[i]))
  }
  return index
}

describe('VectorIndex', () => {
  it('returns top-K hits sorted by descending score', async () => {
    const e = new LightweightEmbedder(256)
    const index = await indexWith([
      'set up the sqlite store for memory',
      'configure the llm context window',
      'deploy the web server over https',
      'tune the token budget thresholds',
    ], e)
    const q = await e.embed('how do I configure the token budget?')
    const hits = index.search(q, 3)
    expect(hits).toHaveLength(3)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    }
    // The closest doc should be the token-budget one.
    expect(hits[0].id).toBe('m3')
  })

  it('filters by a minimum score', async () => {
    const e = new LightweightEmbedder(256)
    const index = await indexWith(['apples and pears', 'bananas and mangoes'], e)
    const q = await e.embed('apples')
    const lenient = index.search(q, 5, -Infinity)
    expect(lenient.length).toBe(2)
    // A threshold equal to the best hit's score keeps exactly the top hit.
    const strict = index.search(q, 5, lenient[0].score)
    expect(strict.length).toBe(1)
    expect(strict[0].id).toBe(lenient[0].id)
  })

  it('supports remove, has, clear, and size', async () => {
    const e = new LightweightEmbedder(64)
    const index = await indexWith(['one', 'two'], e)
    expect(index.size).toBe(2)
    expect(index.has('m0')).toBe(true)
    index.remove('m0')
    expect(index.has('m0')).toBe(false)
    expect(index.size).toBe(1)
    index.clear()
    expect(index.size).toBe(0)
  })

  it('returns [] when k is non-positive or the index is empty', () => {
    const index = new VectorIndex()
    expect(index.search([1, 0], 3)).toEqual([])
    expect(index.search([1, 0], 0)).toEqual([])
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
  })
})
