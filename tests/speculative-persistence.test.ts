/**
 * The SPECULATIVE-HIT commit lifecycle (regression: production session
 * e8d3bbf8, 2026-11-11). The first speculative hit in production exposed
 * that the hit path returned the precomputed summary EARLY — skipping the
 * folded-range archive, the checkpoint memory, the savings record and the
 * task-state rebuild. A hit fold landed unrecoverable at the plugin layer.
 * The fix routes both paths through postSummarize(); these tests drive the
 * real prototype method with only the fields it touches.
 */
import { describe, expect, it } from 'vitest'
import {
  MemoryCompactionEngine,
  regionMessagesFingerprint,
  regionStableFingerprint,
} from '../src/memory-compaction.ts'

const SID = 'sess-hit-test'

/** A compacted region: system head + user/tool/assistant (shadowed = the tail). */
const regionMessages = [
  { role: 'system', content: [{ type: 'text', text: 'session head' }] },
  { role: 'user', content: [{ type: 'text', text: 'fix the login crash in src/auth.ts, see error below' }] },
  {
    role: 'user',
    source: { kind: 'tool', callId: 'call-1' },
    content: [{ type: 'text', text: 'ENOENT: no such file or directory src/auth.ts\n22 tests passed' }],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'the crash is in src/auth.ts line 42' }] },
]

/** The prepared summary the background call produced (long: must be clipped). */
const preparedSummary = '## Primary Request and Intent\n- fix the login crash\n## Files and Code\n- src/auth.ts\n## Next Step\n- '
  + 'patch the resolver and rerun the suite\n'.repeat(60)

function buildEngine() {
  const archived: { sessionId: string; messages: readonly unknown[]; text: string }[] = []
  const stored: { text: string; tier: string; kind?: string }[] = []
  const ledger: { kind: string; value: number; detail?: string }[] = []
  const taskStates: { sessionId: string; state: string }[] = []
  const shadowed = regionMessages.slice(1)

  const engine = Object.create(MemoryCompactionEngine.prototype) as unknown as {
    summarize: (input: unknown, agent: unknown, signal?: unknown) => Promise<{
      summary: { type: string; text?: string }[]
      provider?: string
    }>
    speculative: Map<string, unknown>
    lastSummarizeDegraded: WeakMap<object, boolean>
    ctx: unknown
    usage: unknown
    compressor: unknown
    config: unknown
    foldEvidenceCheck: boolean
  }

  engine.speculative = new Map([[SID, {
    summary: [{ type: 'text', text: preparedSummary }],
    regionFingerprint: regionMessagesFingerprint(shadowed as never),
    stableFingerprint: regionStableFingerprint(shadowed as never),
  }]])
  engine.lastSummarizeDegraded = new WeakMap()
  engine.config = { summarizationProvider: '', summarizationModel: '' }
  engine.foldEvidenceCheck = false
  engine.ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    memoryContext: {
      storeMemory: async (text: string, tier: string, meta: { kind?: string }) => {
        stored.push({ text, tier, ...(meta.kind === undefined ? {} : { kind: meta.kind }) })
        return { id: 'mem-1' }
      },
      supersedePrior: () => 0,
      rebalance: async () => ({
        pyramid: { merged: null, demotedMids: [] },
        forgetting: { dropped: [] },
      }),
    },
  }
  engine.usage = {
    record: (kind: string, value: number, meta: { sessionId?: string; detail?: string }) => {
      ledger.push({ kind, value, ...(meta.detail === undefined ? {} : { detail: meta.detail }) })
    },
  }
  engine.compressor = {
    estimateMessageTokens: (messages: readonly { content?: unknown }[]) => messages
      .reduce((sum, m) => sum + (Array.isArray(m.content)
        ? (m.content as { text?: string }[]).reduce((s, b) => s + (b.text ?? '').length, 0)
        : String(m.content ?? '').length), 0) / 4,
    taskStateOf: () => undefined,
    recordTaskState: (sessionId: string, state: string) => { taskStates.push({ sessionId, state }) },
    archiveFoldedRange: (sessionId: string, messages: readonly unknown[], text: string) => {
      archived.push({ sessionId, messages, text })
      return 'Folded range archived as ref=fl_ab12cd34ef56 — memory_expand {"ref":"fl_ab12cd34ef56"} to read it back.'
    },
  }
  return { engine, archived, stored, ledger, taskStates }
}

