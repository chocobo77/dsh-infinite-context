import { describe, expect, it } from 'vitest'
import {
  anchorsPoolCapped,
  auditEvidence,
  EVIDENCE_SECTION_HEADING,
  evidenceSectionCeiling,
  extractAnchors,
  fitEvidenceOptions,
  renderEvidenceSection,
  type EvidenceMessage,
} from '../src/fold-evidence.ts'

const user = (text: string): EvidenceMessage => ({ role: 'user', source: { kind: 'user' }, text })
const tool = (text: string): EvidenceMessage => ({ role: 'tool', source: { kind: 'tool' }, text })

describe('extractAnchors', () => {
  it('extracts paths from any message and refs from anywhere', () => {
    const anchors = extractAnchors([
      user('edit src/memory-compaction.ts and check tr_a1b2c3d4e5f6'),
      tool('fl_deadbeefcafe read back'),
    ])
    const texts = anchors.map(a => a.text)
    expect(texts).toContain('src/memory-compaction.ts')
    expect(texts).toContain('tr_a1b2c3d4e5f6')
    expect(texts).toContain('fl_deadbeefcafe')
    expect(anchors.find(a => a.text === 'src/memory-compaction.ts')?.kind).toBe('path')
    expect(anchors.find(a => a.text === 'tr_a1b2c3d4e5f6')?.kind).toBe('ref')
  })

  it('takes error/signal lines only from tool output', () => {
    const anchors = extractAnchors([
      user('the run reported ENOENT but I ignored it'),
      tool('ok lines\nENOENT: no such file or directory'),
    ])
    const errors = anchors.filter(a => a.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].text).toBe('ENOENT: no such file or directory')
  })

  it('dedupes case-insensitively per kind', () => {
    const anchors = extractAnchors([
      tool('open /tmp/a_file.txt'),
      tool('open /tmp/A_FILE.txt'),
      tool('open /tmp/a_file.txt'),
    ])
    const paths = anchors.filter(a => a.kind === 'path')
    expect(paths).toHaveLength(1)
  })

  it('drops oversized blobs and short noisy paths', () => {
    const big = 'x'.repeat(300)
    const anchors = extractAnchors([tool(`Error ${big}`)], { maxAnchorChars: 200 })
    expect(anchors.filter(a => a.text.includes(big))).toHaveLength(0)
    const short = extractAnchors([user('see a/b.c')], { minPathChars: 8 })
    expect(short.filter(a => a.text === 'a/b.c')).toHaveLength(0)
  })

  it('caps collection at the pool hard bound (bounded work, provable)', () => {
    const lines: string[] = []
    for (let i = 0; i < 500; i++) lines.push(`failed reading file-${i}`)
    const anchors = extractAnchors([tool(lines.join('\n'))], { maxAnchors: 5 })
    expect(anchors).toHaveLength(5 * 4)
    expect(anchorsPoolCapped(anchors, { maxAnchors: 5 })).toBe(true)
  })

  it('anchors CJK paths like English ones', () => {
    const anchors = extractAnchors([user('修改 D:\\代码\\模块.ts 并读 文档/说明.md')])
    const texts = anchors.map(a => a.text)
    expect(texts).toContain('D:\\代码\\模块.ts')
    expect(texts).toContain('文档/说明.md')
  })

  it('skips template-literal pseudo-paths and half-extension truncation', () => {
    const anchors = extractAnchors([tool('open src/${file}.ts; build app.tsbuildinfo')])
    expect(anchors.filter(a => a.kind === 'path')).toHaveLength(0)
  })

  it('never anchors heading-like lines (parser contract)', () => {
    const anchors = extractAnchors([tool('## Error parsing config\nplain failed line')])
    expect(anchors.some(a => a.text.startsWith('#'))).toBe(false)
    expect(anchors.some(a => a.text === 'plain failed line')).toBe(true)
  })

  it('non-finite bounds fall back to the defaults, never to unbounded', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `failed line ${i}`).join('\n')
    const anchors = extractAnchors([tool(lines)], { maxAnchors: Number.NaN })
    expect(anchors.length).toBeLessThanOrEqual(16 * 4)
  })

  it('a zero pool extracts nothing at all (not just hidden by the audit)', () => {
    const options = fitEvidenceOptions({}, 50)
    const anchors = extractAnchors([tool('ENOENT: no such file /x/y.txt')], options)
    expect(anchors).toHaveLength(0)
    expect(renderEvidenceSection(auditEvidence(anchors, '', options))).toBe('')
  })
})

