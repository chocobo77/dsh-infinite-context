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

/**
 * Cooldown before a failed model probe is retried. A local server that was
 * down (or started after DSH) is re-probed after this delay on later turns.
 */
export const PROBE_RETRY_MS = 60_000

/** Tracks the effective model context window and probe-once-per-model state. */
export class ModelContextTracker {
  private modelContext: ModelContextInfo | null = null
  /**
   * Per-model window registry. A single global slot cannot serve a runtime
   * where concurrent sessions route to different models (a 1M remote chat and
   * an 8K local model): the last observation would poison the other session's
   * budget. Every adoption and per-model override lands here keyed by model id.
   */
  private readonly windowsByModel = new Map<string, ModelContextInfo>()
  /** Models whose window was confirmed by a successful live probe. */
  private readonly resolvedModels = new Set<string>()
  /** Last probe attempt per model (for the retry cooldown). */
  private readonly lastProbeAttempt = new Map<string, number>()
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
   * The narrowed window recorded for one specific model, or undefined when
   * nothing (declaration, probe, or override) has been observed for it.
   */
  windowFor(model: string | undefined): number | undefined {
    if (model === undefined) return undefined
    return this.windowsByModel.get(model)?.contextWindow
  }

  /** All per-model windows currently known, in insertion order. */
  perModel(): readonly ModelContextInfo[] {
    return [...this.windowsByModel.values()]
  }

  /**
   * Record an explicit per-model window (config override or probe result)
   * WITHOUT moving the global "last observed" slot. Probes only ever narrow:
   * a later wider observation for the same model cannot raise a recorded
   * narrower value.
   */
  setModelWindow(info: {
    provider?: string
    model?: string
    contextWindow: number
    source: ModelContextSource
  }): void {
    if (info.model === undefined) return
    if (!Number.isSafeInteger(info.contextWindow) || info.contextWindow <= 0) return
    const existing = this.windowsByModel.get(info.model)
    if (existing !== undefined && info.contextWindow >= existing.contextWindow) return
    this.windowsByModel.set(info.model, {
      ...(info.provider === undefined ? {} : { provider: info.provider }),
      model: info.model,
      contextWindow: info.contextWindow,
      source: info.source,
      detectedAt: Date.now(),
    })
  }

  /**
   * Observe one request's resolved route metadata. A declared window (DSH
   * catalog / `/models` listing) is adopted immediately as an upper bound —
   * but for local servers that value can far exceed the real runtime context,
   * so a live probe is still requested (once per model, respecting the retry
   * cooldown). The probe result (capped at the declared window by the caller)
   * then narrows the effective window to the server's true limit.
   * @param route - the observed route metadata.
   * @returns a model id to probe (once per model, after cooldown), or undefined.
   */
  observe(route: ModelRouteObservation): string | undefined {
    if (route.contextWindow !== undefined) {
      this.adopt({
        ...(route.provider === undefined ? {} : { provider: route.provider }),
        ...(route.model === undefined ? {} : { model: route.model }),
        contextWindow: route.contextWindow,
        source: 'request-context',
      })
    }
    const model = route.model
    if (model === undefined || !this.probeEnabled) return undefined
    if (this.resolvedModels.has(model)) return undefined
    const lastAttempt = this.lastProbeAttempt.get(model) ?? 0
    if (Date.now() - lastAttempt < PROBE_RETRY_MS) return undefined
    this.lastProbeAttempt.set(model, Date.now())
    return model
  }

  /**
   * Mark a model as resolved by a successful live probe, so it is not probed
   * again. A probe only ever narrows the window; the runtime context is stable
   * until the model is reloaded (a process restart re-probes).
   * @param model - the model id whose window was confirmed by a probe.
   */
  markResolved(model: string): void {
    this.resolvedModels.add(model)
    this.lastProbeAttempt.delete(model)
  }

  /**
   * Adopt a context window resolved from any source. Non-positive windows are
   * ignored; repeated identical adoptions are no-ops.
   */
  adopt(info: ModelContextAdoption): void {
    if (!Number.isSafeInteger(info.contextWindow) || info.contextWindow <= 0) return
    // Mirror into the per-model registry: a probe narrowing must win over the
    // declared value, and each model keeps its own slot.
    if (info.model !== undefined) this.setModelWindow({ ...info, source: info.source })
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
