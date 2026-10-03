/**
 * A small append-only ledger of what the plugin did to the model's context and
 * what the provider charged for it.
 *
 * Two questions it answers, which no other part of the runtime can answer for
 * the plugin:
 *  - Are the memories we inject worth their tokens? (injected tokens/entries,
 *    entries skipped because the model already sees them)
 *  - Is the request prefix still cache-warm? (provider cache-read/write vs
 *    uncached input, per DSH's disjoint TokenUsage accounting)
 *
 * Best-effort by contract: a ledger failure is logged and swallowed, never
 * allowed to disturb the agent loop.
 *
 * @module dsh-infinite-context/usage-ledger
 */

import type { UsageDetailTotal, UsageEventRecord, UsageTotal } from './memory-store.ts'

/** Ledger policy. */
export interface UsageOptions {
  /** Whether context accounting is recorded at all. */
  readonly enabled: boolean
  /** Days of events to keep; 0 disables pruning. */
  readonly retentionDays: number
}

/** Defaults: on, one month of history. */
export const DEFAULT_USAGE_OPTIONS: UsageOptions = { enabled: true, retentionDays: 30 }

/** One session's routed model, as `session.requestContext()` reports it. */
export interface UsageAttributionRoute {
  readonly provider?: string
  readonly model?: string
}

/**
 * The ledger attribution for one assistant message: the session it belongs to,
 * plus `provider/model` when the route is known.
 *
 * The route MUST come from the session itself (`session.requestContext()`), not
 * from a tracker-wide "last observed" slot: with concurrent sessions on
 * different models, that slot belongs to whichever model was observed most
 * recently, which silently bills this session's cache/billing buckets to the
 * wrong model — exactly the per-model split this attribution exists to provide.
 */
export function usageAttribution(
  sessionId: string,
  route: UsageAttributionRoute | undefined,
): { sessionId: string; detail?: string } {
  if (route === undefined || (route.provider === undefined && route.model === undefined)) {
    return { sessionId }
  }
  return { sessionId, detail: `${route.provider ?? 'unknown'}/${route.model ?? 'unknown'}` }
}

/** Event kinds. Stable strings — they are persisted, so never rename one. */
export const USAGE_KIND = {
  /** Estimated tokens of the retrieved-context injection. */
  injectTokens: 'inject_tokens',
  /** Number of memories actually injected. */
  injectMemories: 'inject_memories',
  /** Memories skipped because their text is already on the surface. */
  surfaceSkips: 'surface_skips',
  /** Code points removed from the surface by the tool-result archive. */
  archiveChars: 'archive_stub_chars',
  /** Code points of the absorbed digests (0 when the stub was head+tail). */
  absorbChars: 'absorb_digest_chars',
  /** One scheduled (nudged) compression. */
  nudge: 'nudge_forced',
  /** Tokens saved by a history compression. */
  compactionSaved: 'compaction_saved_tokens',
  /** Model requests that reported usage. */
  llmRequests: 'llm_requests',
  /** Uncached input tokens (DSH: inputTokens is NOT the billed total). */
  llmInput: 'llm_input_tokens',
  llmOutput: 'llm_output_tokens',
  llmCacheRead: 'llm_cache_read_tokens',
  llmCacheWrite: 'llm_cache_write_tokens',
} as const

/** Writes between retention sweeps. */
const PRUNE_EVERY_WRITES = 256

/** Minimal logger surface (the cordis logger satisfies it). */
export interface UsageLedgerLogger {
  warn(message: string): void
}

/** The store surface the ledger needs. */
export interface UsageLedgerStore {
  recordUsageEvent(record: UsageEventRecord): void
  usageTotals(sinceTs?: number): UsageTotal[]
  listUsageEvents(limit?: number): UsageEventRecord[]
  pruneUsageEvents(beforeTs: number): number
  /** Optional: per-detail aggregation, present on the SQLite store. */
  usageTotalsByDetail?(sinceTs?: number): UsageDetailTotal[]
}

