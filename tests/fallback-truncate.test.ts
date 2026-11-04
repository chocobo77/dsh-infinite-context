import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import { fallbackTruncate } from '../src/memory-compaction.ts'

/** A text message with a repeated filler body of ~`words` × 4-char tokens. */
function msg(role: 'user' | 'assistant' | 'tool', text: string, toolBlocks = false): Message {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
  if (toolBlocks) {
    content.unshift({ type: 'tool-call', name: 'bash', arguments: '{}' })
    content.push({ type: 'tool-result', text: 'result' })
  }
  return { role, content } as unknown as Message
}

const long = (marker: string): string => marker.repeat(200)

describe('fallbackTruncate phase-3 pins (2026-11-05 review)', () => {
  it('never drops the LATEST user message even when a tool-result tail fills the window', () => {
    // u0 asks; a1+t1..t3 are the call and its results — a count-only window
    // of 4 shifted the question out first and kept the answers.
    const messages = [
      msg('user', 'question that matters'),
      msg('assistant', long('a'), true),
      msg('tool', long('t'), true),
      msg('tool', long('t'), true),
      msg('tool', long('t'), true),
    ]
    const result = fallbackTruncate(messages, 100, 4)
    expect(result.some(m => m.role === 'user' && JSON.stringify(m.content).includes('question that matters')))
      .toBe(true)
  })

  it('never shifts a message carrying tool-call/tool-result blocks (pair orphaning)', () => {
    const messages = [
      msg('assistant', long('a'), true),
      msg('tool', long('t'), true),
      msg('user', 'question'),
      msg('assistant', 'short answer'),
    ]
    const result = fallbackTruncate(messages, 100, 1)
    // The shift stops at the tool-carrying head: the pair survives intact…
    expect(result.some(m => JSON.stringify(m.content).includes('tool-call'))).toBe(true)
    expect(result.some(m => JSON.stringify(m.content).includes('tool-result'))).toBe(true)
    // …and the latest user message is still there.
    expect(result.some(m => m.role === 'user')).toBe(true)
  })

  it('still drops plain oldest messages when nothing is pinned', () => {
    const messages = [
      msg('user', long('u0')),
      msg('assistant', long('a1')),
      msg('user', long('u2')),
      msg('assistant', long('a3')),
      msg('user', 'final question'),
      msg('assistant', 'final answer'),
    ]
    const result = fallbackTruncate(messages, 200, 2)
    // Everything before the last user+answer pair is gone; the pair remains.
    expect(result.some(m => JSON.stringify(m.content).includes('final question'))).toBe(true)
    expect(result.some(m => JSON.stringify(m.content).includes('final answer'))).toBe(true)
    expect(result.some(m => JSON.stringify(m.content).includes('u0'))).toBe(false)
  })
})
