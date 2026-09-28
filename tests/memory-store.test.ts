import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/core.ts'
import type { MemoryDoc } from '../src/core.ts'
import type { ToolResultRecord } from '../src/memory-store.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mic-store-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function makeDoc(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
  return {
    id: overrides.id ?? 'm1',
    tier: 'mid',
    text: 'remember this fact',
    createdAt: 1000,
    importance: 0.5,
    ...overrides,
  }
}

describe('MemoryStore', () => {
  it('inserts, gets, lists, counts, deletes, and clears', () => {
    const store = new MemoryStore(':memory:')
    store.insert(makeDoc({ id: 'a', tier: 'mid' }))
    store.insert(makeDoc({ id: 'b', tier: 'long', importance: 0.9 }))
    store.insert(makeDoc({ id: 'c', tier: 'mid', importance: 0.2 }))
    expect(store.count()).toBe(3)
    expect(store.count('mid')).toBe(2)
    expect(store.count('long')).toBe(1)
    expect(store.get('a')?.tier).toBe('mid')
    const mids = store.list('mid')
    expect(mids.map(m => m.id).sort()).toEqual(['a', 'c'])
    store.delete('a')
    expect(store.get('a')).toBeUndefined()
    expect(store.count()).toBe(2)
    store.clear()
    expect(store.count()).toBe(0)
    store.close()
  })

  it('round-trips embeddings and provenance', () => {
    const store = new MemoryStore(':memory:')
    // Values are chosen to be exactly representable in Float32.
    const doc = makeDoc({
      embedding: [0.5, 0.25, 0.125],
      sourceSessionId: 'sess-1',
      sourceTurns: { start: 2, end: 5 },
      mergedFrom: ['x', 'y'],
    })
    store.insert(doc)
    const loaded = store.get('m1')!
    expect(loaded.embedding![0]).toBeCloseTo(0.5)
    expect(loaded.embedding![1]).toBeCloseTo(0.25)
    expect(loaded.embedding![2]).toBeCloseTo(0.125)
    expect(loaded.sourceSessionId).toBe('sess-1')
    expect(loaded.sourceTurns).toEqual({ start: 2, end: 5 })
    expect(loaded.mergedFrom).toEqual(['x', 'y'])
    store.close()
  })

  it('lists newest-first and upserts by id', () => {
    const store = new MemoryStore(':memory:')
    store.insert(makeDoc({ id: 'a', createdAt: 100 }))
    store.insert(makeDoc({ id: 'b', createdAt: 200 }))
    const list = store.list()
    expect(list[0].id).toBe('b')
    expect(list[1].id).toBe('a')
    store.upsert(makeDoc({ id: 'a', createdAt: 300, text: 'updated' }))
    expect(store.count()).toBe(2)
    expect(store.get('a')?.text).toBe('updated')
    store.close()
  })

  it('persists across reopen on a file path', () => {
    const dir = tempDir()
    const file = join(dir, 'mem.db')
    const first = new MemoryStore(file)
    first.insert(makeDoc({ id: 'persist', text: 'survives restart' }))
    first.close()

    const second = new MemoryStore(file)
    expect(second.get('persist')?.text).toBe('survives restart')
    second.close()
  })

  it('persists the kind column across reopen', () => {
    const dir = tempDir()
    const file = join(dir, 'kind.db')
    const first = new MemoryStore(file)
    first.insert(makeDoc({ id: 'k1', text: 'deploy to prod', kind: 'project' }))
    first.close()

    const second = new MemoryStore(file)
    expect(second.get('k1')?.kind).toBe('project')
    // A row without kind stays unclassified.
    second.insert(makeDoc({ id: 'k2', text: 'legacy row' }))
    expect(second.get('k2')?.kind).toBeUndefined()
    second.close()
  })

  it('migrates a pre-kind database by adding the kind column', () => {
    const dir = tempDir()
    const file = join(dir, 'legacy.db')
    // Simulate a store created before the `kind` column existed.
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, tier TEXT NOT NULL, text TEXT NOT NULL,
        created_at INTEGER NOT NULL, importance REAL NOT NULL,
        source_session_id TEXT, source_turn_start INTEGER, source_turn_end INTEGER,
        embedding BLOB, merged_from TEXT
      )
    `)
    legacy.prepare(`
      INSERT INTO memories (id, tier, text, created_at, importance)
      VALUES ('legacy', 'mid', 'old row', 1000, 0.5)
    `).run()
    legacy.close()

    // Reopen with the current schema — the migration must add `kind`.
    const store = new MemoryStore(file)
    expect(store.get('legacy')?.kind).toBeUndefined()
    store.insert(makeDoc({ id: 'new', text: 'new row', kind: 'project' }))
    expect(store.get('new')?.kind).toBe('project')
    store.close()
  })

  it('supports exact and fuzzy-normalized text dedup', () => {
    const store = new MemoryStore(':memory:')
    store.insert(makeDoc({ id: 'a', text: '[source: pwsh]\ncmd ran at 20240903114205 and printed 42000 items' }))
    // Exact match.
    expect(store.hasText('[source: pwsh]\ncmd ran at 20240903114205 and printed 42000 items')).toBe(true)
    expect(store.hasText('something else entirely')).toBe(false)
    // Fuzzy match: long digit runs (4+: timestamps/counters) and whitespace differ, case differs.
    expect(store.hasTextNormalized('[source: pwsh]\nCMD ran at 19999999999999 and printed 99999 items')).toBe(true)
    // Genuinely different content still misses.
    expect(store.hasTextNormalized('[source: pwsh]\nunrelated text without numbers')).toBe(false)
    // Short digit runs (1–3: small values like counts/ports) stay significant —
    // two facts differing only by such a value are NOT deduplicated.
    store.insert(makeDoc({ id: 'b', text: '[source: pwsh]\nlistening on port 300' }))
    expect(store.hasTextNormalized('[source: pwsh]\nlistening on port 808')).toBe(false)
    store.close()
  })

  it('persists plugin KV state across reopen (turn counters survive restart)', () => {
    const dir = tempDir()
    const file = join(dir, 'kv.db')
    const first = new MemoryStore(file)
    first.kvSet('compression:sess-1', '{"turn":12,"lastCompressedTurn":8,"failureCooldown":0}')
    first.kvSet('compression:sess-2', '{"turn":3,"failureCooldown":2}')
    expect(first.kvGet('compression:sess-1')).toContain('"turn":12')
    expect(first.kvGet('missing-key')).toBeUndefined()
    first.close()

    const second = new MemoryStore(file)
    expect(second.kvGet('compression:sess-1')).toContain('"turn":12')
    expect(second.kvGet('compression:sess-2')).toContain('"failureCooldown":2')
    // Upsert overwrites; delete removes.
    second.kvSet('compression:sess-1', '{"turn":13}')
    expect(second.kvGet('compression:sess-1')).toContain('"turn":13')
    second.kvDelete('compression:sess-2')
    expect(second.kvGet('compression:sess-2')).toBeUndefined()
    second.close()
  })

  it('does not let KV rows leak into memory retrieval', () => {
    const store = new MemoryStore(':memory:')
    store.kvSet('compression:sess-1', '{"turn":1}')
    expect(store.list()).toHaveLength(0)
    expect(store.count()).toBe(0)
    store.close()
  })

  it('throws on use after close', () => {
    const store = new MemoryStore(':memory:')
    store.close()
    expect(() => store.count()).toThrow()
  })

  it('creates missing parent directories for a file-backed store', () => {
    const nested = join(tempDir(), 'storages', 'deeper')
    const file = join(nested, 'memories.db')
    const store = new MemoryStore(file)
    store.insert(makeDoc({ id: 'nested-1' }))
    expect(store.count()).toBe(1)
    store.close()
    expect(existsSync(file)).toBe(true)
  })
})

/**
 * The tool-result archive backs `memory_expand`: an oversized tool result is
 * replaced on the transcript by a short stub carrying a content-addressed ref,
 * and the exact text stays here so it can be handed back verbatim.
 */
describe('MemoryStore tool results', () => {
  function record(overrides: Partial<ToolResultRecord> = {}): ToolResultRecord {
    return {
      ref: 'tr_aaaaaaaaaaaa',
      tool: 'pwsh',
      createdAt: 1000,
      chars: 5,
      text: 'hello',
      ...overrides,
    }
  }

  it('archives idempotently by ref and reads the record back', () => {
    const store = new MemoryStore(':memory:')
    const first = record({ callId: 'c1', sessionId: 's1' })
    expect(store.archiveToolResult(first)).toBe(true)
    expect(store.archiveToolResult({ ...first, tool: 'other' })).toBe(false)
    expect(store.getToolResult(first.ref)).toEqual(first)
    expect(store.getToolResult('tr_missing0000')).toBeUndefined()
    expect(store.countToolResults()).toBe(1)
    store.close()
  })

  it('omits absent optional fields instead of returning nulls', () => {
    const store = new MemoryStore(':memory:')
    store.archiveToolResult(record())
    const got = store.getToolResult(record().ref)
    expect(got).toEqual(record())
    expect('callId' in (got ?? {})).toBe(false)
    expect('sessionId' in (got ?? {})).toBe(false)
    store.close()
  })

  it('finds the newest archived result of one tool call', () => {
    const store = new MemoryStore(':memory:')
    store.archiveToolResult(record({ ref: 'tr_old00000000', callId: 'c1', createdAt: 100 }))
    store.archiveToolResult(record({ ref: 'tr_new00000000', callId: 'c1', createdAt: 300 }))
    store.archiveToolResult(record({ ref: 'tr_mid00000000', callId: 'c2', createdAt: 200 }))
    expect(store.findToolResultByCallId('c1')?.ref).toBe('tr_new00000000')
    expect(store.findToolResultByCallId('c2')?.ref).toBe('tr_mid00000000')
    expect(store.findToolResultByCallId('c9')).toBeUndefined()
    store.close()
  })

  it('lists newest first with a one-line preview and no full text', () => {
    const store = new MemoryStore(':memory:')
    store.archiveToolResult(record({ ref: 'tr_a0000000000', createdAt: 1, text: 'alpha', chars: 3 }))
    store.archiveToolResult(record({ ref: 'tr_b0000000000', createdAt: 2, text: 'line one\n\n  line two', chars: 20 }))
    store.archiveToolResult(record({ ref: 'tr_c0000000000', createdAt: 3, text: 'gamma', chars: 5 }))
    const rows = store.listToolResults()
    expect(rows.map(r => r.ref)).toEqual(['tr_c0000000000', 'tr_b0000000000', 'tr_a0000000000'])
    expect(rows[1]?.preview).toBe('line one line two')
    expect('text' in (rows[0] ?? {})).toBe(false)
    expect(store.listToolResults(1).map(r => r.ref)).toEqual(['tr_c0000000000'])
    expect(store.countToolResults()).toBe(3)
    expect(store.toolResultChars()).toBe(28)
    store.close()
  })

  it('searches case-insensitively and escapes LIKE wildcards', () => {
    const store = new MemoryStore(':memory:')
    store.archiveToolResult(record({ ref: 'tr_pct00000000', text: 'progress 100% done_b', chars: 20 }))
    store.archiveToolResult(record({ ref: 'tr_other000000', text: 'HELLO world', chars: 11 }))
    expect(store.searchToolResults('100%').map(r => r.ref)).toEqual(['tr_pct00000000'])
    expect(store.searchToolResults('hello').map(r => r.ref)).toEqual(['tr_other000000'])
    expect(store.searchToolResults('%').map(r => r.ref)).toEqual(['tr_pct00000000'])
    expect(store.searchToolResults('_b').map(r => r.ref)).toEqual(['tr_pct00000000'])
    expect(store.searchToolResults('absent')).toEqual([])
    store.close()
  })

  it('deletes by age and trims to the newest entries', () => {
    const store = new MemoryStore(':memory:')
    store.archiveToolResult(record({ ref: 'tr_old00000000', createdAt: 100 }))
    store.archiveToolResult(record({ ref: 'tr_new00000000', createdAt: 200 }))
    expect(store.deleteToolResultsBefore(200)).toBe(1)
    expect(store.listToolResults().map(r => r.ref)).toEqual(['tr_new00000000'])
    store.archiveToolResult(record({ ref: 'tr_tie_a000000', createdAt: 300 }))
    store.archiveToolResult(record({ ref: 'tr_tie_b000000', createdAt: 300 }))
    expect(store.trimToolResults(1)).toBe(2)
    expect(store.listToolResults().map(r => r.ref)).toEqual(['tr_tie_b000000'])
    store.close()
  })

  it('persists archived results across reopen', () => {
    const file = join(tempDir(), 'archive.db')
    const store = new MemoryStore(file)
    store.archiveToolResult(record({ ref: 'tr_keep0000000', callId: 'c7', tool: 'read', text: 'kept text', chars: 9 }))
    store.close()
    const reopened = new MemoryStore(file)
    expect(reopened.getToolResult('tr_keep0000000')?.text).toBe('kept text')
    expect(reopened.findToolResultByCallId('c7')?.ref).toBe('tr_keep0000000')
    reopened.close()
  })

  it('refuses tool-result access after close', () => {
    const store = new MemoryStore(':memory:')
    store.close()
    expect(() => store.countToolResults()).toThrow()
    expect(() => store.getToolResult('tr_any00000000')).toThrow()
  })
})