/** Dependencies, all injectable for tests. */
export interface UsageLedgerDeps {
  readonly store: UsageLedgerStore
  readonly options: UsageOptions
  readonly logger: UsageLedgerLogger
  /** Clock, injectable for tests; defaults to Date.now. */
  readonly now?: () => number
}

/** Folded accounting over one window, as reported by `memory_status`. */
export interface UsageSummary {
  readonly windowDays: number
  readonly events: number
  readonly injectedTokens: number
  readonly injectedMemories: number
  readonly surfaceSkips: number
  readonly archivedChars: number
  readonly absorbedChars: number
  readonly nudges: number
  readonly compactionSavedTokens: number
  readonly llm: {
    readonly requests: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    /** cacheRead / (input + cacheRead + cacheWrite); 0 when nothing was billed. */
    readonly cacheHitRate: number
  }
  /**
   * Per-model buckets (the `detail` label of the llm_* events, newest model
   * last). A mid-session model switch shows up here as a second bucket with a
   * collapsed cache-hit rate instead of hiding inside the blended total.
   */
  readonly models: readonly UsageModelTotal[]
}

/** One model's share of the ledger window. */
export interface UsageModelTotal {
  readonly model: string
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** cacheRead / (input + cacheRead + cacheWrite); 0 when nothing was billed. */
  readonly cacheHitRate: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Ledger kind → the per-model field it feeds. */
const LLM_DETAIL_FIELD: Record<string, 'input' | 'output' | 'read' | 'write'> = {
  [USAGE_KIND.llmInput]: 'input',
  [USAGE_KIND.llmOutput]: 'output',
  [USAGE_KIND.llmCacheRead]: 'read',
  [USAGE_KIND.llmCacheWrite]: 'write',
}

/** Human-readable error reason. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The context-accounting ledger. */
export class UsageLedger {
  private readonly store: UsageLedgerStore
  private readonly options: UsageOptions
  private readonly logger: UsageLedgerLogger
  private readonly now: () => number
  private writesSincePrune = 0

  /**
   * @param deps - store, policy, logger, and clock.
   */
  constructor(deps: UsageLedgerDeps) {
    this.store = deps.store
    this.options = deps.options
    this.logger = deps.logger
    this.now = deps.now ?? (() => Date.now())
  }

  /** Whether recording is on. */
  get enabled(): boolean {
    return this.options.enabled
  }

  /** The resolved policy. */
  get policy(): UsageOptions {
    return this.options
  }

  /**
   * Append one measurement. Zero, non-finite, and non-enabled events are
   * dropped, and a store failure is logged, never thrown.
   * @param kind - the event kind (see {@link USAGE_KIND}).
   * @param value - the measured amount (tokens, code points, or a count).
   * @param extra - optional session id and free-form detail.
   */
  record(kind: string, value: number, extra: { sessionId?: string; detail?: string } = {}): void {
    if (!this.options.enabled) return
    if (!Number.isFinite(value) || value === 0) return
    try {
      this.store.recordUsageEvent({
        ts: this.now(),
        kind,
        value: Math.round(value),
        ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
        ...(extra.detail === undefined ? {} : { detail: extra.detail }),
      })
      this.writesSincePrune++
      if (this.writesSincePrune >= PRUNE_EVERY_WRITES) {
        this.writesSincePrune = 0
        this.prune()
      }
    } catch (error) {
      this.logger.warn('usage ledger: record failed for ' + kind + ': ' + reasonOf(error))
    }
  }

  /**
   * Totals per kind since a timestamp.
   * @param sinceTs - epoch milliseconds lower bound (inclusive).
   * @returns the per-kind totals, or `[]` when the ledger is unavailable.
   */
  totals(sinceTs?: number): UsageTotal[] {
    try {
      return this.store.usageTotals(sinceTs)
    } catch (error) {
      this.logger.warn('usage ledger: totals failed: ' + reasonOf(error))
      return []
    }
  }

  /**
   * The newest events, for inspection.
   * @param limit - maximum rows.
   * @returns the events, newest first.
   */
  recent(limit = 20): UsageEventRecord[] {
    try {
      return this.store.listUsageEvents(limit)
    } catch (error) {
      this.logger.warn('usage ledger: recent failed: ' + reasonOf(error))
      return []
    }
  }

