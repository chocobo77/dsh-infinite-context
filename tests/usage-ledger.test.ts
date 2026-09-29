import { describe, expect, it } from 'vitest'
import {
  DEFAULT_USAGE_OPTIONS,
  USAGE_KIND,
  UsageLedger,
} from '../src/usage-ledger.ts'
import type { UsageDetailTotal, UsageEventRecord, UsageTotal } from '../src/memory-store.ts'

const DAY_MS = 24 * 60 * 60 * 1000

interface FakeStore {
  readonly events: UsageEventRecord[]
  readonly prunes: number[]
  failing: boolean
  readonly store: {
    recordUsageEvent(record: UsageEventRecord): void
    usageTotals(sinceTs?: number): UsageTotal[]
    listUsageEvents(limit?: number): UsageEventRecord[]
    pruneUsageEvents(beforeTs: number): number
    usageTotalsByDetail(sinceTs?: number): UsageDetailTotal[]
  }
}

function makeStore(): FakeStore {
  const events: UsageEventRecord[] = []
  const prunes: number[] = []
  const fake: FakeStore = {
    events,
    prunes,
    failing: false,
    store: {
      recordUsageEvent(record) {
        if (fake.failing) throw new Error('record down')
        events.push(record)
      },
      usageTotals(sinceTs) {
        if (fake.failing) throw new Error('totals down')
        const byKind = new Map<string, UsageTotal>()
        for (const event of events) {
          if (sinceTs !== undefined && event.ts < sinceTs) continue
          const current = byKind.get(event.kind) ?? { kind: event.kind, events: 0, value: 0 }
          byKind.set(event.kind, {
            kind: event.kind,
            events: current.events + 1,
            value: current.value + event.value,
          })
        }
        return [...byKind.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1))
      },
      listUsageEvents(limit = 20) {
        if (fake.failing) throw new Error('list down')
        return [...events].reverse().slice(0, limit)
      },
      usageTotalsByDetail(sinceTs) {
        if (fake.failing) throw new Error('detail down')
        const byKey = new Map<string, UsageDetailTotal>()
        for (const event of events) {
          if (event.detail === undefined) continue
          if (sinceTs !== undefined && event.ts < sinceTs) continue
          const key = event.kind + '\u0000' + event.detail
          const current = byKey.get(key) ?? { kind: event.kind, detail: event.detail, events: 0, value: 0 }
          byKey.set(key, {
            kind: event.kind,
            detail: event.detail,
            events: current.events + 1,
            value: current.value + event.value,
          })
        }
        return [...byKey.values()].sort((a, b) => (a.kind + a.detail < b.kind + b.detail ? -1 : 1))
      },
      pruneUsageEvents(beforeTs) {
        if (fake.failing) throw new Error('prune down')
        prunes.push(beforeTs)
        let deleted = 0
        for (let i = events.length - 1; i >= 0; i--) {
          if ((events[i]?.ts ?? 0) < beforeTs) {
            events.splice(i, 1)
            deleted++
          }
        }
        return deleted
      },
    },
  }
  return fake
}

function makeLedger(
  store: FakeStore,
  options = DEFAULT_USAGE_OPTIONS,
  now: () => number = () => 1_000,
): { ledger: UsageLedger; warnings: string[] } {
  const warnings: string[] = []
  const ledger = new UsageLedger({
    store: store.store,
    options,
    logger: { warn: message => { warnings.push(message) } },
    now,
  })
  return { ledger, warnings }
}

