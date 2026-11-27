/**
 * Manual model-callable tools for the memory system: search, status, forget,
 * consolidate, reset, ingest + compress, and tool-result expand. Loaded as a
 * `cordis.yml` entry that injects `tools` and `memoryContext`.
 *
 * @module dsh-infinite-context/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { renderFoldAttachmentLines } from './fold-archive.ts'
import { sanitizeToolResult } from './OutputSanitizer.ts'
import { oneLine } from './strings.ts'

export const name = 'memory-tools'
export const inject = ['tools', 'memoryContext', 'sessions']

/** Longest memory_write payload (a fact, not a transcript). */
const MEMORY_WRITE_MAX_CHARS = 2000
/** memory_write cap per session — retrieval attention is the scarce resource. */
const MEMORY_WRITE_SESSION_MAX = 20

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
  // Cap the needle: every window carries the whole query text, so a
  // multi-10k-char query would blow the tool output past the paging contract
  // the banner promises. 300 code points is ample for a search phrase.
  const needle = Array.from(query.toLowerCase()).slice(0, 300).join('')
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

/**
 * Count EVERY occurrence of `query` in `original` (case-insensitive), not just
 * the capped set `matchWindows` returns, so the tool can say "showing 5 of 9".
 * @param original - the archived text.
 * @param query - the substring to look for.
 * @returns the total number of occurrences (0 for an empty query).
 */
export function countMatches(original: string, query: string): number {
  const needle = query.toLowerCase()
  if (needle.length === 0) return 0
  const haystack = original.toLowerCase()
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count++
    from = at + needle.length
  }
}

/** Default and maximum page sizes of one `memory_expand` read, in code points. */
export const EXPAND_PAGE_CODE_POINTS = 4000
export const EXPAND_MAX_CODE_POINTS = 20000
/** Default and maximum match-window counts of one `memory_expand` query read. */
export const EXPAND_DEFAULT_WINDOWS = 5
export const EXPAND_MAX_WINDOWS = 20

/**
 * Self-describing banner for a `memory_expand` page read, placed as the FIRST
 * line of the returned text.
 *
 * Why the banner must lead the response: the caller (the harness) may truncate
 * a large tool result AGAIN after the tool returns, and it cuts the tail —
 * production evidence shows a 7473-code-point expand being cut this way, after
 * which the model abandoned the archive. A banner at the top survives that cut
 * and tells the model the true size of the text, how much this response
 * carries, and how to fetch the rest via offset/limit paging.
 *
 * A banner is warranted when the read stopped before the end of the text, or
 * when the response body itself exceeds one default page (a body that large is
 * exactly what the caller truncates). Counts are Unicode code points, matching
 * the tool's offset/limit semantics.
 *
 * @param input - the ref, the total size, and the window actually returned.
 * @returns the banner line, or `null` when the read is complete and small.
 */
export function expandTruncationNotice(input: {
  readonly ref: string
  readonly totalPoints: number
  readonly offset: number
  readonly returnedPoints: number
  /**
   * Non-text payload riding the same response (attachment lines). Counts
   * toward "the body exceeds one page" but NEVER toward the read position —
   * mixing it into returnedPoints would advance readTo past text the model
   * never received and misreport "last page".
   */
  readonly extraPoints?: number
}): string | null {
  const readTo = input.offset + input.returnedPoints
  const truncated = readTo < input.totalPoints
  if (!truncated && input.returnedPoints + (input.extraPoints ?? 0) <= EXPAND_PAGE_CODE_POINTS) return null
  if (truncated) {
    const next = JSON.stringify({ ref: input.ref, offset: readTo })
    return '[TRUNCATED READ — full text is ' + input.totalPoints + ' code points; this response returns '
      + input.returnedPoints + ' (offset ' + input.offset + '\u2013' + readTo + '). More remains: '
      + 'call memory_expand ' + next + ' for the next page.]'
  }
  const page = JSON.stringify({ ref: input.ref, offset: input.offset, limit: EXPAND_PAGE_CODE_POINTS })
  return '[READ — offset ' + input.offset + '\u2013' + readTo + ' of ' + input.totalPoints
    + ' code points, last page. If this response looks cut short, the tool CALLER truncated it: '
    + 'page through with memory_expand ' + page + ', advancing offset by limit each call.]'
}

