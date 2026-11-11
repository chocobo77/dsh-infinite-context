/**
 * Fold chunking: split an oversized fold region into segments a smaller model
 * can summarize well, then mechanically merge the per-segment notes back into
 * one checkpoint.
 *
 * The one-shot fold summary asks even a local model to compress a 40k-token
 * range in a single pass; the production telemetry showed those summaries
 * landing 7-13k tokens ABOVE the plan target — the model restates bulk it was
 * asked to drop, and the deviation loop chases it a fold at a time. The fix is
 * shape, not a tighter constant: small segments keep the weak model inside its
 * competence (Mem0's extract-then-merge, the recursive-summary lineage), and a
 * per-section budget bounds output WITHOUT the global truncation that used to
 * delete the last sections whole.
 *
 * All functions here are pure and dependency-free (token estimation is an
 * injected callback), so the segment/merge/budget invariants are unit-testable
 * without an engine or an LLM. The caller owns the LLM calls and persistence.
 *
 * @module dsh-infinite-context/fold-chunking
 */

/** A message reduced to what the chunker needs: role, source kind, content. */
export interface ChunkableMessage {
  readonly role: string
  readonly source?: { kind?: string } | null
  readonly content?: readonly { type?: string }[] | string
}

/** Whether a message carries tool-call blocks (its results must follow it). */
function hasToolCalls(message: ChunkableMessage): boolean {
  return Array.isArray(message.content)
    && message.content.some(block => block.type === 'tool-call' || block.type === 'tool_use')
}

/**
 * Whether a message is a tool RESULT (must stay glued to the tool-call message
 * that produced it). DSH renders tool results as user-role messages whose
 * source kind is 'tool'; legacy/other renderings use role 'tool'; some
 * renderings carry the result as content blocks — all three count.
 */
function isToolResult(message: ChunkableMessage): boolean {
  if (message.role === 'tool') return true
  if (message.source?.kind === 'tool') return true
  return Array.isArray(message.content)
    && message.content.some(block => block.type === 'tool-result' || block.type === 'tool_result')
}

/**
 * Split a fold region into segments each at most `maxTokensPerSegment`
 * estimated tokens, never cutting a tool call from its results and never
 * leaving an empty segment. A single group over the cap becomes its own
 * segment (a monster payload still has to be summarized).
 * @param messages - the region's shadowed messages, in surface order.
 * @param maxTokensPerSegment - the per-segment token ceiling (cold-start
 *   prior supplied by the caller; this function does not own it).
 * @param estimate - token estimate for one message.
 * @returns the segments (each a non-empty message list). One segment when the
 *   whole region already fits, which means "no chunking needed".
 */
export function splitRegionIntoSegments<T extends ChunkableMessage>(
  messages: readonly T[],
  maxTokensPerSegment: number,
  estimate: (message: T) => number,
): T[][] {
  if (messages.length === 0) return []
  // Group using the same view, but keep the concrete T for the caller.
  const groups: { msgs: T[]; tokens: number }[] = []
  const asChunkable = messages as readonly ChunkableMessage[]
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i] as T
    const group: T[] = [message]
    if (hasToolCalls(message)) {
      let j = i + 1
      while (j < messages.length && isToolResult(asChunkable[j] as ChunkableMessage)) {
        group.push(messages[j] as T)
        j += 1
      }
      i = j - 1
    }
    let tokens = 0
    for (const m of group) tokens += Math.max(0, estimate(m))
    groups.push({ msgs: group, tokens })
  }
  const segments: T[][] = []
  let current: T[] = []
  let currentTokens = 0
  for (const group of groups) {
    if (current.length > 0 && currentTokens + group.tokens > maxTokensPerSegment) {
      segments.push(current)
      current = []
      currentTokens = 0
    }
    current.push(...group.msgs)
    currentTokens += group.tokens
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/** A parsed note: heading -> ordered item lines (the heading line itself kept). */
interface ParsedNote {
  readonly preamble: string[]
  readonly sections: { heading: string; items: string[] }[]
}

/** Split a structured note into its `##` sections (heading lines preserved). */
function parseNote(text: string): ParsedNote {
  const preamble: string[] = []
  const sections: { heading: string; items: string[] }[] = []
  let current: { heading: string; items: string[] } | null = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.startsWith('## ')) {
      current = { heading: line, items: [] }
      sections.push(current)
    } else if (current !== null) {
      current.items.push(line)
    } else {
      preamble.push(line)
    }
  }
  return { preamble, sections }
}

/**
 * Mechanically merge per-segment checkpoint notes into one checkpoint: the
 * heading set/order of the first note, every other note's items appended under
 * a matching heading (headings unique to a later note are appended at the end
 * in encounter order), and duplicate bullet lines removed. Nothing is invented
 * and no LLM call is made — this is the "merge" half of extract-then-merge.
 * Heading matching is exact (byte-level): a segment that rewrites a heading's
 * case gets its own section. Accepted deliberately — the base compaction
 * instruction fixes the exact heading names, so drift is bounded, and fuzzy
 * matching risks merging genuinely different sections.
 * @param notes - one structured note per segment, in surface order.
 * @returns the merged checkpoint text (empty string when every note is empty).
 */
