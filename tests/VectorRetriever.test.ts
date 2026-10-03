import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  VectorRetriever,
  buildSurfaceBlob,
  chunkText,
  isMemoryOnSurface,
  normalizeSurfaceText,
  surfaceSegments,
  type VectorRetrieverConfig,
} from '../src/VectorRetriever.ts'
import type { RetrievalHit } from '../src/types.ts'

interface MemoryContextSpies {
  hasText: ReturnType<typeof vi.fn>
  hasTextNormalized: ReturnType<typeof vi.fn>
  retrieve: ReturnType<typeof vi.fn>
  storeMemory: ReturnType<typeof vi.fn>
}

/** Build a minimal Context stand-in exposing only what VectorRetriever uses. */
function makeCtx(overrides: Partial<{
  hasText: (text: string) => boolean
  hasTextNormalized: (text: string) => boolean
  retrieve: (query: string, k?: number, minScore?: number) => Promise<RetrievalHit[]>
  storeMemory: (text: string, tier: string, opts?: { importance?: number; kind?: string }) => Promise<unknown>
}> = {}): { ctx: Context; spies: MemoryContextSpies; logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } } {
  const spies: MemoryContextSpies = {
    hasText: vi.fn(overrides.hasText ?? (() => false)),
    hasTextNormalized: vi.fn(overrides.hasTextNormalized ?? (() => false)),
    retrieve: vi.fn(overrides.retrieve ?? (async () => [])),
    storeMemory: vi.fn(overrides.storeMemory ?? (async (text: string) => ({ id: 'id', text }))),
  }
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const ctx = { logger, memoryContext: spies } as unknown as Context
  return { ctx, spies, logger }
}

function makeConfig(overrides: Partial<VectorRetrieverConfig> = {}): VectorRetrieverConfig {
  return {
    topK: 3,
    minScore: 0.2,
    tokenBudget: 3000,
    chunkSize: 500,
    dedupeExact: true,
    dedupeMinScore: 0.92,
    ingestDenylist: ['memory_status'],
    ingestImportance: 0.3,
    ...overrides,
  }
}

function hit(id: string, text: string, score = 0.5): RetrievalHit {
  return {
    doc: { id, tier: 'short', text, createdAt: Date.now(), importance: 0.3 },
    score,
  }
}

describe('ingest source filtering', () => {
  it('skips denylisted sources entirely', async () => {
    const { ctx, spies } = makeCtx()
    const retriever = new VectorRetriever(ctx, makeConfig())
    await retriever.ingest('some result', 'memory_status')
    expect(spies.storeMemory).not.toHaveBeenCalled()
  })

  it('allowlist (when non-empty) is authoritative', async () => {
    const { ctx, spies } = makeCtx()
    const retriever = new VectorRetriever(ctx, makeConfig({ ingestDenylist: [], ingestAllowlist: ['web_search'] }))
    await retriever.ingest('allowed', 'web_search')
    await retriever.ingest('blocked', 'bash')
    expect(spies.storeMemory).toHaveBeenCalledTimes(1)
    expect(String(spies.storeMemory.mock.calls[0]?.[0])).toContain('allowed')
  })
})

describe('ingest dedup layers', () => {
  it('skips exact duplicates', async () => {
    const { ctx, spies } = makeCtx({ hasText: (text) => text.includes('already stored') })
    const retriever = new VectorRetriever(ctx, makeConfig())
    await retriever.ingest('already stored value', 'bash')
    expect(spies.hasText).toHaveBeenCalled()
    expect(spies.storeMemory).not.toHaveBeenCalled()
  })

  it('skips fuzzy duplicates (identical up to long digit runs/case)', async () => {
    const { ctx, spies } = makeCtx({
      hasTextNormalized: (text) => text.includes('ran at'),
    })
    const retriever = new VectorRetriever(ctx, makeConfig())
    await retriever.ingest('cmd ran at 20240903114205', 'bash')
    expect(spies.storeMemory).not.toHaveBeenCalled()
  })

  it('skips semantic near-duplicates (nearest memory >= dedupeMinScore)', async () => {
    const { ctx, spies } = makeCtx({
      retrieve: async () => [hit('existing', 'near identical memory', 0.95)],
    })
    const retriever = new VectorRetriever(ctx, makeConfig())
    await retriever.ingest('slightly different memory', 'bash')
    expect(spies.retrieve).toHaveBeenCalledWith(expect.any(String), 1, 0.92)
    expect(spies.storeMemory).not.toHaveBeenCalled()
  })

  it('stores fresh chunks with provenance prefix, importance, and reference kind', async () => {
    const { ctx, spies } = makeCtx()
    const retriever = new VectorRetriever(ctx, makeConfig())
    await retriever.ingest('a fresh tool result', 'web_search')
    expect(spies.storeMemory).toHaveBeenCalledTimes(1)
    const [text, tier, opts] = spies.storeMemory.mock.calls[0] as [string, string, { importance: number; kind: string }]
    expect(text.startsWith('[source: web_search]\n')).toBe(true)
    expect(text.endsWith('a fresh tool result')).toBe(true)
    expect(tier).toBe('short')
    expect(opts.importance).toBe(0.3)
    expect(opts.kind).toBe('reference')
  })

  it('chunks long text at chunkSize and stores each chunk', async () => {
    const { ctx, spies } = makeCtx()
    const retriever = new VectorRetriever(ctx, makeConfig({ chunkSize: 100 }))
    await retriever.ingest('x'.repeat(250), 'bash')
    expect(spies.storeMemory).toHaveBeenCalledTimes(3)
  })
})

