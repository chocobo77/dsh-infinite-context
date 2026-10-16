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

/**
 * Read the provider/model durably routed for the session's latest request.
 *
 * Prefers the folded `request/header` (the envelope the NEXT request is
 * compared against) and falls back to the latest `request/context` route.
 * The fallback is what makes the pre-step path work: `agent/pre-step` runs
 * BEFORE the next request envelope is snapshotted, so `requestHeader()` can
 * still be undefined (or lag a route switch) while `requestContext()` already
 * carries the live route. Without it, the fold lane and the narrowed-window
 * override resolved no target and silently skipped — exactly the symptom seen
 * in production (turn counters frozen, zero folded ranges).
 * @param session - the session to read the route from.
 * @returns the routed provider/model, or undefined when the session has none yet.
 */
export function routedTargetOf(session: Session): SummarizationTarget | undefined {
  const config = session.requestHeader()?.config
  if (config !== undefined && config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  // request/context is the live route; guard the call so a partial session
  // object (older mock, forked session) can never make resolution throw.
  try {
    const context = session.requestContext()
    if (context !== undefined && context.provider.length > 0 && context.model.length > 0) {
      return { provider: context.provider, model: context.model }
    }
  } catch {
    // request/context unavailable — fall through to undefined
  }
  return undefined
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
