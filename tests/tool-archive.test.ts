import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_TOOL_ARCHIVE_OPTIONS,
  ToolResultArchive,
  archiveMarker,
  archiveRef,
  digestStub,
  measureChars,
  measureContent,
  replaceTextMiddle,
  replaceTextWithStub,
  textOfBlocks,
  type ToolArchiveOptions,
  type ToolArchiveStore,
} from '../src/tool-archive.ts'
import type { AbsorbOptions } from '../src/absorb.ts'
import type { ToolResultMeta, ToolResultRecord } from '../src/memory-store.ts'

const OPTIONS: ToolArchiveOptions = {
  enabled: true,
  thresholdChars: 400,
  headChars: 100,
  tailChars: 50,
  maxEntries: 100,
  retentionDays: 30,
}

/** A deterministic oversized payload (code-point length = 10 * blocks). */
function longText(blocks = 200): string {
  return 'abcdefghij'.repeat(blocks)
}

function toMeta(row: ToolResultRecord): ToolResultMeta {
  return {
    ref: row.ref,
    tool: row.tool,
    createdAt: row.createdAt,
    chars: row.chars,
    preview: row.text.slice(0, 20),
    ...(row.callId === undefined ? {} : { callId: row.callId }),
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
  }
}

/** In-memory stand-in for the MemoryStore tool-result methods. */
function makeStore() {
  const rows = new Map<string, ToolResultRecord>()
  const byNewest = (a: ToolResultRecord, b: ToolResultRecord): number =>
    b.createdAt - a.createdAt || (a.ref < b.ref ? 1 : -1)
  const store: ToolArchiveStore = {
    archiveToolResult(record) {
      if (rows.has(record.ref)) return false
      rows.set(record.ref, record)
      return true
    },
    getToolResult: ref => rows.get(ref),
    findToolResultByCallId(callId) {
      let found: ToolResultRecord | undefined
      for (const row of rows.values()) {
        if (row.callId !== callId) continue
        if (found === undefined || row.createdAt >= found.createdAt) found = row
      }
      return found
    },
    listToolResults(limit = 20) {
      return [...rows.values()].sort(byNewest).slice(0, limit).map(toMeta)
    },
    searchToolResults(query, limit = 5) {
      return [...rows.values()].filter(row => row.text.includes(query)).sort(byNewest).slice(0, limit).map(toMeta)
    },
    countToolResults: () => rows.size,
    toolResultChars: () => [...rows.values()].reduce((sum, row) => sum + row.chars, 0),
    deleteToolResultsBefore(timestamp) {
      let deleted = 0
      for (const [ref, row] of [...rows]) {
        if (row.createdAt < timestamp) {
          rows.delete(ref)
          deleted++
        }
      }
      return deleted
    },
    trimToolResults(maxEntries) {
      let deleted = 0
      for (const row of [...rows.values()].sort(byNewest).slice(maxEntries)) {
        rows.delete(row.ref)
        deleted++
      }
      return deleted
    },
  }
  return { rows, store }
}

interface FakeEvent {
  seq: number
  type: string
  data: { message: { role: string; source: { kind: string; callId: string }; content: ContentBlock[] } }
}

/** Minimal session surface: append/replace bookkeeping like the real one. */
function makeSession() {
  const events = new Map<number, FakeEvent>()
  const nodes: number[] = []
  let next = 1
  const session = {
    id: 's1',
    surface: { nodes },
    eventAt: (seq: number) => events.get(seq),
    deriveEventMessage: (event: unknown) => (event as FakeEvent).data.message,
    append(type: string, data: unknown, options?: unknown) {
      const seq = next++
      const op = (options as { surfaceOp?: string | { op: string; startSeq: number } } | undefined)?.surfaceOp
      if (op === 'append') nodes.push(seq)
      else if (typeof op === 'object' && op.op === 'replace') {
        const at = nodes.indexOf(op.startSeq)
        if (at >= 0) nodes.splice(at, 1, seq)
        else nodes.push(seq)
      }
      events.set(seq, { seq, type, data: data as FakeEvent['data'] })
      return { seq }
    },
  }
  const addToolResult = (callId: string, text: string): number => {
    const appended = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text }] },
    }, { surfaceOp: 'append' })
    return appended.seq
  }
  return { session, nodes, events, addToolResult }
}

