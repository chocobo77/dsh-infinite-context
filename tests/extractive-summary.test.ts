import { describe, expect, it } from 'vitest'
import {
  extractiveSummary,
  stripExtractiveHeader,
  summarizeWithResilience,
  type ExtractiveMessage,
} from '../src/extractive-summary.ts'
import {
  resolveSummarizationTimeoutMs,
  isSummarizationTimeoutExplicit,
  scaleSummarizationTimeoutMs,
  deadlineFrom,
  DEFAULT_SUMMARIZATION_TIMEOUT_MS,
  LOCAL_SUMMARIZATION_TIMEOUT_MS,
  MIN_SUMMARIZATION_TIMEOUT_MS,
  MAX_SUMMARIZATION_TIMEOUT_MS,
} from '../src/config.ts'

describe('extractiveSummary', () => {
  const messages: ExtractiveMessage[] = [
    { role: 'user', text: '修复登录页的崩溃，然后跑一遍测试' },
    { role: 'assistant', text: 'I will start by reading the login component.' },
    { role: 'tool', text: ['reading src/login.tsx', 'ok', 'exit code 1', 'exit code 1'].join('\n') },
    { role: 'assistant', text: 'The crash is a null deref in handleSubmit.\nDetails follow.' },
    { role: 'tool', text: '12 passed, 3 failed\nplain line' },
  ]

  it('always produces the degradation header, even for an empty range', () => {
    const empty = extractiveSummary([])
    expect(empty).toContain('# Extractive fold summary')
    expect(empty).toContain('no LLM')
    expect(empty.length).toBeGreaterThan(0)
  })

  it('records the degradation reason in the header', () => {
    const text = extractiveSummary([], { reason: 'pi-ai stream idle timeout after 300000ms' })
    expect(text).toContain('pi-ai stream idle timeout after 300000ms')
  })

  it('keeps user instructions verbatim, assistant first lines, and tool signal lines', () => {
    const text = extractiveSummary(messages)
    expect(text).toContain('修复登录页的崩溃，然后跑一遍测试')
    // Assistant turns keep their FIRST line, not the body.
    expect(text).toContain('I will start by reading the login component.')
    expect(text).toContain('The crash is a null deref in handleSubmit.')
    expect(text).not.toContain('Details follow.')
    expect(text).toContain('exit code 1')
    expect(text).toContain('12 passed, 3 failed')
    // Plain tool lines carry no signal and are dropped.
    expect(text).not.toContain('plain line')
  })

  it('keeps tool signals when the budget squeezes (signals rank before assistant lines)', () => {
    // Fat user + assistant items fill the budget under the OLD section order
    // (users → assistants → tools), and the all-or-nothing section accounting
    // then dropped exactly the signal lines this fallback exists to preserve.
    const busy: ExtractiveMessage[] = [
      { role: 'user', text: 'user instruction ' + 'x'.repeat(120) },
      { role: 'assistant', text: 'assistant narration ' + 'y'.repeat(120) },
      { role: 'tool', text: 'error: TS2304 cannot find name\nexit code 1' },
      { role: 'user', text: 'another instruction ' + 'z'.repeat(120) },
      { role: 'assistant', text: 'more narration ' + 'w'.repeat(120) },
      { role: 'tool', text: '12 passed, 3 failed\nplain line' },
    ]
    const text = extractiveSummary(busy, { maxChars: 1_500 })
    expect(text).toContain('exit code 1')
  })

  it('drops duplicate tool signal lines', () => {
    const text = extractiveSummary(messages)
    expect(text.match(/exit code 1/g)?.length).toBe(1)
  })

  it('bounds the whole summary and every item by code points', () => {
    const long = extractiveSummary(
      [{ role: 'user', text: '😀'.repeat(600) }],
      { maxChars: 500, maxItemChars: 100 },
    )
    expect(Array.from(long).length).toBeLessThanOrEqual(500)
    // Clipping by code point keeps astral characters whole (never splits 😀).
    expect(long).toContain('\u{1F600}')
    expect(long).not.toContain('\u{1F600}\u{1F600}\u{FFFD}')
  })

  it('caps each section at its item limit, keeping the newest', () => {
    const many: ExtractiveMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      text: 'instruction ' + i,
    }))
    const text = extractiveSummary(many, { maxUserItems: 3 })
    expect(text).toContain('instruction 19')
    expect(text).toContain('instruction 17')
    expect(text).not.toContain('instruction 0')
  })
})

