/**
 * Summarizer resilience: bounded attempts plus an extractive fallback.
 *
 * Production telemetry (2026-10) showed the compaction summarizer call
 * hanging until the provider's own 300s stream-idle limit while the whole
 * fold waited, and local-model configs failing every call outright
 * ("does not support reasoning"). Either failure abandoned the fold, so the
 * context kept growing exactly when the model could least afford it.
 *
 * Two pieces live here so they are testable without an engine:
 *
 * - {@link summarizeWithResilience}: the attempt state machine — a hard
 *   per-attempt timeout (each attempt gets its own timer), one retry, and a
 *   caller-supplied fallback instead of a throw.
 * - {@link extractiveSummary}: the fallback's deterministic summary — user
 *   instructions verbatim, one line per assistant turn, and the signal lines
 *   (errors, exit codes, counts, diff stats) of tool results.
 */
import { isSignalLine, clipLineByCodePoints } from './absorb.ts'

/** One message reduced to what the extractive summary needs. */
export interface ExtractiveMessage {
  readonly role: string
  readonly text: string
}

/** Bounds for {@link extractiveSummary}. All values are code points. */
export interface ExtractiveSummaryOptions {
  /** Why the LLM summarizer was bypassed (recorded in the header). */
  readonly reason?: string
  /** Total budget for the whole summary. Default 4000. */
  readonly maxChars?: number
  /** Longest single item kept. Default 240 (absorb's line width). */
  readonly maxItemChars?: number
  /** User instructions kept verbatim (newest last). Default 12. */
  readonly maxUserItems?: number
  /** Assistant first lines kept. Default 12. */
  readonly maxAssistantItems?: number
  /** Tool signal lines kept. Default 24. */
  readonly maxToolItems?: number
}

export const DEFAULT_EXTRACTIVE_OPTIONS: Required<Omit<ExtractiveSummaryOptions, 'reason'>> = {
  maxChars: 4_000,
  maxItemChars: 240,
  maxUserItems: 12,
  maxAssistantItems: 12,
  maxToolItems: 24,
}

/**
 * Build the deterministic fallback summary for a folded range.
 *
 * The result is always bounded by `maxChars` and always starts with the
 * degradation header (so the model knows WHY the summary is terse and that
 * the exact original messages stay retrievable via the folded-range archive).
 * An empty range still yields the header alone — never an empty string, since
 * the fold must replace something.
 * @param messages - the folded messages, head-to-tail.
 * @param options - bounds plus the degradation reason.
 * @returns the extractive summary text.
 */
export function extractiveSummary(
  messages: readonly ExtractiveMessage[],
  options: ExtractiveSummaryOptions = {},
): string {
  const o = { ...DEFAULT_EXTRACTIVE_OPTIONS, ...options }
  const reason = (options.reason ?? 'summarizer unavailable').replace(/\s+/g, ' ').trim().slice(0, 160)
  const header = '# Extractive fold summary (no LLM: ' + reason + ')\n'
    + 'The exact original messages are archived; read them back with memory_expand on the fl_ ref above.'

  const users: string[] = []
  const assistants: string[] = []
  const toolSignals: string[] = []
  const seenToolLines = new Set<string>()
  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.text.trim()
      if (text.length > 0) users.push(text)
    } else if (message.role === 'assistant') {
      const first = message.text.trim().split(/\r?\n/).find(line => line.trim().length > 0)
      if (first !== undefined) assistants.push(first.trim())
    } else if (message.role === 'tool') {
      for (const line of message.text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length > 0 && isSignalLine(trimmed) && !seenToolLines.has(trimmed)) {
          seenToolLines.add(trimmed)
          toolSignals.push(trimmed)
        }
      }
    }
  }

  const sections: string[] = []
  const section = (title: string, items: readonly string[], cap: number): void => {
    const picked = items.slice(-cap)
    if (picked.length === 0) return
    sections.push('## ' + title + '\n' + picked
      .map(item => '- ' + clipLineByCodePoints(item, o.maxItemChars))
      .join('\n'))
  }
  section('User instructions (verbatim)', users, o.maxUserItems)
  section('Assistant turns (first line)', assistants, o.maxAssistantItems)
  section('Tool signal lines', toolSignals, o.maxToolItems)

  // Budget accounting in CODE POINTS (matching maxChars' documented unit and
  // the final clip); a UTF-16 length here would overcount astral text and
  // stop a section early.
  let text = header
  let used = Array.from(header).length
  for (const body of sections) {
    const cost = Array.from(body).length + 2
    if (used + cost > o.maxChars) break
    text += '\n\n' + body
    used += cost
  }
  return clipLineByCodePoints(text, o.maxChars)
}

