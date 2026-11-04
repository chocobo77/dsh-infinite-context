import { describe, expect, it } from 'vitest'
import {
  OPP_BONUS_MAX,
  OPP_EARLY_PENALTY,
  OPP_MATURE_TURNS,
  OPP_NUDGE_MIN,
  evaluateOpportunity,
} from '../src/core.ts'

const base = {
  turnCount: 20,
  stepsSinceUser: 3,
  lastEventType: '',
  recentToolRatio: 0,
}

describe('evaluateOpportunity', () => {
  it('scores a turn boundary highest', () => {
    expect(evaluateOpportunity({ ...base, lastEventType: 'user/message' }))
      .toMatchObject({ phase: 'turn-start', score: 1 })
    expect(evaluateOpportunity({ ...base, lastEventType: 'assistant/message', lastEventHadToolCalls: false }))
      .toMatchObject({ phase: 'turn-end', score: 0.9 })
  })

  it('defers mid tool-loop', () => {
    expect(evaluateOpportunity({ ...base, lastEventType: 'tool/result' }))
      .toMatchObject({ phase: 'tool-loop', score: 0.15 })
    expect(evaluateOpportunity({ ...base, lastEventType: 'assistant/message', lastEventHadToolCalls: true }))
      .toMatchObject({ phase: 'tool-loop', score: 0.15 })
  })

  it('penalizes a tool-heavy steady step', () => {
    const quiet = evaluateOpportunity({ ...base, lastEventType: 'system/message', recentToolRatio: 0 })
    const busy = evaluateOpportunity({ ...base, lastEventType: 'system/message', recentToolRatio: 1 })
    expect(quiet.score).toBeGreaterThan(busy.score)
    expect(busy.score).toBeGreaterThanOrEqual(0)
  })

  it('keeps young sessions below full maturity', () => {
    expect(evaluateOpportunity({ ...base, turnCount: 2 }).maturity).toBe(0)
    expect(evaluateOpportunity({ ...base, turnCount: OPP_MATURE_TURNS }).maturity).toBe(1)
    // Surface folding can shrink the turn count; compressions keep maturity.
    expect(evaluateOpportunity({ ...base, turnCount: 1, compressions: 8 }).maturity).toBe(1)
  })

  it('exposes the modulation constants', () => {
    expect(OPP_BONUS_MAX).toBeGreaterThan(0)
    expect(OPP_EARLY_PENALTY).toBeGreaterThan(0)
    expect(OPP_NUDGE_MIN).toBeGreaterThan(0)
  })
})