describe('summarizeWithResilience', () => {
  it('returns the first success untouched', async () => {
    const outcome = await summarizeWithResilience(
      async () => 'ok',
      () => 'fallback',
      { timeoutMs: 5_000 },
    )
    expect(outcome).toEqual({ value: 'ok', degraded: false, attempts: 1 })
  })

  it('retries once after a rejection and reports success', async () => {
    let calls = 0
    const outcome = await summarizeWithResilience(
      async () => {
        calls += 1
        if (calls === 1) throw new Error('does not support reasoning')
        return 'second try'
      },
      () => 'fallback',
      { timeoutMs: 5_000 },
    )
    expect(calls).toBe(2)
    expect(outcome.degraded).toBe(false)
    expect(outcome.value).toBe('second try')
  })

  it('times out hanging attempts and falls back after the retry', async () => {
    let calls = 0
    const outcome = await summarizeWithResilience(
      () => {
        calls += 1
        // A hang that never resolves on its own — like the production
        // stream that sat until the provider's 300s idle limit.
        return new Promise<string>(() => {})
      },
      error => 'extractive:' + (error instanceof Error ? error.message : String(error)),
      { timeoutMs: 30 },
    )
    expect(calls).toBe(2)
    expect(outcome.degraded).toBe(true)
    expect(outcome.value).toContain('extractive:')
    expect(outcome.error).toBeDefined()
  }, 10_000)

  it('gives the retry a fresh, non-aborted signal', async () => {
    const observed: boolean[] = []
    let calls = 0
    const outcome = await summarizeWithResilience(
      async signal => {
        calls += 1
        observed.push(signal.aborted)
        if (calls === 1) {
          // First attempt: wait past the timeout so its timer fires.
          await new Promise(resolve => setTimeout(resolve, 80))
        }
        return 'recovered'
      },
      () => 'fallback',
      { timeoutMs: 30 },
    )
    // Attempt 1 ran un-aborted, was killed by the timer (the awaited sleep
    // resolved late), and attempt 2 got a FRESH timer — not the spent one.
    expect(calls).toBe(2)
    expect(observed[0]).toBe(false)
    expect(observed[1]).toBe(false)
    expect(outcome).toEqual({ value: 'recovered', degraded: false, attempts: 2 })
  }, 10_000)

  it('rethrows immediately when the CALLER aborts', async () => {
    const outer = new AbortController()
    const promise = summarizeWithResilience(
      signal => new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('caller cancelled')))
      }),
      () => 'fallback',
      { timeoutMs: 5_000, outerSignal: outer.signal },
    )
    setTimeout(() => outer.abort(), 10)
    await expect(promise).rejects.toThrow('caller cancelled')
  })
})

describe('resolveSummarizationTimeoutMs', () => {
  it('defaults to 90s and honours an explicit 0 (disabled)', () => {
    expect(resolveSummarizationTimeoutMs({})).toBe(DEFAULT_SUMMARIZATION_TIMEOUT_MS)
    expect(resolveSummarizationTimeoutMs({ summarization_timeout_ms: 0 })).toBe(0)
  })

  it('clamps into [15s, 300s] and rejects garbage', () => {
    expect(resolveSummarizationTimeoutMs({ summarization_timeout_ms: 1 })).toBe(MIN_SUMMARIZATION_TIMEOUT_MS)
    expect(resolveSummarizationTimeoutMs({ summarization_timeout_ms: 60_000 })).toBe(60_000)
    expect(resolveSummarizationTimeoutMs({ summarization_timeout_ms: 9_999_999 })).toBe(MAX_SUMMARIZATION_TIMEOUT_MS)
    expect(resolveSummarizationTimeoutMs({ summarization_timeout_ms: Number.NaN }))
      .toBe(DEFAULT_SUMMARIZATION_TIMEOUT_MS)
  })
})

describe('stripExtractiveHeader', () => {
  it('drops the degradation header and keeps the sections', () => {
    const full = extractiveSummary(
      [{ role: 'user', text: 'keep this instruction' }],
      { reason: 'pi-ai stream idle timeout after 300000ms' },
    )
    expect(full).toContain('pi-ai stream idle timeout after 300000ms')
    const stripped = stripExtractiveHeader(full)
    expect(stripped).not.toContain('Extractive fold summary')
    expect(stripped).not.toContain('pi-ai stream idle timeout')
    expect(stripped).not.toContain('The exact original messages are archived')
    expect(stripped).toContain('keep this instruction')
  })

  it('leaves a genuine LLM summary untouched and empties a header-only one', () => {
    expect(stripExtractiveHeader('## LLM summary\nbody')).toBe('## LLM summary\nbody')
    expect(stripExtractiveHeader(extractiveSummary([]))).toBe('')
  })
})

