/**
 * Pure model-context tracker: holds the currently adopted model context window
 * and decides when a live probe should run. Deliberately dependency-free so
 * the decision logic is unit-testable without a Cordis context; the Cordis
 * service (`memory-context.ts`) drives the async probe using the model id this
 * tracker returns.
 *
 * @module dsh-infinite-context/model-context
 */

import type { ModelContextInfo, ModelContextSource } from './types.ts'

/** One request's resolved route metadata (from DSH `request/context`). */
export interface ModelRouteObservation {
  provider?: string
  model?: string
  contextWindow?: number
}

/** A context window resolved from any source, ready to adopt. */
export interface ModelContextAdoption {
  provider?: string
  model?: string
  contextWindow: number
  source: Exclude<ModelContextSource, 'config'>
}

/** Tracks the effective model context window and probe-once-per-model state. */
export class ModelContextTracker {
  private modelContext: ModelContextInfo | null = null
  private probedForModel: string | null = null
  private readonly fallbackWindow: number
  private readonly probeEnabled: boolean

  /**
   * @param fallbackWindow - the configured context window used until the real
   *   model window is adopted.
   * @param probeEnabled - whether live probing is allowed (config `modelProbe.enabled`).
   */
  constructor(
    fallbackWindow: number,
    probeEnabled: boolean,
  ) {
    this.fallbackWindow = fallbackWindow
    this.probeEnabled = probeEnabled
    if (!Number.isSafeInteger(fallbackWindow) || fallbackWindow <= 0) {
      throw new RangeError('fallbackWindow must be a positive integer')
    }
  }

  /** The effective model context window: adopted value or the fallback. */
  get effectiveWindow(): number {
    return this.modelContext?.contextWindow ?? this.fallbackWindow
  }

  /** The currently adopted model context info, or null. */
  get info(): ModelContextInfo | null {
    return this.modelContext
  }

  /**
   * Observe one request's resolved route metadata. When it carries a context
   * window, adopt it immediately. Otherwise — when live probing is enabled and
   * this model has not been probed yet — return the model id to probe; the
   * caller runs the async probe and passes its result to {@link adopt}.
   * @param route - the observed route metadata.
   * @returns a model id to probe (once per model), or undefined.
   */
  observe(route: ModelRouteObservation): string | undefined {
    if (route.contextWindow !== undefined) {
      this.adopt({
        ...(route.provider === undefined ? {} : { provider: route.provider }),
        ...(route.model === undefined ? {} : { model: route.model }),
        contextWindow: route.contextWindow,
        source: 'request-context',
      })
      if (route.model !== undefined) this.probedForModel = route.model
      return undefined
    }
    const model = route.model
    if (model === undefined || !this.probeEnabled) return undefined
    if (this.probedForModel === model) return undefined
    this.probedForModel = model
    return model
  }

  /**
   * Adopt a context window resolved from any source. Non-positive windows are
   * ignored; repeated identical adoptions are no-ops.
   */
  adopt(info: ModelContextAdoption): void {
    if (!Number.isSafeInteger(info.contextWindow) || info.contextWindow <= 0) return
    const current = this.modelContext
    if (current !== null
      && current.contextWindow === info.contextWindow
      && current.source === info.source
      && current.provider === info.provider
      && current.model === info.model) {
      return
    }
    this.modelContext = {
      ...(info.provider === undefined ? {} : { provider: info.provider }),
      ...(info.model === undefined ? {} : { model: info.model }),
      contextWindow: info.contextWindow,
      source: info.source,
      detectedAt: Date.now(),
    }
  }

  /**
   * Whether the tracker would consider a given window "new" (for logging
   * the first adoption of a value that came from elsewhere).
   */
  get isAdopted(): boolean {
    return this.modelContext !== null
  }
}
