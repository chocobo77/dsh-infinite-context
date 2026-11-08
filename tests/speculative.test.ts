import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  rebaseAnchorSeq,
  regionMessagesFingerprint,
  regionStableFingerprint,
  speculationAnchorsAlive,
  selectFoldRange,
  summarizationFingerprint,
} from '../src/memory-compaction.ts'
import { resolveSpeculativeFold } from '../src/config.ts'

describe('summarizationFingerprint', () => {
  const input = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'fix the login crash' }] },
    ],
  }

  it('is stable for identical inputs and differs on any message text', () => {
    expect(summarizationFingerprint(input)).toBe(summarizationFingerprint(input))
    const changed = {
      messages: [...input.messages, { role: 'user', content: [{ type: 'text', text: 'more' }] }],
    }
    expect(summarizationFingerprint(changed)).not.toBe(summarizationFingerprint(input))
    const edited = {
      messages: [
        input.messages[0]!,
        { role: 'user', content: [{ type: 'text', text: 'fix the login crash NOW' }] },
      ],
    }
    expect(summarizationFingerprint(edited)).not.toBe(summarizationFingerprint(input))
  })

  it('reads only text: non-text blocks add nothing, new messages do', () => {
    // An image block INSIDE an existing message contributes no text, so the
    // fingerprint — the summary's contract — is unchanged.
    const withImage = {
      messages: [
        input.messages[0]!,
        {
          role: 'user',
          content: [
            { type: 'text', text: 'fix the login crash' },
            { type: 'image', mimeType: 'image/png' },
          ],
        },
      ],
    }
    expect(summarizationFingerprint(withImage)).toBe(summarizationFingerprint(input))
    // A NEW message (even one the summarizer reads as empty) is a new input.
    const withExtra = {
      messages: [
        ...input.messages,
        { role: 'tool', content: [{ type: 'image', mimeType: 'image/png' }] },
      ],
    }
    expect(summarizationFingerprint(withExtra)).not.toBe(summarizationFingerprint(input))
    expect(summarizationFingerprint({ ...input, tools: [{ name: 'bash' }] as never }))
      .not.toBe(summarizationFingerprint(input))
  })
})

describe('resolveSpeculativeFold', () => {
  it('defaults on and honours an explicit false', () => {
    expect(resolveSpeculativeFold({})).toBe(true)
    expect(resolveSpeculativeFold({ speculative_fold: false })).toBe(false)
  })
})

/**
 * A minimal fake session for range selection: surface nodes are 1-based seqs,
 * every event is a plain message of the given type, no tool pairing anywhere
 * (so the pairing guard keeps every cut).
 */
function fakeSession(types: string[]): Session {
  const nodes = types.map((_, i) => (i + 1) as never)
  return {
    surface: { nodes, replaceGeneration: 0 },
    seq: types.length + 1,
    eventAt: (seq: number) => {
      const type = types[Number(seq) - 1]
      return {
        seq,
        type,
        data: {
          message: {
            role: type === 'assistant/message' ? 'assistant' : 'user',
            content: [],
          },
        },
      }
    },
    requestHeader: () => undefined,
  } as unknown as Session
}

/** A measurement pricing each node individually. */
function fakeMeasurement(nodeTokens: readonly number[]): Parameters<typeof selectFoldRange>[1] {
  return {
    nodes: nodeTokens.map((tokens, i) => ({ seq: (i + 1) as never, tokens })),
  } as Parameters<typeof selectFoldRange>[1]
}

describe('selectFoldRange high-value cut boundary', () => {
  // firstFoldableIndex pins the leading system+first-user pair, so fixtures
  // lead with [system, u] and the range starts at index 2.
  it('extends the kept tail over a trailing user message', () => {
    // The naive cut (keepFromIdx=5) folds u2 — the user message whose answer
    // a3 stays verbatim — context inversion. The nudge walks the kept tail
    // back over u2 (cheap: 10 tokens ≤ 15% budget) and stops at a3.
    const session = fakeSession(['system/message', 'user/message', 'assistant/message', 'assistant/message', 'user/message', 'assistant/message', 'user/message'])
    const range = selectFoldRange(session, fakeMeasurement([10, 10, 1000, 1000, 10, 1000, 1000]), 1010)
    expect(range).toEqual({ start: 3, end: 4 })
  })

  it('stops at an assistant boundary and at the token budget', () => {
    // Boundary is an assistant message: no extension (u2/u3 fold despite
    // being user messages — the digest preserves their words).
    const plain = fakeSession(['system/message', 'user/message', 'assistant/message', 'assistant/message', 'assistant/message', 'user/message', 'user/message'])
    expect(selectFoldRange(plain, fakeMeasurement([10, 10, 1000, 1000, 1000, 10, 1000]), 1010))
      .toEqual({ start: 3, end: 5 })
    // An expensive user message over the 15% boundary budget is not kept.
    const expensive = fakeSession(['system/message', 'user/message', 'assistant/message', 'user/message', 'assistant/message', 'user/message'])
    expect(selectFoldRange(expensive, fakeMeasurement([10, 10, 1000, 1000, 1000, 1000]), 1010))
      .toEqual({ start: 3, end: 4 })
  })
})

