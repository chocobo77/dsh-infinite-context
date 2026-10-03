/**
 * Sanitize tool execution results before they are ingested into the vector
 * memory.
 *
 * Scope note: this cleans the COPY that goes into persistent memory. The raw
 * tool result still reaches the current turn's context window as-is (the
 * tools/result event is post-hoc and cannot rewrite it) — do not rely on this
 * module as a token guard for the live context.
 *
 * Purpose: reduce memory noise from verbose tool outputs while preserving
 * the semantic content worth retrieving later. Strategies by payload shape:
 *   - ContentBlock[] (the automatic `tools/result` path): each block's text
 *     payload is sanitized per source strategy; non-text blocks are preserved.
 *   - plain string: the same source strategies applied to the text directly.
 *   - structured object (the manual `memory_ingest` path), by source type:
 *       - web_search: extract title + snippet, strip HTML
 *       - code_exec: keep tail 200 lines of stdout + errors
 *       - generic JSON: recursive string truncation at configurable max chars
 *
 * This is a pure utility — no DSH imports, no side effects, fully unit-testable.
 *
 * @module dsh-infinite-context/OutputSanitizer
 */

export interface SanitizerConfig {
  maxChars: number
}

const HTML_TAG_RE = /<[^>]+>/g
const WHITESPACE_RE = /\s+/g

/** Default character limit for generic JSON string fields. */
const DEFAULT_MAX_CHARS = 2000

/** How many trailing lines to keep from code execution stdout. */
const CODE_EXEC_TAIL_LINES = 200

/** Strip all HTML tags and collapse whitespace. */
function stripHtml(text: string): string {
  return text.replace(HTML_TAG_RE, ' ').replace(WHITESPACE_RE, ' ').trim()
}

/** Recursively strip HTML tags from all string fields in an object tree (non-mutating). */
function stripHtmlRecursive(obj: unknown): unknown {
  if (typeof obj === 'string') return stripHtml(obj)
  if (Array.isArray(obj)) return obj.map(stripHtmlRecursive)
  if (obj !== null && typeof obj === 'object') {
    const record = obj as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record)) out[key] = stripHtmlRecursive(record[key])
    return out
  }
  return obj
}

/** Extract just the content fields from a web_search result. */
function sanitizeWebSearch(result: Record<string, unknown>, config: SanitizerConfig): Record<string, unknown> {
  // DSH's own web_search reports `{ content?, sources: [{ url, title, snippet }] }`;
  // other producers use results/items/hits. Missing `sources` meant the REAL
  // payload skipped extraction and the 10-item cap entirely.
  const key = (['sources', 'results', 'items', 'hits'] as const).find(name => Array.isArray(result[name]))
  if (key === undefined) {
    // Unknown shape: still strip HTML, but bound the size like the generic path.
    return truncateStrings(stripHtmlRecursive(result), config.maxChars) as Record<string, unknown>
  }
  const cleaned = (result[key] as Record<string, unknown>[]).slice(0, 10).map(item => ({
    title: typeof item.title === 'string' ? stripHtml(item.title) : item.title,
    snippet: typeof (item.snippet ?? item.description) === 'string'
      ? stripHtml(String(item.snippet ?? item.description))
      : (item.snippet ?? item.description),
    ...(item.url != null ? { url: item.url } : {}),
  }))
  const out: Record<string, unknown> = { [key]: cleaned, total: result.total ?? cleaned.length }
  if (typeof result.content === 'string' && result.content.length > 0) out.content = stripHtml(result.content)
  return out
}

/** Keep tail N lines of stdout + error from a code execution result. */
function sanitizeCodeExec(result: Record<string, unknown>): Record<string, unknown> {
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const error = result.error ?? result.stderr
  const lines = stdout.split('\n')
  const tail = lines.length > CODE_EXEC_TAIL_LINES
    ? lines.slice(-CODE_EXEC_TAIL_LINES)
    : lines
  const out: Record<string, unknown> = { stdout: tail.join('\n') }
  if (error != null && error !== '') out.error = error
  if (result.exitCode != null) out.exitCode = result.exitCode
  return out
}

/** Recursively truncate string fields longer than maxChars (non-mutating). */
function truncateStrings(obj: unknown, maxChars: number): unknown {
  if (typeof obj === 'string') {
    return obj.length > maxChars ? obj.slice(0, maxChars) + '…[truncated]' : obj
  }
  if (Array.isArray(obj)) return obj.map(item => truncateStrings(item, maxChars))
  if (obj !== null && typeof obj === 'object') {
    const record = obj as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record)) out[key] = truncateStrings(record[key], maxChars)
    return out
  }
  return obj
}

/**
 * Text-level strategy for payloads that arrive as rendered text (the
 * `tools/result` listener sees ContentBlock[] / strings, not the tool's
 * native structured output, so the structured strategies below cannot run):
 *   - web_search → strip HTML + collapse whitespace
 *   - code_exec  → keep the tail CODE_EXEC_TAIL_LINES lines
 *   - everything else → truncate at maxChars
 */
function sanitizeTextContent(text: string, source: string, config: SanitizerConfig): string {
  switch (source) {
    case 'web_search':
      return stripHtml(text)
    case 'code_exec': {
      const lines = text.split('\n')
      return lines.length > CODE_EXEC_TAIL_LINES
        ? lines.slice(-CODE_EXEC_TAIL_LINES).join('\n')
        : text
    }
    default:
      return text.length > config.maxChars
        ? text.slice(0, config.maxChars) + '…[truncated]'
        : text
  }
}

/**
 * Sanitize one entry of a content-block array: rewrite the text payload of
 * text blocks, pass everything else (images, tool-call blocks, …) through so
 * the message keeps its modality.
 */
function sanitizeBlock(block: unknown, source: string, config: SanitizerConfig): unknown {
  if (typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string') {
    return { ...block, text: sanitizeTextContent((block as { text: string }).text, source, config) }
  }
  return block
}

/**
 * Sanitize a raw tool result to fit within the token budget.
 *
 * Dispatches by payload shape and `source`:
 *   - string            → per-source text strategy (web_search strip HTML /
 *                         code_exec tail / generic maxChars truncation)
 *   - ContentBlock[]    → per-block text strategy, non-text blocks preserved
 *   - object, web_search → extract title + snippet, strip HTML
 *   - object, code_exec  → tail 200 lines of stdout + error
 *   - object, other      → recursive string truncation
 *
 * @param raw    the raw tool result (never mutated — a sanitized copy is returned).
 * @param source the tool/source identifier (e.g. 'web_search', 'code_exec').
 * @param config sanitizer configuration (maxChars for generic JSON / text).
 * @returns the sanitized result.
 */
export function sanitizeToolResult(
  raw: unknown,
  source: string,
  config: SanitizerConfig = { maxChars: DEFAULT_MAX_CHARS },
): unknown {
  if (raw === null || raw === undefined) return raw
  if (typeof raw === 'string') return sanitizeTextContent(raw, source, config)
  if (Array.isArray(raw)) return raw.map(block => sanitizeBlock(block, source, config))
  if (typeof raw !== 'object') return raw

  const obj = raw as Record<string, unknown>

  switch (source) {
    case 'web_search':
      return sanitizeWebSearch(obj, config)
    case 'code_exec':
      return sanitizeCodeExec(obj)
    default:
      return truncateStrings(obj, config.maxChars)
  }
}
