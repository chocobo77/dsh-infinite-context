/**
 * The working-memory slot: a small TASK-STATE block injected before the
 * model every turn.
 *
 * WHY: after a fold, task state (open jobs, next step, standing constraints)
 * disperses into mid-tier memories that retrieval reaches by EMBEDDING
 * SIMILARITY — and similarity structurally misses open-loop state, because
 * the next user message is rarely similar to a fifty-turn-old pending job.
 * Production agreed: memory_search was never called directly, so nothing
 * pulled that state back. The block makes the loop's working set ALWAYS
 * visible: it is rebuilt from every fold's structured checkpoint
 * (`Primary Request and Intent` / `Pending Jobs` / `Next Step` /
 * `Critical Context` — the compaction-basic summarizer's fixed sections),
 * carried across folds, and spliced into the pre-step message list fresh
 * each turn — never durable, so it adds no per-turn messages and invalidates
 * no prefix beyond what any injected background already does.
 *
 * Deliberately NOT here: an LLM judge (cost/latency), session-log writes
 * (per-turn bloat), and changes to the summarizer's input (its prompt is a
 * genuine prefix of the last routed request for cache reuse; editing it
 * would repay the whole replay, and splicing messages into it would corrupt
 * the folded_ranges archive, which stores the input verbatim).
 *
 * @module dsh-infinite-context/task-state
 */

/** Marker for the injected block; mirrors the conciseness directive's style. */
export const TASK_STATE_MARKER = 'scope="dsh-infinite-context:task-state"'

/** Block budget in code points (≈400 tokens; the injectionBudget covers it). */
export const TASK_STATE_MAX_CHARS = 1200
/** Longest single bullet. */
const MAX_BULLET_CHARS = 160
/** Bullets kept per section. */
const MAX_BULLETS = 6

/** One bounded bullet list. */
type Section = readonly string[]

/** The checkpoint sections the block carries, in display order. */
const SECTIONS = [
  { key: 'primary', heading: 'Primary Request and Intent', label: 'Primary request' },
  { key: 'pending', heading: 'Pending Jobs', label: 'Pending jobs' },
  { key: 'next', heading: 'Next Step', label: 'Next step' },
  { key: 'critical', heading: 'Critical Context', label: 'Critical context' },
] as const

type SectionKey = (typeof SECTIONS)[number]['key']

/** Unicode-code-point slice (surrogate-pair safe). */
function clip(text: string, maxChars: number): string {
  const points = Array.from(text)
  return points.length <= maxChars ? text : points.slice(0, maxChars).join('') + '…'
}

/**
 * Extract the bullets of one `## heading` section from a checkpoint summary
 * (the compaction-basic summarizer's fixed Markdown structure). Stops at the
 * next heading or the checkpoint tag; keeps only bullet lines, drops "(none)"
 * placeholders, clips each bullet and caps the count.
 * @param text - the summary text to scan.
 * @param heading - the exact `## ` heading line content (case-sensitive;
 *   the summarizer emits it verbatim from its template).
 * @returns the section's bullets (possibly empty).
 */
export function parseCheckpointSection(text: string, heading: string): Section {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === '## ' + heading)
  if (start < 0) return []
  const bullets: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (/^##\s/.test(line.trim()) || line.includes('<compacted-summary>')) break
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (!trimmed.startsWith('- ')) continue
    const body = trimmed.slice(2).trim()
    if (body.length === 0 || body === '(none)') continue
    bullets.push(clip(body, MAX_BULLET_CHARS))
    if (bullets.length >= MAX_BULLETS) break
  }
  return bullets
}

/**
 * Parse a PREVIOUS block back into its sections, so a fold whose summary
 * lacks a section can carry the section forward. Reads the labels this
 * module writes; unknown lines are ignored.
 * @param block - a previously built task-state block.
 * @returns the section map (missing sections absent).
 */
function parseBlockSections(block: string): Partial<Record<SectionKey, Section>> {
  const sections: Partial<Record<SectionKey, Section>> = {}
  const lines = block.split(/\r?\n/)
  let current: SectionKey | undefined
  let collected: string[] = []
  const flush = (): void => {
    if (current !== undefined && collected.length > 0) sections[current] = collected
    collected = []
  }
  for (const line of lines) {
    const match = SECTIONS.find(section => line.trim() === section.label + ':')
    if (match !== undefined) {
      flush()
      current = match.key
      continue
    }
    if (current !== undefined && line.startsWith('- ')) {
      collected.push(line.slice(2))
    }
  }
  flush()
  return sections
}

/** Inputs for {@link buildTaskStateBlock}. */
export interface TaskStateInput {
  /** The fold's summary text (compaction-basic checkpoint structure). */
  readonly summary?: string | undefined
  /** The previously injected block (carries sections the new fold lacks). */
  readonly previous?: string | undefined
  /** The session's goal line, when the harness exposes one. */
  readonly goal?: string | undefined
}

/**
 * Build the block to inject this turn.
 *
 * Merge policy: the newest fold wins each section, EXCEPT `primary` and
 * `critical` fall back to the previous block when the new summary has none —
 * goals and standing constraints persist, while pending jobs and the next
 * step go stale fast and are deliberately NOT carried. A summary that parses
 * to nothing (the extractive fallback's shape) therefore degrades to
 * previous-block-minus-stale-sections rather than an empty block.
 * @param input - the new summary, the previous block, and the session goal.
 * @returns the block text, or `undefined` when there is nothing to carry.
 */
export function buildTaskStateBlock(input: TaskStateInput): string | undefined {
  const summary = input.summary ?? ''
  const previous = input.previous ?? ''
  const current: Partial<Record<SectionKey, Section>> = {}
  for (const section of SECTIONS) {
    current[section.key] = parseCheckpointSection(summary, section.heading)
  }
  const prior = parseBlockSections(previous)

  const lines: string[] = [
    `[TASK STATE — carried from folded history; refreshed on every fold (${TASK_STATE_MARKER})]`,
  ]
  const goal = input.goal === undefined ? '' : clip(input.goal.trim(), 200)
  if (goal.length > 0) lines.push('Goal: ' + goal)
  let used = Array.from(lines.join('\n')).length
  for (const section of SECTIONS) {
    const fresh = current[section.key] ?? []
    const carried = section.key === 'pending' || section.key === 'next' ? [] : (prior[section.key] ?? [])
    const bullets = fresh.length > 0 ? fresh : carried
    if (bullets.length === 0) continue
    const body = bullets.map(bullet => '- ' + bullet)
    const cost = Array.from(section.label + ':\n' + body.join('\n')).length + 1
    if (used + cost > TASK_STATE_MAX_CHARS) break
    lines.push(section.label + ':', ...body)
    used += cost
  }
  const text = lines.join('\n')
  // The marker line alone carries no state.
  return lines.length > 1 ? text : undefined
}
