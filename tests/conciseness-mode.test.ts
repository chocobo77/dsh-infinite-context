import { describe, expect, it } from 'vitest'
import {
  CONCISE_DIRECTIVE_MARKER,
  DEFAULT_CONCISE_DIRECTIVE,
  buildConciseDirective,
  createConciseMessage,
  hasConciseDirective,
} from '../src/conciseness-mode.ts'

/** Extract the joined text of a message's text blocks. */
function messageText(message: ReturnType<typeof createConciseMessage>): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
}

describe('conciseness directive', () => {
  it('wraps the directive in a detectable runtime_directive envelope', () => {
    const text = buildConciseDirective('be brief')
    expect(text.startsWith('<runtime_directive ')).toBe(true)
    expect(text).toContain(CONCISE_DIRECTIVE_MARKER)
    expect(text).toContain('be brief')
    expect(text.endsWith('</runtime_directive>')).toBe(true)
  })

  it('creates a user-role message tagged with the plugin source', () => {
    const message = createConciseMessage(DEFAULT_CONCISE_DIRECTIVE)
    expect(message.role).toBe('user')
    expect((message.source as { kind?: string }).kind).toBe('plugin:dsh-infinite-context')
    expect(messageText(message)).toContain(DEFAULT_CONCISE_DIRECTIVE)
  })

  it('the default directive names the three habits it suppresses', () => {
    // Guard against a silent rewrite of the built-in text: the mode's whole
    // value is that it forbids inter-call narration, forces batching, and
    // pushes explanation into the final answer.
    expect(DEFAULT_CONCISE_DIRECTIVE).toContain('不要写任何说明文字')
    expect(DEFAULT_CONCISE_DIRECTIVE).toContain('并行发出')
    expect(DEFAULT_CONCISE_DIRECTIVE).toContain('最终答复')
  })
})

describe('hasConciseDirective (idempotence guard)', () => {
  it('detects its own injected message on the surface', () => {
    const surface = ['a user question', messageText(createConciseMessage('be brief'))]
    expect(hasConciseDirective(surface)).toBe(true)
  })

  it('is false on a surface that never carried it', () => {
    expect(hasConciseDirective(['a user question', '<retrieved_context>memory</retrieved_context>'])).toBe(false)
  })

  it('is false for an empty surface and for a bare directive text without the envelope', () => {
    expect(hasConciseDirective([])).toBe(false)
    expect(hasConciseDirective(['be brief: 本地模型运行中，请压缩输出'])).toBe(false)
  })
})
