/**
 * A SQLite-backed persistent store for memory documents.
 *
 * Uses Node's built-in `node:sqlite` (`DatabaseSync`), the same medium DSH's
 * own `storage-sqlite` backend uses, so no native `sqlite3` dependency is
 * required. Embeddings are stored as `Float32` BLOBs; `mergedFrom` as JSON.
 *
 * @module dsh-infinite-context/memory-store
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IN_MEMORY_STORE } from './config.ts'
import type { MemoryDoc, MemoryKind, Tier } from './types.ts'

/** Serialize a vector to a Float32 BLOB payload. */
function vectorToBlob(vector: readonly number[]): Buffer {
  const f32 = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i++) f32[i] = vector[i]
  return Buffer.from(f32.buffer)
}

/** Deserialize a Float32 BLOB payload back to a number array. */
function blobToVector(blob: Buffer | null | undefined): number[] | undefined {
  if (blob === null || blob === undefined || blob.byteLength === 0) return undefined
  const byteLength = blob.byteLength
  if (byteLength % 4 !== 0) return undefined
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, byteLength / 4)
  const out = new Array<number>(f32.length)
  for (let i = 0; i < f32.length; i++) out[i] = f32[i]
  return out
}

/**
 * An archived oversized tool result: the exact text of a tool result that was
 * replaced in the transcript by a short stub carrying `ref`.
 */
export interface ToolResultRecord {
  readonly ref: string
  readonly tool: string
  readonly callId?: string | undefined
  readonly sessionId?: string | undefined
  readonly createdAt: number
  readonly chars: number
  readonly text: string
  /** Distilled signal lines (see absorb.ts); absent for pre-absorb rows. */
  readonly digest?: string | undefined
}

/** A listing view of an archived result: everything but the full text. */
export interface ToolResultMeta {
  readonly ref: string
  readonly tool: string
  readonly callId?: string | undefined
  readonly sessionId?: string | undefined
  readonly createdAt: number
  readonly chars: number
  readonly preview: string
  /** Distilled signal lines (see absorb.ts), when the result was absorbed. */
  readonly digest?: string | undefined
}

/**
 * One row of the context-accounting ledger (see usage-ledger.ts): either a
 * measurement of what the plugin did to the request, or a provider usage count.
 */
export interface UsageEventRecord {
  readonly ts: number
  readonly kind: string
  readonly value: number
  readonly sessionId?: string | undefined
  readonly detail?: string | undefined
}

/** Aggregated ledger rows for one kind. */
export interface UsageTotal {
  readonly kind: string
  readonly events: number
  readonly value: number
}

/** Aggregated ledger rows for one kind, split by the `detail` label. */
export interface UsageDetailTotal {
  readonly kind: string
  readonly detail: string
  readonly events: number
  readonly value: number
}

/**
 * One folded (summarized) history range, archived verbatim before the summary
 * replaced it on the surface. This is what makes compaction *reversible*: the
 * summary stays in the conversation while the exact messages stay readable
 * here (`memory_expand` with the ref) — the engine-layer equivalent of the
 * upstream `decompress` tool.
 */
export interface FoldedRangeRecord {
  readonly ref: string
  readonly sessionId?: string | undefined
  readonly createdAt: number
  readonly messages: number
  readonly chars: number
  readonly tokens: number
  readonly summary: string
  readonly original: string
  readonly restoredCount: number
}

/** A listing view of a folded range: everything but the original text. */
export interface FoldedRangeMeta {
  readonly ref: string
  readonly sessionId?: string | undefined
  readonly createdAt: number
  readonly messages: number
  readonly chars: number
  readonly tokens: number
  readonly preview: string
  readonly restoredCount: number
}

/** Row shape of `folded_ranges` as stored. */
interface FoldedRangeRow {
  ref: string
  ts: number
  session_id: string | null
  messages: number
  chars: number
  tokens: number
  summary: string
  original: string
  restored_count: number
}

/** A ledger row as stored. */
interface UsageEventRow {
  ts: number
  kind: string
  value: number
  session_id: string | null
  detail: string | null
}