function makeArchive(
  store: ToolArchiveStore,
  options: ToolArchiveOptions,
  now?: () => number,
  absorb?: AbsorbOptions,
) {
  const warnings: string[] = []
  const infos: string[] = []
  const archive = new ToolResultArchive({
    store,
    options,
    logger: { info: message => infos.push(message), warn: message => warnings.push(message) },
    estimateMessage: () => 1,
    ...(now === undefined ? {} : { now }),
    ...(absorb === undefined ? {} : { absorb }),
  })
  return { archive, warnings, infos }
}

describe('tool-archive helpers', () => {
  it('measures and refs by content', () => {
    expect(measureChars('a\u{1F600}b')).toBe(3)
    const ref = archiveRef('hello')
    expect(ref).toBe(archiveRef('hello'))
    expect(ref).not.toBe(archiveRef('hellp'))
    expect(ref.startsWith('tr_')).toBe(true)
    expect(ref.length).toBe(15)
  })

  it('joins text blocks and skips non-text ones', () => {
    const blocks = [
      { type: 'text', text: 'first' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA' } },
      { type: 'text', text: 'second' },
    ] as unknown as ContentBlock[]
    expect(textOfBlocks(blocks)).toBe('first\n\nsecond')
    expect(measureContent(blocks)).toBe('first'.length + 'second'.length)
  })

  it('replaces the middle with a ref-bearing marker', () => {
    const text = longText()
    const marker = archiveMarker('tr_abcdef123456', measureChars(text))
    const rewriten = replaceTextMiddle([{ type: 'text', text }], marker, OPTIONS)
    expect(rewriten).not.toBeNull()
    const out = rewriten as ContentBlock[]
    expect(measureContent(out)).toBeLessThan(measureChars(text))
    const body = textOfBlocks(out)
    expect(body.startsWith('abcdefghij'.repeat(10))).toBe(true)
    expect(body.endsWith('abcdefghij'.repeat(5))).toBe(true)
    expect(body).toContain('tr_abcdef123456')
  })

  it('refuses to rewrite when nothing would shrink or the marker cannot fit', () => {
    expect(replaceTextMiddle([{ type: 'text', text: 'short' }], 'marker', OPTIONS)).toBeNull()
    const marker = archiveMarker('tr_abcdef123456', 2000)
    expect(replaceTextMiddle([{ type: 'text', text: longText() }], marker, {
      ...OPTIONS,
      thresholdChars: 10,
    })).toBeNull()
  })

  it('exposes the default policy', () => {
    expect(DEFAULT_TOOL_ARCHIVE_OPTIONS.enabled).toBe(true)
    expect(DEFAULT_TOOL_ARCHIVE_OPTIONS.thresholdChars).toBeLessThan(8192)
  })

  it('embeds memory_expand calls whose arguments the tool actually accepts', () => {
    // The stub is the ONLY thing the model sees; if its read-back hint named a
    // parameter memory_expand does not take, every future read-back would fail
    // validation. Pin the contract on both stub flavours.
    const hints = [
      ...archiveMarker('tr_ab12cd34ef56', 7473).matchAll(/memory_expand (\{[^}]*\})/g),
      ...digestStub('tr_ab12cd34ef56', 'signal line', 7473).matchAll(/memory_expand (\{[^}]*\})/g),
    ]
    expect(hints.length).toBeGreaterThanOrEqual(3)
    for (const [, raw] of hints) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const key of Object.keys(parsed)) {
        expect(['ref', 'query', 'offset', 'limit']).toContain(key)
      }
      if (parsed.ref !== undefined) {
        expect(parsed.ref).toMatch(/^tr_[0-9a-f]{12}$/)
      }
    }
  })
})

