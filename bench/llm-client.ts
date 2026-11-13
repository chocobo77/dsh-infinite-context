/**
 * Minimal OpenAI-compatible chat client for the bench replay (llama.cpp
 * server, LM Studio, Ollama's OpenAI shim — any `/v1/chat/completions`
 * endpoint). Non-streaming single POST, one retry on 429/5xx/network, no
 * dependencies. Local-model timeouts are generous (llama.cpp has no idle
 * limit; the production local deadline prior is 900s).
 *
 * @module dsh-infinite-context/bench-llm-client
 */

const DEFAULT_TIMEOUT_MS = 900_000
const RETRY_BACKOFF_MS = 3_000

export interface ChatMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

export interface ChatResult {
  readonly text: string
  readonly usage?: { input?: number; output?: number }
}

export interface ChatOptions {
  readonly endpoint: string
  readonly model: string
  readonly messages: readonly ChatMessage[]
  readonly maxTokens?: number
  readonly temperature?: number
  readonly timeoutMs?: number
}

function chatUrl(endpoint: string): string {
  // Accept both the bare host and a /v1-suffixed base without doubling the
  // version segment (llama.cpp serves /v1/chat/completions).
  const base = endpoint.replace(/\/+$/, '').replace(/\/v1$/, '')
  return base + '/v1/chat/completions'
}

function isRetriable(status: number): boolean {
  return status === 429 || status >= 500
}

async function postOnce(options: ChatOptions): Promise<{ text: string; usage?: { input?: number; output?: number } }> {
  const response = await fetch(chatUrl(options.endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
      stream: false,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw Object.assign(new Error(`chat failed: HTTP ${response.status} ${body.slice(0, 200)}`), {
      status: response.status,
    })
  }
  const payload = await response.json() as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const text = payload.choices?.[0]?.message?.content ?? ''
  if (text.length === 0) throw new Error('chat returned no content')
  const usage = payload.usage === undefined
    ? undefined
    : {
      ...(payload.usage.prompt_tokens === undefined ? {} : { input: payload.usage.prompt_tokens }),
      ...(payload.usage.completion_tokens === undefined ? {} : { output: payload.usage.completion_tokens }),
    }
  return {
    text,
    ...(usage === undefined ? {} : { usage }),
  }
}

/** One completion with a single retry on transient failures. */
export async function chatCompletion(options: ChatOptions): Promise<ChatResult> {
  try {
    return await postOnce(options)
  } catch (error: unknown) {
    const status = (error as { status?: number }).status
    const transient = status === undefined || isRetriable(status)
    if (!transient) throw error
    await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS))
    return postOnce(options)
  }
}

export interface JudgeVerdict {
  readonly faithfulness: number
  readonly coverage: number
  readonly notes: string
}

const JUDGE_PROMPT = [
  'You are an evaluation judge. Compare a SUMMARY against the SOURCE conversation segment it was made from.',
  'Score ONLY from the source: do not use outside knowledge.',
  'faithfulness (1-5): 5 = no statement contradicts or invents beyond the source; 1 = fabrications or contradictions.',
  'coverage (1-5): 5 = every load-bearing fact (paths, errors, decisions, user instructions, outcomes) survives; 1 = most dropped.',
  'Respond with ONLY a JSON object: {"faithfulness": <1-5>, "coverage": <1-5>, "notes": "<one sentence>"}',
].join('\n')

function parseVerdict(raw: string): JudgeVerdict {
  // Thinking models wrap reasoning in <think>…</think>; strip before the JSON scan.
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  const match = text.match(/\{[\s\S]*\}/)
  if (match === null) throw new Error('judge returned no JSON object')
  const parsed = JSON.parse(match[0]) as { faithfulness?: unknown; coverage?: unknown; notes?: unknown }
  const clamp = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number.NaN
    return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 0
  }
  const faithfulness = clamp(parsed.faithfulness)
  const coverage = clamp(parsed.coverage)
  if (faithfulness === 0 || coverage === 0) throw new Error('judge JSON missing scores')
  return {
    faithfulness,
    coverage,
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 300) : '',
  }
}

/** Ask the local model to judge one summary against its source region. */
export async function judgeSummary(options: Omit<ChatOptions, 'messages' | 'maxTokens' | 'temperature'> & {
  readonly regionText: string
  readonly summary: string
}): Promise<JudgeVerdict> {
  const result = await chatCompletion({
    endpoint: options.endpoint,
    model: options.model,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // Thinking models spend tokens on reasoning before the JSON verdict —
    // a tight cap yields empty content.
    maxTokens: 2048,
    temperature: 0,
    messages: [
      { role: 'system', content: JUDGE_PROMPT },
      {
        role: 'user',
        content: `SOURCE CONVERSATION SEGMENT:\n${options.regionText.slice(0, 60_000)}\n\nSUMMARY TO JUDGE:\n${options.summary.slice(0, 20_000)}`,
      },
    ],
  })
  return parseVerdict(result.text)
}
