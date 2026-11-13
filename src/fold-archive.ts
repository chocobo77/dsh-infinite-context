/**
 * Reverse compaction: the archive that keeps a folded history range readable.
 *
 * Upstream billion-context equivalent: its `decompress` context-management
 * tool. We do not inject one tool per range; every summary that replaces a
 * range carries the ref of its archive row, and the existing `memory_expand`
 * tool reads it back (see src/memory-store.ts `folded_ranges`).
 *
 * Why archive at all: the summarizer is lossy by construction, and the one
 * thing an agent cannot recover later is the literal text it was working on
 * (a stack trace, a diff, an exact file path). Keeping the pre-fold text in
 * the store costs disk, not context — nothing is injected unless asked for.
 *
 * @module dsh-infinite-context/fold-archive
 */

/** Folded-range archive policy. */
export interface FoldOptions {
  /** Whether folded ranges are archived (off = compaction is not reversible). */
  readonly enabled: boolean
  /** Days to retain a folded range; 0 disables age-based pruning. */
  readonly retentionDays: number
  /** Newest folded ranges kept (older ones are trimmed). */
  readonly maxEntries: number
}

/** Defaults: on, one month, a few hundred ranges. */
export const DEFAULT_FOLD_OPTIONS: FoldOptions = { enabled: true, retentionDays: 30, maxEntries: 300 }

/** Longest ref we will print into a summary header (refs are fixed-shape today). */
const MAX_REF_CHARS = 64

/**
 * Build the header that introduces a compression summary on the surface.
 *
 * The header is the ONLY thing the model sees about the archive, so it has to
 * carry the ref; without a ref it degrades to the pre-archive wording and the
 * range is simply not recoverable.
 *
 * @param messages - how many messages were folded into the summary.
 * @param chars - code points of the archived serialized record.
 * @param ref - the archive ref, or `null` when archiving did not happen.
 * @returns the header line (no trailing newline).
 */
export function foldedRangeHeader(messages: number, chars: number, ref: string | null): string {
  const count = Number.isFinite(messages) ? Math.max(0, Math.round(messages)) : 0
  const size = Number.isFinite(chars) ? Math.max(0, Math.round(chars)) : 0
  if (ref === null || ref.trim().length === 0 || ref.length > MAX_REF_CHARS) {
    return `[Compressed history — ${count} earlier messages, details preserved below]`
  }
  // The archive holds a SERIALIZED, text-only rendering (long messages are
  // truncated), so the header must not promise byte-exact messages.
  return `[Compressed history — ${count} earlier messages, folded into the summary below. `
    + `A serialized text record of them (${size} chars, long messages truncated) is archived: `
    + `read it back with memory_expand ref=${ref}]`
}

/**
 * Render the archived non-text blocks (images, files) of one folded range as
 * deterministic text lines. The text-only `original` record drops these
 * blocks' pixels, but their DURABLE attachment references survive in
 * `fold_attachments`; naming the ref and its metadata keeps the fold
 * information-reversible — the host attachment service owns the bytes and
 * resolves a ref on demand. Corrupt payloads degrade to a count line rather
 * than throwing (the audit rule: archiving must never break a read-back).
 * @param records - the stored attachment records, message order.
 * @returns the rendered block appended to a read-back, or '' when none.
 */
export function renderFoldAttachmentLines(
  records: readonly { kind: string; payload: string }[],
): string {
  if (records.length === 0) return ''
  const lines = records.map((record, i) => {
    try {
      const parsed = JSON.parse(record.payload) as {
        attachmentId?: unknown
        name?: unknown
        mediaType?: unknown
        bytes?: unknown
        width?: unknown
        height?: unknown
      }
      const id = typeof parsed.attachmentId === 'string' ? parsed.attachmentId : ''
      const digest = id.startsWith('sha256:')
        ? id.slice('sha256:'.length, 'sha256:'.length + 8)
        : id.slice(0, 12)
      const dims = typeof parsed.width === 'number' && typeof parsed.height === 'number'
        ? `, ${parsed.width}x${parsed.height}px`
        : ''
      const meta = [
        typeof parsed.mediaType === 'string' ? parsed.mediaType : undefined,
        typeof parsed.bytes === 'number' ? `${parsed.bytes}B` : undefined,
      ].filter(Boolean).join(' ')
      const label = typeof parsed.name === 'string' && parsed.name.length > 0
        ? `${record.kind} "${parsed.name}"`
        : record.kind
      return `- [attachment ${i + 1}/${records.length}] ${label} (${meta}${dims})`
        + (digest.length > 0 ? ` — attachment sha256:${digest}` : '')
    } catch {
      return `- [attachment ${i + 1}/${records.length}] ${record.kind} (record unreadable)`
    }
  })
  return '\n\n[Archived attachments — durable refs survive the fold; '
    + `re-attach or view via the client to see them again]\n${lines.join('\n')}`
}
