import { describe, expect, it } from 'vitest'

import { createSeqCounter } from './seq-counter'

describe('createSeqCounter', () => {
  it('counts from 1 for a fresh session', () => {
    const c = createSeqCounter(() => [])
    expect(c.nextSeq('s')).toBe(1)
    expect(c.nextSeq('s')).toBe(2)
  })

  it('resumes past the persisted max after a restart', () => {
    // "Restart": a brand-new counter over the same persisted history (seqs 5, 9).
    const c = createSeqCounter(() => [{ seq: 5 }, { seq: 9 }])
    expect(c.nextSeq('s')).toBe(10)
  })

  it('counters are independent per session', () => {
    const c = createSeqCounter(() => [])
    expect(c.nextSeq('a')).toBe(1)
    expect(c.nextSeq('b')).toBe(1)
    expect(c.nextSeq('a')).toBe(2)
  })

  it('ignores legacy events without seq when initing', () => {
    const c = createSeqCounter(() => [{ seq: 7 }])
    expect(c.nextSeq('s')).toBe(8)
  })
})
