/**
 * Implicit fold recall: fold summaries embed at archive time; each step's
 * user-authored input is matched against the recent folds, and significant
 * semantic overlap bumps the SAME flRecalls counter an explicit
 * memory_expand read uses — one recall loop, no new learned state. The
 * threshold is a cold-start prior; the cooldown is per ref per turn window.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveImplicitRecall } from '../src/config.ts'
import { MemoryCompactionEngine } from '../src/memory-compaction.ts'
import { MemoryStore } from '../src/memory-store.ts'

describe('fold summary embeddings in the store', () => {
  it('stores and returns the newest embedded folds for a session', () => {
    const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'dsh-ir-')), 'ir.db'))
    try {
      const v1 = [1, 0, 0]
      const v2 = [0, 1, 0]
      store.archiveFoldedRange({ messages: 1, chars: 1, tokens: 1, summary: 'a', original: 'o', sessionId: 's', createdAt: 1_000, embedding: v1 })
      store.archiveFoldedRange({ messages: 1, chars: 1, tokens: 1, summary: 'b', original: 'o', sessionId: 's', createdAt: 2_000, embedding: v2 })
      store.archiveFoldedRange({ messages: 1, chars: 1, tokens: 1, summary: 'no-embedding', original: 'o', sessionId: 's', createdAt: 3_000 })
      store.archiveFoldedRange({ messages: 1, chars: 1, tokens: 1, summary: 'other', original: 'o', sessionId: 'other', createdAt: 4_000, embedding: [0, 0, 1] })
      const recent = store.recentFoldEmbeddings('s', 8)
      expect(recent.map(row => row.ref.length)).toEqual([15, 15])
      expect(recent[0]!.embedding).toEqual(v2)
      expect(recent[1]!.embedding).toEqual(v1)
      // limit respected
      expect(store.recentFoldEmbeddings('s', 1)).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})

describe('scanImplicitRecall', () => {
  function harness({ embedding, recent, enabled = true }: {
    embedding?: readonly number[]
    recent: readonly { ref: string; embedding: readonly number[] }[]
    enabled?: boolean
  }) {
    const noted: string[] = []
    const ledger: { kind: string; detail?: string }[] = []
    const engine = Object.create(MemoryCompactionEngine.prototype) as unknown as {
      config: Record<string, unknown>
      ctx: { memoryContext: Record<string, unknown> }
      usage: { record: (kind: string, value: number, meta: { detail?: string }) => void }
      implicitRecallCooldown: Map<string, number>
      scanImplicitRecall: (sessionId: string, turn: number, texts: readonly string[]) => Promise<void>
    }
    engine.config = { ...(enabled ? {} : { fold_implicit_recall: false }) }
    engine.ctx = {
      memoryContext: {
        embedText: async () => embedding,
        recentFoldEmbeddings: () => recent,
        noteFlRecall: (sessionId: string) => { noted.push(sessionId) },
      },
    }
    engine.usage = { record: (kind: string, _value: number, meta: { detail?: string }) => { ledger.push({ kind, detail: meta.detail }) } }
    engine.implicitRecallCooldown = new Map()
    return { engine, noted, ledger }
  }

  it('counts a significant overlap once, then cools down', async () => {
    const vector = [0.6, 0.8, 0]
    const { engine, noted, ledger } = harness({ embedding: vector, recent: [{ ref: 'fl_aa11bb22cc33', embedding: vector }] })
    const text = 'back to the folded topic: fix the login crash in src/auth.ts and rerun the suite'
    await engine.scanImplicitRecall('s1', 5, [text])
    expect(noted).toEqual(['s1'])
    expect(ledger.some(row => row.detail === 'implicit-recall:ref=fl_aa11bb22cc33;score=1.00')).toBe(true)
    // same ref, later turn inside the cooldown window: no double count
    await engine.scanImplicitRecall('s1', 6, [text])
    expect(noted).toEqual(['s1'])
    expect(ledger).toHaveLength(1)
  })

  it('ignores low-overlap folds and disabled config', async () => {
    const { engine, noted, ledger } = harness({ embedding: [1, 0, 0], recent: [{ ref: 'fl_aa11bb22cc33', embedding: [0, 1, 0] }] })
    await engine.scanImplicitRecall('s1', 1, ['totally unrelated topic'])
    expect(noted).toEqual([])
    expect(ledger).toEqual([])
    const off = harness({ embedding: [1, 0, 0], recent: [{ ref: 'fl_aa11bb22cc33', embedding: [1, 0, 0] }], enabled: false })
    await off.engine.scanImplicitRecall('s1', 1, ['some long enough user input text here'])
    expect(off.noted).toEqual([])
  })

  it('skips tiny inputs and missing embeddings', async () => {
    const { engine, noted } = harness({ embedding: [1, 0, 0], recent: [] })
    await engine.scanImplicitRecall('s1', 1, ['hi'])
    expect(noted).toEqual([])
    const noEmbed = harness({ recent: [{ ref: 'fl_aa11bb22cc33', embedding: [1, 0, 0] }] })
    await noEmbed.engine.scanImplicitRecall('s1', 1, ['a long enough user input that still cannot match without a query embedding'])
    expect(noEmbed.noted).toEqual([])
  })
})

describe('resolveImplicitRecall', () => {
  it('defaults on and honours an explicit off', () => {
    expect(resolveImplicitRecall({})).toBe(true)
    expect(resolveImplicitRecall({ fold_implicit_recall: false })).toBe(false)
    expect(resolveImplicitRecall({ fold_implicit_recall: true })).toBe(true)
  })
})