describe('UsageLedger', () => {
  it('records rounded values with the session, and drops noise', () => {
    const fake = makeStore()
    const { ledger } = makeLedger(fake)
    ledger.record(USAGE_KIND.injectTokens, 12.6, { sessionId: 's1', detail: 'rag' })
    ledger.record(USAGE_KIND.archiveChars, 0)
    ledger.record(USAGE_KIND.archiveChars, Number.NaN)
    ledger.record(USAGE_KIND.archiveChars, Number.POSITIVE_INFINITY)
    expect(fake.events).toEqual([
      { ts: 1_000, kind: 'inject_tokens', value: 13, sessionId: 's1', detail: 'rag' },
    ])
    const off = makeLedger(makeStore(), { enabled: false, retentionDays: 30 })
    off.ledger.record(USAGE_KIND.injectTokens, 5)
    expect(off.ledger.enabled).toBe(false)
  })

  it('folds every kind into the summary with a disjoint-input cache rate', () => {
    const fake = makeStore()
    const { ledger } = makeLedger(fake)
    ledger.record(USAGE_KIND.injectTokens, 100)
    ledger.record(USAGE_KIND.injectMemories, 2)
    ledger.record(USAGE_KIND.surfaceSkips, 1)
    ledger.record(USAGE_KIND.archiveChars, 500)
    ledger.record(USAGE_KIND.absorbChars, 50)
    ledger.record(USAGE_KIND.nudge, 1)
    ledger.record(USAGE_KIND.compactionSaved, 300)
    ledger.record(USAGE_KIND.llmRequests, 1)
    ledger.record(USAGE_KIND.llmInput, 1_000)
    ledger.record(USAGE_KIND.llmOutput, 200)
    ledger.record(USAGE_KIND.llmCacheRead, 9_000)
    const summary = ledger.summary()
    expect(summary.windowDays).toBe(7)
    expect(summary.events).toBe(11)
    expect(summary.injectedTokens).toBe(100)
    expect(summary.injectedMemories).toBe(2)
    expect(summary.surfaceSkips).toBe(1)
    expect(summary.archivedChars).toBe(500)
    expect(summary.absorbedChars).toBe(50)
    expect(summary.nudges).toBe(1)
    expect(summary.compactionSavedTokens).toBe(300)
    expect(summary.llm.requests).toBe(1)
    expect(summary.llm.inputTokens).toBe(1_000)
    expect(summary.llm.outputTokens).toBe(200)
    expect(summary.llm.cacheReadTokens).toBe(9_000)
    expect(summary.llm.cacheWriteTokens).toBe(0)
    // 9000 / (1000 + 9000 + 0) — inputTokens is the UNCACHED part only.
    expect(summary.llm.cacheHitRate).toBe(0.9)
  })

  it('reports a zero cache rate before anything was billed', () => {
    const { ledger } = makeLedger(makeStore())
    expect(ledger.summary().llm.cacheHitRate).toBe(0)
  })

  it('summarises only the requested window', () => {
    const fake = makeStore()
    let now = 1_000
    const { ledger } = makeLedger(fake, DEFAULT_USAGE_OPTIONS, () => now)
    ledger.record(USAGE_KIND.injectTokens, 111)
    now += 8 * DAY_MS
    ledger.record(USAGE_KIND.injectTokens, 222)
    expect(ledger.summary(7).injectedTokens).toBe(222)
    expect(ledger.summary(30).injectedTokens).toBe(333)
  })

  it('prunes by retention and treats zero retention as off', () => {
    const fake = makeStore()
    let now = 1_000
    const { ledger } = makeLedger(fake, DEFAULT_USAGE_OPTIONS, () => now)
    ledger.record(USAGE_KIND.injectTokens, 1)
    ledger.record(USAGE_KIND.injectTokens, 2)
    now += 31 * DAY_MS
    expect(ledger.prune()).toBe(2)
    expect(fake.events).toHaveLength(0)
    const kept = makeStore()
    const noRetention = makeLedger(
      kept,
      { enabled: true, retentionDays: 0 },
      () => 1_000 + 31 * DAY_MS,
    )
    noRetention.ledger.record(USAGE_KIND.injectTokens, 7)
    expect(noRetention.ledger.prune()).toBe(0)
    expect(kept.events).toHaveLength(1)
  })

  it('prunes on its own once enough events accumulate', () => {
    const fake = makeStore()
    const { ledger } = makeLedger(fake)
    for (let i = 0; i < 256; i++) ledger.record(USAGE_KIND.injectTokens, 1)
    expect(fake.events).toHaveLength(256)
    expect(fake.prunes).toHaveLength(1)
    expect(fake.prunes[0]).toBe(1_000 - 30 * DAY_MS)
  })

  it('buckets llm usage per model so a mid-session switch stays visible', () => {
    const fake = makeStore()
    const { ledger } = makeLedger(fake)
    ledger.record(USAGE_KIND.llmRequests, 1, { detail: 'p/a' })
    ledger.record(USAGE_KIND.llmInput, 100, { detail: 'p/a' })
    ledger.record(USAGE_KIND.llmCacheRead, 900, { detail: 'p/a' })
    ledger.record(USAGE_KIND.llmOutput, 50, { detail: 'p/a' })
    // The switch: the same prefix is re-billed uncached, so the hit rate drops.
    ledger.record(USAGE_KIND.llmRequests, 1, { detail: 'p/b' })
    ledger.record(USAGE_KIND.llmInput, 1000, { detail: 'p/b' })
    ledger.record(USAGE_KIND.llmCacheRead, 0, { detail: 'p/b' })
    ledger.record(USAGE_KIND.llmCacheWrite, 1000, { detail: 'p/b' })
    // Events without a model label never form a bucket of their own.
    ledger.record(USAGE_KIND.llmRequests, 1)
    const summary = ledger.summary(7)
    // Same request count, so the tie breaks alphabetically.
    expect(summary.models.map(model => model.model)).toEqual(['p/a', 'p/b'])
    const a = summary.models.find(model => model.model === 'p/a')
    const b = summary.models.find(model => model.model === 'p/b')
    expect(a).toEqual({
      model: 'p/a',
      requests: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      cacheHitRate: 0.9,
    })
    expect(b?.cacheHitRate).toBe(0)
    // The blended total still reports every request, labelled or not.
    expect(summary.llm.requests).toBe(3)
  })

  it('reports no model buckets when the store cannot aggregate by detail', () => {
    const fake = makeStore()
    const { ledger } = makeLedger(fake)
    // Exercising a store that predates the optional aggregation.
    delete (fake.store as { usageTotalsByDetail?: unknown }).usageTotalsByDetail
    ledger.record(USAGE_KIND.llmRequests, 1, { detail: 'p/a' })
    expect(ledger.summary(7).models).toEqual([])
  })

  it('lists the newest events first and survives a broken store', () => {
    const fake = makeStore()
    const { ledger, warnings } = makeLedger(fake)
    ledger.record(USAGE_KIND.injectTokens, 1, { sessionId: 'a' })
    ledger.record(USAGE_KIND.injectTokens, 2, { sessionId: 'b' })
    expect(ledger.recent(1).map(event => event.sessionId)).toEqual(['b'])
    expect(ledger.totals()).toEqual([{ kind: 'inject_tokens', events: 2, value: 3 }])
    fake.failing = true
    expect(() => ledger.record(USAGE_KIND.injectTokens, 3)).not.toThrow()
    expect(ledger.totals()).toEqual([])
    expect(ledger.recent()).toEqual([])
    expect(ledger.prune()).toBe(0)
    expect(ledger.summary().events).toBe(0)
    // 4 store reads + the per-model aggregation all fail and warn.
    expect(warnings).toHaveLength(6)
  })
})
