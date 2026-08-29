/**
 * The forgetting policy: score memories by importance and recency, and select
 * the low-value ones to drop so the store stays bounded and relevant.
 *
 * @module dsh-infinite-context/forgetting
 */

import type { ForgettingConfig, MemoryDoc } from './types.ts'

const MS_PER_DAY = 86_400_000

/**
 * Recency factor in `[0, 1]`: 1 for a fresh memory, halving every
 * `halfLifeDays`. A non-positive half-life disables decay (always 1).
 * @param ageMs - the memory's age in milliseconds.
 * @param halfLifeDays - the recency half-life in days.
 * @returns the recency factor.
 */
export function recencyFactor(ageMs: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1
  if (ageMs <= 0) return 1
  return Math.pow(0.5, ageMs / (halfLifeDays * MS_PER_DAY))
}

/**
 * Score a memory in `[0, 1]` as a weighted blend of its importance and its
 * recency. Weights are used as given; normalize them if you want the score to
 * stay within `[0, 1]` exactly.
 * @param doc - the memory to score.
 * @param now - the reference time (epoch ms).
 * @param config - the forgetting configuration.
 * @returns the combined score.
 */
export function scoreMemory(doc: MemoryDoc, now: number, config: ForgettingConfig): number {
  const age = now - doc.createdAt
  const recency = recencyFactor(age, config.halfLifeDays)
  return config.importanceWeight * doc.importance + config.recencyWeight * recency
}

/** Select which memories to forget, honoring the score floor and the cap. */
export class ForgettingPolicy {
  readonly config: ForgettingConfig

  /**
   * @param config - the forgetting configuration.
   */
  constructor(config: ForgettingConfig) {
    this.config = config
  }

  /**
   * The combined score for a memory at a reference time.
   * @param doc - the memory.
   * @param now - the reference time (epoch ms).
   * @returns the score.
   */
  score(doc: MemoryDoc, now: number): number {
    return scoreMemory(doc, now, this.config)
  }

  /**
   * Choose the memories to drop: every memory below the score floor, plus the
   * lowest-scoring extras needed to bring the total within the cap.
   * @param docs - the candidate memories.
   * @param now - the reference time (epoch ms).
   * @returns the memories to forget (a subset of `docs`).
   */
  selectToForget(docs: readonly MemoryDoc[], now: number): MemoryDoc[] {
    const scored = docs
      .map(doc => ({ doc, score: this.score(doc, now) }))
      .sort((a, b) => a.score - b.score) // worst first
    const toDrop = new Set<string>()
    for (const { doc, score } of scored) {
      if (score < this.config.minScore) toDrop.add(doc.id)
    }
    let retained = docs.length - toDrop.size
    for (const { doc } of scored) {
      if (retained <= this.config.maxMemories) break
      if (!toDrop.has(doc.id)) {
        toDrop.add(doc.id)
        retained--
      }
    }
    return docs.filter(doc => toDrop.has(doc.id))
  }
}
