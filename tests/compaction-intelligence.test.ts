import { describe, expect, it } from 'vitest'
import { analyzeContext } from '../src/core.ts'

const toolHeavy = [
  { type: 'user/message', tokens: 100, text: 'read the files' },
  { type: 'assistant/message', tokens: 200, text: 'reading', hasToolCalls: true },
  { type: 'tool/result', tokens: 5000 },
  { type: 'tool/result', tokens: 5000 },
]

const reasoningHeavy = [
  { type: 'user/message', tokens: 2000, text: 'the plan is to keep the cache warm' },
  { type: 'assistant/message', tokens: 3000, text: 'done. next steps: verify the patch' },
]

describe('analyzeContext', () => {
  it('folds tool-heavy context deeper than reasoning-heavy context', () => {
    const tools = analyzeContext(toolHeavy)
    const reasoning = analyzeContext(reasoningHeavy)
    expect(tools.magnitude).toBeGreaterThan(reasoning.magnitude)
    expect(tools.profile.toolShare).toBeGreaterThan(0.9)
    expect(tools.reasons).toContain('tool-heavy')
  })

  it('treats a turn-end milestone as a clean seam', () => {
    const intent = analyzeContext(reasoningHeavy)
    expect(intent.profile.milestone).toBe(true)
    expect(intent.profile.phase).toBe('turn-end')
    expect(intent.timing).toBeGreaterThan(0.8)
  })

  it('defers inside a tool run', () => {
    const intent = analyzeContext(toolHeavy)
    expect(intent.profile.phase).toBe('tool-loop')
    expect(intent.profile.toolRun).toBe(2)
    expect(intent.timing).toBeLessThan(0.3)
  })

  it('lowers timing when the assistant is waiting for an answer', () => {
    const question = analyzeContext([
      { type: 'user/message', tokens: 200, text: 'continue' },
      { type: 'assistant/message', tokens: 400, text: 'Which file should I change?' },
    ])
    expect(question.profile.openQuestion).toBe(true)
    expect(question.timing).toBeLessThan(0.75)
  })

  it('recognises a user confirmation as a milestone', () => {
    const intent = analyzeContext([
      { type: 'assistant/message', tokens: 400, text: 'the patch is applied' },
      { type: 'user/message', tokens: 20, text: '继续' },
    ])
    expect(intent.profile.milestone).toBe(true)
    expect(intent.profile.phase).toBe('turn-start')
  })
})

describe('milestone hardening', () => {
  it('a long message that merely ENDS with a Done line is not a milestone', () => {
    const body = Array.from({ length: 30 }, (_, i) => `Step ${i}: edited file-${i}.ts and reran the suite.`).join('\n')
    const intent = analyzeContext([
      { type: 'user/message', tokens: 200, text: 'keep going' },
      { type: 'assistant/message', tokens: 3000, text: body + '\nDone.' },
    ])
    expect(intent.profile.milestone).toBe(false)
  })

  it('a short wrap-up still counts', () => {
    const intent = analyzeContext([
      { type: 'user/message', tokens: 200, text: 'status?' },
      { type: 'assistant/message', tokens: 300, text: 'All three checks pass.\nReady for review.' },
    ])
    expect(intent.profile.milestone).toBe(true)
  })

  it('negation vetoes the completion match', () => {
    const intent = analyzeContext([
      { type: 'user/message', tokens: 100, text: 'so is it done?' },
      { type: 'assistant/message', tokens: 200, text: '还没完成，卡在依赖安装。' },
    ])
    expect(intent.profile.milestone).toBe(false)
  })

  it('negation vetoes the English completion match too', () => {
    const intent = analyzeContext([
      { type: 'user/message', tokens: 100, text: 'status' },
      { type: 'assistant/message', tokens: 200, text: 'Not finished yet — the migration is still running.' },
    ])
    expect(intent.profile.milestone).toBe(false)
  })

  it('a user confirmation is still a milestone even mid-negation context', () => {
    const intent = analyzeContext([
      { type: 'assistant/message', tokens: 300, text: '还差一步，要我继续吗？' },
      { type: 'user/message', tokens: 20, text: '继续' },
    ])
    expect(intent.profile.milestone).toBe(true)
  })
})
