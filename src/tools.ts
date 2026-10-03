/**
 * Manual model-callable tools for the memory system: search, status, forget,
 * consolidate, reset, ingest + compress, and tool-result expand. Loaded as a
 * `cordis.yml` entry that injects `tools` and `memoryContext`.
 *
 * @module dsh-infinite-context/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sanitizeToolResult } from './OutputSanitizer.ts'
import { oneLine } from './strings.ts'

export const name = 'memory-tools'
export const inject = ['tools', 'memoryContext', 'sessions']

/** Render retrieval hits as a compact text block for the tool output. */
function renderHits(hits: { doc: { tier: string; text: string }; score: number }[]): string {
  if (hits.length === 0) {
    return '(no relevant memories found — the store does not record this topic; '
      + 'it does NOT mean the topic never appeared. The store only holds curated summaries.)'
  }
  return hits.map(({ doc, score }, index) => (
    `[${index + 1}] (${doc.tier}, score ${score.toFixed(3)})\n${doc.text}`
  )).join('\n\n')
}

/**
 * Code-point window(s) around every occurrence of `query` in `original`.
 * @param original - the archived text.
 * @param query - the substring to look for (case-insensitive).
 * @param maxWindows - upper bound on the number of returned windows.
 * @param pad - code points of context kept on each side of a match.
 * @returns one `...window...` string per match, up to `maxWindows`.
 */
export function matchWindows(original: string, query: string, maxWindows: number, pad = 200): string[] {
  const points = Array.from(original)
  const haystack = original.toLowerCase()
  const needle = query.toLowerCase()
  const windows: string[] = []
  let from = 0
  while (windows.length < maxWindows) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    // `indexOf` reports a UTF-16 offset, but the window is sliced from a
    // CODE-POINT array: with an astral character (emoji, some CJK extensions)
    // before the match the two index spaces diverge, so the window would start
    // past the match and the scan would drift. Convert, and keep `from` in
    // UTF-16 space because it feeds `indexOf`.
    const startPoint = Array.from(original.slice(0, at)).length
    const matchPoints = Array.from(original.slice(at, at + needle.length)).length
    const start = Math.max(0, startPoint - pad)
    const end = Math.min(points.length, startPoint + matchPoints + pad)
    windows.push('...' + points.slice(start, end).join('') + '...')
    from = at + needle.length
  }
  return windows
}