describe('auditEvidence', () => {
  // NB: a line CONTAINING a path is itself a signal line (pattern 63), so the
  // path line yields both a path anchor and an error anchor of the same text.
  const anchors = extractAnchors([
    tool('src/config.ts\nENOENT: no such file\ntr_abcdef012345'),
  ])

  it('flags only anchors absent from the summary', () => {
    const audit = auditEvidence(anchors, 'summary mentions src/config.ts and tr_abcdef012345')
    expect(audit.missing.map(a => a.text)).toEqual(['ENOENT: no such file'])
    expect(audit.truncated).toBe(false)
  })

  it('containment is case-insensitive', () => {
    const audit = auditEvidence(anchors, 'hit src/CONFIG.ts with error enoent: No Such File and TR_ABCDEF012345')
    expect(audit.missing).toHaveLength(0)
  })

  it('caps the missing list and reports truncation', () => {
    const many = extractAnchors([tool('ENOENT: no such file a1\nENOENT: no such file a2\nENOENT: no such file a3')])
    const audit = auditEvidence(many, '', { maxAnchors: 2 })
    expect(audit.missing).toHaveLength(2)
    expect(audit.truncated).toBe(true)
  })
})

describe('renderEvidenceSection', () => {
  it('renders nothing when nothing is missing', () => {
    expect(renderEvidenceSection({ missing: [], truncated: false })).toBe('')
  })

  it('labels each kind and notes truncation', () => {
    const section = renderEvidenceSection({
      missing: [
        { kind: 'path', text: 'src/a.ts' },
        { kind: 'ref', text: 'tr_ffffffffffff' },
        { kind: 'error', text: 'ENOENT: x' },
      ],
      truncated: true,
    })
    expect(section.startsWith(EVIDENCE_SECTION_HEADING)).toBe(true)
    expect(section).toContain('- path: src/a.ts')
    expect(section).toContain('- ref: tr_ffffffffffff')
    expect(section).toContain('- signal: ENOENT: x')
    expect(section).toContain('more evidence lost than this cap')
  })
})

describe('budget helpers', () => {
  it('ceiling provably bounds the rendered section', () => {
    // Worst case: every kept anchor at the length bound, all signal lines.
    const longLine = 'E'.repeat(185)
    const lines: string[] = []
    for (let i = 0; i < 40; i++) lines.push(`failed ${longLine}${i}`)
    const anchors = extractAnchors([tool(lines.join('\n'))])
    const audit = auditEvidence(anchors, '')
    const section = renderEvidenceSection(audit)
    expect(section.length).toBeLessThanOrEqual(evidenceSectionCeiling())
  })

  it('fitEvidenceOptions shrinks the cap so the section fits the budget', () => {
    const tiny = fitEvidenceOptions({}, 400)
    expect(tiny.maxAnchors).toBeGreaterThanOrEqual(1)
    expect(evidenceSectionCeiling(tiny)).toBeLessThanOrEqual(400)
    const zero = fitEvidenceOptions({}, 50)
    expect(zero.maxAnchors).toBe(0)
    // never raises the caller's cap
    expect(fitEvidenceOptions({ maxAnchors: 3 }, 100_000).maxAnchors).toBe(3)
  })

  it('ceiling is zero when the cap is zero', () => {
    expect(evidenceSectionCeiling({ maxAnchors: 0 })).toBe(0)
  })

  it('pool exhaustion is reported honestly as truncation', () => {
    const options = { maxAnchors: 2 }
    const lines = Array.from({ length: 10 }, (_, i) => `ENOENT: no such file n${i}`)
    const anchors = extractAnchors([tool(lines.join('\n'))], options)
    const capped = anchorsPoolCapped(anchors, options)
    expect(capped).toBe(true)
    const audit = auditEvidence(anchors, '', options, capped)
    expect(audit.missing).toHaveLength(2)
    expect(audit.truncated).toBe(true)
    expect(renderEvidenceSection(audit)).toContain('more evidence lost than this cap')
  })
})
