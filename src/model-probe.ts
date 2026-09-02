/**
 * Live model-context probing for local servers whose model listing does not
 * advertise a context window.
 *
 * The plugin normally adopts the context window DSH already resolved from the
 * model catalog (online providers) or from an OpenAI-compatible `/models`
 * listing (gateways like llama-server / vLLM / LiteLLM). Some local servers —
 * notably Ollama — never report `context_length` on their listing, so this
 * module speaks each server's native endpoint as a fallback:
 *
 * - `llama`   → `GET /props`          (`default_generation_settings.n_ctx`)
 * - `ollama`  → `POST /api/show`      (`model_info['llama.context_length']`)
 * - `openai`  → `GET /models`         (`context_length`/`context_window`/`max_model_len`)
 *
 * Every probe is best-effort: a failure returns `undefined` and never throws
 * into the caller. Probes are bounded by a timeout so a dead local server
 * cannot stall the request path (probing runs off the request path anyway).
 *
 * @module dsh-infinite-context/model-probe
 */

import type { ModelProbeKind } from './config.ts'

/** Timeout for one live probe, in milliseconds. */
export const PROBE_TIMEOUT_MS = 5000

/** A positive integer field, or `undefined` when absent/unusable. */
function positiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value)
    if (Number.isInteger(n) && n > 0) return n
  }
  return undefined
}

/** A non-empty string field, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** Join a base URL with a path, keeping any deployment prefix segments. */
function joinPath(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}${path}`
}

/** Fetch with a bounded timeout; resolves to `null` on any transport failure. */
async function boundedFetch(url: string, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Read a bounded JSON body, or `null` when the server refused or the body is not JSON. */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok) return null
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** `GET /props` on llama-server: the effective `n_ctx` of the running model. */
export async function probeLlama(baseURL: string): Promise<number | undefined> {
  const response = await boundedFetch(joinPath(baseURL, '/props'))
  if (response === null) return undefined
  const body = await readJson(response)
  if (body === null) return undefined
  const settings = body.default_generation_settings as Record<string, unknown> | undefined
  return positiveInt(settings?.n_ctx) ?? positiveInt(body.n_ctx)
}

/** `POST /api/show` on Ollama: the loaded model's context length. */
export async function probeOllama(baseURL: string, model?: string): Promise<number | undefined> {
  const name = label(model)
  if (name === undefined) return undefined
  const response = await boundedFetch(joinPath(baseURL, '/api/show'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name }),
  })
  if (response === null) return undefined
  const body = await readJson(response)
  if (body === null) return undefined
  const info = body.model_info as Record<string, unknown> | undefined
  const params = body.parameters as Record<string, unknown> | undefined
  return positiveInt(info?.['llama.context_length']) ?? positiveInt(params?.num_ctx)
}

/** Context-length fields advertised by standard OpenAI-compatible `/models` listings. */
const CONTEXT_FIELDS = ['context_length', 'context_window', 'max_model_len', 'n_ctx'] as const

/**
 * Context-length fields reported by local servers' NATIVE listings that never
 * advertise one on their OpenAI-compatible surface — LM Studio's
 * `/api/v0/models` reports the loaded model's runtime context here.
 */
const NATIVE_CONTEXT_FIELDS = ['max_total_tokens', 'max_completion_tokens', 'n_ctx'] as const

/**
 * Read a context length from one listing entry: first the entry's own fields,
 * then the nested `meta` object. llama-server's OpenAI-compatible listing
 * reports the runtime context only as `meta.n_ctx` (never as a top-level
 * `context_length`), so without this fallback the probe would not discover
 * the real `--ctx-size` of a local llama.cpp model.
 */
function entryContext(entry: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const found = positiveInt(entry[field])
    if (found !== undefined) return found
  }
  const meta = entry.meta
  if (typeof meta === 'object' && meta !== null) {
    const record = meta as Record<string, unknown>
    for (const field of fields) {
      const found = positiveInt(record[field])
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Read a context length from a `{ data: [...] }` listing, filtered by model id. */
async function probeListing(
  url: string,
  model: string | undefined,
  fields: readonly string[],
): Promise<number | undefined> {
  const response = await boundedFetch(url)
  if (response === null) return undefined
  const body = await readJson(response)
  if (body === null) return undefined
  const data = body.data
  if (!Array.isArray(data)) return undefined
  const name = label(model)
  const entries = name === undefined
    ? data
    : data.filter(entry => (entry as { id?: unknown })?.id === name)
  for (const raw of entries) {
    const found = entryContext(raw as Record<string, unknown>, fields)
    if (found !== undefined) return found
  }
  return undefined
}

/** `GET /models` (OpenAI-compatible), with an LM Studio native fallback. */
export async function probeOpenAI(baseURL: string, model?: string): Promise<number | undefined> {
  // Standard OpenAI-compatible listing first (vLLM / llama-server / LiteLLM).
  const fromModels = await probeListing(joinPath(baseURL, '/models'), model, CONTEXT_FIELDS)
  if (fromModels !== undefined) return fromModels
  // LM Studio's /v1/models never advertises a context length, but its native
  // /api/v0/models reports the loaded model's runtime context (max_total_tokens).
  const nativeBase = baseURL.replace(/\/v1$/, '')
  return probeListing(joinPath(nativeBase, '/api/v0/models'), model, NATIVE_CONTEXT_FIELDS)
}

/** Probe the configured local server for a model's context window. */
export async function probeModelContext(
  config: { enabled: boolean; kind: ModelProbeKind; baseURL: string },
  model?: string,
): Promise<number | undefined> {
  if (!config.enabled || config.baseURL.length === 0) return undefined
  switch (config.kind) {
    case 'llama': return probeLlama(config.baseURL)
    case 'ollama': return probeOllama(config.baseURL, model)
    case 'openai': return probeOpenAI(config.baseURL, model)
  }
}