describe('selectFoldRange goal-conditioned importance', () => {
  // firstFoldableIndex pins [system, u]; the naive cut is before a3 — the
  // boundary node is an ASSISTANT message the task-state marked on-topic.
  it('keeps an on-topic assistant node the role rule alone would fold', () => {
    const session = fakeSession(['system/message', 'user/message', 'assistant/message', 'assistant/message', 'assistant/message', 'user/message', 'user/message'])
    const keep = new Set([5 as never]) // a3's seq
    // a3 is CHEAP (10 tokens) so the 15% boundary budget does not block the
    // keep - the test isolates the importance signal from the budget gate.
    const without = selectFoldRange(session, fakeMeasurement([10, 10, 1000, 1000, 10, 10, 1000]), 1010)
    expect(without).toEqual({ start: 3, end: 5 })
    const withImportance = selectFoldRange(session, fakeMeasurement([10, 10, 1000, 1000, 10, 10, 1000]), 1010, keep)
    expect(withImportance).toEqual({ start: 3, end: 4 })
  })

  it('the importance set cannot push the cut past the foldable start', () => {
    const session = fakeSession(['system/message', 'user/message', 'assistant/message'])
    const keep = new Set([2 as never, 3 as never])
    expect(selectFoldRange(session, fakeMeasurement([10, 1000, 1000]), 1010, keep)).toBeNull()
  })
})

describe('selectFoldRange pressure escalation', () => {
  // Same pinned head as the boundary tests: fixtures lead with [system, u].
  it('widens the range node-by-node until it clears minimumTokens', () => {
    // A monster tail node overshoots retain=1010: the naive range [3,3] holds
    // only 1000 tokens — below the 1200 minimum. Escalation joins the next
    // node until the sum crosses it (bounded at the FIRST crossing).
    const session = fakeSession(['system/message', 'user/message', 'assistant/message', 'assistant/message', 'user/message'])
    expect(selectFoldRange(session, fakeMeasurement([10, 10, 1000, 1000, 10]), 1010, undefined, 1200))
      .toEqual({ start: 3, end: 4 })
  })

  it('stops escalating before the newest node even below the minimum', () => {
    // The minimum is unreachable without folding the newest nodes — widening
    // stops at the protective bound and returns what it has (the caller's
    // small-fold gate stays the backstop).
    const session = fakeSession(['system/message', 'user/message', 'assistant/message', 'assistant/message', 'user/message', 'assistant/message'])
    expect(selectFoldRange(session, fakeMeasurement([10, 10, 100, 100, 10, 10]), 25, undefined, 1200))
      .toEqual({ start: 3, end: 5 })
  })

  it('minimumTokens=0 reproduces the unescalated selection byte-for-byte', () => {
    const session = fakeSession(['system/message', 'user/message', 'assistant/message', 'assistant/message', 'user/message', 'assistant/message', 'user/message'])
    expect(selectFoldRange(session, fakeMeasurement([10, 10, 1000, 1000, 10, 1000, 1000]), 1010, undefined, 0))
      .toEqual({ start: 3, end: 4 })
  })
})

describe('regionMessagesFingerprint consume contract', () => {
  const region = [
    { role: 'user', content: [{ type: 'text', text: 'fix the login crash' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'the crash is in auth.ts' }] },
  ] as const

  it('matches across builder preambles and tool churn (the production miss)', () => {
    // Mirror the production pipeline: both call sites strip their leading
    // system preamble (shadowedMessages) before hashing the projection.
    const strip = (messages: readonly unknown[]) =>
      (messages[0] as { role: string }).role === 'system' ? messages.slice(1) : messages
    // Prepare side: the plugin builder — session system head, header tools.
    const prepared = regionMessagesFingerprint(strip([
      { role: 'system', content: [{ type: 'text', text: 'session system head' }] },
      ...region,
    ]))
    // Consume side: the BASE engine's rebuild — its OWN preamble and the
    // request's CURRENT tools. The full-input hash broke on exactly this
    // (production: 0 hits in 11 launches); the region projection must not.
    const consumed = regionMessagesFingerprint(strip([
      { role: 'system', content: [{ type: 'text', text: 'compaction summarizer prompt v2' }] },
      ...region,
    ]))
    expect(consumed).toBe(prepared)
    // And the old hash demonstrably DID diverge here — this is the regression.
    const fullA = { messages: [...region], tools: [{ name: 'toolA' }] }
    const fullB = { messages: [...region], tools: [{ name: 'toolB' }] }
    expect(summarizationFingerprint(fullA as never)).not.toBe(summarizationFingerprint(fullB as never))
  })

  it('still misses when a region message is edited or appended', () => {
    const base = regionMessagesFingerprint(region)
    expect(regionMessagesFingerprint([
      region[0]!,
      { role: 'assistant', content: [{ type: 'text', text: 'the crash is in auth2.ts' }] },
    ])).not.toBe(base)
    expect(regionMessagesFingerprint([
      ...region,
      { role: 'user', content: [{ type: 'text', text: 'go on' }] },
    ])).not.toBe(base)
  })
})

