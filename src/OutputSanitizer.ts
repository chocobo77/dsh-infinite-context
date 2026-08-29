/**
 * Sanitize tool execution results before they enter the context window.
 *
 * Purpose: reduce token consumption from verbose tool outputs while preserving
 * the semantic content the LLM needs. Three strategies by source type:
 *   - web_search: extract title + snippet, strip HTML
 *   - code_exec: keep tail 200 lines of stdout + errors
 *   - generic JSON: recursive string truncation at configurable max chars
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
function sanitizeWebSearch(result: Record<string, unknown>): Record<string, unknown> {
  const items = result.results ?? result.items ?? result.hits
  if (!Array.isArray(items)) return stripHtmlRecursive(result) as Record<string, unknown>
  const cleaned = items.slice(0, 10).map((item: Record<string, unknown>) => ({
    title: typeof item.title === 'string' ? stripHtml(item.title) : item.title,
    snippet: typeof (item.snippet ?? item.description) === 'string'
      ? stripHtml(String(item.snippet ?? item.description))
      : (item.snippet ?? item.description),
    ...(item.url != null ? { url: item.url } : {}),
  }))
  return { results: cleaned, total: result.total ?? cleaned.length }
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
 * Sanitize a raw tool result to fit within the token budget.
 *
 * Dispatches by `source`:
 *   - 'web_search'  → extract title + snippet, strip HTML
 *   - 'code_exec'   → tail 200 lines of stdout + error
 *   - everything else → recursive string truncation
 *
 * @param raw    the raw tool result (never mutated — a sanitized copy is returned).
 * @param source the tool/source identifier (e.g. 'web_search', 'code_exec').
 * @param config sanitizer configuration (maxChars for generic JSON).
 * @returns the sanitized result.
 */
export function sanitizeToolResult(
  raw: unknown,
  source: string,
  config: SanitizerConfig = { maxChars: DEFAULT_MAX_CHARS },
): unknown {
  if (raw === null || raw === undefined) return raw
  if (typeof raw !== 'object') return raw

  const obj = raw as Record<string, unknown>

  switch (source) {
    case 'web_search':
      return sanitizeWebSearch(obj)
    case 'code_exec':
      return sanitizeCodeExec(obj)
    default:
      return truncateStrings(obj, config.maxChars)
  }
}
