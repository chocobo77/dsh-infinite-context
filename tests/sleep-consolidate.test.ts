/**
 * Sleep-time consolidation: idle agents re-summarize their superseded
 * checkpoint history into one long-tier memory (kind 'project' — the fold
 * supersede chain must not retire the consolidation). LLM spend is bounded:
 * min superseded count to arm, one pass per idle window, per-session rerun
 * gap; any wake-up cancels the pending pass.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSleepConsolidate } from '../src/config.ts'
import { MemoryCompactionEngine } from '../src/memory-compaction.ts'
import { MemoryStore } from '../src/memory-store.ts'

describe('resolveSleepConsolidate', () => {
  it('defaults on with a 15min idle delay and honours overrides', () => {
    expect(resolveSleepConsolidate({})).toEqual({ enabled: true, idleMs: 900_000 })
    expect(resolveSleepConsolidate({ sleep_consolidate: false })).toMatchObject({ enabled: false })
    // below the 60s floor falls back to the default
    expect(resolveSleepConsolidate({ sleep_idle_ms: 1_000 })).toMatchObject({ idleMs: 900_000 })
    expect(resolveSleepConsolidate({ sleep_idle_ms: 60_000 })).toMatchObject({ idleMs: 60_000 })
  })
})

describe('supersededCheckpointTexts', () => {
  it('counts and lists superseded checkpoints, ignoring other kinds', () => {
    const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'dsh-sleep-')), 'sleep.db'))
    try {
      // The fold's supersede chain, materialized directly: m3 is the LIVE
      // checkpoint; m1/m2 are its retired predecessors; the project memory
      // must not appear in the checkpoint query.
      store.insert({ id: 'm1', tier: 'mid', text: 'checkpoint one', createdAt: 1_000, importance: 0.6, sourceSessionId: 's1', kind: 'checkpoint' })
      store.insert({ id: 'm2', tier: 'mid', text: 'checkpoint two', createdAt: 2_000, importance: 0.6, sourceSessionId: 's1', kind: 'checkpoint' })
      store.insert({ id: 'mp', tier: 'mid', text: 'project note', createdAt: 2_500, importance: 0.6, sourceSessionId: 's1', kind: 'project' })
      store.insert({ id: 'm3', tier: 'mid', text: 'checkpoint three', createdAt: 3_000, importance: 0.6, sourceSessionId: 's1', kind: 'checkpoint' })
      // The fold's supersede chain (engine path: list → filter → markSuperseded).
      store.markSuperseded(['m1', 'm2'], 'm3')
      const superseded = store.supersededCheckpointTexts('s1', 8)
      expect(superseded.count).toBe(2)
      expect(superseded.texts).toEqual(['checkpoint two', 'checkpoint one'])
    } finally {
      store.close()
    }
  })
})

describe('runSleepMaintenance', () => {
  function harness({ count, texts = undefined, enabled = true, lastRun = undefined }: {
    count: number
    texts?: string[] | undefined
    enabled?: boolean
    lastRun?: number | undefined
  }) {
    const stored: { text: string; tier: string; kind?: string }[] = []
    const ledger: { detail?: string }[] = []
    const merges: readonly string[][] = []
    const engine = Object.create(MemoryCompactionEngine.prototype) as unknown as {
      config: Record<string, unknown>
      ctx: { memoryContext: Record<string, unknown>; logger: { info: (m: string) => void } }
      usage: { record: (kind: string, value: number, meta: { detail?: string }) => void }
      sleepLastRun: Map<string, number>
      runSleepMaintenance: (sessionId: string, session: unknown, summarize?: (texts: readonly string[]) => Promise<string>) => Promise<void>
    }
    engine.config = { ...(enabled ? {} : { sleep_consolidate: false }) }
    engine.ctx = {
      memoryContext: {
        supersededCheckpointTexts: () => ({ count, ...(texts === undefined ? {} : { texts: texts.slice() }) }),
        storeMemory: async (text: string, tier: string, meta: { kind?: string }) => {
          stored.push({ text, tier, ...(meta.kind === undefined ? {} : { kind: meta.kind }) })
          return { id: 'merged-1' }
        },
      },
      logger: { info: () => {} },
    }
    engine.usage = { record: (_kind: string, _value: number, meta: { detail?: string }) => { ledger.push({ detail: meta.detail }) } }
    engine.sleepLastRun = new Map([['s1', ...(lastRun === undefined ? [] : [lastRun])]])
    const run = (summarize?: (texts: readonly string[]) => Promise<string>): Promise<void> =>
      engine.runSleepMaintenance('s1', { id: 's1' } as never, summarize ?? (async (texts: readonly string[]) => {
        merges.push(texts)
        return `merged ${texts.length} checkpoints`
      }))
    return { engine, stored, ledger, merges, run }
  }

  it('merges superseded checkpoints into one long project memory and records the pass', async () => {
    const { stored, ledger, merges, run } = harness({ count: 4, texts: ['c1', 'c2', 'c3', 'c4'] })
    await run()
    expect(merges).toEqual([['c1', 'c2', 'c3', 'c4']])
    expect(stored).toEqual([{ text: 'merged 4 checkpoints', tier: 'long', kind: 'project' }])
    expect(ledger.some(row => row.detail === 'sleep:consolidated=4')).toBe(true)
  })

  it('stands down below the arm threshold, when disabled, after a fresh run, or on an empty merge', async () => {
    const below = harness({ count: 2, texts: ['c1', 'c2'] })
    await below.run()
    expect(below.merges).toEqual([])
    expect(below.stored).toEqual([])

    const disabled = harness({ count: 5, texts: ['c'], enabled: false })
    await disabled.run()
    expect(disabled.stored).toEqual([])

    const fresh = harness({ count: 5, texts: ['c'], lastRun: Date.now() })
    await fresh.run()
    expect(fresh.stored).toEqual([])

    const empty = harness({ count: 5, texts: ['c'] })
    await empty.run(async () => '   ')
    expect(empty.stored).toEqual([])
  })
})

describe('idle schedule lifecycle', () => {
  function scheduleHarness(enabled = true) {
    const engine = Object.create(MemoryCompactionEngine.prototype) as unknown as {
      config: Record<string, unknown>
      sleepTimers: Map<string, NodeJS.Timeout>
      scheduleIdleMaintenance: (sessionId: string, session: unknown) => void
      cancelIdleMaintenance: (sessionId: string) => void
    }
    engine.config = { ...(enabled ? {} : { sleep_consolidate: false }), sleep_idle_ms: 60_000 }
    engine.sleepTimers = new Map()
    return engine
  }

  it('arms one timer per session, ignores repeats, and cancels on wake', () => {
    const engine = scheduleHarness()
    const session = { id: 's1' } as never
    engine.scheduleIdleMaintenance('s1', session)
    expect(engine.sleepTimers.size).toBe(1)
    engine.scheduleIdleMaintenance('s1', session)
    expect(engine.sleepTimers.size).toBe(1)
    engine.cancelIdleMaintenance('s1')
    expect(engine.sleepTimers.size).toBe(0)
  })

  it('never arms when disabled', () => {
    const engine = scheduleHarness(false)
    engine.scheduleIdleMaintenance('s1', { id: 's1' } as never)
    expect(engine.sleepTimers.size).toBe(0)
  })
})
