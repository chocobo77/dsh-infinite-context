import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { FoldedRangeRecord, ToolResultRecord } from '../src/memory-store.ts'
import { archiveRef } from '../src/tool-archive.ts'
import { FOLDED_REF_PREFIX } from '../src/memory-store.ts'
import {
  apply,
  countMatches,
  EXPAND_PAGE_CODE_POINTS,
  expandTruncationNotice,
  matchWindows,
} from '../src/tools.ts'

describe('matchWindows', () => {
  it('returns a padded window containing the match', () => {
    const text = 'x'.repeat(300) + 'NEEDLE' + 'y'.repeat(300)
    const windows = matchWindows(text, 'needle', 5)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toContain('NEEDLE')
    expect(windows[0]!.length).toBeLessThan(text.length)
  })

  it('stays aligned when astral characters precede the match', () => {
    // 300 emoji are 300 code points but 600 UTF-16 units: the match offset must
    // be converted before slicing the code-point array, or the window starts
    // past the match and shows the wrong text (and drifts the scan).
    const text = '\u{1F600}'.repeat(300) + 'TARGET' + 'z'.repeat(50)
    const windows = matchWindows(text, 'target', 1)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toContain('TARGET')
  })

  it('finds every occurrence up to the cap', () => {
    const text = 'alpha one beta alpha two gamma alpha three'
    expect(matchWindows(text, 'alpha', 2)).toHaveLength(2)
    expect(matchWindows(text, 'alpha', 20)).toHaveLength(3)
  })

  it('returns no windows when nothing matches', () => {
    expect(matchWindows('alpha', 'omega', 3)).toEqual([])
  })
})

describe('countMatches', () => {
  it('counts every occurrence, case-insensitively', () => {
    expect(countMatches('a A aA', 'a')).toBe(4)
    expect(countMatches('alpha one beta alpha', 'alpha')).toBe(2)
  })

  it('does not double-count overlapping needles and rejects empty ones', () => {
    expect(countMatches('aaaa', 'aa')).toBe(2)
    expect(countMatches('text', '')).toBe(0)
  })

  it('agrees with matchWindows under the window cap', () => {
    const text = 'alpha one beta alpha two gamma alpha three'
    expect(countMatches(text, 'alpha')).toBe(matchWindows(text, 'alpha', 20).length)
    expect(countMatches(text, 'alpha')).toBeGreaterThan(matchWindows(text, 'alpha', 2).length)
  })
})

describe('expandTruncationNotice', () => {
  const TRUNCATED = expandTruncationNotice({
    ref: 'tr_ab12cd34ef56',
    totalPoints: 7473,
    offset: 0,
    returnedPoints: 4000,
  })

  it('self-describes a limit-truncated read: sizes plus the exact next call', () => {
    // The production failure mode: the model could not tell how much of the
    // archive it had seen, so it abandoned the read. The banner names all of it.
    expect(TRUNCATED).toContain('TRUNCATED READ')
    expect(TRUNCATED).toContain('full text is 7473 code points')
    expect(TRUNCATED).toContain('this response returns 4000 (offset 0\u20134000)')
    expect(TRUNCATED).toContain('{"ref":"tr_ab12cd34ef56","offset":4000}')
  })

  it('names the caller as the truncator when the tool itself returned everything', () => {
    const notice = expandTruncationNotice({
      ref: 'tr_ab12cd34ef56',
      totalPoints: 7473,
      offset: 0,
      returnedPoints: 7473,
    })
    expect(notice).toContain('offset 0\u20137473 of 7473 code points')
    expect(notice).toContain('CALLER truncated it')
    // The recovery call pages from the top in default-page pieces.
    expect(notice).toContain('{"ref":"tr_ab12cd34ef56","offset":0,"limit":' + EXPAND_PAGE_CODE_POINTS + '}')
  })

  it('stays silent for complete reads that fit one default page', () => {
    expect(expandTruncationNotice({ ref: 'tr_x', totalPoints: 3000, offset: 0, returnedPoints: 3000 })).toBeNull()
    expect(expandTruncationNotice({ ref: 'fl_x', totalPoints: 7473, offset: 4000, returnedPoints: 3473 })).toBeNull()
  })

  it('banners a mid-archive page even when it completes a small remainder', () => {
    const notice = expandTruncationNotice({
      ref: 'fl_ab12cd34ef56',
      totalPoints: 9000,
      offset: 4000,
      returnedPoints: 2000,
    })
    expect(notice).toContain('TRUNCATED READ')
    expect(notice).toContain('{"ref":"fl_ab12cd34ef56","offset":6000}')
  })
})