export function mergeSegmentNotes(notes: readonly string[]): string {
  const parsed = notes
    .map(note => note.trim())
    .filter(note => note.length > 0)
    .map(parseNote)
  if (parsed.length === 0) return ''
  // EVERY note's preamble is kept (deduped): a later segment's lead-in lines
  // ("this segment covered X") are content, and dropping them silently is the
  // exact failure mode this merge exists to prevent.
  const preambleLines: string[] = []
  for (const note of parsed) {
    for (const line of note.preamble) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || preambleLines.includes(trimmed)) continue
      preambleLines.push(trimmed)
    }
  }
  // Ordered heading list seeded by the first note, extended by unseen headings.
  const order: string[] = []
  const byHeading = new Map<string, string[]>()
  for (const note of parsed) {
    for (const section of note.sections) {
      let items = byHeading.get(section.heading)
      if (items === undefined) {
        items = []
        byHeading.set(section.heading, items)
        order.push(section.heading)
      }
      for (const line of section.items) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        if (!items.includes(trimmed)) items.push(trimmed)
      }
    }
  }
  const blocks: string[] = []
  if (preambleLines.length > 0) blocks.push(preambleLines.join('\n'))
  for (const heading of order) {
    const items = byHeading.get(heading) ?? []
    blocks.push([heading, ...items].join('\n'))
  }
  return blocks.join('\n\n').trim()
}

/** Budgets for the per-section reflow. All values are Unicode code points. */
export interface SectionBudget {
  /** Max code points of one section's body (its heading line is not counted).
   * `<= 0` DISABLES this layer (the engine floors it above zero); it does not
   * mean "clip every body to nothing". */
  readonly perSectionMaxChars: number
  /** Max code points of the whole text; trailing sections are dropped beyond it. */
  readonly totalMaxChars: number
}

/** The marker left where a section body was clipped to its own budget. */
const SECTION_CLIP_MARKER = '\n…[section budget reached]'

/** Code-point length of a string (surrogate-safe, matching measureChars). */
function charsOf(text: string): number {
  return Array.from(text).length
}

/** Clip a section body to the budget at a line boundary (never mid-line). */
function clipBody(body: string, budget: number): string {
  const points = Array.from(body)
  if (points.length <= budget) return body
  if (budget <= SECTION_CLIP_MARKER.length) {
    // A budget that cannot even fit the marker: honor the cap over the
    // line-boundary promise (reachable only under absurd per-section budgets;
    // the engine floors this layer well above it).
    return points.slice(0, Math.max(0, budget)).join('')
  }
  const room = budget - SECTION_CLIP_MARKER.length
  const head = points.slice(0, room).join('')
  const lastNewline = head.lastIndexOf('\n')
  // Keep up to the last whole line inside the room; when the body opens with
  // a blank line (lastNewline === 0) or is one monster line, no line fits —
  // keep only the marker rather than halving a line.
  const kept = lastNewline >= 0 ? head.slice(0, lastNewline) : ''
  return kept + SECTION_CLIP_MARKER
}

/**
 * Reflow a checkpoint so NO single section can balloon (each body clipped to
 * `perSectionMaxChars` at a line boundary) and the whole stays under
 * `totalMaxChars` (whole trailing sections dropped, never a section cut in
 * half at the end). This replaces the old global truncation that deleted the
 * last sections (Critical Context, Next Step) whole — exactly the sections a
 * resume needs. The `##`-section parse matches mergeSegmentNotes.
 * @param text - the checkpoint text.
 * @param budget - the per-section and total caps.
 * @returns the reflowed text.
 */
export function applySectionBudget(text: string, budget: SectionBudget): string {
  const parsed = parseNote(text.trim())
  const blocks: string[] = []
  if (parsed.preamble.length > 0) {
    blocks.push(parsed.preamble.filter(line => line.length > 0).join('\n'))
  }
  for (const section of parsed.sections) {
    // Trailing blank lines inside a section would multiply when sections are
    // re-joined with a blank line between them.
    const body = section.items.join('\n').trimEnd()
    const clipped = budget.perSectionMaxChars > 0 ? clipBody(body, budget.perSectionMaxChars) : body
    // A clipped-to-marker-only body already starts with the marker's newline;
    // joining with another '\n' would double the blank line.
    blocks.push(clipped.length === 0
      ? section.heading
      : section.heading + (clipped.startsWith('\n') ? clipped : '\n' + clipped))
  }
  // Enforce the total cap by dropping trailing whole sections, newest first —
  // but never below the FIRST section (preamble kept if there was one):
  // emptying every section is exactly the old bug this reflow replaced.
  const floorBlocks = parsed.preamble.some(line => line.trim().length > 0) ? 2 : 1
  let out = blocks.join('\n\n').trim()
  while (blocks.length > floorBlocks && charsOf(out) > budget.totalMaxChars) {
    blocks.pop()
    out = blocks.join('\n\n').trim()
  }
  // A single over-budget block (or preamble alone): hard-clip as last resort,
  // and even then the total cap holds — the marker is dropped when it would
  // itself break the budget.
  if (charsOf(out) > budget.totalMaxChars) {
    if (budget.totalMaxChars <= 0) return ''
    const points = Array.from(out)
    const marker = '\n…[truncated]'
    if (budget.totalMaxChars <= marker.length) {
      // The cap cannot fit the marker: a raw code-point cut (a documented
      // mid-line exception) is the only way to keep the promise "the whole
      // stays under totalMaxChars".
      return points.slice(0, budget.totalMaxChars).join('')
    }
    out = points.slice(0, budget.totalMaxChars - marker.length).join('') + marker
  }
  return out
}