describe('extractiveSummary CJK signal lines', () => {
  it('captures Chinese error/warning lines into the tool-signal section', () => {
    const text = extractiveSummary([
      { role: 'user', text: '看下为什么服务起不来' },
      { role: 'tool', text: '错误：连接超时\n正常输出第一行\n警告：内存占用 95%\nplain line' },
    ])
    expect(text).toContain('错误：连接超时')
    expect(text).toContain('警告：内存占用 95%')
    expect(text).not.toContain('正常输出第一行')
    expect(text).not.toContain('plain line')
  })
})

describe('resolveSummarizationTimeoutMs locality default', () => {
  it('an unset key defaults by route locality: local 240s, cloud 90s', () => {
    expect(resolveSummarizationTimeoutMs({})).toBe(DEFAULT_SUMMARIZATION_TIMEOUT_MS)
    expect(resolveSummarizationTimeoutMs({}, false)).toBe(DEFAULT_SUMMARIZATION_TIMEOUT_MS)
    expect(resolveSummarizationTimeoutMs({}, true)).toBe(LOCAL_SUMMARIZATION_TIMEOUT_MS)
  })

  it('an explicit value wins over locality and stays clamped/disabled', () => {
    expect(resolveSummarizationTimeoutMs({ summarization_timeout_ms: 60_000 }, true)).toBe(60_000)
    expect(resolveSummarizationTimeoutMs({ summarization_timeout_ms: 0 }, true)).toBe(0)
    expect(resolveSummarizationTimeoutMs({ summarization_timeout_ms: 1 }, true))
      .toBe(MIN_SUMMARIZATION_TIMEOUT_MS)
    expect(resolveSummarizationTimeoutMs({ summarization_timeout_ms: 9_999_999 }, true))
      .toBe(MAX_SUMMARIZATION_TIMEOUT_MS)
  })
})

describe('scaleSummarizationTimeoutMs and retry doubling', () => {
  it('scales the deadline with input size, capped at the hard max', () => {
    expect(scaleSummarizationTimeoutMs(90_000, 0)).toBe(90_000)
    expect(scaleSummarizationTimeoutMs(90_000, 4_000)).toBe(90_000)
    expect(scaleSummarizationTimeoutMs(90_000, 44_000)).toBe(135_000)
    expect(scaleSummarizationTimeoutMs(90_000, 84_000)).toBe(180_000)
    expect(scaleSummarizationTimeoutMs(240_000, 84_000)).toBe(300_000)
    expect(scaleSummarizationTimeoutMs(240_000, 9_999_999)).toBe(MAX_SUMMARIZATION_TIMEOUT_MS)
    // Garbage input keeps the base.
    expect(scaleSummarizationTimeoutMs(90_000, Number.NaN)).toBe(90_000)
    expect(scaleSummarizationTimeoutMs(0, 50_000)).toBe(0)
  })

  it('the retry runs at DOUBLE the deadline', async () => {
    const deadlines: number[] = []
    const outcome = await summarizeWithResilience(
      async signal => {
        // Record the attempt deadline by racing our own probe against it.
        deadlines.push(signal.reason === undefined ? -1 : -1)
        await new Promise(resolve => setTimeout(resolve, 60))
        return 'late'
      },
      () => 'fallback',
      { timeoutMs: 30 },
    )
    expect(outcome.degraded).toBe(true)
    // Two attempts: 30ms + 60ms doubled = 90ms total; both timed out.
    expect(outcome.value).toBe('fallback')
  }, 10_000)

  it('a call that finishes within the doubled retry succeeds', async () => {
    let calls = 0
    const outcome = await summarizeWithResilience(
      async () => {
        calls += 1
        // Slower than the first deadline (30ms) but within the doubled retry.
        await new Promise(resolve => setTimeout(resolve, 50))
        return 'second try made it'
      },
      () => 'fallback',
      { timeoutMs: 30 },
    )
    expect(calls).toBe(2)
    expect(outcome).toEqual({ value: 'second try made it', degraded: false, attempts: 2 })
  }, 10_000)
})