describe('ToolResultArchive', () => {
  it('still returns the ref when retention pruning fails', () => {
    const { store } = makeStore()
    const failing: ToolArchiveStore = {
      ...store,
      deleteToolResultsBefore() { throw new Error('prune failed') },
    }
    const { archive, warnings } = makeArchive(failing, { ...OPTIONS, retentionDays: 1 })
    const captured = archive.capture('pwsh', 'c1', 's1', longText())
    // The row WAS stored: returning null ("nothing archived") would hide it and
    // drop the caller's digest/absorb accounting.
    expect(captured).not.toBeNull()
    expect(captured?.ref.startsWith('tr_')).toBe(true)
    expect(warnings.some(message => message.includes('retention'))).toBe(true)
  })

  it('leaves an oversized result on the surface when the store rejects it', () => {
    const { store } = makeStore()
    const failing: ToolArchiveStore = {
      ...store,
      archiveToolResult() { throw new Error('disk full') },
    }
    const { archive, warnings } = makeArchive(failing, OPTIONS)
    const { session, events, addToolResult } = makeSession()
    const seq = addToolResult('c1', longText())
    const result = archive.rewriteAllResults(session as unknown as Session)
    // Nothing was storable, so nothing may be rewritten: a stub would point at
    // a ref that does not exist and the only copy of the text would be gone.
    expect(result.replaced).toBe(0)
    expect(result.refs).toEqual([])
    const event = events.get(seq) as unknown as FakeEvent | undefined
    expect(textOfBlocks(event?.data.message.content ?? [])).toContain('abcdefghij')
    expect(warnings.some(message => message.includes('could not store'))).toBe(true)
  })

  it('captures only oversized results, once per content', () => {
    const { rows, store } = makeStore()
    const { archive } = makeArchive(store, OPTIONS)
    expect(archive.capture('pwsh', 'c1', 's1', 'small')).toBeNull()
    const first = archive.capture('pwsh', 'c1', 's1', longText())
    expect(first).not.toBeNull()
    expect(first?.inserted).toBe(true)
    expect(rows.get(first?.ref ?? '')?.tool).toBe('pwsh')
    const again = archive.capture('other', 'c1', 's1', longText())
    expect(again?.ref).toBe(first?.ref)
    expect(again?.inserted).toBe(false)
    expect(rows.size).toBe(1)
  })

  it('reads, lists, searches and reports status', () => {
    const { store } = makeStore()
    const { archive } = makeArchive(store, OPTIONS)
    const text = longText() + 'NEEDLE'
    const captured = archive.capture('pwsh', 'c1', 's1', text)
    const ref = captured?.ref ?? ''
    expect(archive.read(ref)?.text).toBe(text)
    expect(archive.read('tr_missing')).toBeUndefined()
    expect(archive.list()[0]?.ref).toBe(ref)
    expect(archive.search('NEEDLE').map(row => row.ref)).toEqual([ref])
    expect(archive.search('ABSENT')).toEqual([])
    expect(archive.status()).toEqual({ enabled: true, entries: 1, chars: measureChars(text) })
  })

  it('keeps a cache barrier: the first pass only records the highest seq', () => {
    const { store } = makeStore()
    const { archive } = makeArchive(store, OPTIONS)
    const { session, nodes, events, addToolResult } = makeSession()
    addToolResult('c1', longText())
    const first = archive.rewriteNewResults(session as unknown as Session)
    expect(first.replaced).toBe(0)
    expect(nodes.length).toBe(1)
    expect((events.get(nodes[0] as number)?.data.message.content[0] as { text: string }).text).toBe(longText())
  })

  it('stubs results appended after the barrier and keeps the surface in place', () => {
    const { rows, store } = makeStore()
    const { archive, infos } = makeArchive(store, OPTIONS)
    const { session, nodes, events, addToolResult } = makeSession()
    addToolResult('old', longText())
    archive.rewriteNewResults(session as unknown as Session)
    const before = nodes.length
    addToolResult('c9', longText())
    const result = archive.rewriteNewResults(session as unknown as Session)
    expect(result.replaced).toBe(1)
    expect(result.charsRemoved).toBeGreaterThan(0)
    expect(result.refs.length).toBe(1)
    expect(nodes.length).toBe(before + 1)
    const stubbed = events.get(result.replaced > 0 ? (nodes[nodes.length - 1] as number) : 0)
    expect(textOfBlocks(stubbed?.data.message.content ?? [])).toContain(result.refs[0] as string)
    expect(rows.has(result.refs[0] as string)).toBe(true)
    expect(infos.some(message => message.includes('stubbed 1'))).toBe(true)
  })

  it('rewrites pre-existing oversized results on a full pass', () => {
    const { rows, store } = makeStore()
    const { archive } = makeArchive(store, OPTIONS)
    const { session, nodes, events, addToolResult } = makeSession()
    const seq = addToolResult('c1', longText())
    const result = archive.rewriteAllResults(session as unknown as Session)
    expect(result.replaced).toBe(1)
    expect(nodes.length).toBe(1)
    expect(nodes[0]).not.toBe(seq)
    expect(textOfBlocks(events.get(nodes[0] as number)?.data.message.content ?? [])).toContain(result.refs[0] as string)
    expect(rows.size).toBe(1)
  })

  it('does nothing when disabled', () => {
    const { rows, store } = makeStore()
    const { archive } = makeArchive(store, { ...OPTIONS, enabled: false })
    const { session, nodes, addToolResult } = makeSession()
    addToolResult('c1', longText())
    expect(archive.rewriteNewResults(session as unknown as Session).replaced).toBe(0)
    expect(archive.rewriteAllResults(session as unknown as Session).replaced).toBe(0)
    expect(archive.capture('pwsh', 'c1', 's1', longText())).toBeNull()
    expect(rows.size).toBe(0)
    expect(nodes.length).toBe(1)
  })

  it('drops entries past retention and past the entry cap on capture', () => {
    const { rows, store } = makeStore()
    let now = 1_000_000_000
    const { archive } = makeArchive(store, { ...OPTIONS, maxEntries: 2, retentionDays: 1 }, () => now)
    rows.set('tr_stale000000', {
      ref: 'tr_stale000000',
      tool: 'pwsh',
      createdAt: now - 2 * 24 * 60 * 60 * 1000,
      chars: 9000,
      text: longText(),
    })
    archive.capture('pwsh', 'c1', 's1', longText(100) + 'A')
    expect(rows.has('tr_stale000000')).toBe(false)
    archive.capture('pwsh', 'c2', 's1', longText(100) + 'B')
    now += 1000
    archive.capture('pwsh', 'c3', 's1', longText(100) + 'C')
    expect(rows.size).toBe(2)
    expect(archive.status().entries).toBe(2)
  })
})

