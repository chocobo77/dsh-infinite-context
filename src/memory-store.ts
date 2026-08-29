/**
 * A SQLite-backed persistent store for memory documents.
 *
 * Uses Node's built-in `node:sqlite` (`DatabaseSync`), the same medium DSH's
 * own `storage-sqlite` backend uses, so no native `sqlite3` dependency is
 * required. Embeddings are stored as `Float32` BLOBs; `mergedFrom` as JSON.
 *
 * @module dsh-infinite-context/memory-store
 */

import { DatabaseSync } from 'node:sqlite'
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

/**
 * Normalize text for fuzzy-exact dedup: lowercases, collapses whitespace, and
 * replaces digit runs with a placeholder so timestamps, counters, and other
 * volatile numbers do not defeat the exact-text match. Used by ingest dedup.
 */
export function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
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
   * (lowercase, whitespace-collapsed, digit-runs masked). Catches repeats that
   * differ only by timestamps/counters — too costly as an indexed query, so it
   * scans the (bounded) store; fine for hundreds of memories.
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
