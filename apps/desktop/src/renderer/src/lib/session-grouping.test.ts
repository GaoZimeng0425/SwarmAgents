import type { SessionSummary } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { flattenForReorder, groupSessionsByDirectory, UNGROUPED } from './session-grouping'

const mk = (over: Partial<SessionSummary> & { id: string }): SessionSummary => ({
  id: over.id,
  title: over.title ?? over.id,
  status: 'active',
  lastActiveAt: over.lastActiveAt ?? 0,
  taskCount: 0,
  pinned: over.pinned ?? false,
  sortOrder: over.sortOrder ?? 0,
  isSystem: over.isSystem ?? false,
  cwd: over.cwd,
})

describe('groupSessionsByDirectory', () => {
  it('groups by cwd and puts the ungrouped bucket last', () => {
    const groups = groupSessionsByDirectory(
      [
        mk({ id: 'a', cwd: '/home/proj' }),
        mk({ id: 'b' }), // no cwd
        mk({ id: 'c', cwd: '/home/proj' }),
      ],
      []
    )
    expect(groups.map((g) => g.dir)).toEqual(['/home/proj', UNGROUPED])
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['a', 'c'])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['b'])
    expect(groups[1].label).toBe('无目录')
  })

  it('excludes system sessions entirely', () => {
    const groups = groupSessionsByDirectory([mk({ id: 'sys', isSystem: true, cwd: '/x' })], [])
    expect(groups).toEqual([])
  })

  it('derives the label from the directory basename', () => {
    const groups = groupSessionsByDirectory([mk({ id: 'a', cwd: '/Users/me/Code/swarm/' })], [])
    expect(groups[0].label).toBe('swarm')
  })

  it('honors directoryOrder for known dirs, then appends unknown by recency desc', () => {
    const groups = groupSessionsByDirectory(
      [
        mk({ id: 'a', cwd: '/a', lastActiveAt: 1 }),
        mk({ id: 'b', cwd: '/b', lastActiveAt: 5 }),
        mk({ id: 'c', cwd: '/c', lastActiveAt: 9 }),
      ],
      ['/b'] // only /b is recorded
    )
    // /b first (recorded); then /c and /a unknown, by lastActiveAt desc
    expect(groups.map((g) => g.dir)).toEqual(['/b', '/c', '/a'])
  })

  it('orders sessions within a group pinned-first then sortOrder', () => {
    const groups = groupSessionsByDirectory(
      [
        mk({ id: 'a', cwd: '/p', pinned: false, sortOrder: 1 }),
        mk({ id: 'b', cwd: '/p', pinned: true, sortOrder: 5 }),
        mk({ id: 'c', cwd: '/p', pinned: false, sortOrder: 0 }),
      ],
      []
    )
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('flattenForReorder', () => {
  it('flattens groups into a single id list in display order', () => {
    const groups = groupSessionsByDirectory(
      [mk({ id: 'a', cwd: '/p' }), mk({ id: 'z' }), mk({ id: 'b', cwd: '/p', sortOrder: 1 })],
      []
    )
    expect(flattenForReorder(groups)).toEqual(['a', 'b', 'z'])
  })
})
