/**
 * Public barrel for the dependency-free memory core.
 *
 * Import from here for the pure logic (store, embedder, vector index, budget,
 * forgetting, engine). The Cordis integration lives in `memory-context.ts` and
 * `memory-compaction.ts`.
 *
 * @module dsh-infinite-context/core
 */

export type * from './types.ts'
export {
  cosineSimilarity,
  createEmbedder,
  fnv1a,
  LightweightEmbedder,
  normalize,
  tokenize,
  type Embedder,
} from './embedder.ts'
export { TransformersEmbedder, DEFAULT_TRANSFORMERS_MODEL } from './transformers-embedder.ts'
export { VectorIndex, type VectorHit } from './vector-index.ts'
export { MemoryStore } from './memory-store.ts'
export { TokenBudget, estimateTokens } from './token-budget.ts'
export { ForgettingPolicy, recencyFactor, scoreMemory } from './forgetting.ts'
export { MemoryEngine, type MemoryEngineDeps, type StoreMemoryOptions, type SummarizeFn, type MaintenanceReport } from './memory-engine.ts'
export { oneLine } from './strings.ts'
export { probeModelContext, probeLlama, probeOllama, probeOpenAI } from './model-probe.ts'
export {
  ModelContextTracker,
  type ModelContextAdoption,
  type ModelRouteObservation,
} from './model-context.ts'