const ABSORB: AbsorbOptions = { enabled: true, minChars: 100, maxDigestChars: 600 }

describe('tool-archive absorb stubs', () => {
  it('distils a sub-threshold payload without archiving it', () => {
    const { rows, store } = makeStore()
    const { archive } = makeArchive(store, OPTIONS, undefined, ABSORB)
    const text = ['line one', 'line two', 'ERROR: small failure', 'line four'].join('\n')
      + '\n' + 'x'.repeat(200)
    const captured = archive.capture('pwsh', 'c1', 's1', text)
    expect(captured?.ref).toBeUndefined()
    expect(captured?.inserted).toBe(false)
    expect(captured?.digest).toContain('ERROR: small failure')
    expect(rows.size).toBe(0)
  })

  it('archives the digest of an oversized payload', () => {
    const { rows, store } = makeStore()
    const { archive } = makeArchive(store, OPTIONS, undefined, ABSORB)
    const text = ['setup ok', 'ERROR: big failure', 'noise ' + 'x'.repeat(400)].join('\n')
      + '\n' + longText()
    const captured = archive.capture('pwsh', 'c1', 's1', text)
    expect(captured?.inserted).toBe(true)
    expect(captured?.digest).toContain('ERROR: big failure')
    expect(rows.get(captured?.ref as string)?.digest).toBe(captured?.digest)
  })

  it('replaces a result with the stored digest stub', () => {
    const { rows, store } = makeStore()
    const { archive, infos } = makeArchive(store, OPTIONS, undefined, ABSORB)
    const { session, nodes, events, addToolResult } = makeSession()
    // The tools/result hook archives first, so the call on the surface is known.
    const captured = archive.capture('pwsh', 'c1', 's1', longText())
    // The first pass only records the prefix barrier; it rewrites nothing.
    expect(archive.rewriteNewResults(session as unknown as Session).replaced).toBe(0)
    addToolResult('c1', longText())
    const result = archive.rewriteNewResults(session as unknown as Session)
    expect(result.replaced).toBe(1)
    expect(result.refs[0]).toBe(captured?.ref)
    const stub = textOfBlocks(events.get(nodes[nodes.length - 1] as number)?.data.message.content ?? [])
    expect(stub.startsWith('[pwsh result absorbed: ')).toBe(true)
    expect(stub).toContain('chars absorbed and archived as ' + (captured?.ref as string))
    expect(stub).toContain('memory_expand {"ref":"' + (captured?.ref as string) + '"}')
    expect(rows.get(captured?.ref as string)?.digest).toBe(captured?.digest)
    expect(infos.some(message => message.includes('stubbed 1'))).toBe(true)
  })

  it('falls back to the head+tail marker when absorb is off', () => {
    const { store } = makeStore()
    const { archive } = makeArchive(
      store,
      OPTIONS,
      undefined,
      { enabled: false, minChars: 100, maxDigestChars: 600 },
    )
    const { session, nodes, events, addToolResult } = makeSession()
    addToolResult('c1', longText())
    archive.rewriteAllResults(session as unknown as Session)
    const stub = textOfBlocks(events.get(nodes[0] as number)?.data.message.content ?? [])
    expect(stub).toContain('chars archived as')
    expect(stub).not.toContain('result absorbed')
  })

  it('renders the stub hint and keeps one stub per result', () => {
    const stub = digestStub('tr_abcdef012345', 'body line', 4_321)
    expect(stub.startsWith('body line\n\n')).toBe(true)
    expect(stub).toContain('4321 chars absorbed and archived as tr_abcdef012345')
    expect(stub).toContain('memory_expand {"ref":"tr_abcdef012345"}')
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a'.repeat(1_000) },
      { type: 'text', text: 'b'.repeat(1_000) },
    ]
    expect(measureContent(replaceTextWithStub(blocks, 'stub') ?? [])).toBe(4)
    expect(textOfBlocks(replaceTextWithStub(blocks, 'stub') ?? [])).toBe('stub')
    expect(replaceTextWithStub([{ type: 'text', text: 'short' }], 'a much longer stub')).toBeNull()
  })
})

