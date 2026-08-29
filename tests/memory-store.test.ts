import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/core.ts'
import type { MemoryDoc } from '../src/core.ts'

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
    store.insert(makeDoc({ id: 'a', text: '[source: pwsh]\ncmd ran at 13:14:05 and printed 42' }))
    // Exact match.
    expect(store.hasText('[source: pwsh]\ncmd ran at 13:14:05 and printed 42')).toBe(true)
    expect(store.hasText('something else entirely')).toBe(false)
    // Fuzzy match: digit runs and whitespace differ, case differs (full text, incl. prefix).
    expect(store.hasTextNormalized('[source: pwsh]\nCMD ran at 99:99:99 and printed 7')).toBe(true)
    // Genuinely different content still misses.
    expect(store.hasTextNormalized('[source: pwsh]\nunrelated text without numbers')).toBe(false)
    store.close()
  })

  it('throws on use after close', () => {
    const store = new MemoryStore(':memory:')
    store.close()
    expect(() => store.count()).toThrow()
  })
})
