/**
 * Exact-text archive for oversized tool results.
 *
 * DSH's built-in `toolResultPruner` replaces the middle of an over-budget tool
 * result with a fixed marker at compaction time, and there is no way to read the
 * removed text back. This module closes that gap: an oversized tool result is
 * copied verbatim into the store the moment it lands, and its live surface node
 * is rewritten to `head + marker(ref) + tail`, so the transcript stays cheap
 * while the full text stays one `memory_expand` call away.
 *
 * Two rewrite passes exist, with different cache costs:
 *   - `rewriteNewResults` runs on every agent pre-step and touches only nodes
 *     appended since the previous pass, so an already-cached request prefix is
 *     never re-sent with different bytes.
 *   - `rewriteAllResults` runs when compaction is about to break the prefix
 *     anyway. It also covers history that predates this plugin instance (e.g. a
 *     resumed session) and runs before the built-in pruner, so `memory_expand`
 *     can recover what that pruner would otherwise have eaten for good.
 *
 * @module dsh-infinite-context/tool-archive
 */

import { createHash } from 'node:crypto'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merge (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
import type { ToolResultMeta, ToolResultRecord } from './memory-store.ts'

/**
 * The store surface the archive needs. `MemoryContext` mirrors these methods,
 * so the archive never touches the raw store.
 */
export interface ToolArchiveStore {
  archiveToolResult(record: ToolResultRecord): boolean
  getToolResult(ref: string): ToolResultRecord | undefined
  findToolResultByCallId(callId: string): ToolResultRecord | undefined
  listToolResults(limit?: number): ToolResultMeta[]
  searchToolResults(query: string, limit?: number): ToolResultMeta[]
  countToolResults(): number
  toolResultChars(): number
  deleteToolResultsBefore(timestamp: number): number
  trimToolResults(maxEntries: number): number
}

/** Resolved archive policy. */
export interface ToolArchiveOptions {
  /** Master switch. When false nothing is captured and nothing is rewritten. */
  readonly enabled: boolean
  /** Text size (code points) above which a tool result is archived. */
  readonly thresholdChars: number
  /** Kept head of an archived result, in code points. */
  readonly headChars: number
  /** Kept tail of an archived result, in code points. */
  readonly tailChars: number
  /** How many archived results to retain (newest win). */
  readonly maxEntries: number
  /** Days after which an archived result is dropped (0 disables). */
  readonly retentionDays: number
}

/**
 * Defaults. The threshold sits BELOW the built-in pruner's 8192 so an archived
 * result is already under the pruner budget when compaction runs: our
 * recoverable stub is emitted first, and the destructive marker never applies.
 */
export const DEFAULT_TOOL_ARCHIVE_OPTIONS: ToolArchiveOptions = {
  enabled: true,
  thresholdChars: 6000,
  headChars: 2048,
  tailChars: 1024,
  maxEntries: 500,
  retentionDays: 30,
}

/** Ref prefix; the remainder is a sha256 prefix of the archived text. */
export const ARCHIVE_REF_PREFIX = 'tr_'

/** Unicode-code-point length (surrogate-pair safe), matching the DSH measure. */
export function measureChars(text: string): number {
  return Array.from(text).length
}

/** Content-addressed ref for archived text. */
export function archiveRef(text: string): string {
  return ARCHIVE_REF_PREFIX + createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

/** Rebuild the plain text of a tool result (text blocks only). */
export function textOfBlocks(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/** Measure the text payload of content blocks in Unicode code points. */
export function measureContent(blocks: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of blocks) {
    if (block.type === 'text') chars += measureChars(block.text)
  }
  return chars
}

/** The marker that stands in for an archived middle. */
export function archiveMarker(ref: string, chars: number): string {
  return '\n\n[... ' + chars + ' chars archived as ' + ref
    + ' \u2014 call memory_expand {"ref":"' + ref + '"} to read the full text,'
    + ' or add {"query":"..."} to search inside it ...]\n\n'
}

/** Character budgets the middle replacer needs. */
export interface MiddleReplacementOptions {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
}

/**
 * Replace the middle of `blocks` with `marker`, keeping the head, the tail, and
 * the order of non-text blocks. Slicing is by Unicode code point, so a retained
 * boundary cannot split a surrogate pair.
 * @param blocks - original tool-result content.
 * @param marker - the replacement marker (carries the archive ref).
 * @param options - character budgets.
 * @returns the rewritten content, or `null` when nothing should be replaced.
 */
export function replaceTextMiddle(
  blocks: readonly ContentBlock[],
  marker: string,
  options: MiddleReplacementOptions,
): ContentBlock[] | null {
  const totalChars = measureContent(blocks)
  if (totalChars <= options.thresholdChars) return null
  const markerChars = measureChars(marker)
  const budget = options.thresholdChars - markerChars
  if (budget < 0) return null
  let headChars = options.headChars
  let tailChars = options.tailChars
  const wanted = headChars + tailChars
  if (wanted > budget) {
    const scale = wanted === 0 ? 0 : budget / wanted
    headChars = Math.floor(headChars * scale)
    tailChars = Math.floor(tailChars * scale)
  }

  const removedStart = headChars
  const removedEnd = totalChars - tailChars
  const rewritten: ContentBlock[] = []
  let consumed = 0
  let markerInserted = false

  for (const block of blocks) {
    if (block.type !== 'text') {
      rewritten.push(block)
      continue
    }
    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
    const markerText = intersectsRemoved && !markerInserted ? marker : ''
    if (markerText.length > 0) markerInserted = true
    const text = points.slice(0, headEnd).join('') + markerText + points.slice(tailStart).join('')
    if (text.length > 0) rewritten.push({ ...block, text })
    consumed = blockEnd
  }

  if (!markerInserted) return null
  if (measureContent(rewritten) >= totalChars) return null
  return rewritten
}

/** What one rewrite pass did. */
export interface ArchiveRewriteResult {
  readonly replaced: number
  readonly charsRemoved: number
  readonly refs: readonly string[]
}

/** One archived copy. */
export interface ArchiveCaptureResult {
  readonly ref: string
  readonly chars: number
  readonly inserted: boolean
}

/** Archive size summary. */
export interface ArchiveStatus {
  readonly enabled: boolean
  readonly entries: number
  readonly chars: number
}

/** Minimal logger surface (the cordis logger satisfies it). */
export interface ToolArchiveLogger {
  info(message: string): void
  warn(message: string): void
}

/** Dependencies, all injectable for tests. */
export interface ToolResultArchiveDeps {
  readonly store: ToolArchiveStore
  readonly options: ToolArchiveOptions
  readonly logger: ToolArchiveLogger
  /** Prices a shadowed node for the compaction/prune shadow-price event. */
  readonly estimateMessage: (message: ToolResultMessage) => number
  /** Clock, injectable for tests; defaults to Date.now. */
  readonly now?: () => number
}

const EMPTY_RESULT: ArchiveRewriteResult = { replaced: 0, charsRemoved: 0, refs: [] }

/**
 * The archive: capture, read back, and the two cache-aware rewrite passes.
 */
export class ToolResultArchive {
  private readonly store: ToolArchiveStore
  private readonly options: ToolArchiveOptions
  private readonly logger: ToolArchiveLogger
  private readonly estimateMessage: (message: ToolResultMessage) => number
  private readonly now: () => number
  /**
   * Highest surface seq already passed over, per session. This is the cache
   * barrier: nodes at or below it belong to a request prefix already sent.
   */
  private readonly passBarrier = new WeakMap<Session, number>()

  /**
   * @param deps - store, policy, logger, and the token-meter pricing hook.
   */
  constructor(deps: ToolResultArchiveDeps) {
    this.store = deps.store
    this.options = deps.options
    this.logger = deps.logger
    this.estimateMessage = deps.estimateMessage
    this.now = deps.now ?? (() => Date.now())
  }

  /** Whether archiving is on. */
  get enabled(): boolean {
    return this.options.enabled
  }

  /** The resolved policy. */
  get policy(): ToolArchiveOptions {
    return this.options
  }

  /**
   * Copy one tool result into the archive when it is over the threshold.
   * Best-effort: a store failure is logged, never thrown.
   * @param tool - the tool name.
   * @param callId - the tool call id, when known.
   * @param sessionId - the owning session id, when known.
   * @param text - the exact result text.
   * @returns the archived ref, or `null` when nothing was archived.
   */
  capture(
    tool: string,
    callId: string | undefined,
    sessionId: string | undefined,
    text: string,
  ): ArchiveCaptureResult | null {
    if (!this.options.enabled) return null
    const chars = measureChars(text)
    if (chars <= this.options.thresholdChars) return null
    const ref = archiveRef(text)
    try {
      const inserted = this.store.archiveToolResult({
        ref,
        tool,
        ...(callId === undefined ? {} : { callId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        createdAt: this.now(),
        chars,
        text,
      })
      this.enforceRetention()
      return { ref, chars, inserted }
    } catch (error) {
      this.logger.warn('tool archive: store failed for ' + ref + ': ' + reasonOf(error))
      return null
    }
  }

  /**
   * Read archived text back.
   * @param ref - the archive ref.
   * @returns the record, or `undefined` when unknown.
   */
  read(ref: string): ToolResultRecord | undefined {
    try {
      return this.store.getToolResult(ref)
    } catch (error) {
      this.logger.warn('tool archive: read failed for ' + ref + ': ' + reasonOf(error))
      return undefined
    }
  }

  /**
   * List archived results, newest first.
   * @param limit - maximum rows.
   * @returns the listing.
   */
  list(limit = 20): ToolResultMeta[] {
    try {
      return this.store.listToolResults(limit)
    } catch (error) {
      this.logger.warn('tool archive: list failed: ' + reasonOf(error))
      return []
    }
  }

  /**
   * Search archived text by substring.
   * @param query - the substring to look for.
   * @param limit - maximum rows.
   * @returns matching listings.
   */
  search(query: string, limit = 5): ToolResultMeta[] {
    try {
      return this.store.searchToolResults(query, limit)
    } catch (error) {
      this.logger.warn('tool archive: search failed: ' + reasonOf(error))
      return []
    }
  }

  /**
   * Archive size summary.
   * @returns whether archiving is on, plus the entry and code-point totals.
   */
  status(): ArchiveStatus {
    try {
      return {
        enabled: this.options.enabled,
        entries: this.store.countToolResults(),
        chars: this.store.toolResultChars(),
      }
    } catch {
      return { enabled: this.options.enabled, entries: 0, chars: 0 }
    }
  }

  /**
   * Cache-safe pass: rewrite only tool results appended since the previous
   * pass. The first pass for a session only records the barrier, because
   * rewriting the existing surface would invalidate a warm request prefix for
   * no token saving; the compaction-time pass covers that history instead.
   * @param session - the session whose surface may be rewritten.
   * @returns the landed replacements.
   */
  rewriteNewResults(session: Session): ArchiveRewriteResult {
    if (!this.options.enabled) return EMPTY_RESULT
    const barrier = this.passBarrier.get(session)
    if (barrier === undefined) {
      this.passBarrier.set(session, highestSeq(session))
      return EMPTY_RESULT
    }
    const result = this.rewrite(session, seq => seq > barrier)
    this.passBarrier.set(session, highestSeq(session))
    return result
  }

  /**
   * Full pass: rewrite every oversized tool result on the current surface. Call
   * this only when the request prefix is about to be rewritten anyway
   * (compaction), and before the built-in pruner so the recoverable stub wins.
   * @param session - the session whose surface is rewritten.
   * @returns the landed replacements.
   */
  rewriteAllResults(session: Session): ArchiveRewriteResult {
    if (!this.options.enabled) return EMPTY_RESULT
    const result = this.rewrite(session, () => true)
    this.passBarrier.set(session, highestSeq(session))
    return result
  }

  /** Drop archived results past retention, then past the entry cap. */
  private enforceRetention(): void {
    if (this.options.retentionDays > 0) {
      const cutoff = this.now() - this.options.retentionDays * 24 * 60 * 60 * 1000
      this.store.deleteToolResultsBefore(cutoff)
    }
    if (this.options.maxEntries > 0) this.store.trimToolResults(this.options.maxEntries)
  }

  /** Replace the middle of every selected oversized tool result. */
  private rewrite(session: Session, include: (seq: number) => boolean): ArchiveRewriteResult {
    const candidates: { seq: SessionSeq; event: SessionEvent<'tool/result'> }[] = []
    for (const seq of [...session.surface.nodes]) {
      if (!include(seq)) continue
      // oxlint-disable-next-line typescript/no-deprecated -- Existing session history read; migration deferred.
      const event = session.eventAt(seq)
      if (event?.type === 'tool/result') candidates.push({ seq, event })
    }
    let replaced = 0
    let charsRemoved = 0
    const refs: string[] = []

    for (const { seq, event } of candidates) {
      const original = session.deriveEventMessage(event) as ToolResultMessage
      const text = textOfBlocks(original.content)
      const charsBefore = measureChars(text)
      if (charsBefore <= this.options.thresholdChars) continue
      const callId = original.source?.callId
      const known = callId === undefined ? undefined : this.safeFindByCallId(callId)
      const ref = known?.ref
        ?? this.capture(known?.tool ?? 'unknown', callId, String(session.id), text)?.ref
        ?? archiveRef(text)
      const content = replaceTextMiddle(original.content, archiveMarker(ref, charsBefore), this.options)
      if (content === null) continue
      const charsAfter = measureContent(content)
      const message = freezeMessage<ToolResultMessage>({ ...original, content })
      // Shadow-price protocol: the metering event and its replacement are
      // appended adjacently so pure consumers can price the shadowed node
      // without per-node state (the contract the built-in pruner honours).
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.estimateMessage(original),
      })
      session.append('tool/result', { ...event.data, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      replaced++
      charsRemoved += charsBefore - charsAfter
      refs.push(ref)
    }
    if (replaced > 0) {
      this.logger.info('tool archive: stubbed ' + replaced + ' oversized tool result(s), '
        + charsRemoved + ' chars off the surface; refs ' + refs.join(', '))
    }
    return { replaced, charsRemoved, refs }
  }

  private safeFindByCallId(callId: string): ToolResultRecord | undefined {
    try {
      return this.store.findToolResultByCallId(callId)
    } catch {
      return undefined
    }
  }
}

/** Highest seq on a session surface (0 when empty). */
function highestSeq(session: Session): number {
  const nodes = session.surface.nodes
  return nodes.length === 0 ? 0 : Number(nodes[nodes.length - 1])
}

/** Human-readable error reason. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
