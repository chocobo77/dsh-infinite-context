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
 * @param chars - code points of the archived original.
 * @param ref - the archive ref, or `null` when archiving did not happen.
 * @returns the header line (no trailing newline).
 */
export function foldedRangeHeader(messages: number, chars: number, ref: string | null): string {
  const count = Number.isFinite(messages) ? Math.max(0, Math.round(messages)) : 0
  const size = Number.isFinite(chars) ? Math.max(0, Math.round(chars)) : 0
  if (ref === null || ref.trim().length === 0 || ref.length > MAX_REF_CHARS) {
    return `[Compressed history — ${count} earlier messages, details preserved below]`
  }
  return `[Compressed history — ${count} earlier messages, folded into the summary below. `
    + `The exact messages (${size} chars) are archived: read them back with memory_expand ref=${ref}]`
}
