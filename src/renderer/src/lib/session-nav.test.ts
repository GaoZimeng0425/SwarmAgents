import type { SessionSummary } from '@shared/types/ui'
import { describe, expect, it } from 'vitest'

import { pickNextSession } from './session-nav'

const s = (id: string, lastActiveAt: number): SessionSummary => ({
  id,
  title: id,
  status: 'active',
  lastActiveAt,
  taskCount: 0,
  pinned: false,
})

describe('pickNextSession', () => {
  it('returns the most recently active remaining session', () => {
    expect(pickNextSession([s('a', 100), s('b', 300), s('c', 200)], 'b')).toBe('c')
  })

  it('ignores the deleted session even if it was the most recent', () => {
    expect(pickNextSession([s('a', 100), s('b', 300)], 'b')).toBe('a')
  })

  it('returns null when no sessions remain', () => {
    expect(pickNextSession([s('a', 100)], 'a')).toBeNull()
  })
})
