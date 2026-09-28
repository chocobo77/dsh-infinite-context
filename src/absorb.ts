/**
 * Absorb-style distillation of oversized tool results.
 *
 * A large tool result spends a lot of context on a few useful facts (the error
 * line, the exit code, the test counts, the changed files). {@link buildDigest}
 * keeps exactly those lines, plus the head and the tail, and drops the rest.
 *
 * The digest feeds two things, in this order of authority:
 *  - the recoverable stub left on the surface by the tool-result archive, so
 *    the model keeps the signal while the exact text waits in the store;
 *  - a memory ingested for retrieval, so the signal outlives a compaction.
 *
 * Distillation is therefore lossy only BY DEFAULT: `memory_expand` still hands
 * back the exact archived text.
 *
 * @module dsh-infinite-context/absorb
 */

/** Options controlling absorb-style distillation. */
export interface AbsorbOptions {
  /** Whether oversized results are distilled at all. */
  readonly enabled: boolean
  /** Results at or below this code-point size are left alone. */
  readonly minChars: number
  /** Hard cap on the digest size in code points. */
  readonly maxDigestChars: number
}

/**
 * Defaults. `minChars` sits below the archive threshold (6000) so every result
 * big enough to be archived is also worth distilling — the archive gate is what
 * actually decides which results are touched.
 */
export const DEFAULT_ABSORB_OPTIONS: AbsorbOptions = {
  enabled: true,
  minChars: 4000,
  maxDigestChars: 1200,
}

/** Longest single line kept in a digest (code points). */
export const ABSORB_MAX_LINE_CHARS = 240
/** Head lines kept verbatim, whatever they say. */
export const ABSORB_HEAD_LINES = 3
/** Tail lines kept verbatim, whatever they say. */
export const ABSORB_TAIL_LINES = 3
/** Rough price of one signal line, used to bound how many are scanned. */
const SIGNAL_LINE_COST = 120

/**
 * Lines that carry the OUTCOME of a tool call: failures, warnings, exit codes,
 * test counts, diff stats, and file paths. Everything else in a huge payload is
 * usually payload (JSON, source, logs) the model does not need verbatim.
 */
const SIGNAL_PATTERNS: readonly RegExp[] = [
  /\b(error|errors|failed|failure|fatal|panic|exception|traceback)\b/i,
  /\b(denied|refused|rejected|timeout|timed out|not found|no such|cannot|unable|invalid|conflict|aborted)\b/i,
  /\b(warn|warning|deprecated|retry|retrying)\b/i,
  /\bexit(?:ed)?\s*(?:code|status)?\s*[:=]?\s*\d+/i,
  /\b\d+\s+(?:passed|failed|skipped|pending|errors?)\b/i,
  /\b(?:tests?|suites?|specs?)\b[^\n]*\b(?:pass|passed|fail|failed|green|red)\b/i,
  /\b\d+\s+(?:insertions?|deletions?)\b/i,
  /\bfiles? changed\b/i,
  /\b[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|cpp|c|h|hpp|json|ya?ml|toml|md|sql|sh|ps1|css|html)\b/,
  /^\s*(?:[\u2717\u2718\u00d7]|FAIL|FAILED|ERROR|WARN\b|Traceback)/,
]

/** Unicode-code-point length (surrogate-pair safe). */
function measureChars(text: string): number {
  return Array.from(text).length
}

/** True when a line carries a signal the digest wants. */
function isSignal(line: string): boolean {
  return SIGNAL_PATTERNS.some(pattern => pattern.test(line))
}

/**
 * Distill one tool result into a digest of its signal lines, head, and tail.
 *
 * Best-effort and bounded: the result is never longer than
 * `maxDigestChars` code points, every line is clipped to
 * {@link ABSORB_MAX_LINE_CHARS}, and duplicate lines are dropped.
 *
 * @param tool - the tool name (for the digest header).
 * @param text - the exact result text.
 * @param options - the resolved absorb policy.
 * @returns the digest, or `null` when there is nothing worth absorbing.
 */
export function buildDigest(
  tool: string,
  text: string,
  options: AbsorbOptions = DEFAULT_ABSORB_OPTIONS,
): string | null {
  if (!options.enabled) return null
  const chars = measureChars(text)
  if (chars <= options.minChars) return null
  const lines = text.split(/\r?\n/)
  const header = '[' + tool + ' result absorbed: ' + chars + ' chars / ' + lines.length + ' lines]'
  const kept: string[] = [header]
  const seen = new Set<string>()
  let used = measureChars(header)
  const add = (line: string): boolean => {
    const trimmed = line.trim().slice(0, ABSORB_MAX_LINE_CHARS)
    if (trimmed.length === 0 || seen.has(trimmed)) return false
    const cost = measureChars(trimmed) + 1
    if (used + cost > options.maxDigestChars) return false
    seen.add(trimmed)
    kept.push(trimmed)
    used += cost
    return true
  }

  for (const line of lines.slice(0, ABSORB_HEAD_LINES)) add(line)

  const signalCap = Math.max(1, Math.floor(options.maxDigestChars / SIGNAL_LINE_COST))
  let signals = 0
  for (const line of lines) {
    if (signals >= signalCap) break
    if (!isSignal(line)) continue
    if (add(line)) signals++
  }

  for (const line of lines.slice(Math.max(ABSORB_HEAD_LINES, lines.length - ABSORB_TAIL_LINES))) {
    add(line)
  }

  // Nothing beyond the header: the payload is one long undifferentiated blob,
  // so the archive's head+tail stub is at least as useful.
  if (kept.length <= 1) return null
  const digest = kept.join('\n')
  return measureChars(digest) > options.maxDigestChars
    ? Array.from(digest).slice(0, options.maxDigestChars).join('')
    : digest
}
