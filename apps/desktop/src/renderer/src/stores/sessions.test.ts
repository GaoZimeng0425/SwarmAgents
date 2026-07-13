import type { SessionSummary } from '@swarm/protocol'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSessionsStore } from './sessions'

describe('sessions store', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], selectedSessionId: null, unread: {}, forkedFrom: {} })
  })

  it('sets the session list', () => {
    useSessionsStore.getState().setSessions([
      {
        id: 'a',
        title: 'A',
        status: 'active',
        lastActiveAt: 2,
        taskCount: 1,
        pinned: false,
        sortOrder: 0,
        isSystem: false,
      },
      {
        id: 'b',
        title: null,
        status: 'active',
        lastActiveAt: 1,
        taskCount: 0,
        pinned: false,
        sortOrder: 0,
        isSystem: false,
      },
    ])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('upserts a session newest-first and updates title', () => {
    const { upsert } = useSessionsStore.getState()
    upsert({
      id: 'a',
      title: null,
      status: 'active',
      lastActiveAt: 1,
      taskCount: 0,
      pinned: false,
      sortOrder: 0,
      isSystem: false,
    })
    upsert({
      id: 'a',
      title: 'Renamed',
      status: 'active',
      lastActiveAt: 5,
      taskCount: 0,
      pinned: false,
      sortOrder: 0,
      isSystem: false,
    })
    const list = useSessionsStore.getState().sessions
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Renamed')
  })

  it('upsert keeps two distinct sessions sorted newest-first', () => {
    const { upsert } = useSessionsStore.getState()
    upsert({
      id: 'old',
      title: null,
      status: 'active',
      lastActiveAt: 1,
      taskCount: 0,
      pinned: false,
      sortOrder: 0,
      isSystem: false,
    })
    upsert({
      id: 'new',
      title: null,
      status: 'active',
      lastActiveAt: 9,
      taskCount: 0,
      pinned: false,
      sortOrder: 0,
      isSystem: false,
    })
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['new', 'old'])
  })

  it('upserts a brand-new session above existing ones whatever their sortOrder', () => {
    // Existing sessions loaded from the DB carry their real (often negative)
    // sort_order; a freshly created session arrives via session.created with no
    // backend sortOrder. It must still float to the top.
    useSessionsStore.getState().setSessions([
      {
        id: 'a',
        title: null,
        status: 'active',
        lastActiveAt: 2,
        taskCount: 0,
        pinned: false,
        sortOrder: -1,
        isSystem: false,
      },
      {
        id: 'b',
        title: null,
        status: 'active',
        lastActiveAt: 1,
        taskCount: 0,
        pinned: false,
        sortOrder: -2,
        isSystem: false,
      },
    ])
    useSessionsStore.getState().upsert({
      id: 'new',
      title: null,
      status: 'active',
      lastActiveAt: 9,
      taskCount: 0,
      pinned: false,
      sortOrder: 0,
      isSystem: false,
    })
    expect(useSessionsStore.getState().sessions[0].id).toBe('new')
  })

  it('floats pinned sessions to the top regardless of recency', () => {
    useSessionsStore.getState().setSessions([
      {
        id: 'recent',
        title: null,
        status: 'active',
        lastActiveAt: 9,
        taskCount: 0,
        pinned: false,
        sortOrder: 0,
        isSystem: false,
      },
      {
        id: 'pinned-old',
        title: null,
        status: 'active',
        lastActiveAt: 1,
        taskCount: 0,
        pinned: true,
        sortOrder: 0,
        isSystem: false,
      },
    ])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['pinned-old', 'recent'])
  })

  it('removes a session and clears selection when it was selected', () => {
    useSessionsStore.getState().setSessions([
      {
        id: 'a',
        title: null,
        status: 'active',
        lastActiveAt: 2,
        taskCount: 0,
        pinned: false,
        sortOrder: 0,
        isSystem: false,
      },
      {
        id: 'b',
        title: null,
        status: 'active',
        lastActiveAt: 1,
        taskCount: 0,
        pinned: false,
        sortOrder: 0,
        isSystem: false,
      },
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

  it('setSessions orders by pinned then sortOrder', () => {
    const s = (id: string, sortOrder: number, pinned = false): SessionSummary => ({
      id,
      title: id,
      status: 'active',
      lastActiveAt: 0,
      taskCount: 0,
      pinned,
      sortOrder,
      isSystem: false,
    })
    useSessionsStore.getState().setSessions([s('a', 2), s('b', 0), s('c', 1, true)])
    expect(useSessionsStore.getState().sessions.map((x) => x.id)).toEqual(['c', 'b', 'a'])
  })

  it('floats the system session above everything, even pinned ones', () => {
    useSessionsStore.getState().setSessions([
      {
        id: 'pinned',
        title: null,
        status: 'active',
        lastActiveAt: 9,
        taskCount: 0,
        pinned: true,
        sortOrder: 0,
        isSystem: false,
      },
      {
        id: '__system__',
        title: '定时任务',
        status: 'active',
        lastActiveAt: 1,
        taskCount: 0,
        pinned: false,
        sortOrder: 5,
        isSystem: true,
      },
    ])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['__system__', 'pinned'])
  })

  it('reorder reassigns sortOrder by index', () => {
    const s = (id: string, sortOrder: number): SessionSummary => ({
      id,
      title: id,
      status: 'active',
      lastActiveAt: 0,
      taskCount: 0,
      pinned: false,
      sortOrder,
      isSystem: false,
    })
    useSessionsStore.getState().setSessions([s('a', 0), s('b', 1), s('c', 2)])
    useSessionsStore.getState().reorder(['c', 'a', 'b'])
    expect(useSessionsStore.getState().sessions.map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('markForked records the fork lineage keyed by the forked session', () => {
    useSessionsStore.getState().markForked('fork', 'source')
    expect(useSessionsStore.getState().forkedFrom).toEqual({ fork: 'source' })
  })

  it('markForked is idempotent for the same lineage', () => {
    const { markForked } = useSessionsStore.getState()
    markForked('fork', 'source')
    const before = useSessionsStore.getState().forkedFrom
    markForked('fork', 'source')
    // Same ref — no new object allocated when nothing changes.
    expect(useSessionsStore.getState().forkedFrom).toBe(before)
  })

  it('remove clears the forkedFrom entry for the removed fork', () => {
    useSessionsStore.getState().markForked('fork', 'source')
    useSessionsStore.getState().remove('fork')
    expect(useSessionsStore.getState().forkedFrom).toEqual({})
  })

  it('remove clears forks that pointed at the removed source', () => {
    useSessionsStore.getState().markForked('fork', 'source')
    useSessionsStore.getState().remove('source')
    expect(useSessionsStore.getState().forkedFrom).toEqual({})
  })
})
