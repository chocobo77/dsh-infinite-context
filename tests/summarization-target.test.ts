import { describe, expect, it } from 'vitest'
import {
  resolveSummarizationTarget,
  routedTargetOf,
  type SummarizationConfig,
} from '../src/summarization-target.ts'
import type { Session } from '@deepseek-ai/dsh-session'

/** Minimal fake session exposing ONLY the routed request-header config. */
function fakeSession(provider: string, model: string): Session {
  return {
    requestHeader: () => ({
      config: { provider, model },
    }),
  } as unknown as Session
}

/** Fake session with NO request header but a live request/context route. */
function fakeContextOnly(provider: string, model: string): Session {
  return {
    requestHeader: () => undefined,
    requestContext: () => ({ provider, model }),
  } as unknown as Session
}

const NO_CONFIG: SummarizationConfig = { summarizationProvider: '', summarizationModel: '' }
const PINNED: SummarizationConfig = {
  summarizationProvider: 'deepseek-official',
  summarizationModel: 'deepseek-v4-flash',
}

describe('resolveSummarizationTarget', () => {
  it('uses the explicit config when both fields are set (pinned model wins)', () => {
    const target = resolveSummarizationTarget(PINNED, fakeSession('qwen3', 'Qwen3.8-27B-UD-Q2_K_XL'))
    expect(target).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('follows the session routed model when config is empty (zero-config install)', () => {
    const target = resolveSummarizationTarget(
      NO_CONFIG,
      fakeSession('qwen3', 'Qwen3.8-27B-UD-Q2_K_XL'),
    )
    expect(target).toEqual({ provider: 'qwen3', model: 'Qwen3.8-27B-UD-Q2_K_XL' })
  })

  it('returns undefined when config is empty and there is no session', () => {
    expect(resolveSummarizationTarget(NO_CONFIG)).toBeUndefined()
  })

  it('returns undefined when config is empty and the session has no route yet', () => {
    expect(resolveSummarizationTarget(NO_CONFIG, fakeSession('', ''))).toBeUndefined()
  })

  it('does not treat a partial config (provider only) as a pin', () => {
    const partial: SummarizationConfig = { summarizationProvider: 'qwen3', summarizationModel: '' }
    expect(resolveSummarizationTarget(partial, fakeSession('ark-code-latest', 'deepseek-v4-flash')))
      .toEqual({ provider: 'ark-code-latest', model: 'deepseek-v4-flash' })
  })
})

describe('routedTargetOf', () => {
  it('reads the durably routed provider/model from the request header', () => {
    expect(routedTargetOf(fakeSession('qwen3', 'Qwen3.8-27B-UD-Q2_K_XL')))
      .toEqual({ provider: 'qwen3', model: 'Qwen3.8-27B-UD-Q2_K_XL' })
  })

  it('returns undefined when the header config is empty', () => {
    expect(routedTargetOf(fakeSession('', ''))).toBeUndefined()
  })

  it('falls back to request/context when the request header is not set yet (pre-step)', () => {
    expect(routedTargetOf(fakeContextOnly('deepseek-official', 'deepseek-flash')))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('prefers the request header over the request context', () => {
    const session = {
      requestHeader: () => ({ config: { provider: 'header-provider', model: 'header-model' } }),
      requestContext: () => ({ provider: 'ctx-provider', model: 'ctx-model' }),
    } as unknown as Session
    expect(routedTargetOf(session)).toEqual({ provider: 'header-provider', model: 'header-model' })
  })

  it('returns undefined when neither route carries a provider/model', () => {
    const session = {
      requestHeader: () => undefined,
      requestContext: () => ({ provider: '', model: '' }),
    } as unknown as Session
    expect(routedTargetOf(session)).toBeUndefined()
  })

  it('never throws when requestContext is missing on a partial session object', () => {
    expect(routedTargetOf(fakeSession('', ''))).toBeUndefined()
  })
})

describe('resolveSummarizationTarget with the pre-step fallback', () => {
  it('follows request/context when the header is absent (zero-config install)', () => {
    expect(resolveSummarizationTarget(NO_CONFIG, fakeContextOnly('qwen3', 'Qwen3.8-27B-UD-Q2_K_XL')))
      .toEqual({ provider: 'qwen3', model: 'Qwen3.8-27B-UD-Q2_K_XL' })
  })

  it('still lets an explicit pin win over the context route', () => {
    expect(resolveSummarizationTarget(PINNED, fakeContextOnly('qwen3', 'Qwen3.8-27B-UD-Q2_K_XL')))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })
})
