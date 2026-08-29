/**
 * Manual model-callable tools for the memory system: search, status, forget,
 * consolidate, reset, and (new) ingest + compress. Loaded as a separate
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
      return renderHits(hits)
    },
    presentCall: args => ({ card: 'generic', title: 'Memory search', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_status',
    description: 'Report the memory system status: tier counts, budgets, embedder, forgetting policy, and the adopted model context window.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    async execute() {
      const status = ctx.memoryContext.status()
      return JSON.stringify({
        ...status,
        modelContext: ctx.memoryContext.modelInfo
          ?? { contextWindow: ctx.memoryContext.contextWindow, source: 'config' },
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
      if (info !== null) {
        return `Model context: ${info.contextWindow} tokens (source=${info.source})`
          + (info.model === undefined ? '' : `, model=${info.model}`)
          + (info.provider === undefined ? '' : `, provider=${info.provider}`)
      }
      return `Model context: ${ctx.memoryContext.contextWindow} tokens (source=config fallback; `
        + 'no request context or live probe resolved one yet)'
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
      const result = await ctx.memoryContext.consolidate()
      if (result === null) return 'Nothing to consolidate (below the merge threshold).'
      return `Consolidated ${result.droppedMids.length} mid memories into one long memory (${result.merged?.id}).`
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
        const sanitized = sanitizeToolResult(parsed, args.source, { maxChars: 2000 })
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
            const result = await engine.compressor.compressForce(args.sessionId, messages)
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
}