interface MemoryRow {
  id: string
  tier: string
  text: string
  created_at: number
  importance: number
  source_session_id: string | null
  source_turn_start: number | null
  source_turn_end: number | null
  embedding: Buffer | null
  merged_from: string | null
  kind: string | null
}

interface ToolResultRow {
  ref: string
  tool: string
  call_id: string | null
  session_id: string | null
  created_at: number
  chars: number
  text: string
  digest: string | null
}

interface ToolResultMetaRow {
  ref: string
  tool: string
  call_id: string | null
  session_id: string | null
  created_at: number
  chars: number
  preview: string | null
  digest: string | null
}

/** Collapse a preview blob to one short line. */
function previewOf(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function rowToToolResult(row: ToolResultRow): ToolResultRecord {
  return {
    ref: row.ref,
    tool: row.tool,
    ...(row.call_id !== null ? { callId: row.call_id } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    createdAt: row.created_at,
    chars: row.chars,
    text: row.text,
    ...(row.digest !== null ? { digest: row.digest } : {}),
  }
}

function rowToToolResultMeta(row: ToolResultMetaRow): ToolResultMeta {
  return {
    ref: row.ref,
    tool: row.tool,
    ...(row.call_id !== null ? { callId: row.call_id } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    createdAt: row.created_at,
    chars: row.chars,
    preview: previewOf(row.preview),
    ...(row.digest !== null ? { digest: row.digest } : {}),
  }
}

/** Ref prefix of a folded history range (see `memory_expand`). */
export const FOLDED_REF_PREFIX = 'fl_'

/** Collision-free ref for one folded range. */
function newFoldedRef(): string {
  return FOLDED_REF_PREFIX + randomUUID().replace(/-/g, '').slice(0, 12)
}

function rowToFoldedRange(row: FoldedRangeRow): FoldedRangeRecord {
  return {
    ref: row.ref,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    createdAt: row.ts,
    messages: row.messages,
    chars: row.chars,
    tokens: row.tokens,
    summary: row.summary,
    original: row.original,
    restoredCount: row.restored_count,
  }
}

function rowToFoldedRangeMeta(row: FoldedRangeRow): FoldedRangeMeta {
  return {
    ref: row.ref,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    createdAt: row.ts,
    messages: row.messages,
    chars: row.chars,
    tokens: row.tokens,
    preview: previewOf(row.summary),
    restoredCount: row.restored_count,
  }
}

/**
 * Normalize text for fuzzy-exact dedup: lowercases, collapses whitespace, and
 * replaces LONG digit runs (4+ digits — timestamps, counters, ids) with a
 * placeholder so volatile numbers do not defeat the exact-text match. Short
 * digit runs (1–3) are kept intact: values like ports or small counts are
 * semantically meaningful, and masking them would collapse genuinely different
 * facts ("port 3000" vs "port 8080") into one dedup key. Used by ingest dedup.
 */
export function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d{4,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A persistent, tiered store of memory documents. */
export class MemoryStore {
  private readonly db: DatabaseSync
  private closed = false

  /**
   * @param path - SQLite file path, or `:memory:` for an in-process database
   *   (tests). Missing parent directories are created.
   */
  constructor(path: string) {
    if (path !== IN_MEMORY_STORE) mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id                TEXT PRIMARY KEY,
        tier              TEXT NOT NULL,
        text              TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        importance        REAL NOT NULL,
        source_session_id TEXT,
        source_turn_start INTEGER,
        source_turn_end   INTEGER,
        embedding         BLOB,
        merged_from       TEXT,
        kind              TEXT
      )
    `)
    // Migration for stores created before the `kind` column existed: ALTER
    // TABLE ADD COLUMN is idempotent-guarded by checking PRAGMA table_info.
    const columns = this.db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    if (!columns.some(col => col.name === 'kind')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN kind TEXT')
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories (tier)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_created ON memories (created_at)')
    // Generic key/value table for plugin state that must survive restarts
    // (e.g. the HistoryCompressor per-session turn counters). Kept separate
    // from the memories table so it never pollutes retrieval.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
    // Exact-text archive for oversized tool results. The transcript keeps only
    // a short stub carrying `ref`; the full text stays here so `memory_expand`
    // can hand it back verbatim after the built-in pruner (or a compaction) has
    // replaced the middle with an unrecoverable marker. Content-addressed: the
    // same payload archives once, however many times it is produced.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_results (
        ref        TEXT PRIMARY KEY,
        tool       TEXT NOT NULL,
        call_id    TEXT,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        chars      INTEGER NOT NULL,
        text       TEXT NOT NULL,
        digest     TEXT
      )
    `)
    // Same idempotent migration guard as `memories.kind`: stores created before
    // the absorb digest existed gain the column instead of failing on INSERT.
    const toolColumns = this.db.prepare('PRAGMA table_info(tool_results)').all() as { name: string }[]
    if (!toolColumns.some(col => col.name === 'digest')) {
      this.db.exec('ALTER TABLE tool_results ADD COLUMN digest TEXT')
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tool_results_created ON tool_results (created_at)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results (session_id, created_at)')
    // Context-accounting ledger (see usage-ledger.ts): append-only, pruned by
    // age, and never read by retrieval. One row per measurement.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        value      INTEGER NOT NULL,
        session_id TEXT,
        detail     TEXT
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events (ts)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_kind ON usage_events (kind, ts)')
    // Folded history ranges (see memory-compaction.ts): the exact messages a
    // compression replaced with a summary. Written best-effort, read back only
    // by memory_expand, never by retrieval.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folded_ranges (
        ref            TEXT PRIMARY KEY,
        ts             INTEGER NOT NULL,
        session_id     TEXT,
        messages       INTEGER NOT NULL,
        chars          INTEGER NOT NULL,
        tokens         INTEGER NOT NULL,
        summary        TEXT NOT NULL,
        original       TEXT NOT NULL,
        restored_count INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_folded_ranges_ts ON folded_ranges (ts)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_folded_ranges_session ON folded_ranges (session_id, ts)')
  }

  /**
   * Read a value from the generic key/value table.
   * @param key - the key.
   * @returns the stored value, or `undefined` when absent.
   */
  kvGet(key: string): string | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT value FROM plugin_kv WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  /**
   * Write a value to the generic key/value table (upsert).
   * @param key - the key.
   * @param value - the value to store.
   */
  kvSet(key: string, value: string): void {
    this.assertOpen()
    this.db.prepare(`
      INSERT INTO plugin_kv (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  }

  /**
   * Delete a key from the generic key/value table. A no-op when absent.
   * @param key - the key to delete.
   */
  kvDelete(key: string): void {
    this.assertOpen()
    this.db.prepare('DELETE FROM plugin_kv WHERE key = ?').run(key)
  }

  /**
   * Archive the exact text of one oversized tool result (idempotent by ref).
   * @param record - the archived payload.
   * @returns `true` when a new row was inserted.
   */
  archiveToolResult(record: ToolResultRecord): boolean {
    this.assertOpen()
    const info = this.db.prepare(`
      INSERT OR IGNORE INTO tool_results (ref, tool, call_id, session_id, created_at, chars, text, digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.ref,
      record.tool,
      record.callId ?? null,
      record.sessionId ?? null,
      record.createdAt,
      record.chars,
      record.text,
      record.digest ?? null,
    )
    if (Number(info.changes) > 0) return true
    // The row already exists (content-addressed). Backfill a digest computed
    // on a later rewrite, but never overwrite one that is already there.
    if (record.digest !== undefined && record.digest.length > 0) {
      this.db.prepare(
        `UPDATE tool_results SET digest = ? WHERE ref = ? AND (digest IS NULL OR digest = '')`,
      ).run(record.digest, record.ref)
    }
    return false
  }

  /**
   * Read an archived tool result by ref.
   * @param ref - the content-addressed ref.
   * @returns the record, or `undefined` when unknown.
   */
  getToolResult(ref: string): ToolResultRecord | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM tool_results WHERE ref = ?').get(ref) as ToolResultRow | undefined
    return row === undefined ? undefined : rowToToolResult(row)
  }

  /**
   * Find the newest archived result produced by one tool call.
   * @param callId - the tool call id.
   * @returns the record, or `undefined` when the call was never archived.
   */
  findToolResultByCallId(callId: string): ToolResultRecord | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM tool_results WHERE call_id = ? ORDER BY created_at DESC LIMIT 1').get(callId) as ToolResultRow | undefined
    return row === undefined ? undefined : rowToToolResult(row)
  }

  /**
   * List archived results, newest first, without their full text.
   * @param limit - maximum rows to return.
   * @returns the listing.
   */
  listToolResults(limit = 20): ToolResultMeta[] {
    this.assertOpen()
    const rows = this.db.prepare(
      'SELECT ref, tool, call_id, session_id, created_at, chars, digest, substr(text, 1, 400) AS preview FROM tool_results ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as unknown as ToolResultMetaRow[]
    return rows.map(rowToToolResultMeta)
  }

  /**
   * Search archived text by substring (case-insensitive for ASCII).
   * @param query - the substring to look for.
   * @param limit - maximum rows to return.
   * @returns matching listings, newest first.
   */
  searchToolResults(query: string, limit = 5): ToolResultMeta[] {
    this.assertOpen()
    const pattern = '%' + query.replace(/[\\%_]/g, ch => '\\' + ch) + '%'
    const rows = this.db.prepare(
      `SELECT ref, tool, call_id, session_id, created_at, chars, digest, substr(text, 1, 400) AS preview FROM tool_results WHERE text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`,
    ).all(pattern, limit) as unknown as ToolResultMetaRow[]
    return rows.map(rowToToolResultMeta)
  }

  /**
   * Count archived tool results.
   * @returns the number of rows.
   */
  countToolResults(): number {
    this.assertOpen()
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tool_results').get() as { n: number }
    return row.n
  }

  /**
   * Total archived text size in code points.
   * @returns the summed archived character count.
   */
  toolResultChars(): number {
    this.assertOpen()
    const row = this.db.prepare('SELECT COALESCE(SUM(chars), 0) AS n FROM tool_results').get() as { n: number }
    return row.n
  }

  /**
   * Delete archived results older than a timestamp.
   * @param timestamp - epoch milliseconds cutoff (exclusive).
   * @returns the number of deleted rows.
   */
  deleteToolResultsBefore(timestamp: number): number {
    this.assertOpen()
    const info = this.db.prepare('DELETE FROM tool_results WHERE created_at < ?').run(timestamp)
    return Number(info.changes)
  }

  /**
   * Keep only the newest N archived results.
   * @param maxEntries - the number of rows to keep.
   * @returns the number of deleted rows.
   */
  trimToolResults(maxEntries: number): number {
    this.assertOpen()
    const info = this.db.prepare(`
      DELETE FROM tool_results WHERE ref NOT IN (
        SELECT ref FROM tool_results ORDER BY created_at DESC, ref DESC LIMIT ?
      )
    `).run(maxEntries)
    return Number(info.changes)
  }

  /**
   * Append one ledger measurement.
   * @param record - the event to store.
   */
  recordUsageEvent(record: UsageEventRecord): void {
    this.assertOpen()
    this.db.prepare(
      'INSERT INTO usage_events (ts, kind, value, session_id, detail) VALUES (?, ?, ?, ?, ?)',
    ).run(
      record.ts,
      record.kind,
      record.value,
      record.sessionId ?? null,
      record.detail ?? null,
    )
  }

  /**
   * Sum ledger values per kind.
   * @param sinceTs - epoch-millisecond lower bound (inclusive); omit for all time.
   * @returns one row per kind, ordered by kind.
   */
  usageTotals(sinceTs?: number): UsageTotal[] {
    this.assertOpen()
    const rows = sinceTs === undefined
      ? this.db.prepare('SELECT kind, COUNT(*) AS events, SUM(value) AS value FROM usage_events GROUP BY kind ORDER BY kind').all()
      : this.db.prepare('SELECT kind, COUNT(*) AS events, SUM(value) AS value FROM usage_events WHERE ts >= ? GROUP BY kind ORDER BY kind').all(sinceTs)
    return (rows as unknown as { kind: string; events: number; value: number }[]).map(row => ({
      kind: row.kind,
      events: Number(row.events),
      value: Number(row.value),
    }))
  }

  /**
   * Read the newest ledger events.
   * @param limit - maximum rows.
   * @returns the events, newest first.
   */
  listUsageEvents(limit = 20): UsageEventRecord[] {
    this.assertOpen()
    const rows = this.db.prepare(
      'SELECT ts, kind, value, session_id, detail FROM usage_events ORDER BY id DESC LIMIT ?',
    ).all(limit) as unknown as UsageEventRow[]
    return rows.map(row => ({
      ts: row.ts,
      kind: row.kind,
      value: row.value,
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.detail === null ? {} : { detail: row.detail }),
    }))
  }

  /**
   * Delete ledger events older than a timestamp.
   * @param beforeTs - epoch-millisecond cutoff (exclusive).
   * @returns the number of deleted rows.
   */
  pruneUsageEvents(beforeTs: number): number {
    this.assertOpen()
    const info = this.db.prepare('DELETE FROM usage_events WHERE ts < ?').run(beforeTs)
    return Number(info.changes)
  }

  /**
   * Sum ledger values per kind *and* detail label (e.g. one bucket per
   * provider/model), so a mid-session model switch stays visible instead of
   * being averaged away in the per-kind totals.
   * @param sinceTs - epoch-millisecond lower bound (inclusive); omit for all time.
   * @returns one row per (kind, detail) pair, ordered by kind then detail.
   */
  usageTotalsByDetail(sinceTs?: number): UsageDetailTotal[] {
    this.assertOpen()
    const sql = 'SELECT kind, detail, COUNT(*) AS events, SUM(value) AS value FROM usage_events WHERE detail IS NOT NULL'
    const rows = sinceTs === undefined
      ? this.db.prepare(sql + ' GROUP BY kind, detail ORDER BY kind, detail').all()
      : this.db.prepare(sql + ' AND ts >= ? GROUP BY kind, detail ORDER BY kind, detail').all(sinceTs)
    return (rows as unknown as { kind: string; detail: string; events: number; value: number }[]).map(row => ({
      kind: row.kind,
      detail: row.detail,
      events: Number(row.events),
      value: Number(row.value),
    }))
  }

  // --- folded history ranges: compaction that can be undone --------------

  /**
   * Archive the exact messages a compression folded into a summary, so the
   * summary on the surface stays reversible (read back with `memory_expand`).
   * @param input - the folded payload; the ref is generated when omitted.
   * @returns the archive ref to embed in the summary that replaced the range.
   */
  archiveFoldedRange(input: {
    readonly messages: number
    readonly chars: number
    readonly tokens: number
    readonly summary: string
    readonly original: string
    readonly sessionId?: string | undefined
    readonly ref?: string | undefined
    readonly createdAt?: number | undefined
  }): string {
    this.assertOpen()
    const ref = input.ref ?? newFoldedRef()
    this.db.prepare(
      'INSERT INTO folded_ranges (ref, ts, session_id, messages, chars, tokens, summary, original) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING',
    ).run(
      ref,
      input.createdAt ?? Date.now(),
      input.sessionId ?? null,
      input.messages,
      input.chars,
      input.tokens,
      input.summary,
      input.original,
    )
    return ref
  }

  /**
   * Read one folded range back, exact text included.
   * @param ref - the archive ref.
   * @returns the record, or `undefined` when unknown.
   */
  getFoldedRange(ref: string): FoldedRangeRecord | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM folded_ranges WHERE ref = ?').get(ref) as unknown as FoldedRangeRow | undefined
    return row === undefined ? undefined : rowToFoldedRange(row)
  }

  /**
   * List folded ranges newest first, without the original text.
   * @param limit - maximum rows.
   * @returns the listings.
   */
  listFoldedRanges(limit = 20): FoldedRangeMeta[] {
    this.assertOpen()
    const rows = this.db.prepare('SELECT * FROM folded_ranges ORDER BY ts DESC LIMIT ?').all(limit) as unknown as FoldedRangeRow[]
    return rows.map(rowToFoldedRangeMeta)
  }

  /**
   * Keyword-search folded ranges by their summary and original text.
   * @param query - the substring to look for.
   * @param limit - maximum rows to return.
   * @returns matching listings, newest first.
   */
  searchFoldedRanges(query: string, limit = 5): FoldedRangeMeta[] {
    this.assertOpen()
    const pattern = '%' + query.replace(/[\\%_]/g, ch => '\\' + ch) + '%'
    const rows = this.db.prepare(
      'SELECT * FROM folded_ranges WHERE summary LIKE ? ESCAPE \'\\\' OR original LIKE ? ESCAPE \'\\\' ORDER BY ts DESC LIMIT ?',
    ).all(pattern, pattern, limit) as unknown as FoldedRangeRow[]
    return rows.map(rowToFoldedRangeMeta)
  }

  /**
   * Record that a folded range was read back through `memory_expand`.
   * @param ref - the archive ref.
   */
  markFoldedRangeRestored(ref: string): void {
    this.assertOpen()
    this.db.prepare('UPDATE folded_ranges SET restored_count = restored_count + 1 WHERE ref = ?').run(ref)
  }

  /**
   * Aggregate size of the folded-range archive.
   * @returns row count and summed chars/tokens.
   */
  foldedRangeStats(): { count: number; chars: number; tokens: number } {
    this.assertOpen()
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(chars), 0) AS chars, COALESCE(SUM(tokens), 0) AS tokens FROM folded_ranges',
    ).get() as unknown as { count: number; chars: number; tokens: number }
    return { count: Number(row.count), chars: Number(row.chars), tokens: Number(row.tokens) }
  }

  /**
   * Delete folded ranges older than a timestamp.
   * @param beforeTs - epoch-millisecond cutoff (exclusive).
   * @returns the number of deleted rows.
   */
  pruneFoldedRanges(beforeTs: number): number {
    this.assertOpen()
    const info = this.db.prepare('DELETE FROM folded_ranges WHERE ts < ?').run(beforeTs)
    return Number(info.changes)
  }

  /**
   * Keep only the newest N folded ranges.
   * @param maxEntries - the cap (<= 0 clears the archive).
   * @returns the number of deleted rows.
   */
  trimFoldedRanges(maxEntries: number): number {
    this.assertOpen()
    const info = this.db.prepare(
      'DELETE FROM folded_ranges WHERE ref NOT IN (SELECT ref FROM folded_ranges ORDER BY ts DESC LIMIT ?)',
    ).run(Math.max(0, maxEntries))
    return Number(info.changes)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('MemoryStore is closed')
  }

  private rowToDoc(row: MemoryRow): MemoryDoc {
    const embedding = blobToVector(row.embedding)
    let mergedFrom: string[] | undefined
    if (row.merged_from !== null) {
      try {
        const parsed = JSON.parse(row.merged_from) as unknown
        if (Array.isArray(parsed)) mergedFrom = parsed as string[]
      } catch {
        // Corrupt merged_from is non-fatal; provenance is best-effort.
      }
    }
    return {
      id: row.id,
      tier: row.tier as Tier,
      text: row.text,
      createdAt: row.created_at,
      importance: row.importance,
      ...(row.source_session_id !== null ? { sourceSessionId: row.source_session_id } : {}),
      ...(row.source_turn_start !== null && row.source_turn_end !== null
        ? { sourceTurns: { start: row.source_turn_start, end: row.source_turn_end } as const }
        : {}),
      ...(embedding !== undefined ? { embedding } : {}),
      ...(mergedFrom !== undefined ? { mergedFrom } : {}),
      ...(row.kind !== null && row.kind !== undefined
        ? { kind: row.kind as MemoryKind }
        : {}),
    }
  }

  /**
   * Insert a new memory document. Fails if the id already exists.
   * @param doc - the document to store.
   */
  insert(doc: MemoryDoc): void {
    this.assertOpen()
    this.db.prepare(`
      INSERT INTO memories (
        id, tier, text, created_at, importance,
        source_session_id, source_turn_start, source_turn_end, embedding, merged_from, kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc.id,
      doc.tier,
      doc.text,
      doc.createdAt,
      doc.importance,
      doc.sourceSessionId ?? null,
      doc.sourceTurns?.start ?? null,
      doc.sourceTurns?.end ?? null,
      doc.embedding === undefined ? null : vectorToBlob(doc.embedding),
      doc.mergedFrom === undefined ? null : JSON.stringify(doc.mergedFrom),
      doc.kind ?? null,
    )
  }

  /**
   * Replace an existing memory document (upsert by id).
   * @param doc - the document to write.
   */
  upsert(doc: MemoryDoc): void {
    this.assertOpen()
    this.db.prepare(`
      INSERT INTO memories (
        id, tier, text, created_at, importance,
        source_session_id, source_turn_start, source_turn_end, embedding, merged_from, kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tier = excluded.tier,
        text = excluded.text,
        created_at = excluded.created_at,
        importance = excluded.importance,
        source_session_id = excluded.source_session_id,
        source_turn_start = excluded.source_turn_start,
        source_turn_end = excluded.source_turn_end,
        embedding = excluded.embedding,
        merged_from = excluded.merged_from,
        kind = excluded.kind
    `).run(
      doc.id,
      doc.tier,
      doc.text,
      doc.createdAt,
      doc.importance,
      doc.sourceSessionId ?? null,
      doc.sourceTurns?.start ?? null,
      doc.sourceTurns?.end ?? null,
      doc.embedding === undefined ? null : vectorToBlob(doc.embedding),
      doc.mergedFrom === undefined ? null : JSON.stringify(doc.mergedFrom),
      doc.kind ?? null,
    )
  }

  /**
   * Fetch a single document by id.
   * @param id - the document id.
   * @returns the document, or `undefined` if absent.
   */
  get(id: string): MemoryDoc | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
    return row === undefined ? undefined : this.rowToDoc(row)
  }

  /**
   * List documents, optionally restricted to a tier, ordered newest first.
   * @param tier - optional tier filter.
   * @returns the matching documents.
   */
  list(tier?: Tier): MemoryDoc[] {
    this.assertOpen()
    const rows = tier === undefined
      ? (this.db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all() as unknown as MemoryRow[])
      : (this.db.prepare('SELECT * FROM memories WHERE tier = ? ORDER BY created_at DESC').all(tier) as unknown as MemoryRow[])
    return rows.map(row => this.rowToDoc(row))
  }

  /**
   * Count documents, optionally restricted to a tier.
   * @param tier - optional tier filter.
   * @returns the count.
   */
  count(tier?: Tier): number {
    this.assertOpen()
    const row = tier === undefined
      ? this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
      : this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE tier = ?').get(tier) as { n: number }
    return row.n
  }

  /**
   * Whether any stored memory has exactly this text (used for ingest dedup).
   * @param text - the exact text to look up.
   * @returns true when a memory with this text already exists.
   */
  hasText(text: string): boolean {
    this.assertOpen()
    const row = this.db.prepare('SELECT 1 FROM memories WHERE text = ? LIMIT 1').get(text) as { 1?: number } | undefined
    return row !== undefined
  }

  /**
   * Whether any stored memory has this text after fuzzy normalization
   * (lowercase, whitespace-collapsed, digit runs of 4+ masked). Catches repeats
   * that differ only by timestamps/counters — too costly as an indexed query,
   * so it scans the (bounded) store; fine for hundreds of memories.
   * @param text - the raw text to normalize and look up.
   * @returns true when a memory with the same normalized text exists.
   */
  hasTextNormalized(text: string): boolean {
    this.assertOpen()
    const target = normalizeForDedup(text)
    if (target.length === 0) return false
    const rows = this.db.prepare('SELECT text FROM memories').all() as { text: string }[]
    return rows.some(row => normalizeForDedup(row.text) === target)
  }

  /**
   * Delete a document by id. A no-op if absent.
   * @param id - the id to delete.
   */
  delete(id: string): void {
    this.assertOpen()
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  /**
   * Delete many documents by id.
   * @param ids - the ids to delete.
   */
  deleteMany(ids: readonly string[]): void {
    this.assertOpen()
    if (ids.length === 0) return
    const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?')
    for (const id of ids) stmt.run(id)
  }

  /** Remove every document. */
  clear(): void {
    this.assertOpen()
    this.db.exec('DELETE FROM memories')
  }

  /**
   * Close the underlying database. Idempotent.
   *
   * Note: the plugin does not call close() on shutdown — DSH manages the
   * process lifecycle and SQLite's WAL mode guarantees data safety on exit.
   * Call close() explicitly only in tests or standalone scripts.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