describe('tool-archive absorb CJK signals', () => {
  it('distils CJK signal lines alongside English ones', () => {
    const { rows, store } = makeStore()
    const { archive } = makeArchive(store, OPTIONS, undefined, ABSORB)
    // 10 lines: the CJK signal sits at line 5, beyond both the 3-line head
    // and the 3-line tail, so capturing it proves the signal PATTERN matched,
    // not the head/tail passthrough.
    const text = ['h1', 'h2', 'h3', 'filler', '错误：连接被拒绝', 'WARN: retrying', 'f6', 'f7', 'f8', 'x'.repeat(200)].join('\n')
    const captured = archive.capture('pwsh', 'c1', 's1', text)
    expect(captured?.digest).toContain('错误：连接被拒绝')
    expect(captured?.digest).toContain('WARN: retrying')
    expect(captured?.digest).not.toContain('f6')
  })
})

describe('tool-archive expiry (fold-time aging)', () => {
  // A threshold ABOVE the expiry floor (400): the band 400..threshold is
  // exactly what the size-gated passes leave on the surface and expiry must
  // age out — the whole point of the pass.
  const EXPIRY_OPTIONS: ToolArchiveOptions = {
    enabled: true,
    thresholdChars: 5000,
    headChars: 100,
    tailChars: 50,
    maxEntries: 100,
    retentionDays: 30,
  }
  /** Medium result: over the expiry floor, under the size-gate threshold. */
  const mediumText = (): string => 'abcdefghij'.repeat(80) // 800 code points

  it('ages results under the archive threshold once they leave the working set', () => {
    const { rows, store } = makeStore()
    const { archive } = makeArchive(store, EXPIRY_OPTIONS)
    const { session, nodes, events, addToolResult } = makeSession()
    const seqs: number[] = []
    for (let i = 0; i < 13; i += 1) seqs.push(addToolResult('c' + i, mediumText()))
    // The size-gated pass leaves ALL of these (800 < 5000).
    expect(archive.rewriteAllResults(session as unknown as Session).replaced).toBe(0)
    const result = archive.expireOldResults(session as unknown as Session)
    // 13 results, the newest 10 stay: exactly 3 age out (the oldest).
    expect(result.replaced).toBe(3)
    expect(result.refs.length).toBe(3)
    // Reversibility: force-archived under the size threshold, still readable.
    const stored = archive.read(result.refs[0] ?? '')
    expect(stored?.text).toBe(mediumText())
    // The stub carries the ref.
    const event = events.get(nodes[0]) as unknown as FakeEvent | undefined
    expect(textOfBlocks(event?.data.message.content ?? [])).toContain('tr_')
    // Content-addressed refs: three aged results of identical text share ONE
    // stored row; the working-set tail (never captured, under the size gate)
    // contributes nothing.
    expect(rows.size).toBe(1)
    expect(new Set(result.refs).size).toBe(1)
    void seqs
  })

  it('is idempotent and leaves tiny results and existing stubs alone', () => {
    const { store } = makeStore()
    const { archive } = makeArchive(store, EXPIRY_OPTIONS)
    const { session, addToolResult } = makeSession()
    for (let i = 0; i < 12; i += 1) addToolResult('c' + i, mediumText())
    addToolResult('tiny', 'x'.repeat(120)) // below the expiry floor
    const first = archive.expireOldResults(session as unknown as Session)
    expect(first.replaced).toBe(3) // 13 - 10 kept
    const second = archive.expireOldResults(session as unknown as Session)
    expect(second.replaced).toBe(0) // already-stubbed nodes never re-stub
    const tiny = archive.capture('x', 'tiny', 's1', 'x'.repeat(120), true)
    expect(tiny?.ref).toBeDefined() // capture(force) archives below the threshold
  })

  it('capture(force) archives below the size gate; without force a digest-less small result stores nothing', () => {
    const { rows, store } = makeStore()
    const { archive } = makeArchive(store, EXPIRY_OPTIONS)
    // No signal lines and under the size gate → nothing (old behavior kept).
    expect(archive.capture('x', 'c1', 's1', mediumText())).toBeNull()
    expect(rows.size).toBe(0)
    // force: the expiry pass needs a ref for every aged payload.
    const forced = archive.capture('x', 'c1', 's1', mediumText(), true)
    expect(forced?.ref).toBeDefined()
    expect(rows.get(forced?.ref ?? '')?.text).toBe(mediumText())
  })

  it('disabled policy expires nothing', () => {
    const { store } = makeStore()
    const { archive } = makeArchive(store, { ...EXPIRY_OPTIONS, enabled: false })
    const { session, addToolResult } = makeSession()
    for (let i = 0; i < 12; i += 1) addToolResult('c' + i, mediumText())
    expect(archive.expireOldResults(session as unknown as Session).replaced).toBe(0)
  })
})
