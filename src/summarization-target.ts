/**
 * Pure resolver for the provider/model used by this plugin's summarization
 * calls (history compression + pyramid consolidation).
 *
 * Kept free of runtime dependencies so it can be unit-tested in isolation.
 *
 * @module dsh-infinite-context/summarization-target
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** Provider/model pair for one summarization call. */
export type SummarizationTarget = {
  readonly provider: string
  readonly model: string
}

/** The subset of `ResolvedConfig` this resolver reads. */
export type SummarizationConfig = {
  readonly summarizationProvider: string
  readonly summarizationModel: string
}

/** Read the provider/model durably routed for the session's latest request. */
export function routedTargetOf(session: Session): SummarizationTarget | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Resolve the provider/model used for a plugin summarization call.
 *
 * Priority (mirrors compaction-basic's own `configured ?? latest`):
 *   1. explicit `summarizationProvider`/`summarizationModel` config;
 *   2. the session's routed model (request header) — this is what makes a
 *      fresh install work with ZERO config: a local-model session summarizes
 *      with the local model, a cloud session with the cloud model;
 *   3. `undefined` → the caller must skip/defer the summarization.
 *
 * The plugin never pins a hard-coded provider, so a dead endpoint (e.g. an
 * out-of-balance DeepSeek account returning "Insufficient Balance") can no
 * longer silently block every compaction.
 */
export function resolveSummarizationTarget(
  config: SummarizationConfig,
  session?: Session,
): SummarizationTarget | undefined {
  if (config.summarizationProvider.length > 0 && config.summarizationModel.length > 0) {
    return { provider: config.summarizationProvider, model: config.summarizationModel }
  }
  return session === undefined ? undefined : routedTargetOf(session)
}
