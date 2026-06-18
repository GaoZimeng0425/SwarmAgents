import { beforeEach, describe, expect, it } from 'vitest'

import { useSessionsStore } from './sessions'

describe('sessions store', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], selectedSessionId: null, unread: {} })
  })

  it('sets the session list', () => {
    useSessionsStore.getState().setSessions([
      { id: 'a', title: 'A', status: 'active', lastActiveAt: 2, taskCount: 1, pinned: false, sortOrder: 0 },
      { id: 'b', title: null, status: 'active', lastActiveAt: 1, taskCount: 0, pinned: false, sortOrder: 0 },
    ])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('upserts a session newest-first and updates title', () => {
    const { upsert } = useSessionsStore.getState()
    upsert({ id: 'a', title: null, status: 'active', lastActiveAt: 1, taskCount: 0, pinned: false, sortOrder: 0 })
    upsert({ id: 'a', title: 'Renamed', status: 'active', lastActiveAt: 5, taskCount: 0, pinned: false, sortOrder: 0 })
    const list = useSessionsStore.getState().sessions
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Renamed')
  })

  it('upsert keeps two distinct sessions sorted newest-first', () => {
    const { upsert } = useSessionsStore.getState()
    upsert({ id: 'old', title: null, status: 'active', lastActiveAt: 1, taskCount: 0, pinned: false, sortOrder: 0 })
    upsert({ id: 'new', title: null, status: 'active', lastActiveAt: 9, taskCount: 0, pinned: false, sortOrder: 0 })
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['new', 'old'])
  })

  it('floats pinned sessions to the top regardless of recency', () => {
    useSessionsStore.getState().setSessions([
      { id: 'recent', title: null, status: 'active', lastActiveAt: 9, taskCount: 0, pinned: false, sortOrder: 0 },
      { id: 'pinned-old', title: null, status: 'active', lastActiveAt: 1, taskCount: 0, pinned: true, sortOrder: 0 },
    ])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['pinned-old', 'recent'])
  })

  it('removes a session and clears selection when it was selected', () => {
    useSessionsStore.getState().setSessions([
      { id: 'a', title: null, status: 'active', lastActiveAt: 2, taskCount: 0, pinned: false, sortOrder: 0 },
      { id: 'b', title: null, status: 'active', lastActiveAt: 1, taskCount: 0, pinned: false, sortOrder: 0 },
    ])
    useSessionsStore.getState().select('a')
    useSessionsStore.getState().remove('a')
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['b'])
    expect(useSessionsStore.getState().selectedSessionId).toBeNull()
  })

  it('selects a session', () => {
    useSessionsStore.getState().select('x')
    expect(useSessionsStore.getState().selectedSessionId).toBe('x')
  })

  it('marks a background session unread', () => {
    useSessionsStore.getState().select('a')
    useSessionsStore.getState().markUnread('b')
    expect(useSessionsStore.getState().unread).toEqual({ b: true })
  })

  it('does not mark the currently selected session unread', () => {
    useSessionsStore.getState().select('a')
    useSessionsStore.getState().markUnread('a')
    expect(useSessionsStore.getState().unread).toEqual({})
  })

  it('clears unread when the session is selected', () => {
    useSessionsStore.getState().markUnread('b')
    expect(useSessionsStore.getState().unread).toEqual({ b: true })
    useSessionsStore.getState().select('b')
    expect(useSessionsStore.getState().unread).toEqual({})
  })

  it('clears unread when the session is removed', () => {
    useSessionsStore.getState().markUnread('b')
    useSessionsStore.getState().remove('b')
    expect(useSessionsStore.getState().unread).toEqual({})
  })
})