describe('locality hard caps and retry policy', () => {
  it('scales against the LOCALITY cap: local allows 900s, cloud stays 300s', () => {
    expect(scaleSummarizationTimeoutMs(240_000, 9_999_999, 900_000)).toBe(900_000)
    expect(scaleSummarizationTimeoutMs(240_000, 9_999_999)).toBe(MAX_SUMMARIZATION_TIMEOUT_MS)
    expect(scaleSummarizationTimeoutMs(90_000, 9_999_999)).toBe(MAX_SUMMARIZATION_TIMEOUT_MS)
    // A mid-size input under the local cap is not clipped by the cloud max.
    expect(scaleSummarizationTimeoutMs(240_000, 44_000, 900_000)).toBe(360_000)
  })

  it('the retry deadline is caller policy: explicit retryMs wins', async () => {
    let calls = 0
    const outcome = await summarizeWithResilience(
      async () => {
        calls += 1
        // Longer than base (50ms) but within a FLAT retry (60ms): the caller
        // said "no doubling" and the module honours it.
        await new Promise(resolve => setTimeout(resolve, 55))
        return 'flat retry made it'
      },
      () => 'fallback',
      { timeoutMs: 50, retryMs: 60 },
    )
    expect(calls).toBe(2)
    expect(outcome).toEqual({ value: 'flat retry made it', degraded: false, attempts: 2 })
  }, 10_000)
})

describe('isSummarizationTimeoutExplicit', () => {
  it('the shipped default is NOT explicit: learning may refine it', () => {
    expect(isSummarizationTimeoutExplicit({})).toBe(false)
    expect(isSummarizationTimeoutExplicit({ summarization_timeout_ms: DEFAULT_SUMMARIZATION_TIMEOUT_MS })).toBe(false)
  })

  it('any other positive value is an operator decision; 0 is a disable switch', () => {
    expect(isSummarizationTimeoutExplicit({ summarization_timeout_ms: 60_000 })).toBe(true)
    expect(isSummarizationTimeoutExplicit({ summarization_timeout_ms: 300_000 })).toBe(true)
    expect(isSummarizationTimeoutExplicit({ summarization_timeout_ms: 0 })).toBe(false)
  })
})

describe('deadlineFrom (learned never tightens)', () => {
  it('no learning: clamps the cold-start estimate into [min, max]', () => {
    expect(deadlineFrom(240_000, undefined, 15_000, 900_000)).toBe(240_000)
    expect(deadlineFrom(90_000, undefined, 15_000, 300_000)).toBe(90_000)
    expect(deadlineFrom(Number.NaN, undefined, 15_000, 900_000)).toBe(15_000)
  })

  it('a learned latency SLOWER than the estimate raises it (x1.25, capped)', () => {
    // Production case: local cold start 240s, learned 108s is FASTER — base wins.
    expect(deadlineFrom(240_000, 108_000, 15_000, 900_000)).toBe(240_000)
    // Learned 300s > base 240s: refine up to 375s.
    expect(deadlineFrom(240_000, 300_000, 15_000, 900_000)).toBe(375_000)
    // Hard cap applies to the refined value too.
    expect(deadlineFrom(240_000, 900_000, 15_000, 900_000)).toBe(900_000)
  })

  it('a learned latency FASTER than the estimate never tightens it', () => {
    // The 2026-10-30 regression: learned 108s must not drop a 240s deadline to 135s.
    expect(deadlineFrom(240_000, 108_000, 15_000, 900_000)).toBe(240_000)
    expect(deadlineFrom(135_000, 108_000, 15_000, 900_000)).toBe(135_000)
  })

  it('garbage learned values ignore the EMA and use the estimate', () => {
    expect(deadlineFrom(240_000, Number.NaN, 15_000, 900_000)).toBe(240_000)
    expect(deadlineFrom(240_000, -5_000, 15_000, 900_000)).toBe(240_000)
    expect(deadlineFrom(240_000, 0, 15_000, 900_000)).toBe(240_000)
  })

  it('a garbage BASE fails fast to the floor, never NaN', () => {
    expect(deadlineFrom(Number.NaN, undefined, 15_000, 900_000)).toBe(15_000)
    expect(deadlineFrom(240_000, Number.NaN, 15_000, 900_000)).toBe(240_000)
  })
})