/**
 * First line of a degraded extractive summary. Callers match on it to tell a
 * degraded summary apart from an LLM one without threading a flag around.
 */
export const EXTRACTIVE_DEGRADED_MARKER = '# Extractive fold summary'

/**
 * Drop the degradation header (title line plus the archived-messages note)
 * from an extractive summary, keeping the extracted sections.
 *
 * The header belongs to the SURFACE copy only: it tells the model why this
 * summary is terse. The durable copies (folded_ranges summary, mid-tier
 * memory) would otherwise persist a transient provider error string into
 * long-term memory and re-inject it through retrieval.
 * @param text - a model summary; a degraded extractive one starts with
 *   {@link EXTRACTIVE_DEGRADED_MARKER}.
 * @returns the text without its degradation header; unchanged when the text
 *   is not a degraded extractive summary. An extractive summary with no
 *   sections reduces to the empty string.
 */
export function stripExtractiveHeader(text: string): string {
  if (!text.startsWith(EXTRACTIVE_DEGRADED_MARKER)) return text
  const cut = text.indexOf('\n\n')
  return cut < 0 ? '' : text.slice(cut + 2)
}

/** Outcome of {@link summarizeWithResilience}. */export interface ResilienceOutcome<T> {
  readonly value: T
  /** True when every attempt failed and `fallback` produced the value. */
  readonly degraded: boolean
  /** The last attempt error when `degraded` is true. */
  readonly error?: unknown
}

/** Knobs for {@link summarizeWithResilience}. */
export interface ResilienceOptions {
  /** Hard timeout per attempt in ms; each attempt gets a FRESH timer. */
  readonly timeoutMs: number
  /**
   * Deadline for the RETRY attempt. Default: `timeoutMs × 2` (a timeout is
   * evidence the estimate was too tight). Callers with locality knowledge
   * override: a slow-but-alive local route doubles, a hung cloud stream
   * retries flat.
   */
  readonly retryMs?: number
  /** Extra attempts after the first (default 1). */
  readonly retries?: number
  /** Caller's cancellation signal; its abort always rethrows immediately. */
  readonly outerSignal?: AbortSignal
}

/**
 * Run an attempt under a hard timeout, retry once, then fall back — never
 * throw. The RETRY deadline is caller policy (`retryMs`, default: double the
 * first attempt): a first-attempt timeout is evidence the estimate was too
 * tight, but HOW much tighter differs by failure mode — a local model is
 * slow-but-alive (double helps), a cloud stream that produced nothing is
 * usually dead (double just wastes time). Worst case stays bounded at
 * `timeoutMs + retryMs`.
 *
 * The outer signal is honoured on every path: when the CALLER aborts, the
 * error rethrows (a cancelled step must not fabricate a degraded result); a
 * timeout on our own timer counts as a failed attempt and moves on.
 * @param attempt - one summarizer call; receives a per-attempt signal.
 * @param fallback - builds the degraded value from the last error.
 * @returns the successful or fallback value plus the degradation flag.
 */
export async function summarizeWithResilience<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  fallback: (error: unknown) => T,
  options: ResilienceOptions,
): Promise<ResilienceOutcome<T>> {
  const retries = Number.isFinite(options.retries) ? Math.max(0, Math.floor(options.retries as number)) : 1
  let lastError: unknown
  for (let triesLeft = 1 + retries; triesLeft > 0; triesLeft -= 1) {
    const isRetry = triesLeft <= retries
    const attemptMs = isRetry ? (options.retryMs ?? options.timeoutMs * 2) : options.timeoutMs
    const timer = AbortSignal.timeout(attemptMs)
    const combined = options.outerSignal === undefined
      ? timer
      : AbortSignal.any([options.outerSignal, timer])
    // The signal alone does not settle a HANGING call (an abort only works if
    // the callee listens), so the deadline is enforced by a race; the combined
    // signal additionally tells a well-behaved callee to release its stream.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('summarizer timed out after ' + attemptMs + 'ms')),
        attemptMs,
      )
    })
    try {
      const value = await Promise.race([attempt(combined), deadline])
      return { value, degraded: false }
    } catch (error) {
      if (options.outerSignal?.aborted === true) throw error
      lastError = error
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    }
  }
  return { value: fallback(lastError), degraded: true, error: lastError }
}