/** Register the memory tools. */
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Semantic search over persistent memory summaries.',
    parameters: {
      query: { type: 'string', required: true, description: 'Question or topic.' },
      k: { type: 'number', description: 'Max results (default 5).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { query: string; k?: number }) {
      // Clamp: a huge k renders the whole store into one model-visible result.
      const k = Math.max(1, Math.min(20, Math.floor(args.k ?? 5)))
      const hits = await ctx.memoryContext.retrieve(args.query, k)
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
    description: 'Memory system status: tier counts, budgets, model window, 7-day context accounting (injections, skips, archived chars, compactions, cache hit rate).',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute() {
      const status = ctx.memoryContext.status()
      return JSON.stringify({
        ...status,
        // Agent-curated writes this process (memory_write cap accounting).
        memoryWrites: [...memoryWriteCounts.values()].reduce((sum, count) => sum + count, 0),
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
    description: 'Current model context window (CTX) and its source: "request-context" / "probe" / "config"; forceProbe re-queries the local server live.',
    parameters: {
      forceProbe: { type: 'boolean', description: 'Re-probe the local server live.' },
      model: { type: 'string', description: 'Model id (default last observed).' },
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
    description: 'List the memory index (one line per memory, grouped by kind). See WHAT exists, then memory_search for full details.',
    parameters: {
      limit: { type: 'number', description: 'Max entries per kind (default 10).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { limit?: number }) {
      // Clamp: negative slice(0, -n) and huge limits both render wrong scopes.
      const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 10)))
      return ctx.memoryContext.generateIndex(limit)
    },
    presentCall: args => ({ card: 'generic', title: 'Memory index', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_maintain',
    description: 'Audit the memory store: near-duplicates, candidate conflicts, stale low-value entries. Read-only.',
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

  // Consecutive zero-drop memory_forget calls. THREE escalation layers,
  // because prose provably fails: production 2026-11-11 session a24b23b6
  // ran the tool 122 times — the model (glm-5.3-flash) degenerated into
  // BARE tool-call responses (zero reasoning, ~7 output tokens each), so
  // neither the explanation nor the STOP instruction was ever read. Layer 3
  // is execution-level: the breaker THROWS, and an error-shaped tool result
  // is the only signal a degenerate loop responds to.
  let consecutiveZeroForgetDrops = 0
  // Per-session memory_write counters. The cap must survive DSH restarts — a
  // process-memory map made the cap bypassable by restarting (the 0.9.8
  // review's F5) — so the durable value lives in plugin_kv under
  // `memory-write:<sessionId>`; the module map mirrors it as the in-process
  // status readout.
  const memoryWriteCounts = new Map<string, number>()
  const kvWriteCount = (capKey: string): number => {
    const mirror = memoryWriteCounts.get(capKey)
    if (mirror !== undefined) return mirror
    const raw = ctx.memoryContext.kvGet('memory-write:' + capKey)
    const value = raw === undefined ? 0 : Number.parseInt(raw, 10)
    const count = Number.isFinite(value) && value > 0 ? value : 0
    memoryWriteCounts.set(capKey, count)
    return count
  }
  const bumpWriteCount = (capKey: string, count: number): void => {
    memoryWriteCounts.set(capKey, count)
    // The write already landed; a KV hiccup must not turn success into a
    // tool error — the mirror advances and the KV catches up next write
    // (follow-up review F6).
    try {
      ctx.memoryContext.kvSet('memory-write:' + capKey, String(count))
    } catch { /* mirror stays authoritative for this process */ }
  }

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: 'Persist one durable fact for future sessions (preference/constraint/reference). Verbatim, deduplicated. NOT for session summaries — folds checkpoint automatically.',
    parameters: {
      text: { type: 'string', required: true, description: 'The fact, self-contained (max 2000 chars).' },
      kind: { type: 'string', description: '"user" / "feedback" / "project" / "reference". Default "project".' },
      importance: { type: 'number', description: '0-1 forgetting weight (default 0.6).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { text: string; kind?: string; importance?: number }, exec: ToolRunContext) {
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const capKey = sessionId ?? '(global)'
      const written = kvWriteCount(capKey)
      if (written >= MEMORY_WRITE_SESSION_MAX) {
        return `STOP — do not call memory_write again this session. ${written} writes is the cap `
          + `(MEMORY_WRITE_SESSION_MAX); each write costs retrieval attention for the REST of this `
          + `project. Keep only what a future session genuinely needs. Continue with the actual task.`
      }
      const text = args.text.trim()
      if (text.length === 0) return 'Nothing to remember: the text was empty.'
      const clipped = text.length > MEMORY_WRITE_MAX_CHARS
        ? text.slice(0, MEMORY_WRITE_MAX_CHARS) + '…'
        : text
      if (ctx.memoryContext.hasTextNormalized(clipped)) {
        return 'Already remembered — an equivalent memory exists; no second copy stored.'
      }
      const allowedKind = ['user', 'feedback', 'project', 'reference'] as const
      const requestedKind = args.kind ?? 'project'
      if (!(allowedKind as readonly string[]).includes(requestedKind)) {
        return `Rejected: kind "${requestedKind}" is not one of ${allowedKind.join(', ')}. `
          + `"checkpoint" is reserved for the automatic fold system and cannot be written manually.`
      }
      const kind = requestedKind as 'user' | 'feedback' | 'project' | 'reference'
      const importanceRaw = args.importance ?? 0.6
      const importance = Number.isFinite(importanceRaw) ? Math.min(1, Math.max(0, importanceRaw)) : 0.6
      const doc = await ctx.memoryContext.storeMemory(clipped, 'mid', {
        importance,
        kind,
        ...(sessionId === undefined ? {} : { sourceSessionId: sessionId }),
      })
      bumpWriteCount(capKey, written + 1)
      return `Remembered (${requestedKind}, importance ${importance.toFixed(2)}, id ${doc.id}`
        + `${clipped.length < text.length ? `, clipped from ${text.length}` : ''}). `
        + `${written + 1}/${MEMORY_WRITE_SESSION_MAX} writes used this session.`
    },
    presentCall: args => ({ card: 'generic', title: 'Memory write', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Run a forgetting sweep (drop low-value memories per policy). Idempotent; also reruns automatically after every fold.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute() {
      if (consecutiveZeroForgetDrops >= 2) {
        throw new Error(
          `memory_forget circuit breaker: ${consecutiveZeroForgetDrops} consecutive zero-drop sweeps. `
          + `The store is within the forgetting policy's bounds; the sweep also reruns automatically `
          + `after every fold. Do not call this tool again this turn.`,
        )
      }
      const result = await ctx.memoryContext.forget()
      if (result.dropped.length === 0) {
        consecutiveZeroForgetDrops++
        if (consecutiveZeroForgetDrops >= 2) {
          return `STOP — do not call memory_forget again. It has now returned 0 drops `
            + `${consecutiveZeroForgetDrops} times in a row: the result is deterministic, `
            + `${result.retained} memories are within the forgetting policy's bounds, and no `
            + `further call can change that. The sweep also runs automatically after every `
            + `fold. Continue with the actual task.`
        }
        return `Forgot 0 memories; ${result.retained} remain. The store is within the `
          + `forgetting policy's bounds — nothing more can be dropped right now (memories `
          + `age out under per-type half-lives, and the sweep reruns automatically after `
          + `every fold). Calling this tool again will return the same result.`
      }
      consecutiveZeroForgetDrops = 0
      return `Forgot ${result.dropped.length} memories; ${result.retained} remain `
        + `(policy cap enforced). The sweep reruns automatically after every fold — `
        + `manual calls are only needed for immediate cleanup.`
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
    description: 'Ingest a tool result into vector memory for future retrieval. Runs automatically via the tools/result callback; this is the manual escape hatch.',
    parameters: {
      source: { type: 'string', required: true, description: 'Tool source id (e.g. "web_search").' },
      result: { type: 'string', required: true, description: 'Raw tool result (JSON string or text).' },
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
    description: 'Force one surface compaction for a session now, bypassing trigger/interval; returns the committed compaction.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session ID to compress.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { sessionId: string }, exec: ToolRunContext) {
      try {
        const engine = ctx.memoryContext.compactionEngine
        if (engine == null) {
          return 'Force compression unavailable: memory-compaction engine not loaded.'
        }
        const agent = engine.agentFor(args.sessionId)
        if (agent === undefined) {
          return `Force compression skipped: session ${args.sessionId} has no active agent yet; `
            + 'run at least one step, or let the automatic fold/durable lane compact.'
        }
        // The fold runs as a SURFACE rewrite via compaction-basic's compactRegion.
        // The old implementation computed a summary from deriveMessages() but the
        // tool discarded the returned messages, so it reported a saving it never applied.
        const result = await engine.foldNow(agent, exec.signal, true)
        if (result === null) {
          return `Force compression found no safe foldable range for session ${args.sessionId}.`
        }
        return `Force compressed session ${args.sessionId}: shadowed ${result.shadowedSeqs.length} node(s), `
          + `~${result.shadowedTokenCount} tokens (compaction ${String(result.compactionId)}).`
      } catch (err) {
        return `Force compression failed: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'memory_expand',
    description: 'Read archived text back. tr_… = oversized tool result archived off the context; fl_… = folded history range (the exact messages a summary replaced). Pass ref for its text — paginate with offset/limit or search with query; omit ref to list recent archives and folded ranges. A read that stops short of the end (or is large enough to be cut by the caller) opens with a [TRUNCATED READ …]/[READ …] banner naming the full size and the exact next offset call.',
    parameters: {
      ref: { type: 'string', description: 'tr_… or fl_… ref, as named in the stub/summary that replaced the text.' },
      query: { type: 'string', description: 'Substring to search: within ref, or across all archives.' },
      offset: { type: 'number', description: 'Code-point offset (default 0).' },
      limit: { type: 'number', description: 'Code points (default 4000, max 20000); with ref+query, match windows (default 5).' },
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
      let archiveSessionId: string | undefined
      if (record !== undefined) {
        original = record.text
        archiveSessionId = record.sessionId
        header = 'Archived tool result ' + record.ref + ' (tool ' + record.tool + ', ' + Array.from(record.text).length
          + ' code points' + (record.callId === undefined ? '' : ', callId ' + record.callId) + ').'
      } else if (folded !== undefined) {
        // Reverse compaction: the exact pre-fold messages, restored on demand
        // (upstream billion-context calls this `decompress`).
        original = folded.original
        archiveSessionId = folded.sessionId
        header = 'Folded history range ' + folded.ref + ' (' + folded.messages + ' messages, '
          + Array.from(folded.original).length + ' code points, folded '
          + new Date(folded.createdAt).toISOString() + ').\n'
          + 'Summary currently on the surface: '
          + folded.summary.replace(/\s+/g, ' ').trim().slice(0, 240)
      } else {
        return 'Unknown archive ref: ' + ref + '. Call memory_expand without a ref to list recent entries.'
      }
      const points = Array.from(original)
      // Read-back telemetry, both tracks in ONE place, called only when
      // archived text actually came back — a failed read (offset past the
      // end, no match) counts on neither track.
      // Track 1 of 2: the fl_-only per-range counter surfaced by the listing
      // above ("read back Nx").
      // Track 2 of 2: one usage-ledger event per expansion (both tr_ and fl_
      // refs — this is the only counter the tr_ path has).
      const reportRestore = (returnedPoints: number, truncated: boolean): void => {
        if (folded !== undefined) ctx.memoryContext.markFoldedRangeRestored(folded.ref)
        ctx.memoryContext.recordExpandRestore({
          ref,
          returnedChars: returnedPoints,
          truncated,
          ...(archiveSessionId === undefined ? {} : { sessionId: archiveSessionId }),
        })
      }
      if (query !== undefined && query.length > 0) {
        const label = JSON.stringify(query)
        const maxWindows = Math.max(1, Math.min(EXPAND_MAX_WINDOWS, Math.floor(args.limit ?? EXPAND_DEFAULT_WINDOWS)))
        const windows = matchWindows(original, query, maxWindows)
        if (windows.length === 0) return header + '\nNo match for ' + label + '.'
        const totalMatches = countMatches(original, query)
        const capped = totalMatches > windows.length
        const body = windows.join('\n\n')
        reportRestore(Array.from(body).length, capped)
        // Attachment refs reach the model on the query path too: a caller who
        // locates content via query would otherwise never learn the archived
        // attachments exist (the 0.9.8 review's F11).
        const queryAttachments = folded !== undefined
          ? renderFoldAttachmentLines(ctx.memoryContext.getFoldAttachments(folded.ref))
          : ''
        const notice = capped
          ? '[PARTIAL MATCHES — ' + totalMatches + ' occurrence(s) in the archive; showing the first '
            + windows.length + ' window(s). Call again with a higher limit (max ' + EXPAND_MAX_WINDOWS
            + ') or a narrower query.]'
          : ''
        return (notice === '' ? '' : notice + '\n') + header + queryAttachments + '\n' + windows.length + ' match window(s) for '
          + label + (capped ? ' of ' + totalMatches + ' matches' : '') + ':\n\n' + body
      }
      const offset = Math.max(0, Math.floor(args.offset ?? 0))
      const want = Math.max(1, Math.min(EXPAND_MAX_CODE_POINTS, Math.floor(args.limit ?? EXPAND_PAGE_CODE_POINTS)))
      const slice = points.slice(offset, offset + want)
      if (slice.length === 0) return header + '\nOffset ' + offset + ' is past the end of the archived text.'
      const readTo = offset + slice.length
      const truncated = readTo < points.length
      // Archived non-text blocks ride the FIRST page only, directly under the
      // header: the truncation banner exists because the harness cuts long
      // tool results at the tail, so anything after the text slice would be
      // exactly what gets cut (the 0.9.8 review's F6). The banner must also
      // know the attachments consume page budget.
      const attachments = folded !== undefined && offset === 0
        ? renderFoldAttachmentLines(ctx.memoryContext.getFoldAttachments(folded.ref))
        : ''
      const notice = expandTruncationNotice({
        ref,
        totalPoints: points.length,
        offset,
        returnedPoints: slice.length,
        ...(attachments === '' ? {} : { extraPoints: Array.from(attachments).length }),
      })
      reportRestore(slice.length, truncated)
      const tail = truncated
        ? '\n\n[read up to code point ' + readTo + ' of ' + points.length + '; call again with offset ' + readTo + ']'
        : '\n\n[end of archived text]'
      return (notice === null ? '' : notice + '\n') + header + attachments + '\n\n' + slice.join('') + tail
    },
    presentCall: args => ({ card: 'generic', title: 'Tool result expand', kind: 'other', rawInput: args }),
  }))
}
