import { describe, expect, it } from 'vitest'
import { matchWindows } from '../src/tools.ts'

describe('matchWindows', () => {
  it('returns a padded window containing the match', () => {
    const text = 'x'.repeat(300) + 'NEEDLE' + 'y'.repeat(300)
    const windows = matchWindows(text, 'needle', 5)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toContain('NEEDLE')
    expect(windows[0]!.length).toBeLessThan(text.length)
  })

  it('stays aligned when astral characters precede the match', () => {
    // 300 emoji are 300 code points but 600 UTF-16 units: the match offset must
    // be converted before slicing the code-point array, or the window starts
    // past the match and shows the wrong text (and drifts the scan).
    const text = '\u{1F600}'.repeat(300) + 'TARGET' + 'z'.repeat(50)
    const windows = matchWindows(text, 'target', 1)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toContain('TARGET')
  })

  it('finds every occurrence up to the cap', () => {
    const text = 'alpha one beta alpha two gamma alpha three'
    expect(matchWindows(text, 'alpha', 2)).toHaveLength(2)
    expect(matchWindows(text, 'alpha', 20)).toHaveLength(3)
  })

  it('returns no windows when nothing matches', () => {
    expect(matchWindows('alpha', 'omega', 3)).toEqual([])
  })
})
