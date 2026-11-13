/**
 * Folded-range attachments: the text-only `original` record drops images and
 * files, so the durable host attachment refs must ride a side table
 * (`fold_attachments`) and ride the read-back's first page. The bytes stay
 * owned by the host attachment service — the archive stores refs only.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { renderFoldAttachmentLines } from '../src/fold-archive.ts'
import { extractFoldAttachments } from '../src/memory-compaction.ts'
import { MemoryStore } from '../src/memory-store.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-fold-attachments-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const imageRef = {
  attachmentId: 'sha256:abcd1234ffffffffabcd1234ffffffffabcd1234ffffffffabcd1234ffffffff',
  mediaType: 'image/png',
  bytes: 152_000,
  width: 1280,
  height: 720,
  name: 'screenshot.png',
}

const IMAGE = { type: 'image', attachment: imageRef } as const
const FILE = { type: 'file', attachment: { attachmentId: 'sha256:ffff0000', name: 'log.txt', bytes: 42 } } as const

describe('extractFoldAttachments', () => {
  it('collects image and file refs with positions, skipping text-only messages', () => {
    const extracted = extractFoldAttachments([
      { role: 'user', content: [{ type: 'text', text: 'look at this' }, IMAGE] },
      { role: 'assistant', content: [{ type: 'text', text: 'got it' }] },
      { role: 'user', content: [FILE, { type: 'text', text: 'and the log' }] },
    ] as never)
    expect(extracted).toEqual([
      { msgIdx: 0, blockIdx: 1, kind: 'image', payload: JSON.stringify(imageRef) },
      { msgIdx: 2, blockIdx: 0, kind: 'file', payload: JSON.stringify(FILE.attachment) },
    ])
  })

  it('returns nothing for a text-only region', () => {
    expect(extractFoldAttachments([
      { role: 'user', content: [{ type: 'text', text: 'plain' }] },
    ] as never)).toEqual([])
  })
})

describe('fold_attachments store round-trip', () => {
  it('stores and reads back attachments with the range ref', () => {
    const store = new MemoryStore(join(dir, 'a.db'))
    try {
      const ref = store.archiveFoldedRange({
        messages: 3,
        chars: 100,
        tokens: 50,
        summary: 's',
        original: 'o',
        sessionId: 'sess-1',
        attachments: [
          { msgIdx: 0, blockIdx: 1, kind: 'image', payload: JSON.stringify(imageRef) },
          { msgIdx: 2, blockIdx: 0, kind: 'file', payload: JSON.stringify(FILE.attachment) },
        ],
      })
      const records = store.getFoldAttachments(ref)
      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ ref, msgIdx: 0, blockIdx: 1, kind: 'image' })
      expect(JSON.parse(records[0]!.payload)).toMatchObject({ mediaType: 'image/png', width: 1280 })
      expect(store.getFoldAttachments('fl_nonexistent')).toEqual([])
    } finally {
      store.close()
    }
  })

  it('prune and trim cascade to the attachment rows', () => {
    const store = new MemoryStore(join(dir, 'b.db'))
    try {
      const old = store.archiveFoldedRange({
        messages: 1, chars: 1, tokens: 1, summary: 'old', original: 'o',
        createdAt: 1_000,
        attachments: [{ msgIdx: 0, blockIdx: 0, kind: 'image', payload: JSON.stringify(imageRef) }],
      })
      const kept = store.archiveFoldedRange({
        messages: 1, chars: 1, tokens: 1, summary: 'new', original: 'o',
        createdAt: 2_000,
        attachments: [{ msgIdx: 0, blockIdx: 0, kind: 'image', payload: JSON.stringify(imageRef) }],
      })
      store.pruneFoldedRanges(1_500)
      expect(store.getFoldedRange(old)).toBeUndefined()
      expect(store.getFoldAttachments(old)).toEqual([])
      expect(store.getFoldAttachments(kept)).toHaveLength(1)
      // trim to 0 keeps nothing, and must not leave attachment orphans
      store.trimFoldedRanges(0)
      expect(store.getFoldAttachments(kept)).toEqual([])
    } finally {
      store.close()
    }
  })
})

describe('compressor archive path passes attachments', () => {
  it('archiveFoldedRange forwards the extracted refs to the store', async () => {
    const { HistoryCompressor } = await import('../src/memory-compaction.ts')
    const captured: { attachments?: unknown[] }[] = []
    const compressor = Object.create(HistoryCompressor.prototype) as unknown as {
      config: Record<string, unknown>
      ctx: { memoryContext: Record<string, unknown>; logger: { warn: (m: string) => void } }
      estimateMessageTokens: (messages: readonly unknown[]) => number
      archiveFoldedRange: (sessionId: string, messages: readonly unknown[], summaryText: string) => string
    }
    compressor.config = {}
    compressor.ctx = {
      memoryContext: {
        archiveFoldedRange: (input: { attachments?: unknown[] }) => {
          captured.push(input)
          return 'fl_ab12cd34ef56'
        },
        pruneFoldedRanges: () => 0,
        trimFoldedRanges: () => 0,
      },
      logger: { warn: () => {} },
    }
    compressor.estimateMessageTokens = () => 100
    const header = compressor.archiveFoldedRange('sess-1', [
      { role: 'user', content: [{ type: 'text', text: 'see attached' }, IMAGE] },
    ] as never, 'summary text')
    expect(header).toContain('fl_ab12cd34ef56')
    expect(captured[0]?.attachments).toHaveLength(1)
    expect(JSON.parse((captured[0]?.attachments as { payload: string }[])[0]!.payload))
      .toMatchObject({ mediaType: 'image/png' })
  })
})

describe('renderFoldAttachmentLines', () => {
  it('renders one deterministic line per attachment, empty when none', () => {
    expect(renderFoldAttachmentLines([])).toBe('')
    const rendered = renderFoldAttachmentLines([
      { kind: 'image', payload: JSON.stringify(imageRef) },
    ])
    expect(rendered).toContain('[attachment 1/1] image "screenshot.png" (image/png 152000B, 1280x720px)')
    expect(rendered).toContain('sha256:abcd1234')
    expect(rendered).toContain('durable refs survive the fold')
  })

  it('degrades a corrupt payload to a count line instead of throwing', () => {
    const rendered = renderFoldAttachmentLines([{ kind: 'image', payload: '{not json' }])
    expect(rendered).toContain('[attachment 1/1] image (record unreadable)')
  })
})
