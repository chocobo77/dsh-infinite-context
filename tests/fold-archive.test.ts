/**
 * Folded-range archive (reverse compaction): header rendering and policy
 * resolution. The store round-trip lives in memory-store.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_FOLD_OPTIONS, foldedRangeHeader } from '../src/fold-archive.ts'
import { FOLDED_REF_PREFIX } from '../src/memory-store.ts'
import { resolveFoldOptions } from '../src/config.ts'

type RawConfig = Parameters<typeof resolveFoldOptions>[0]

describe('foldedRangeHeader', () => {
  it('names the ref and the archived size when the range was archived', () => {
    const header = foldedRangeHeader(12, 4321, 'fl_ab12cd34ef56')
    expect(header).toContain('12 earlier messages')
    expect(header).toContain('4321 chars')
    expect(header).toContain('memory_expand ref=fl_ab12cd34ef56')
  })

  it('degrades to the plain wording when archiving did not happen', () => {
    const plain = '[Compressed history — 3 earlier messages, details preserved below]'
    expect(foldedRangeHeader(3, 900, null)).toBe(plain)
    expect(foldedRangeHeader(3, 900, '   ')).toBe(plain)
  })

  it('clamps nonsense input and ignores oversized refs', () => {
    expect(foldedRangeHeader(Number.NaN, Number.POSITIVE_INFINITY, 'fl_x')).toContain('0 earlier messages')
    expect(foldedRangeHeader(-4, -9, 'x'.repeat(65)))
      .toBe('[Compressed history — 0 earlier messages, details preserved below]')
  })

  it('promises a ref shape memory_expand can resolve', () => {
    // The header promises reversibility; the promised ref must keep the fl_
    // prefix the store mints (memory-store.ts newFoldedRef) so the read-back
    // resolves and the expand_restore telemetry can attribute it to the fold
    // lane rather than the tool-result lane.
    const header = foldedRangeHeader(3, 900, 'fl_ab12cd34ef56')
    const ref = header.match(/ref=(fl_[0-9a-f]+)/)?.[1]
    expect(ref).toBe('fl_ab12cd34ef56')
    expect(ref?.startsWith(FOLDED_REF_PREFIX)).toBe(true)
  })
})

describe('resolveFoldOptions', () => {
  it('defaults to on, one month, a few hundred ranges', () => {
    expect(resolveFoldOptions({} as RawConfig)).toEqual(DEFAULT_FOLD_OPTIONS)
  })

  it('honours explicit values', () => {
    const raw = {
      fold_ranges: false,
      fold_range_retention_days: 0,
      fold_range_max_entries: 5,
    } as RawConfig
    expect(resolveFoldOptions(raw)).toEqual({ enabled: false, retentionDays: 0, maxEntries: 5 })
  })
})