  /**
   * Drop events past retention.
   * @returns the number of deleted rows.
   */
  prune(): number {
    if (this.options.retentionDays <= 0) return 0
    try {
      return this.store.pruneUsageEvents(this.now() - this.options.retentionDays * DAY_MS)
    } catch (error) {
      this.logger.warn('usage ledger: prune failed: ' + reasonOf(error))
      return 0
    }
  }

  /**
   * Fold the last N days into the accounting summary `memory_status` reports.
   * @param days - the window in days (default 7).
   * @returns the summary; all zeros when the ledger is empty or unavailable.
   */
  summary(days = 7): UsageSummary {
    const totals = this.totals(this.now() - days * DAY_MS)
    const byKind = new Map<string, number>()
    let events = 0
    for (const total of totals) {
      byKind.set(total.kind, total.value)
      events += total.events
    }
    const value = (kind: string): number => byKind.get(kind) ?? 0
    const models = this.modelTotals(days)
    const inputTokens = value(USAGE_KIND.llmInput)
    const cacheReadTokens = value(USAGE_KIND.llmCacheRead)
    const cacheWriteTokens = value(USAGE_KIND.llmCacheWrite)
    const billed = inputTokens + cacheReadTokens + cacheWriteTokens
    return {
      windowDays: days,
      events,
      injectedTokens: value(USAGE_KIND.injectTokens),
      injectedMemories: value(USAGE_KIND.injectMemories),
      surfaceSkips: value(USAGE_KIND.surfaceSkips),
      archivedChars: value(USAGE_KIND.archiveChars),
      absorbedChars: value(USAGE_KIND.absorbChars),
      nudges: value(USAGE_KIND.nudge),
      compactionSavedTokens: value(USAGE_KIND.compactionSaved),
      llm: {
        requests: value(USAGE_KIND.llmRequests),
        inputTokens,
        outputTokens: value(USAGE_KIND.llmOutput),
        cacheReadTokens,
        cacheWriteTokens,
        cacheHitRate: billed === 0 ? 0 : Math.round((cacheReadTokens / billed) * 1000) / 1000,
      },
      models,
    }
  }

  /**
   * Bucket the llm_* events by their `detail` label (the provider/model the
   * request went to). Best-effort: a store without per-detail aggregation, or
   * a failing query, yields no model rows instead of failing the status call.
   * @param days - the window in days.
   * @returns one bucket per model, busiest first.
   */
  private modelTotals(days: number): UsageModelTotal[] {
    const aggregate = this.store.usageTotalsByDetail
    if (aggregate === undefined) return []
    type Bucket = { requests: number; input: number; output: number; read: number; write: number }
    const buckets = new Map<string, Bucket>()
    const bucketFor = (model: string): Bucket => {
      const existing = buckets.get(model)
      if (existing !== undefined) return existing
      const created: Bucket = { requests: 0, input: 0, output: 0, read: 0, write: 0 }
      buckets.set(model, created)
      return created
    }
    try {
      for (const row of aggregate.call(this.store, this.now() - days * DAY_MS)) {
        const bucket = bucketFor(row.detail)
        if (row.kind === USAGE_KIND.llmRequests) {
          bucket.requests += row.events
          continue
        }
        const field = LLM_DETAIL_FIELD[row.kind]
        if (field === undefined) continue
        bucket[field] += row.value
      }
    } catch (err) {
      this.logger.warn(`[ContextGovernor] Usage per-model aggregation failed: ${reasonOf(err)}`)
      return []
    }
    return [...buckets.entries()].map(([model, bucket]) => {
      const modelBilled = bucket.input + bucket.read + bucket.write
      return {
        model,
        requests: bucket.requests,
        inputTokens: bucket.input,
        outputTokens: bucket.output,
        cacheReadTokens: bucket.read,
        cacheWriteTokens: bucket.write,
        cacheHitRate: modelBilled === 0 ? 0 : Math.round((bucket.read / modelBilled) * 1000) / 1000,
      }
    }).sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model))
  }
}
