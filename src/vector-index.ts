/**
 * An in-memory vector index over memory embeddings, providing top-K cosine
 * similarity search.
 *
 * The index is deliberately a linear scan: a memory store holds on the order
 * of hundreds to low thousands of documents, where an exact scan is both fast
 * (microseconds) and simpler than an ANN structure. Swap in an ANN index (or a
 * dedicated vector DB such as Qdrant/Chroma) only if the corpus grows into the
 * tens of thousands.
 *
 * @module dsh-infinite-context/vector-index
 */

import { cosineSimilarity } from './embedder.ts'

/** A single search result: a document id and its similarity score. */
export interface VectorHit {
  readonly id: string
  readonly score: number
}

/** Top-K cosine similarity search over a set of named vectors. */
export class VectorIndex {
  private readonly vectors = new Map<string, number[]>()

  /** The number of indexed vectors. */
  get size(): number {
    return this.vectors.size
  }

  /**
   * Index (or replace) a vector under an id.
   * @param id - stable document id.
   * @param vector - the embedding to store.
   */
  add(id: string, vector: readonly number[]): void {
    this.vectors.set(id, [...vector])
  }

  /**
   * Remove a vector by id. A no-op if the id is not present.
   * @param id - the id to remove.
   */
  remove(id: string): void {
    this.vectors.delete(id)
  }

  /** Drop every indexed vector. */
  clear(): void {
    this.vectors.clear()
  }

  /** Whether a vector is present for the id. */
  has(id: string): boolean {
    return this.vectors.has(id)
  }

  /**
   * Find the up-to-`k` most similar vectors to `query`.
   * @param query - the query vector (need not be normalized).
   * @param k - maximum number of hits.
   * @param minScore - optional lower bound on similarity; hits below it are
   *   omitted. Defaults to no bound.
   * @returns hits sorted by descending score.
   */
  search(query: readonly number[], k: number, minScore = -Infinity): VectorHit[] {
    if (k <= 0 || this.vectors.size === 0) return []
    const hits: VectorHit[] = []
    for (const [id, vector] of this.vectors) {
      const score = cosineSimilarity(query, vector)
      if (score >= minScore) hits.push({ id, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  }
}
