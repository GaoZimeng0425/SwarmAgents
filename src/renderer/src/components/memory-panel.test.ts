import type { MemoryView } from '@shared/types/memory'
import { describe, expect, it } from 'vitest'

import { groupByCategory } from './memory-panel'

const entry = (over: Partial<MemoryView>): MemoryView => ({
  id: 'ns:k',
  namespace: 'ns',
  key: 'k',
  content: 'c',
  category: 'note',
  timestamp: 0,
  ...over,
})

describe('groupByCategory', () => {
  it('groups entries by category, newest-first within a group, groups sorted by label', () => {
    const groups = groupByCategory([
      entry({ id: '1', key: 'a', category: 'fact', timestamp: 1 }),
      entry({ id: '2', key: 'b', category: 'action', timestamp: 2 }),
      entry({ id: '3', key: 'c', category: 'fact', timestamp: 3 }),
    ])
    expect(groups.map((g) => g.category)).toEqual(['action', 'fact'])
    const fact = groups.find((g) => g.category === 'fact')!
    expect(fact.entries.map((e) => e.key)).toEqual(['c', 'a'])
  })

  it('returns an empty array for no entries', () => {
    expect(groupByCategory([])).toEqual([])
  })
})
