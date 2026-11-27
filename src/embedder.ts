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
  // CJK runs additionally emit adjacent BIGRAMS: single Han characters carry
  // almost no discriminative power (的/了/是 appear everywhere, and compound
  // words like 部署/软件 are the actual retrieval units) — the unigram+bigram
  // mix is the standard CJK lexical-retrieval feature set (the same shape as
  // Lucene's cjk analyzer). ASCII word runs stay whole words.
  const re = /[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lower)) !== null) {
    const run = m[0]
    if (isHanRun(run) && run.length > 1) {
      // Han run: unigrams + adjacent bigrams (see the comment above).
      for (const ch of run) tokens.push(ch)
      for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2))
    } else if (/^[a-z0-9_]+$/.test(run)) {
      // ASCII word: stays WHOLE (splitting it would flood the vector with
      // single-letter noise and destroy word-level discrimination).
      tokens.push(run)
    } else {
      // Kana/hangul runs and single characters: per-character tokens
      // (phonetic scripts have no compound-word structure to capture).
      for (const ch of run) tokens.push(ch)
    }
  }
  return tokens
}

/** Whether every code point of `run` is CJK (i.e. the run supports bigrams). */
function isHanRun(run: string): boolean {
  return /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/.test(run)
}

/**
 * A deterministic, dependency-free embedder using signed feature hashing with
 * sublinear term weighting. Not a true semantic model, but it captures lexical
 * and character n-gram overlap well enough for keyword-ish memory retrieval
 * and requires no model download — so the plugin works immediately.
 */
export class LightweightEmbedder implements Embedder {
  readonly dimension: number
  // v2: the tokenizer emits Han bigrams (weighted 1.5) alongside unigrams —
  // the name bump is what drives the stored-vector migration in
  // MemoryEngine.loadFromStore. Never rename without shipping that migration.
  readonly name = 'lightweight-feature-hash-v2'

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
      // Bigrams outweigh unigrams 1.5:1 — a two-character compound (部署,
      // 卸载, 软件) is the actual unit of meaning in Chinese and should
      // dominate the single characters it is made of.
      const bigram = token.length === 2 && isHanRun(token)
      const weight = bigram ? 1.5 : 1
      vector[bucket] += sign * weight * (1 + Math.log(count))
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
    // The doc above promises a clear failure HERE so the caller can fall back,
    // but importing our own wrapper always succeeds: the optional package is
    // only touched on the first embed(), where the failure would be swallowed
    // by the best-effort retrieval paths.
    try {
      await import('@huggingface/transformers')
    } catch {
      throw new Error(
        "embedder kind 'transformers' requires the optional '@huggingface/transformers' package "
        + '(install it, or use the default lightweight embedder)',
      )
    }
    const { TransformersEmbedder } = await import('./transformers-embedder.ts')
    const embedder = new TransformersEmbedder(config.model ?? 'sentence-transformers/all-MiniLM-L6-v2', config.dimension)
    // Probe the REAL output dimension once, before any caller computes an
    // embedder signature or reads `dimension`: the model's true output wins
    // over the configured guess (all-MiniLM is 384, all-mpnet is 768), and a
    // late mutation would race the engine's signature math (permanent
    // re-migration loop or silent zero-index loads). The probe text is tiny;
    // the model is already downloaded/initialized by the pre-import above
    // only when the package was present — first real init happens here.
    const probe = await embedder.embed('dimension probe')
    if (embedder.dimension !== probe.length) {
      // The embedder already adopted the real length; surface the drift.
      console.warn(`[dsh-infinite-context] transformers embedder reports ${probe.length} dimensions, config expected ${embedder.dimension} — using ${probe.length}`)
    }
    return embedder
  }
  throw new Error(`unknown embedder kind: ${String(config.kind)}`)
}
