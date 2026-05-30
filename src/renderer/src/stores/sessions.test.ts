import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionsStore } from './sessions'

describe('sessions store', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], selectedSessionId: null })
  })

  it('sets the session list', () => {
    useSessionsStore.getState().setSessions([
      { id: 'a', title: 'A', status: 'active', lastActiveAt: 2, taskCount: 1 },
      { id: 'b', title: null, status: 'active', lastActiveAt: 1, taskCount: 0 },
    ])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('upserts a session newest-first and updates title', () => {
    const { upsert } = useSessionsStore.getState()
    upsert({ id: 'a', title: null, status: 'active', lastActiveAt: 1, taskCount: 0 })
    upsert({ id: 'a', title: 'Renamed', status: 'active', lastActiveAt: 5, taskCount: 0 })
    const list = useSessionsStore.getState().sessions
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Renamed')
  })

  it('upsert keeps two distinct sessions sorted newest-first', () => {
    const { upsert } = useSessionsStore.getState()
    upsert({ id: 'old', title: null, status: 'active', lastActiveAt: 1, taskCount: 0 })
    upsert({ id: 'new', title: null, status: 'active', lastActiveAt: 9, taskCount: 0 })
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['new', 'old'])
  })

  it('selects a session', () => {
    useSessionsStore.getState().select('x')
    expect(useSessionsStore.getState().selectedSessionId).toBe('x')
  })
})
