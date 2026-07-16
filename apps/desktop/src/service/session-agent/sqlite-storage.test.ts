import type { SessionStorage, SessionTreeEntry } from '@earendil-works/pi-agent-core'
import type { SessionEntry } from '@swarm/protocol'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { createEntryStore, type EntryStore, ensureEntriesSchema } from './sqlite-storage'

const userEntry = (id: string, parentId: string | null, text: string): SessionEntry => ({
  type: 'message',
  id,
  parentId,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: text },
})

describe('EntryStore', () => {
  let store: EntryStore
  beforeEach(() => {
    const db = new Database(':memory:')
    ensureEntriesSchema(db)
    store = createEntryStore(db)
  })

  it('append returns a monotonically increasing rowId', () => {
    const a = store.append('s1', userEntry('e1', null, 'a'))
    const b = store.append('s1', userEntry('e2', 'e1', 'b'))
    expect(b).toBeGreaterThan(a)
  })

  it('list is ordered by rowId and respects the afterRowId cursor', () => {
    const a = store.append('s1', userEntry('e1', null, 'a'))
    store.append('s2', userEntry('x1', null, 'other session'))
    store.append('s1', userEntry('e2', 'e1', 'b'))
    const all = store.list('s1')
    expect(all.map((r) => r.entry.id)).toEqual(['e1', 'e2'])
    const tail = store.list('s1', a)
    expect(tail.map((r) => r.entry.id)).toEqual(['e2'])
  })

  it('copyUpTo forks full-fidelity history into a new session', () => {
    const a = store.append('s1', userEntry('e1', null, 'a'))
    store.append('s1', userEntry('e2', 'e1', 'b'))
    store.copyUpTo('s1', 's3', a)
    expect(store.list('s3').map((r) => r.entry.id)).toEqual(['e1'])
  })

  it('rejects entries that fail schema validation', () => {
    expect(() => store.append('s1', { type: 'nope' } as unknown as SessionEntry)).toThrow()
  })
})

describe('SqliteSessionStorage (pi SessionStorage contract)', () => {
  it('implements the pi interface and round-trips entries', async () => {
    const db = new Database(':memory:')
    ensureEntriesSchema(db)
    const store = createEntryStore(db)
    // Type-level pin: our storage satisfies pi 0.80.6 SessionStorage, and our
    // wire SessionEntry is assignable to pi's SessionTreeEntry.
    const storage: SessionStorage = store.forSession('s1')
    const Pin: SessionTreeEntry = userEntry('t', null, 'x') as SessionTreeEntry
    void Pin
    const id = await storage.createEntryId()
    await storage.appendEntry({
      type: 'message',
      id,
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'hi' },
    } as SessionTreeEntry)
    expect((await storage.getEntries()).map((e) => e.id)).toEqual([id])
    expect(await storage.getLeafId()).toBe(id)
    expect((await storage.getPathToRoot(id)).length).toBe(1)
    expect((await storage.findEntries('message')).length).toBe(1)
    expect(await storage.getEntry(id)).toBeDefined()
    expect((await storage.getMetadata()).id).toBe('s1')
  })
})
