import {
  appendList,
  type Context,
  deleteList,
  deleteValue,
  insertEntry,
  insertUsage,
  list,
  type NewEntry,
  setValue,
  value,
} from '@earendil-works/pi-agent-core'
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

// ─── SqliteStorage (pi 0.85 Storage contract) ────────────────────────────────

// pi message entry before the storage assigns seq/timestamp.
const piMessage = (id: string, parentId: string | null, text: string): NewEntry => ({
  type: 'message',
  id,
  parentId,
  message: { role: 'user', content: text, timestamp: 0 },
})

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

describe('SqliteStorage (pi Storage contract)', () => {
  let db: Database.Database
  let store: EntryStore
  const ctx = {} as Context

  beforeEach(() => {
    db = new Database(':memory:')
    ensureEntriesSchema(db)
    store = createEntryStore(db)
  })

  it('commit assigns a per-session global seq and back-fills the entry', async () => {
    const storage = store.forSession('s1')
    const result = await storage.commit([insertEntry(piMessage('e1', null, 'a'))], ctx)
    expect(result.firstSeq).toBe(1)
    expect(result.seqs).toEqual([1])
    expect(result.stats.messageCount).toBe(1)
    expect(result.timestamp).toBeGreaterThan(0)

    const entries = await storage.scanEntries({ order: 'asc' }, ctx)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'e1', seq: 1, parentId: null, type: 'message' })
  })

  it('seq continuity survives a reopen of the same database', async () => {
    await store.forSession('s1').commit([insertEntry(piMessage('e1', null, 'a'))], ctx)
    // A fresh instance over the same db (e.g. after an app restart) must not
    // restart the sequence.
    const reopened = store.forSession('s1')
    const result = await reopened.commit([insertEntry(piMessage('e2', 'e1', 'b'))], ctx)
    expect(result.firstSeq).toBe(2)
    const tip = await reopened.getEntries(['e2'], ctx)
    expect(tip.get('e2')?.parentId).toBe('e1')
  })

  it('scanEntries filters by type and honors order/limit', async () => {
    const storage = store.forSession('s1')
    await storage.commit(
      [
        insertEntry(piMessage('m1', null, 'a')),
        insertEntry({ type: 'custom', customType: 'plan', id: 'c1', parentId: 'm1', data: { todos: [] } }),
        insertEntry(piMessage('m2', 'c1', 'b')),
      ],
      ctx
    )
    const asc = await storage.scanEntries({ type: 'message', order: 'asc' }, ctx)
    expect(asc.map((e) => e.id)).toEqual(['m1', 'm2'])
    const desc = await storage.scanEntries({ type: 'message', order: 'desc', limit: 1 }, ctx)
    expect(desc.map((e) => e.id)).toEqual(['m2'])
  })

  it('scanBranch walks the parent chain and honors stop/order', async () => {
    const storage = store.forSession('s1')
    await storage.commit(
      [
        insertEntry(piMessage('e1', null, 'a')),
        insertEntry(piMessage('e2', 'e1', 'b')),
        insertEntry(piMessage('e3', 'e2', 'c')),
      ],
      ctx
    )
    const newestFirst = await storage.scanBranch({ start: 'e3' }, ctx)
    expect(newestFirst.map((e) => e.id)).toEqual(['e3', 'e2', 'e1'])
    const oldestFirst = await storage.scanBranch({ start: 'e3', order: 'oldestFirst' }, ctx)
    expect(oldestFirst.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    const stopped = await storage.scanBranch({ start: 'e3', order: 'oldestFirst', stopAtId: 'e2' }, ctx)
    expect(stopped.map((e) => e.id)).toEqual(['e1', 'e2'])
    await expect(storage.scanBranch({ start: 'missing' }, ctx)).rejects.toThrow('Unknown branch start')
  })

  it('values round-trip and delete removes the whole key', async () => {
    const storage = store.forSession('s1')
    const address = value<string | null>('branch', 'main')
    await storage.commit([setValue(address, 'e1')], ctx)
    const stored = await storage.getValue(address, ctx)
    expect(stored?.value).toBe('e1')
    expect(stored?.seq).toBe(1)
    expect((await storage.scanValues(value<string | null>('branch'), ctx)).map((s) => s.address.key)).toEqual(['main'])
    await storage.commit([deleteValue(address)], ctx)
    expect(await storage.getValue(address, ctx)).toBeUndefined()
  })

  it('lists append with cursor paging and delete clears the list', async () => {
    const storage = store.forSession('s1')
    const address = list<number>('inbox', 'items')
    await storage.commit([appendList(address, 1), appendList(address, 2), appendList(address, 3)], ctx)
    const all = await storage.readList(address, undefined, ctx)
    expect(all.map((e) => e.value)).toEqual([1, 2, 3])
    const paged = await storage.readList(address, { cursor: { seq: all[0].seq }, order: 'asc' }, ctx)
    expect(paged.map((e) => e.value)).toEqual([2, 3])
    const newestFirst = await storage.readList(address, { order: 'desc', limit: 1 }, ctx)
    expect(newestFirst.map((e) => e.value)).toEqual([3])
    await storage.commit([deleteList(address)], ctx)
    expect(await storage.readList(address, undefined, ctx)).toEqual([])
  })

  it('getStats sums usage rows including negative adjustments', async () => {
    const storage = store.forSession('s1')
    await storage.commit(
      [
        insertEntry(piMessage('m1', null, 'a')),
        insertUsage({ id: 'u1', usage: { ...zeroUsage, input: 10, totalTokens: 10 }, adjustment: false }),
      ],
      ctx
    )
    await storage.commit(
      [insertUsage({ id: 'u2', usage: { ...zeroUsage, input: -4, totalTokens: -4 }, adjustment: true })],
      ctx
    )
    const stats = await storage.getStats(ctx)
    expect(stats.messageCount).toBe(1)
    expect(stats.usage.input).toBe(6)
    expect(stats.usage.totalTokens).toBe(6)
  })

  it('rejects a duplicate entry id', async () => {
    const storage = store.forSession('s1')
    await storage.commit([insertEntry(piMessage('e1', null, 'a'))], ctx)
    await expect(storage.commit([insertEntry(piMessage('e1', null, 'dup'))], ctx)).rejects.toThrow()
  })
})