describe('retrieve', () => {
  it('returns a retrieved_context message with tier/age/score headers and hit ids', async () => {
    const { ctx } = makeCtx({ retrieve: async () => [hit('a', 'memory A'), hit('b', 'memory B', 0.7)] })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query')
    expect(out).not.toBeNull()
    const text = out!.message.content.find(block => block.type === 'text')
    expect(text && 'text' in text ? text.text : '').toContain('<retrieved_context>')
    expect(text && 'text' in text ? text.text : '').toContain('historical background ONLY')
    expect(text && 'text' in text ? text.text : '').toContain('memory A')
    expect(out!.ids).toEqual(['a', 'b'])
    expect(out!.hitCount).toBe(2)
  })

  it('excludes memories injected in the previous turn', async () => {
    const { ctx } = makeCtx({ retrieve: async () => [hit('a', 'memory A'), hit('b', 'memory B')] })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query', new Set(['a']))
    expect(out!.ids).toEqual(['b'])
  })

  it('returns null when every hit was already injected (cross-turn dedup)', async () => {
    const { ctx } = makeCtx({ retrieve: async () => [hit('a', 'memory A')] })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query', new Set(['a']))
    expect(out).toBeNull()
  })

  it('strict budget: oversized memories are skipped, not force-injected', async () => {
    const { ctx } = makeCtx({
      retrieve: async () => [hit('big', 'A'.repeat(400)), hit('small', 'B'.repeat(40))],
    })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query', undefined, 50)
    expect(out).not.toBeNull()
    const text = out!.message.content.find(block => block.type === 'text')
    const body = text && 'text' in text ? text.text : ''
    expect(body).toContain('B'.repeat(40))
    expect(body).not.toContain('A'.repeat(400))
    expect(out!.ids).toEqual(['small'])
  })

  it('strict budget: null when nothing fits', async () => {
    const { ctx } = makeCtx({ retrieve: async () => [hit('big', 'A'.repeat(400))] })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query', undefined, 10)
    expect(out).toBeNull()
  })

  it('falls back to null on retrieval failure (error-isolated)', async () => {
    const { ctx, logger } = makeCtx({ retrieve: async () => { throw new Error('embedder down') } })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query')
    expect(out).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('surface-aware dedup helpers', () => {
  it('chunkText terminates for a non-positive or non-finite size', () => {
    // A width of 0 used to spin forever: the hard-cut branch pushed the same
    // (empty) head and sliced zero characters off `remaining`.
    expect(chunkText('abc', 0)).toEqual(['a', 'b', 'c'])
    expect(chunkText('abc', Number.NaN)).toEqual(['a', 'b', 'c'])
    expect(chunkText('one. two. three.', 6)).toEqual(['one.', 'two.', 'three.'])
  })

  it('normalizes case and collapses whitespace runs', () => {
    expect(normalizeSurfaceText('  Hello\n\tWorld  ')).toBe('hello world')
  })

  it('strips the injection-time tier header before splitting', () => {
    const segments = surfaceSegments('[tier=short, 3m ago, score=0.461]\nsome longer memory body text')
    expect(segments).toEqual(['some longer memory body text'])
  })

  it('strips the ingest-time source header too', () => {
    // `[source: …]` is written by ingest and never appears on the surface; left
    // in, it counts as a 20-char segment and pushes a short memory below the
    // 70% match ratio, re-injecting content that is still visible.
    expect(surfaceSegments('[source: web_search]\nthe quick brown fox jumps'))
      .toEqual(['the quick brown fox jumps'])
    const blob = buildSurfaceBlob(['the quick brown fox jumps'])
    expect(isMemoryOnSurface('[source: web_search]\nthe quick brown fox jumps', blob!)).toBe(true)
  })

  it('drops segments shorter than the minimum match length', () => {
    expect(surfaceSegments('memory A')).toEqual([])
  })

  it('matches on a 70% segment overlap and rejects a single shared segment', () => {
    const memory = [
      'first segment of the stored memory',
      'second segment of the stored memory',
      'third segment of the stored memory',
      'fourth segment that is absent here',
    ].join('\n')
    const threeOfFour = buildSurfaceBlob([
      'first segment of the stored memory',
      'second segment of the stored memory',
      'third segment of the stored memory',
    ])
    const oneOfFour = buildSurfaceBlob(['first segment of the stored memory'])
    expect(threeOfFour).toBeDefined()
    expect(isMemoryOnSurface(memory, threeOfFour!)).toBe(true)
    expect(isMemoryOnSurface(memory, oneOfFour!)).toBe(false)
  })

  it('never matches ACROSS a message boundary (NUL separator)', () => {
    // Each half lives in a different message; joining them must not create a
    // matchable segment.
    const blob = buildSurfaceBlob(['alpha beta gamma delta', 'epsilon zeta eta theta'])
    expect(blob).toBeDefined()
    expect(isMemoryOnSurface('alpha beta gamma delta epsilon zeta eta theta', blob!)).toBe(false)
  })

  it('buildSurfaceBlob returns undefined for an empty surface', () => {
    expect(buildSurfaceBlob([])).toBeUndefined()
    expect(buildSurfaceBlob(['   '])).toBeUndefined()
  })
})

describe('retrieve surface dedup', () => {
  const onSurface = 'the retriever injected three short tier memories verbatim'

  it('skips a memory whose text is already on the active surface', async () => {
    const { ctx, logger } = makeCtx({
      retrieve: async () => [hit('dup', onSurface), hit('fresh', 'an unrelated memory body about deployment')],
    })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query', undefined, undefined, [
      'a tool result the model can already read',
      `  The Retriever  Injected Three Short Tier Memories Verbatim\n`,
    ])
    expect(out).not.toBeNull()
    expect(out!.ids).toEqual(['fresh'])
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('surface dedup: skipped 1/2'))
  })

  it('returns null when every fresh hit is already visible', async () => {
    const { ctx } = makeCtx({ retrieve: async () => [hit('dup', onSurface)] })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query', undefined, undefined, [onSurface])
    expect(out).toBeNull()
  })

  it('keeps a memory whose content has left the surface', async () => {
    const { ctx } = makeCtx({ retrieve: async () => [hit('dup', onSurface)] })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query', undefined, undefined, ['unrelated compressed summary text'])
    expect(out!.ids).toEqual(['dup'])
  })

  it('is disabled by dedupeSurface: false', async () => {
    const { ctx } = makeCtx({ retrieve: async () => [hit('dup', onSurface)] })
    const retriever = new VectorRetriever(ctx, makeConfig({ dedupeSurface: false }))
    const out = await retriever.retrieve('query', undefined, undefined, [onSurface])
    expect(out!.ids).toEqual(['dup'])
  })

  it('does nothing when no surface is supplied (back-compat)', async () => {
    const { ctx } = makeCtx({ retrieve: async () => [hit('dup', onSurface)] })
    const retriever = new VectorRetriever(ctx, makeConfig())
    const out = await retriever.retrieve('query')
    expect(out!.ids).toEqual(['dup'])
  })

  it('surface suppression does not touch cross-turn exclusion semantics', async () => {
    const { ctx } = makeCtx({ retrieve: async () => [hit('a', onSurface), hit('b', 'another distinct memory body here')] })
    const retriever = new VectorRetriever(ctx, makeConfig())
    // 'a' is excluded by id AND suppressed by the surface; only 'b' is injected.
    const out = await retriever.retrieve('query', new Set(['a']), undefined, [onSurface])
    expect(out!.ids).toEqual(['b'])
  })
})
