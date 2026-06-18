import { describe, expect, test } from 'vitest'

import { occurrencesInRange } from './cron-occurrences'

describe('occurrencesInRange', () => {
  test('daily 9am expands to one run per day', () => {
    const from = new Date('2026-06-01T00:00:00')
    const to = new Date('2026-06-07T23:59:59')
    const runs = occurrencesInRange('0 9 * * *', from, to)
    expect(runs).toHaveLength(7)
    expect(runs[0].getHours()).toBe(9)
  })

  test('invalid expression returns empty array', () => {
    expect(occurrencesInRange('not a cron', new Date(), new Date())).toEqual([])
  })

  test('empty range returns empty array', () => {
    const d = new Date('2026-06-01T00:00:00')
    expect(occurrencesInRange('0 9 * * *', new Date('2026-06-01T10:00:00'), d)).toEqual([])
  })
})
