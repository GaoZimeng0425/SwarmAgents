import { describe, expect, it } from 'vitest'

import { parseSummary } from './summarize'

describe('parseSummary', () => {
  it('parses a fenced JSON block into the structured shape', () => {
    const raw = '```json\n{"gist":"主旨","points":["p1"],"experience":[],"pitfalls":["x"],"steps":["s1","s2"]}\n```'
    const s = parseSummary(raw)
    expect(s.gist).toBe('主旨')
    expect(s.points).toEqual(['p1'])
    expect(s.steps).toEqual(['s1', 's2'])
  })

  it('coerces missing arrays to empty arrays', () => {
    const s = parseSummary('{"gist":"g"}')
    expect(s.points).toEqual([])
    expect(s.pitfalls).toEqual([])
  })
})