describe('speculationAnchorsAlive', () => {
  const surface = [5, 12, 17, 40, 41, 88] as const

  it('accepts a range whose anchors both exist', () => {
    expect(speculationAnchorsAlive(surface, 12, 88)).toBe(true)
    expect(speculationAnchorsAlive(surface, 5, 5)).toBe(true) // single-node range
  })

  it('rejects a range whose start was retired by a surface rewrite (the ghost anchor)', () => {
    expect(speculationAnchorsAlive(surface, 918, 88)).toBe(false)
    expect(speculationAnchorsAlive(surface, 12, 90)).toBe(false)
    expect(speculationAnchorsAlive([], 5, 5)).toBe(false)
  })
})

describe('regionStableFingerprint drift tiers', () => {
  // Tool messages are user-role with source {kind:'tool', callId} — the
  // stable tier keys them by callId because archive stubbing / memory_expand
  // / absorb digests rewrite their TEXT in place while the callId (and the
  // recoverable information) stays constant.
  const conv = [
    { role: 'user', content: [{ type: 'text', text: 'fix the login crash' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reading auth.ts' }] },
  ]
  const tool = (callId: string, text: string) => ({
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{ type: 'text', text }],
  })
  const prepared = [conv[0]!, tool('call-1', 'FULL FILE CONTENT ~40KB ...'), conv[1]!]

  it('survives tool-text drift (the 7-of-9 production loss): stub, restore, digest', () => {
    const stable = regionStableFingerprint(prepared)
    expect(regionStableFingerprint([
      conv[0]!, tool('call-1', 'tr_abc [digest: 12 signal lines]'), conv[1]!,   // stub write
    ])).toBe(stable)
    expect(regionStableFingerprint([
      conv[0]!, tool('call-1', 'FULL FILE CONTENT ~40KB ... RESTORED'), conv[1]!, // memory_expand
    ])).toBe(stable)
    // ...while the STRICT tier demonstrably broke on exactly this — the
    // regression this tier exists for.
    expect(regionMessagesFingerprint(prepared))
      .not.toBe(regionMessagesFingerprint([conv[0]!, tool('call-1', 'tr_abc [digest]'), conv[1]!]))
  })

  it('still catches conversational edits, additions, and callId swaps', () => {
    const stable = regionStableFingerprint(prepared)
    expect(regionStableFingerprint([
      { role: 'user', content: [{ type: 'text', text: 'fix the login crash NOW' }] },
      tool('call-1', 'FULL FILE CONTENT ~40KB ...'),
      conv[1]!,
    ])).not.toBe(stable)
    expect(regionStableFingerprint([...prepared, { role: 'user', content: [{ type: 'text', text: 'go on' }] }]))
      .not.toBe(stable)
    expect(regionStableFingerprint([conv[0]!, tool('call-9', 'FULL FILE CONTENT ~40KB ...'), conv[1]!]))
      .not.toBe(stable)
  })
})

describe('rebaseAnchorSeq (stub-replace survival)', () => {
  // The tool archive writes its stub with surfaceOp replace: the old seq is
  // RETIRED and a new seq takes the position, carrying the SAME callId.
  const nodes = [12, 13, 15, 40, 41] as const
  const callIdAt = (seq: number) => (seq === 41 ? 'call-1' : undefined) // post-replace position

  it('keeps a live anchor untouched', () => {
    expect(rebaseAnchorSeq(nodes, 13, 'call-9', () => undefined)).toBe(13)
    expect(rebaseAnchorSeq(nodes, 13, undefined, () => undefined)).toBe(13)
  })

  it('follows a stub replace: retired seq, same callId at a new seq', () => {
    // seq 14 was retired by the replace; its callId now lives at 41.
    expect(rebaseAnchorSeq(nodes, 14, 'call-1', callIdAt)).toBe(41)
  })

  it('rejects a genuinely dead anchor: no callId, or callId folded away', () => {
    expect(rebaseAnchorSeq(nodes, 14, undefined, callIdAt)).toBe(null)
    expect(rebaseAnchorSeq(nodes, 14, 'call-gone', callIdAt)).toBe(null)
    expect(rebaseAnchorSeq([], 14, 'call-1', callIdAt)).toBe(null)
  })
})