/** One expand-restore ledger event captured from the fake memory context. */
interface RecordedExpand {
  ref: string
  returnedChars: number
  truncated: boolean
  sessionId?: string | undefined
}

/**
 * The registered tools against a fake context whose memoryContext holds the
 * exact surface `memory_expand` touches, so the tool's read-back telemetry and
 * truncation banner can be exercised end to end.
 */
function makeExpandTool() {
  const toolResults = new Map<string, ToolResultRecord>()
  const foldedRanges = new Map<string, FoldedRangeRecord>()
  const events: RecordedExpand[] = []
  const restored: string[] = []
  const defs: ToolDefinition[] = []
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { defs.push(tool) } },
    memoryContext: {
      getToolResult: (ref: string) => toolResults.get(ref),
      getFoldedRange: (ref: string) => foldedRanges.get(ref),
      markFoldedRangeRestored: (ref: string) => { restored.push(ref) },
      recordExpandRestore: (input: RecordedExpand) => { events.push(input) },
      listToolResults: () => [],
      searchToolResults: () => [],
      listFoldedRanges: () => [],
      searchFoldedRanges: () => [],
      getFoldAttachments: () => [],
    },
  } as unknown as Context
  apply(ctx)
  const tool = defs.find(candidate => candidate.name === 'memory_expand')
  if (tool === undefined) throw new Error('memory_expand was not registered')
  const run = (args: Record<string, unknown>): Promise<string> =>
    tool.execute(args, {} as ToolRunContext) as Promise<string>
  const addToolResult = (text: string, sessionId?: string): string => {
    const ref = archiveRef(text)
    toolResults.set(ref, {
      ref,
      tool: 'run_code',
      createdAt: 1,
      chars: Array.from(text).length,
      text,
      ...(sessionId === undefined ? {} : { sessionId }),
    })
    return ref
  }
  const addFoldedRange = (original: string, sessionId?: string): string => {
    const ref = FOLDED_REF_PREFIX + 'ab12cd34ef56'
    foldedRanges.set(ref, {
      ref,
      ...(sessionId === undefined ? {} : { sessionId }),
      createdAt: 1,
      messages: 4,
      chars: Array.from(original).length,
      tokens: 10,
      summary: 'the agent finished the refactor',
      original,
      restoredCount: 0,
    })
    return ref
  }
  return { run, events, restored, addToolResult, addFoldedRange }
}

