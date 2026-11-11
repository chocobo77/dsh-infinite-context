import { describe, expect, it } from 'vitest'
import {
  applySectionBudget,
  mergeSegmentNotes,
  splitRegionIntoSegments,
  type ChunkableMessage,
} from '../src/fold-chunking.ts'

const est = (m: ChunkableMessage): number => (typeof m.content === 'string' ? m.content.length / 4 : 1)

const user = (n = 100): ChunkableMessage => ({ role: 'user', source: { kind: 'user' }, content: 'x'.repeat(n) })
const toolResult = (n = 100): ChunkableMessage => ({
  role: 'user',
  source: { kind: 'tool' },
  content: 'z'.repeat(n),
})
// assistant with real tool-call blocks (hasToolCalls must see them)
const assistantWithCalls = (): ChunkableMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: {} } as never],
})

describe('splitRegionIntoSegments', () => {
  it('returns one segment when the region fits', () => {
    const messages = [user(), user()]
    expect(splitRegionIntoSegments(messages, 1000, est).length).toBe(1)
  })

  it('splits near the cap without splitting messages', () => {
    const messages = Array.from({ length: 10 }, () => user(400)) // 100 tokens each
    const segments = splitRegionIntoSegments(messages, 250, est)
    expect(segments.length).toBe(5)
    for (const segment of segments) expect(segment.length).toBe(2)
    expect(segments.flat().length).toBe(10)
  })

  it('never separates a tool call from its results', () => {
    // Sized so a plain cut WOULD straddle the call+result pair: the pair must
    // travel in the SAME segment, not merely coexist with other results.
    const messages: ChunkableMessage[] = [
      user(80), // 20 tokens
      assistantWithCalls(), toolResult(400), // call + its own 100-token result
      user(80),
    ]
    const segments = splitRegionIntoSegments(messages, 25, est)
    const withCall = segments.filter(s => s.some(m => m.role === 'assistant'))
    expect(withCall).toHaveLength(1)
    const seg = withCall[0] as ChunkableMessage[]
    expect(seg.some(m => typeof m.content === 'string' && m.content.length === 400)).toBe(true)
    // a segment never STARTS with an orphan result when the region does not
    const rest = segments.filter(s => s !== seg)
    for (const segment of rest) expect(segment[0]?.source?.kind).not.toBe('tool')
  })

  it('a region opening with an orphan result still partitions losslessly', () => {
    const messages: ChunkableMessage[] = [toolResult(80), user(80), toolResult(80)]
    const segments = splitRegionIntoSegments(messages, 25, est)
    expect(segments.flat()).toHaveLength(3)
  })

  it('a monster group over the cap becomes its own segment', () => {
    const messages: ChunkableMessage[] = [assistantWithCalls(), toolResult(5000), user(20)]
    const segments = splitRegionIntoSegments(messages, 100, est)
    expect(segments.length).toBe(2)
    expect(segments[0]?.length).toBe(2)
  })

  it('empty region yields no segments', () => {
    expect(splitRegionIntoSegments([], 100, est)).toEqual([])
  })
})