describe('speculative-hit commit lifecycle (e8d3bbf8 regression)', () => {
  it('a consumed speculative summary archives, checkpoints, records and rebuilds task state', async () => {
    const { engine, archived, stored, ledger, taskStates } = buildEngine()
    const agent = { session: { id: SID } }
    const result = await engine.summarize({ messages: regionMessages }, agent, undefined)

    // The hit was consumed...
    expect(ledger.some(e => e.detail === 'speculative:hit')).toBe(true)
    // ...and the fold is RECOVERABLE: the range was archived and the fl_ ref
    // was prefixed onto the surface summary.
    expect(archived).toHaveLength(1)
    expect(archived[0]?.text).toContain('fix the login crash')
    expect(archived[0]?.messages).toHaveLength(regionMessages.length - 1)
    expect(String(result.summary[0]?.text ?? '')).toContain('fl_ab12cd34ef56')
    // The mid-tier checkpoint landed (supersede chain continues).
    expect(stored).toHaveLength(1)
    expect(stored[0]?.kind).toBe('checkpoint')
    expect(stored[0]?.text).toContain('## Primary Request and Intent')
    // The savings are on the ledger (one row per committed fold).
    expect(ledger.some(e => e.kind === 'compaction_saved_tokens')).toBe(true)
    // Task state was rebuilt from this fold's structured sections.
    expect(taskStates).toHaveLength(1)
    expect(result.provider).toBe('precomputed')
  })

  it('the precomputed summary is clipped to the same budget as a live one', async () => {
    const { engine } = buildEngine()
    const result = await engine.summarize({ messages: regionMessages }, { session: { id: SID } }, undefined)
    // preparedSummary is ~2.4k chars over the region's 1024-char budget floor:
    // the budget clip must have fired on the consumed copy too.
    const joined = result.summary.map(b => b.text ?? '').join('\n')
    expect(joined).toContain('[truncated]')
    expect(joined.length).toBeLessThan(preparedSummary.length)
  })

  it('a fingerprint mismatch dies as a miss and persists nothing', async () => {
    const { engine, archived, stored, ledger } = buildEngine()
    // Break the contract: the region text drifted, so the prepared summary is
    // no longer a valid replacement — the entry must be dropped and the live
    // summarizer take over instead.
    engine.speculative = new Map([[SID, {
      summary: [{ type: 'text', text: preparedSummary }],
      regionFingerprint: 'stale-fingerprint',
      stableFingerprint: 'stale-fingerprint',
    }]])
    // The own-region validity probe fails (the fake session cannot rebase),
    // so the entry dies outright; the live path is stubbed to fail so the
    // test asserts only the miss bookkeeping, not summarizer resilience.
    const shim = engine as unknown as {
      rebaseSpeculation: (s: string, sess: unknown, e: unknown) => unknown
      summarizeResilient: () => Promise<never>
    }
    shim.rebaseSpeculation = () => null
    shim.summarizeResilient = () => Promise.reject(new Error('no live summarizer in the harness'))
    await expect(engine.summarize(
      { messages: regionMessages },
      { session: { id: SID } },
      undefined,
    )).rejects.toThrow('no live summarizer')
    expect(ledger.some(e => e.detail === 'speculative:miss')).toBe(true)
    // Nothing speculative persisted on a miss.
    expect(archived).toHaveLength(0)
    expect(stored).toHaveLength(0)
  })
})