/** Register the memory tools. */
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Semantically search the persistent multi-tier memory for summaries relevant to a query.',
    parameters: {
      query: { type: 'string', required: true, description: 'The question or topic to search for.' },
      k: { type: 'number', description: 'Max number of results (default 5).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { query: string; k?: number }) {
      const hits = await ctx.memoryContext.retrieve(args.query, args.k ?? 5)
      const base = renderHits(hits)
      // Upstream `search_context` parity: a keyword sweep over the folded
      // (compressed) ranges, which the semantic store only keeps as
      // summaries. Each hit names the ref that restores the exact text.
      const folded = ctx.memoryContext.searchFoldedRanges(args.query, 3)
      if (folded.length === 0) return base
      const section = folded.map((row, index) => (
        `[f${index + 1}] (folded range ${row.ref}, ${row.messages} messages, ${row.chars} chars)\n  ${row.preview}`
      )).join('\n')
      return base + '\n\nKeyword matches in folded (compressed) history — memory_expand ref=<ref> returns the exact text:\n' + section
    },
    presentCall: args => ({ card: 'generic', title: 'Memory search', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_status',
    description: 'Report the memory system status: tier counts, budgets, embedder, forgetting policy, the adopted model context window, and the last week of context accounting (injected tokens/memories, surface skips, archived chars, compactions, provider cache hit rate).',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute() {
      const status = ctx.memoryContext.status()
      return JSON.stringify({
        ...status,
        // Reverse compaction: what is archived and therefore still recoverable.
        foldedRanges: {
          ...ctx.memoryContext.foldedRangeStats(),
          recent: ctx.memoryContext.listFoldedRanges(5),
        },
        modelContext: ctx.memoryContext.modelInfo
          ?? { contextWindow: ctx.memoryContext.contextWindow, source: 'config' },
        perModelWindows: ctx.memoryContext.perModelWindows(),
        usage: ctx.memoryContext.usageSummary(7) ?? null,
      }, null, 2)
    },
    presentCall: () => ({ card: 'generic', title: 'Memory status', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_model_probe',
    description: 'Report the current model context window (CTX) and how it was resolved: "request-context" (DSH model catalog / /models), "probe" (live local server query), or "config" (configured fallback). Optionally force a fresh live probe of the local server.',
    parameters: {
      forceProbe: { type: 'boolean', description: 'Force a live probe of the configured local server (llama/ollama/openai).' },
      model: { type: 'string', description: 'Model id to probe (defaults to the last observed model).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { forceProbe?: boolean; model?: string }) {
      const info = args.forceProbe === true
        ? await ctx.memoryContext.probeModel(args.model)
        : ctx.memoryContext.modelInfo
      const perModel = ctx.memoryContext.perModelWindows()
        .map(entry => `${entry.model ?? '?'}=${entry.contextWindow}(${entry.source})`)
        .join(', ')
      if (info !== null) {
        return `Model context: ${info.contextWindow} tokens (source=${info.source})`
          + (info.model === undefined ? '' : `, model=${info.model}`)
          + (info.provider === undefined ? '' : `, provider=${info.provider}`)
          + (perModel.length === 0 ? '' : `\nPer-model windows: ${perModel}`)
      }
      return `Model context: ${ctx.memoryContext.contextWindow} tokens (source=config fallback; `
        + 'no request context or live probe resolved one yet)'
      + (perModel.length === 0 ? '' : `\nPer-model windows: ${perModel}`)
    },
    presentCall: args => ({ card: 'generic', title: 'Memory model probe', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_index',
    description: 'List the structured memory index (MEMORY.md style): every stored memory as one line, grouped by kind (project/reference/feedback/user). Use this to see WHAT the store contains, then memory_search to fetch full details on demand.',
    parameters: {
      limit: { type: 'number', description: 'Max entries per kind group (default 10).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { limit?: number }) {
      return ctx.memoryContext.generateIndex(args.limit ?? 10)
    },
    presentCall: args => ({ card: 'generic', title: 'Memory index', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_maintain',
    description: 'Audit the memory store for maintenance issues: near-duplicate entries (repeated decisions), candidate conflicts (similar but different conclusions), and stale low-value entries. Read-only — nothing is deleted.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute() {
      const report = ctx.memoryContext.maintain()
      const lines: string[] = [`Memory audit: ${report.total} memories total.`]
      lines.push(`- duplicates (score >= 0.95): ${report.duplicates.length}`)
      lines.push(`- candidate conflicts (0.85–0.95): ${report.conflicts.length}`)
      lines.push(`- stale low-value (>30d, importance<0.4): ${report.stale.length}`)
      for (const [a, b] of report.duplicates) {
        lines.push(`  dup: "${oneLine(a.text)}" ≈ "${oneLine(b.text)}"`)
      }
      for (const { a, b, score } of report.conflicts) {
        lines.push(`  conflict(${score.toFixed(2)}): "${oneLine(a.text)}" vs "${oneLine(b.text)}"`)
      }
      return lines.join('\n')
    },
    presentCall: () => ({ card: 'generic', title: 'Memory maintain', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Run a forgetting sweep: drop low-value memories per the configured policy.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute() {
      const result = await ctx.memoryContext.forget()
      return `Forgot ${result.dropped.length} memories; ${result.retained} remain.`
    },
    presentCall: () => ({ card: 'generic', title: 'Memory forget', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_consolidate',
    description: 'Force pyramid consolidation: fold the oldest mid-tier summaries into one long-term memory.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute() {
      try {
        const result = await ctx.memoryContext.consolidate()
        if (result === null) return 'Nothing to consolidate (below the merge threshold).'
        return `Consolidated ${result.demotedMids.length} mid memories into one long memory (${result.merged?.id}; the mids were demoted to the short tier).`
      } catch (err) {
        // No summarization target (no configured provider/model and no
        // session-routed model available) is not an error the tool should
        // surface as a crash — report it as a skip.
        return `Pyramid consolidation skipped: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Memory consolidate', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_reset',
    description: 'Erase ALL persisted memories and reset the vector index. Requires confirm=true.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'Must be true to reset.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { confirm: boolean }) {
      if (args.confirm !== true) throw new Error('memory_reset requires confirm=true')
      ctx.memoryContext.reset()
      return 'All memories erased and the index reset.'
    },
    presentCall: args => ({ card: 'generic', title: 'Memory reset', kind: 'delete', rawInput: args }),
  }))

  // --- New tools for the four governance strategies ---

  ctx.tools.register(defineTool({
    name: 'memory_ingest',
    description: 'Sanitize and ingest a tool result into the vector memory for future retrieval. Usually triggered automatically by the tools/result callback — this manual tool is an escape hatch for explicit ingestion after web_search, code_exec, or other tool results that should be remembered.',
    parameters: {
      source: { type: 'string', required: true, description: 'The tool source identifier (e.g. "web_search", "code_exec").' },
      result: { type: 'string', required: true, description: 'The raw tool result (JSON string or plain text).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { source: string; result: string }) {
      try {
        const parsed = (() => { try { return JSON.parse(args.result) } catch { return args.result } })()
        // Reuse the compaction engine's configured sanitizer cap
        // (sanitize_max_chars) instead of a hard-coded default.
        const maxChars = ctx.memoryContext.compactionEngine?.sanitizerConfig?.maxChars ?? 2000
        const sanitized = sanitizeToolResult(parsed, args.source, { maxChars })
        const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized)
        // Reuse the compaction engine's configured retriever (rag_* config)
        // instead of constructing a hard-coded one here.
        const retriever = ctx.memoryContext.retriever
        if (retriever === null) {
          return 'Ingestion unavailable: memory-compaction engine not loaded.'
        }
        await retriever.ingest(text, args.source)
        return `Ingested sanitized result from ${args.source} (${text.length} chars).`
      } catch (err) {
        return `Ingestion failed: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Memory ingest', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_force_compress',
    description: 'Force a history compression for the current session, bypassing the round-interval check. Calls the compressor directly.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'The session ID to compress.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { sessionId: string }) {
      try {
        const engine = ctx.memoryContext.compactionEngine
        if (engine != null) {
          const session = ctx.sessions.get(SessionId(args.sessionId))
          if (session != null) {
            const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
            const result = await engine.compressor.compressForce(args.sessionId, messages, { session })
            return `Force compressed session ${args.sessionId}: freed ${result.tokensSaved} tokens.`
          }
          return `Session ${args.sessionId} not found.`
        }
        return `Force compression unavailable: memory-compaction engine not loaded.`
      } catch (err) {
        return `Force compression failed: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Memory force compress', kind: 'other', rawInput: args }),
  }))
  ctx.tools.register(defineTool({
    name: 'memory_expand',
    description: 'Read archived text back from the store. Two kinds of ref: tr_… is an oversized tool result archived off the context (tool-result CCR, upstream ~billion-context CCR); fl_… is a folded history range — the exact messages a compression replaced with a summary (upstream `decompress`). Pass a ref to get its exact text back, optionally paginated with offset/limit or searched with query; omit ref to list the most recent archived results and folded ranges.',
    parameters: {
      ref: { type: 'string', description: 'Archive ref: tr_ab12cd34ef56 (archived tool result) or fl_ab12cd34ef56 (folded history range) — both appear in the stub/summary that replaced the text.' },
      query: { type: 'string', description: 'Substring to search: inside one archived result when ref is given, otherwise across every archived result.' },
      offset: { type: 'number', description: 'Code-point offset to start reading from (default 0).' },
      limit: { type: 'number', description: 'Code points to return (default 4000, max 20000); with ref+query, the number of match windows (default 5).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { ref?: string; query?: string; offset?: number; limit?: number }) {
      const query = args.query?.trim()
      const ref = args.ref?.trim()
      if (ref === undefined || ref.length === 0) {
        const listLimit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 10)))
        const searching = query !== undefined && query.length > 0
        const rows = searching
          ? ctx.memoryContext.searchToolResults(query, listLimit)
          : ctx.memoryContext.listToolResults(listLimit)
        const foldedRows = searching
          ? ctx.memoryContext.searchFoldedRanges(query, listLimit)
          : ctx.memoryContext.listFoldedRanges(listLimit)
        const sections: string[] = []
        if (rows.length > 0) {
          sections.push(rows.map(row => (
            '[' + row.ref + '] ' + row.tool + ' · ' + row.chars + ' chars · ' + new Date(row.createdAt).toISOString()
            + '\n  ' + row.preview
          )).join('\n\n'))
        }
        if (foldedRows.length > 0) {
          sections.push('Folded history ranges (reversible compaction):\n' + foldedRows.map(row => (
            '[' + row.ref + '] ' + row.messages + ' messages · ' + row.chars + ' chars · '
            + new Date(row.createdAt).toISOString()
            + (row.restoredCount > 0 ? ' · read back ' + row.restoredCount + 'x' : '')
            + '\n  ' + row.preview
          )).join('\n\n'))
        }
        if (sections.length === 0) return 'No archived tool results or folded history ranges match.'
        return sections.join('\n\n')
      }
      const record = ctx.memoryContext.getToolResult(ref)
      const folded = record === undefined ? ctx.memoryContext.getFoldedRange(ref) : undefined
      let header: string
      let original: string
      if (record !== undefined) {
        original = record.text
        header = 'Archived tool result ' + record.ref + ' (tool ' + record.tool + ', ' + Array.from(record.text).length
          + ' code points' + (record.callId === undefined ? '' : ', callId ' + record.callId) + ').'
      } else if (folded !== undefined) {
        // Reverse compaction: the exact pre-fold messages, restored on demand
        // (upstream billion-context calls this `decompress`).
        original = folded.original
        ctx.memoryContext.markFoldedRangeRestored(folded.ref)
        header = 'Folded history range ' + folded.ref + ' (' + folded.messages + ' messages, '
          + Array.from(folded.original).length + ' code points, folded '
          + new Date(folded.createdAt).toISOString() + ').\n'
          + 'Summary currently on the surface: '
          + folded.summary.replace(/\s+/g, ' ').trim().slice(0, 240)
      } else {
        return 'Unknown archive ref: ' + ref + '. Call memory_expand without a ref to list recent entries.'
      }
      const points = Array.from(original)
      if (query !== undefined && query.length > 0) {
        const label = JSON.stringify(query)
        const maxWindows = Math.max(1, Math.min(20, Math.floor(args.limit ?? 5)))
        const windows = matchWindows(original, query, maxWindows)
        if (windows.length === 0) return header + '\nNo match for ' + label + '.'
        return header + '\n' + windows.length + ' match window(s) for ' + label + ':\n\n' + windows.join('\n\n')
      }
      const offset = Math.max(0, Math.floor(args.offset ?? 0))
      const want = Math.max(1, Math.min(20000, Math.floor(args.limit ?? 4000)))
      const slice = points.slice(offset, offset + want)
      if (slice.length === 0) return header + '\nOffset ' + offset + ' is past the end of the archived text.'
      const readTo = offset + slice.length
      const tail = readTo < points.length
        ? '\n\n[read up to code point ' + readTo + ' of ' + points.length + '; call again with offset ' + readTo + ']'
        : '\n\n[end of archived text]'
      return header + '\n\n' + slice.join('') + tail
    },
    presentCall: args => ({ card: 'generic', title: 'Tool result expand', kind: 'other', rawInput: args }),
  }))
}
