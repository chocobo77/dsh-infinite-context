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
export {
  probeModelContext,
  probeLlama,
  probeOllama,
  probeOpenAI,
  isLocalBaseURL,
  isLocalHostname,
  providerProfile,
  providerBaseURL,
  type ConfigurableProviderSettings,
  type SettingsNamespaceEntry,
} from './model-probe.ts'
export {
  ModelContextTracker,
  PROBE_RETRY_MS,
  type ModelContextAdoption,
  type ModelRouteObservation,
} from './model-context.ts'
export {
  COMPRESS_FAILURE_COOLDOWN,
  HISTORY_HOT_GROWTH,
  HISTORY_MATURE_COMPRESSIONS,
  HISTORY_MAX_BAND,
  HISTORY_MIN_BAND,
  HISTORY_SAFETY_MARGIN,
  HISTORY_STAGE_BAND,
  HISTORY_TARGET_FLOOR,
  HISTORY_TRIGGER_CEILING,
  HISTORY_TRIGGER_FLOOR,
  SUMMARY_OUTPUT_SHARE,
  SURGE_RATIO,
  decidePressureCompaction,
  dynamicCompactionRatio,
  dynamicHistoryLevels,
  firstFoldableIndex,
  foldTokensForTarget,
  orderFoldedMessages,
  retainedTailStart,
  nextGrowthEma,
  shouldCompressHistory,
  shouldNudgeCompaction,
  type HistoryLevelInput,
  type HistoryLevels,
  type HistoryTriggerInput,
  type HistoryTriggerReason,
  type HistoryTriggerResult,
  type PressureDecision,
  type PressureDecisionInput,
  type PressureDecisionMode,
} from './compaction-policy.ts'
export {
  DEFAULT_WATER_LEVEL_BOUNDS,
  GOV_FILL_SPAN,
  GOV_FILL_START,
  GOV_HOT_GROWTH,
  GOV_MATURE_COMPRESSIONS,
  GOV_MAX_BAND,
  GOV_MIN_BAND,
  GOV_SAFETY_MARGIN,
  GOV_STAGE_BAND,
  GOV_TARGET_FLOOR,
  GOV_TARGET_MEMORY_FLOOR,
  GOV_TRIGGER_CEILING,
  GOV_TRIGGER_FLOOR,
  clamp01,
  clampRange,
  compactionTriggerRatio,
  compactionWaterLevels,
  fillPressureOf,
  type TriggerCurveInput,
  type WaterLevelBounds,
  type WaterLevelInput,
  DEFAULT_GOVERNANCE_BOUNDS,
  GOV_GUARD_RESERVE_MIN,
  GOV_GUARD_RESERVE_RATIO,
  GOV_SURGE_RATIO,
  ledgerView,
  planCompaction,
  planFoldCompaction,
  toSurfaceSnapshot,
  type CompactionPlan,
  type GovernanceBounds,
  type GovernanceCapabilities,
  type GovernanceInput,
  type GovernanceLane,
  type GovernanceLedger,
  type GovernanceReason,
  type FoldPlanInput,
  type SessionLedgerEntry,
  type SurfaceSnapshot,
  type SurfaceSnapshotInput,
  type WaterLevels,
  GOV_MIN_PROMPT_SHARE,
  GOV_CONFIG_ERROR_COOLDOWN,
  failureCooldownFor,
  foldPressureBudget,
  minimumFoldTokens,
  summaryCharBudget,
  type FoldBudgetInput,
  GOV_TARGET_DEVIATION_ALPHA,
  GOV_TARGET_DEVIATION_MAX,
  GOV_DEEP_PROBE_MIN_WINDOW,
  GOV_DEEP_PROBE_MAX_WINDOW_FILL,
  GOV_DEEP_PROBE_MIN_MAGNITUDE,
  GOV_DEEP_PROBE_MEMORY_FLOOR,
  nextTargetDeviationEma,
  targetDeviationCorrection,
} from './compaction-governance.ts'
export {
  analyzeContext,
  type CompactionIntent,
  type ContextProfile,
  type SurfaceSignal,
} from './compaction-intelligence.ts'
export {
  OPP_BONUS_MAX,
  OPP_EARLY_PENALTY,
  OPP_MATURE_TURNS,
  OPP_NUDGE_MIN,
  evaluateOpportunity,
  type CompactionOpportunity,
  type SessionPhase,
  type SessionPhaseSignals,
} from './compaction-opportunity.ts'
export {
  DEFAULT_FOLD_OPTIONS,
  foldedRangeHeader,
  type FoldOptions,
} from './fold-archive.ts'
