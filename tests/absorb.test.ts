import { describe, expect, it } from 'vitest'
import {
  ABSORB_MAX_LINE_CHARS,
  DEFAULT_ABSORB_OPTIONS,
  buildDigest,
} from '../src/absorb.ts'

const OPTIONS = { enabled: true, minChars: 100, maxDigestChars: 600 }

/** A realistic oversized tool result: head lines, noise, signals, and a tail. */
function makePayload(): string {
  const lines = ['[test] running suite', 'setup ok', 'connecting to worker']
  for (let i = 0; i < 60; i++) lines.push('noise line ' + i + ' ' + 'x'.repeat(120))
  lines.push('ERROR: boom at src/a.ts:12')
  lines.push('Tests 3 failed | 12 passed')
  lines.push('2 files changed, 5 insertions(+), 1 deletion(-)')
  lines.push('done')
  lines.push('final line')
  return lines.join('\n')
}

describe('buildDigest', () => {
  it('declines when disabled or under the minimum size', () => {
    const payload = makePayload()
    expect(buildDigest('pwsh', payload, { ...OPTIONS, enabled: false })).toBeNull()
    expect(buildDigest('pwsh', 'tiny', OPTIONS)).toBeNull()
    expect(buildDigest('pwsh', 'y'.repeat(2_000), DEFAULT_ABSORB_OPTIONS)).toBeNull()
  })

  it('keeps the header, the head, the signals, and the tail', () => {
    const payload = makePayload()
    const digest = buildDigest('pwsh', payload, OPTIONS)
    expect(digest).not.toBeNull()
    const lines = (digest ?? '').split('\n')
    expect(lines[0]?.startsWith('[pwsh result absorbed: ')).toBe(true)
    expect(lines[0]?.endsWith(' chars / ' + payload.split('\n').length + ' lines]')).toBe(true)
    expect(lines).toContain('[test] running suite')
    expect(lines).toContain('ERROR: boom at src/a.ts:12')
    expect(lines).toContain('Tests 3 failed | 12 passed')
    expect(lines).toContain('2 files changed, 5 insertions(+), 1 deletion(-)')
    expect(lines).toContain('final line')
    // The noise never makes it in, so the digest is a small fraction.
    expect(lines.length).toBeLessThan(20)
  })

  it('clips overlong lines to one line each and drops duplicates', () => {
    const blob = 'ERROR ' + 'y'.repeat(500)
    const payload = ['first line', blob, blob, 'last line', 'z'.repeat(4_500)].join('\n')
    const digest = buildDigest('read', payload, OPTIONS)
    expect(digest).not.toBeNull()
    const lines = (digest ?? '').split('\n')
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(ABSORB_MAX_LINE_CHARS)
    expect(lines.filter(line => line.startsWith('ERROR yyy'))).toHaveLength(1)
  })

  it('never exceeds maxDigestChars and degrades to null for a blank blob', () => {
    const payload = makePayload()
    for (const cap of [120, 240, 600]) {
      const digest = buildDigest('pwsh', payload, { ...OPTIONS, maxDigestChars: cap })
      expect(digest).not.toBeNull()
      expect(Array.from(digest ?? '').length).toBeLessThanOrEqual(cap)
    }
    expect(buildDigest('pwsh', ' '.repeat(5_000), OPTIONS)).toBeNull()
  })
})
