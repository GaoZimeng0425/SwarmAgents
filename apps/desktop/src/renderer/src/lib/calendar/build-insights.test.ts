import { describe, expect, it } from 'vitest'

import type { InsightInput } from './build-insights'
import { buildCalendarInsights } from './build-insights'

// Helpers: build items with sensible defaults. Times are ms epochs; only
// relative ordering matters for the rules, so we use small offsets from a base.
const NOON = new Date(2026, 6, 3, 12, 0).getTime() // Jul 3 2026 12:00
function ev(over: Partial<InsightInput> & Pick<InsightInput, 'startMs'>): InsightInput {
  return { kind: 'event', source: 'google', title: 'e', endMs: over.startMs + 60 * 60 * 1000, ...over }
}
function proj(over: Partial<InsightInput> & Pick<InsightInput, 'startMs'>): InsightInput {
  return { kind: 'projection', source: 'task', title: 't', endMs: over.startMs, ...over }
}

describe('buildCalendarInsights', () => {
  it('returns no insights for an empty day', () => {
    expect(buildCalendarInsights([])).toEqual([])
  })

  it('returns no insights for a single event', () => {
    expect(buildCalendarInsights([ev({ startMs: NOON })])).toEqual([])
  })

  it('flags a conflict when two events are back-to-back with <30min gap', () => {
    const a = ev({ startMs: new Date(2026, 6, 3, 11, 0).getTime(), endMs: new Date(2026, 6, 3, 11, 30).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 11, 45).getTime(), endMs: new Date(2026, 6, 3, 12, 30).getTime() })
    const out = buildCalendarInsights([a, b])
    expect(out.some((i) => i.kind === 'conflict')).toBe(true)
  })

  it('does not flag a conflict when gap is >=30min', () => {
    const a = ev({ startMs: new Date(2026, 6, 3, 11, 0).getTime(), endMs: new Date(2026, 6, 3, 11, 30).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 12, 0).getTime(), endMs: new Date(2026, 6, 3, 13, 0).getTime() })
    const out = buildCalendarInsights([a, b])
    expect(out.some((i) => i.kind === 'conflict')).toBe(false)
  })

  it('flags overlapping events as a conflict', () => {
    const a = ev({ startMs: new Date(2026, 6, 3, 11, 0).getTime(), endMs: new Date(2026, 6, 3, 12, 0).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 11, 30).getTime(), endMs: new Date(2026, 6, 3, 12, 30).getTime() })
    const out = buildCalendarInsights([a, b])
    expect(out.some((i) => i.kind === 'conflict')).toBe(true)
  })

  it('emits a delegable insight when a local event exists', () => {
    const out = buildCalendarInsights([ev({ startMs: NOON, source: 'local', title: 'Agent:整理周报' })])
    expect(out.some((i) => i.kind === 'delegable')).toBe(true)
  })

  it('emits a delegable insight when a cron projection exists', () => {
    const out = buildCalendarInsights([proj({ startMs: NOON })])
    expect(out.some((i) => i.kind === 'delegable')).toBe(true)
  })

  it('emits a focus insight when a >=90min free block exists in the afternoon', () => {
    // 09:00-10:00 meeting, then nothing until evening -> 13:00-15:00 is free (>=90min, outside lunch)
    const a = ev({ startMs: new Date(2026, 6, 3, 9, 0).getTime(), endMs: new Date(2026, 6, 3, 10, 0).getTime() })
    const out = buildCalendarInsights([a])
    expect(out.some((i) => i.kind === 'focus')).toBe(true)
  })

  it('does not emit a focus insight inside the 12:00-13:00 lunch band', () => {
    // Only a 09:00-11:30 meeting; the largest non-lunch free block before lunch is 11:30-12:00 (30min, too short);
    // afternoon is fully free though -> focus IS emitted. To test lunch exclusion we need the ONLY gap to be lunch.
    // Construct: meetings 09:00-12:00 and 13:00-18:00 -> the only gap is 12:00-13:00 (lunch), no focus.
    const a = ev({ startMs: new Date(2026, 6, 3, 9, 0).getTime(), endMs: new Date(2026, 6, 3, 12, 0).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 13, 0).getTime(), endMs: new Date(2026, 6, 3, 18, 0).getTime() })
    const out = buildCalendarInsights([a, b])
    expect(out.some((i) => i.kind === 'focus')).toBe(false)
  })

  it('emits multiple distinct insights when several rules fire', () => {
    const a = ev({ startMs: new Date(2026, 6, 3, 11, 0).getTime(), endMs: new Date(2026, 6, 3, 11, 15).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 11, 20).getTime(), endMs: new Date(2026, 6, 3, 12, 0).getTime() })
    const c = ev({ startMs: new Date(2026, 6, 3, 16, 0).getTime(), source: 'local' })
    const out = buildCalendarInsights([a, b, c])
    const kinds = new Set(out.map((i) => i.kind))
    expect(kinds.has('conflict')).toBe(true)
    expect(kinds.has('delegable')).toBe(true)
    expect(kinds.has('focus')).toBe(true) // morning has conflict but 12:00-16:00 afternoon is free
  })
})