describe('memory_expand (registered tool)', () => {
  it('leads a limit-truncated read with the banner and records the ledger event', async () => {
    const { run, events, addToolResult } = makeExpandTool()
    const text = 'x'.repeat(7473)
    const ref = addToolResult(text, 'sess-1')
    const out = await run({ ref })
    expect(out.startsWith('[TRUNCATED READ')).toBe(true)
    expect(out).toContain('full text is 7473 code points')
    expect(out).toContain('{"ref":"' + ref + '","offset":' + EXPAND_PAGE_CODE_POINTS + '}')
    expect(out.endsWith('[end of archived text]')).toBe(false)
    expect(out).toContain('call again with offset ' + EXPAND_PAGE_CODE_POINTS)
    expect(events).toEqual([
      { ref, returnedChars: EXPAND_PAGE_CODE_POINTS, truncated: true, sessionId: 'sess-1' },
    ])
  })

  it('warns about CALLER truncation when the whole archive fits one response', async () => {
    const { run, events, addToolResult } = makeExpandTool()
    // The exact production shape: limit=20000 over a 7473-code-point archive.
    const ref = addToolResult('x'.repeat(7473), 'sess-1')
    const out = await run({ ref, limit: 20000 })
    expect(out.startsWith('[READ ')).toBe(true)
    expect(out).toContain('offset 0\u20137473 of 7473 code points')
    expect(out).toContain('CALLER truncated it')
    expect(out.endsWith('[end of archived text]')).toBe(true)
    expect(events).toEqual([{ ref, returnedChars: 7473, truncated: false, sessionId: 'sess-1' }])
  })

  it('counts code points, not UTF-16 units, in the banner and the ledger', async () => {
    const { run, events, addToolResult } = makeExpandTool()
    // 3000 emoji = 3000 code points but 6000 UTF-16 units.
    const ref = addToolResult('\u{1F600}'.repeat(3000) + 'TAIL')
    const out = await run({ ref, limit: 2000 })
    expect(out).toContain('full text is 3004 code points')
    expect(events).toEqual([{ ref, returnedChars: 2000, truncated: true, sessionId: undefined }])
  })

  it('leaves small complete reads banner-free but still records the event', async () => {
    const { run, events, addToolResult } = makeExpandTool()
    const ref = addToolResult('short archive')
    const out = await run({ ref })
    expect(out.startsWith('Archived tool result ' + ref)).toBe(true)
    expect(out).toContain('[end of archived text]')
    expect(events).toEqual([{ ref, returnedChars: 13, truncated: false, sessionId: undefined }])
  })

  it('records nothing for unknown refs or offsets past the end', async () => {
    const { run, events, restored, addToolResult } = makeExpandTool()
    const ref = addToolResult('short archive')
    expect((await run({ ref: 'tr_missing' })).startsWith('Unknown archive ref')).toBe(true)
    expect((await run({ ref, offset: 999 }))).toContain('past the end')
    // A failed read counts on NEITHER track: no ledger event, and (for fl_
    // refs) no "read back Nx" counter either.
    expect(events).toEqual([])
    expect(restored).toEqual([])
  })

  it('keeps both read-back tracks for folded ranges: counter plus ledger event', async () => {
    const { run, events, restored, addFoldedRange } = makeExpandTool()
    const ref = addFoldedRange('folded text '.repeat(200), 'sess-2')
    const out = await run({ ref, limit: 1000 })
    expect(out.startsWith('[TRUNCATED READ')).toBe(true)
    expect(out).toContain('Folded history range ' + ref)
    expect(out).toContain('the agent finished the refactor')
    // Track 1: the folded_ranges.restored_count increment (fl_ only).
    expect(restored).toEqual([ref])
    // Track 2: the ledger event (fl_ and tr_ alike).
    expect(events).toEqual([{ ref, returnedChars: 1000, truncated: true, sessionId: 'sess-2' }])
  })

  it('a failed fl_ read (offset past the end) leaves both tracks untouched', async () => {
    const { run, events, restored, addFoldedRange } = makeExpandTool()
    const ref = addFoldedRange('folded text '.repeat(200), 'sess-2')
    expect((await run({ ref, offset: 99_999 }))).toContain('past the end')
    expect(restored).toEqual([])
    expect(events).toEqual([])
  })

  it('records query reads and announces capped match windows', async () => {
    const { run, events, addToolResult } = makeExpandTool()
    const text = ('needle ' + 'x'.repeat(300) + ' ').repeat(3).trim()
    const ref = addToolResult(text, 'sess-3')
    const out = await run({ ref, query: 'needle', limit: 2 })
    expect(out.startsWith('[PARTIAL MATCHES')).toBe(true)
    expect(out).toContain('3 occurrence(s) in the archive; showing the first 2 window(s)')
    expect(out).toContain('2 match window(s) for "needle" of 3 matches')
    expect(events).toHaveLength(1)
    expect(events[0]?.ref).toBe(ref)
    expect(events[0]?.truncated).toBe(true)
    expect(events[0]?.returnedChars).toBe(Array.from(matchWindows(text, 'needle', 2).join('\n\n')).length)
    expect(events[0]?.sessionId).toBe('sess-3')
  })

  it('records nothing when a query has no hits', async () => {
    const { run, events, addToolResult } = makeExpandTool()
    const ref = addToolResult('plain archive body')
    const out = await run({ ref, query: 'absent' })
    expect(out).toContain('No match for "absent"')
    expect(events).toEqual([])
  })
})
