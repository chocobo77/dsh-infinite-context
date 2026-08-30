import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeLlama, probeModelContext, probeOllama, probeOpenAI } from '../src/core.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetchOnce(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init))
}

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
  })
}

describe('model probe', () => {
  it('reads llama-server n_ctx from default_generation_settings', async () => {
    mockFetchOnce(url => {
      expect(url).toBe('http://127.0.0.1:8080/props')
      return jsonResponse({ default_generation_settings: { n_ctx: 8192 } })
    })
    await expect(probeLlama('http://127.0.0.1:8080')).resolves.toBe(8192)
  })

  it('falls back to the top-level llama-server n_ctx', async () => {
    mockFetchOnce(() => jsonResponse({ n_ctx: 4096 }))
    await expect(probeLlama('http://127.0.0.1:8080/')).resolves.toBe(4096)
  })

  it('reads ollama context_length from model_info', async () => {
    mockFetchOnce((url, init) => {
      expect(url).toBe('http://127.0.0.1:11434/api/show')
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'qwen2.5:7b' })
      return jsonResponse({ model_info: { 'llama.context_length': 32_768 } })
    })
    await expect(probeOllama('http://127.0.0.1:11434', 'qwen2.5:7b')).resolves.toBe(32_768)
  })

  it('needs a model name for ollama', async () => {
    await expect(probeOllama('http://127.0.0.1:11434')).resolves.toBeUndefined()
  })

  it('reads the matching model entry from an OpenAI listing', async () => {
    mockFetchOnce((url, init) => {
      expect(url).toBe('http://127.0.0.1:8000/v1/models')
      expect(init?.method).toBeUndefined()
      return jsonResponse({
        data: [
          { id: 'other', context_length: 2048 },
          { id: 'llama-3.1-8b', context_length: 131_072 },
        ],
      })
    })
    await expect(probeOpenAI('http://127.0.0.1:8000/v1', 'llama-3.1-8b')).resolves.toBe(131_072)
  })

  it('reads max_model_len when context_length is absent', async () => {
    mockFetchOnce(() => jsonResponse({ data: [{ id: 'vllm-model', max_model_len: 32_768 }] }))
    await expect(probeOpenAI('http://127.0.0.1:8000/v1', 'vllm-model')).resolves.toBe(32_768)
  })

  it('falls back to LM Studio /api/v0/models max_total_tokens', async () => {
    mockFetchOnce(url => {
      if (url === 'http://127.0.0.1:1234/v1/models') {
        // LM Studio's OpenAI-compatible listing advertises no context length.
        return jsonResponse({ data: [{ id: 'qwen3.8-27b' }] })
      }
      if (url === 'http://127.0.0.1:1234/api/v0/models') {
        return jsonResponse({ data: [
          { id: 'qwen3.8-27b', max_total_tokens: 8192, max_completion_tokens: 4096 },
        ] })
      }
      throw new Error(`unexpected url ${url}`)
    })
    await expect(probeOpenAI('http://127.0.0.1:1234/v1', 'qwen3.8-27b')).resolves.toBe(8192)
  })

  it('ignores the LM Studio fallback when the model id does not match', async () => {
    mockFetchOnce(url => {
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'other' }] })
      return jsonResponse({ data: [{ id: 'other', max_total_tokens: 4096 }] })
    })
    await expect(probeOpenAI('http://127.0.0.1:1234/v1', 'qwen3.8-27b')).resolves.toBeUndefined()
  })

  it('returns undefined on a non-2xx reply', async () => {
    mockFetchOnce(() => jsonResponse({ error: 'nope' }, false))
    await expect(probeLlama('http://127.0.0.1:8080')).resolves.toBeUndefined()
  })

  it('returns undefined on a transport failure', async () => {
    mockFetchOnce(() => { throw new TypeError('ECONNREFUSED') })
    await expect(probeLlama('http://127.0.0.1:8080')).resolves.toBeUndefined()
  })

  it('returns undefined when probing is disabled or baseURL is blank', async () => {
    await expect(probeModelContext({ enabled: false, kind: 'llama', baseURL: 'http://x' })).resolves.toBeUndefined()
    await expect(probeModelContext({ enabled: true, kind: 'llama', baseURL: '' })).resolves.toBeUndefined()
  })
})
