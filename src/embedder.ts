/**
 * Text embedders for semantic retrieval.
 *
 * Two implementations share one interface:
 *  - {@link LightweightEmbedder}: a deterministic, dependency-free signed
 *    feature-hashing bag-of-words embedder. Works out of the box (no model
 *    download) and handles CJK text by tokenizing each Han character.
 *  - {@link TransformersEmbedder} (in `transformers-embedder.ts`): a true
 *    semantic embedder backed by `all-MiniLM-L6-v2` via `@huggingface/transformers`.
 *
 * This module is dependency-free; the transformers embedder is a separate
 * module so its optional dependency stays isolated.
 *
 * @module dsh-infinite-context/embedder
 */

import type { EmbedderConfig } from './types.ts'

/** A text embedder producing fixed-dimension, L2-normalized vectors. */
export interface Embedder {
  /** The vector dimension this embedder produces. */
  readonly dimension: number
  /** A stable human-readable name for logging/status. */
  readonly name: string
  /**
   * Embed a text into an L2-normalized vector.
   * @param text - the text to embed.
   * @returns a vector of length {@link dimension}.
   */
  embed(text: string): Promise<number[]>
}

/**
 * L2-normalize a vector in place and return it. A zero vector is left as-is
 * (its cosine similarity is defined as 0 by the search layer).
 * @param v - the vector to normalize.
 * @returns the same array, normalized.
 */
export function normalize(v: number[]): number[] {
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm)
  if (norm === 0) return v
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

/**
 * Cosine similarity between two vectors. Returns `0` when either is a zero
 * vector or the lengths differ (a defensive guard, not an expected path).
 * @param a - first vector.
 * @param b - second vector.
 * @returns similarity in `[-1, 1]`.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 32-bit FNV-1a hash. Deterministic across runs and platforms, which is what
 * makes the lightweight embedder stable across processes.
 * @param str - the string to hash.
 * @returns an unsigned 32-bit integer.
 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // h *= 0x01000193, using 32-bit overflow semantics.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

/**
 * Tokenize text into retrieval units: ASCII word runs and individual Han
 * characters. This gives the lightweight embedder reasonable CJK coverage
 * without a segmentation model.
 * @param text - the text to tokenize.
 * @returns the token list.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  const re = /[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lower)) !== null) tokens.push(m[0])
  return tokens
}

/**
 * A deterministic, dependency-free embedder using signed feature hashing with
 * sublinear term weighting. Not a true semantic model, but it captures lexical
 * and character n-gram overlap well enough for keyword-ish memory retrieval
 * and requires no model download — so the plugin works immediately.
 */
export class LightweightEmbedder implements Embedder {
  readonly dimension: number
  readonly name = 'lightweight-feature-hash'

  /**
   * @param dimension - vector dimension (default 256). Higher = fewer hash
   *   collisions but larger storage; 256–512 is a good range.
   */
  constructor(dimension = 256) {
    if (!Number.isInteger(dimension) || dimension < 8) {
      throw new RangeError(`LightweightEmbedder dimension must be an integer >= 8, got ${dimension}`)
    }
    this.dimension = dimension
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimension).fill(0)
    const counts = new Map<string, number>()
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    for (const [token, count] of counts) {
      const h = fnv1a(token)
      const bucket = h % this.dimension
      const sign = (h >>> 31) & 1 ? 1 : -1
      vector[bucket] += sign * (1 + Math.log(count))
    }
    return normalize(vector)
  }
}

/**
 * Build an embedder from configuration. The `transformers` kind dynamically
 * imports the optional `@huggingface/transformers` package; if it is not
 * installed the factory throws a clear error so the caller can fall back.
 * @param config - embedder configuration.
 * @returns a ready embedder.
 */
export async function createEmbedder(config: EmbedderConfig): Promise<Embedder> {
  if (config.kind === 'lightweight') {
    return new LightweightEmbedder(config.dimension)
  }
  if (config.kind === 'transformers') {
    const { TransformersEmbedder } = await import('./transformers-embedder.ts')
    return new TransformersEmbedder(config.model ?? 'sentence-transformers/all-MiniLM-L6-v2', config.dimension)
  }
  throw new Error(`unknown embedder kind: ${String(config.kind)}`)
}
