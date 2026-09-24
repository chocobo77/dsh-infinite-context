import { describe, expect, it } from 'vitest'
import { sanitizeToolResult } from '../src/OutputSanitizer.ts'

describe('structured object payloads (manual memory_ingest path)', () => {
  it('web_search: extracts title/snippet, strips HTML, keeps urls, caps at 10', () => {
    const raw = {
      results: [
        { title: '<b>DeepSeek</b> Harness', snippet: '<p>a plugin system</p>', url: 'https://example.com' },
        ...Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, snippet: `s${i}` })),
      ],
      total: 99,
    }
    const out = sanitizeToolResult(raw, 'web_search') as {
      results: { title: string; snippet: string; url?: string }[]
      total: number
    }
    expect(out.results).toHaveLength(10)
    expect(out.results[0].title).toBe('DeepSeek Harness')
    expect(out.results[0].snippet).toBe('a plugin system')
    expect(out.results[0].url).toBe('https://example.com')
    expect(out.total).toBe(99)
  })

  it('code_exec: keeps the tail 200 lines of stdout plus error and exitCode', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`)
    const out = sanitizeToolResult({ stdout: lines.join('\n'), stderr: 'boom', exitCode: 1 }, 'code_exec') as {
      stdout: string
      error?: string
      exitCode?: number
    }
    const kept = out.stdout.split('\n')
    expect(kept).toHaveLength(200)
    expect(kept[0]).toBe('line 50')
    expect(kept[199]).toBe('line 249')
    expect(out.error).toBe('boom')
    expect(out.exitCode).toBe(1)
  })

  it('generic source: recursively truncates long string fields at maxChars', () => {
    const out = sanitizeToolResult(
      { a: 'x'.repeat(3000), nested: { b: 'y'.repeat(3000) } },
      'bash',
      { maxChars: 100 },
    ) as { a: string; nested: { b: string } }
    expect(out.a).toBe('x'.repeat(100) + '…[truncated]')
    expect(out.nested.b).toBe('y'.repeat(100) + '…[truncated]')
  })
})

describe('string payloads (automatic tools/result text path)', () => {
  it('web_search: strips HTML and collapses whitespace', () => {
    expect(sanitizeToolResult('<b>Title</b>   — snippet\ntext', 'web_search'))
      .toBe('Title — snippet text')
  })

  it('code_exec: keeps the tail 200 lines', () => {
    const text = Array.from({ length: 210 }, (_, i) => `line ${i}`).join('\n')
    const out = sanitizeToolResult(text, 'code_exec') as string
    expect(out.split('\n')).toHaveLength(200)
    expect(out.startsWith('line 10\n')).toBe(true)
  })

  it('default source: truncates at maxChars with a marker', () => {
    expect(sanitizeToolResult('x'.repeat(3000), 'bash', { maxChars: 100 }))
      .toBe('x'.repeat(100) + '…[truncated]')
    expect(sanitizeToolResult('short', 'bash', { maxChars: 100 })).toBe('short')
  })
})

describe('content-block array payloads (automatic tools/result path)', () => {
  it('sanitizes each text block per source and preserves non-text blocks', () => {
    const image = { type: 'image', source: { kind: 'base64', data: 'AAAA' } }
    const blocks = [
      { type: 'text', text: 'x'.repeat(3000) },
      image,
      { type: 'text', text: '<i>ok</i>' },
    ]
    const out = sanitizeToolResult(blocks, 'bash', { maxChars: 100 }) as { type: string; text?: string }[]
    expect(out).toHaveLength(3)
    expect(out[0].text).toBe('x'.repeat(100) + '…[truncated]')
    expect(out[1]).toEqual(image)
    // Generic source truncates but does NOT strip HTML (that is web_search-only).
    expect(out[2].text).toBe('<i>ok</i>')
  })

  it('web_search source strips HTML inside text blocks', () => {
    const out = sanitizeToolResult([{ type: 'text', text: '<h1>Hi</h1>' }], 'web_search') as
      { text: string }[]
    expect(out[0].text).toBe('Hi')
  })
})

describe('passthrough', () => {
  it('returns null/undefined/primitives unchanged', () => {
    expect(sanitizeToolResult(null, 'bash')).toBeNull()
    expect(sanitizeToolResult(undefined, 'bash')).toBeUndefined()
    expect(sanitizeToolResult(42, 'bash')).toBe(42)
  })
})
