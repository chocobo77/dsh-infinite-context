import { describe, expect, it } from 'vitest'
import {
  TASK_STATE_MARKER,
  TASK_STATE_MAX_CHARS,
  buildTaskStateBlock,
  parseCheckpointSection,
} from '../src/task-state.ts'

/** The compaction-basic checkpoint shape (verbatim section headings). */
const CHECKPOINT = [
  '## Primary Request and Intent',
  '- Fix the login page crash; constraint: keep the OAuth flow intact',
  '',
  '## Key Technical Concepts',
  '- oauth PKCE',
  '',
  '## Files and Code',
  '- src/login.tsx: patched handleSubmit',
  '',
  '## Pending Jobs',
  '- write tests for the OAuth path',
  '',
  '## Current Work',
  '- (none)',
  '',
  '## Next Step',
  '- run the full suite',
  '',
  '## Critical Context',
  '- the access token must never be logged',
].join('\n')

describe('parseCheckpointSection', () => {
  it('extracts the bullets of one section and stops at the next heading', () => {
    expect(parseCheckpointSection(CHECKPOINT, 'Pending Jobs'))
      .toEqual(['write tests for the OAuth path'])
    expect(parseCheckpointSection(CHECKPOINT, 'Primary Request and Intent'))
      .toEqual(['Fix the login page crash; constraint: keep the OAuth flow intact'])
  })

  it('drops (none), unknown sections are empty, and bullets are capped', () => {
    expect(parseCheckpointSection(CHECKPOINT, 'Current Work')).toEqual([])
    expect(parseCheckpointSection(CHECKPOINT, 'Nonexistent')).toEqual([])
    const many = '## Pending Jobs\n' + Array.from({ length: 10 }, (_, i) => `- job ${i}`).join('\n')
    expect(parseCheckpointSection(many, 'Pending Jobs')).toHaveLength(6)
  })

  it('clips long bullets by code points without splitting astral chars', () => {
    const text = '## Next Step\n- ' + '😀'.repeat(200)
    const bullets = parseCheckpointSection(text, 'Next Step')
    expect(Array.from(bullets[0] ?? '').length).toBeLessThanOrEqual(161)
    expect(bullets[0]).toContain('😀')
  })
})

describe('buildTaskStateBlock', () => {
  it('builds the block from the checkpoint sections with the marker', () => {
    const block = buildTaskStateBlock({ summary: CHECKPOINT })
    expect(block).toContain(TASK_STATE_MARKER)
    expect(block).toContain('Primary request:')
    expect(block).toContain('- Fix the login page crash')
    expect(block).toContain('Pending jobs:')
    expect(block).toContain('- run the full suite')
    // Sections the block does not carry stay out.
    expect(block).not.toContain('Key Technical')
    expect(block).not.toContain('oauth PKCE')
  })

  it('carries primary and critical forward, but NOT stale jobs or next step', () => {
    const previous = buildTaskStateBlock({ summary: CHECKPOINT })
    const nextFold = [
      '## Primary Request and Intent',
      '- (none)',
      '## Pending Jobs',
      '- a brand new job',
      '## Next Step',
      '- deploy',
      '## Critical Context',
      '- (none)',
    ].join('\n')
    const block = buildTaskStateBlock({ summary: nextFold, previous })
    expect(block).toContain('keep the OAuth flow intact') // carried
    expect(block).toContain('the access token must never be logged') // carried
    expect(block).toContain('a brand new job') // fresh
    expect(block).toContain('- deploy') // fresh
    expect(block).not.toContain('write tests for the OAuth path') // stale, dropped
    expect(block).not.toContain('run the full suite') // stale, dropped
  })

  it('an extractive-shape summary degrades to the carried primary only', () => {
    const previous = buildTaskStateBlock({ summary: CHECKPOINT })
    const block = buildTaskStateBlock({ summary: '# Extractive fold summary\n- 修复登录页', previous })
    expect(block).toContain('Fix the login page crash')
    expect(block).not.toContain('Pending jobs:')
  })

  it('includes the goal line and stays inside the code-point budget', () => {
    const block = buildTaskStateBlock({ summary: CHECKPOINT, goal: '  面板关闭后 8790 的面板读数依旧正确  ' })
    expect(block).toContain('Goal: 面板关闭后 8790 的面板读数依旧正确')
    const big = '## Critical Context\n' + Array.from(
      { length: 30 },
      (_, i) => `- constraint ${i} ${'x'.repeat(150)}`,
    ).join('\n')
    const bounded = buildTaskStateBlock({ summary: big, goal: 'g'.repeat(100) })
    expect(Array.from(bounded ?? '').length).toBeLessThanOrEqual(TASK_STATE_MAX_CHARS)
  })

  it('returns undefined when there is nothing to carry', () => {
    expect(buildTaskStateBlock({})).toBeUndefined()
    expect(buildTaskStateBlock({ summary: 'no headings here', previous: undefined })).toBeUndefined()
  })
})