describe('mergeSegmentNotes', () => {
  it('merges matching headings in order and dedupes items', () => {
    const a = 'preamble line\n\n## Primary Request\n- do X\n## Pending Jobs\n- job 1'
    const b = '## Primary Request\n- do X\n- then Y\n## Pending Jobs\n- job 1'
    const merged = mergeSegmentNotes([a, b])
    expect(merged).toContain('preamble line')
    // first note's heading order wins
    expect(merged.indexOf('## Primary Request')).toBeLessThan(merged.indexOf('## Pending Jobs'))
    expect(merged).toContain('- then Y')
    // '- do X' appears exactly once
    expect(merged.split('- do X').length - 1).toBe(1)
  })

  it('appends headings unique to later notes at the end', () => {
    const merged = mergeSegmentNotes([
      '## A\n- a',
      '## A\n- a2\n## B\n- b',
    ])
    expect(merged.indexOf('## A')).toBeLessThan(merged.indexOf('## B'))
    expect(merged).toContain('- a2')
  })

  it('is empty-safe and makes no up', () => {
    expect(mergeSegmentNotes([])).toBe('')
    expect(mergeSegmentNotes(['', '  '])).toBe('')
    const merged = mergeSegmentNotes(['## A\n- keep'])
    expect(merged).toBe('## A\n- keep')
  })

  it('keeps LATER notes preambles too (deduped)', () => {
    const merged = mergeSegmentNotes([
      'segment one covered the setup\n## A\n- a',
      'segment two covered the tests\nsegment two covered the tests\n## A\n- b',
    ])
    expect(merged).toContain('segment one covered the setup')
    expect(merged).toContain('segment two covered the tests')
    expect(merged.split('segment two covered the tests').length - 1).toBe(1)
    // preambles precede the sections
    expect(merged.indexOf('segment two covered the tests')).toBeLessThan(merged.indexOf('## A'))
  })
})

describe('applySectionBudget', () => {
  const text = [
    '## Errors and Fixes',
    ...Array.from({ length: 40 }, (_, i) => `- error line ${i} ${'e'.repeat(30)}`),
    '',
    '## Next Step',
    '- the single next action',
  ].join('\n')

  it('clips the long section at a line boundary and keeps the rest', () => {
    const out = applySectionBudget(text, { perSectionMaxChars: 600, totalMaxChars: 5000 })
    expect(out).toContain('…[section budget reached]')
    expect(out).toContain('## Next Step')
    expect(out).toContain('- the single next action')
    // no line was halved: every kept error line is complete
    for (const line of out.split('\n')) {
      if (line.startsWith('- error line')) expect(line.endsWith('e')).toBe(true)
    }
  })

  it('drops whole trailing sections over the total cap, keeping earlier ones', () => {
    const long = [
      '## One\n- one item',
      '## Two\n- two item',
      '## Three\n- three item',
    ].join('\n\n')
    const out = applySectionBudget(long, { perSectionMaxChars: 1000, totalMaxChars: 30 })
    expect(out).toContain('## One')
    expect(out).not.toContain('## Two')
    expect(out).not.toContain('## Three')
  })

  it('passes through a bounded text unchanged', () => {
    const out = applySectionBudget('## A\n- a\n\n## B\n- b', { perSectionMaxChars: 100, totalMaxChars: 1000 })
    expect(out).toBe('## A\n- a\n\n## B\n- b')
  })

  it('respects absurd total caps instead of breaking them with markers', () => {
    const long = '## One\n' + '- item '.repeat(50)
    expect(applySectionBudget(long, { perSectionMaxChars: 1000, totalMaxChars: 0 })).toBe('')
    const tiny = applySectionBudget(long, { perSectionMaxChars: 1000, totalMaxChars: 10 })
    expect(Array.from(tiny).length).toBeLessThanOrEqual(10)
    // per-section clip at a budget below its marker: cap still holds, no marker
    const clipped = applySectionBudget('## One\n- a longish item here', { perSectionMaxChars: 5, totalMaxChars: 500 })
    expect(clipped.includes('[section budget reached]')).toBe(false)
  })

  it('never drops below the FIRST section, even with a preamble', () => {
    const out = applySectionBudget('intro\n\n## One\n- a\n\n## Two\n- b', {
      perSectionMaxChars: 1000,
      totalMaxChars: 20,
    })
    expect(out).toContain('intro')
    expect(out).toContain('## One')
    expect(out).not.toContain('## Two')
  })

  it('clips a body opening with a blank line without halving a line', () => {
    const out = applySectionBudget('## A\n\n- ' + 'q'.repeat(500), {
      perSectionMaxChars: 60,
      totalMaxChars: 1000,
    })
    expect(out).toBe('## A\n…[section budget reached]')
  })
})
