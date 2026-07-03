// src/main/gmail/cache.test.ts
import { afterEach, describe, expect, it } from 'vitest'

import { type Cache, createCache } from './cache'

let cache: Cache
afterEach(() => cache?.close())

describe('gmail cache', () => {
  it('upsert + search by substring (case-insensitive)', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      {
        id: 't1',
        snippet: 'invoice attached',
        fromAddr: 'acme@x.com',
        subject: 'Invoice 42',
        lastDateMs: 10,
        labelIds: ['INBOX'],
        unread: true,
      },
      {
        id: 't2',
        snippet: 'lunch?',
        fromAddr: 'bob@x.com',
        subject: 'Lunch',
        lastDateMs: 20,
        labelIds: ['INBOX'],
        unread: false,
      },
    ])
    const hits = cache.search('INVOICE', 10)
    expect(hits.map((t) => t.id)).toEqual(['t1'])
  })

  it('getThread returns thread + messages', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      { id: 't1', snippet: 's', fromAddr: 'a@x.com', subject: 'S', lastDateMs: 1, labelIds: ['INBOX'], unread: false },
    ])
    cache.upsertMessages([
      {
        id: 'm1',
        threadId: 't1',
        fromAddr: 'a@x.com',
        toAddrs: [],
        subject: 'S',
        snippet: 'sn',
        bodyText: 'hello',
        htmlBody: '',
        dateMs: 1,
        labelIds: ['INBOX'],
      },
    ])
    const t = cache.getThread('t1')
    expect(t?.thread.id).toBe('t1')
    expect(t?.messages[0].bodyText).toBe('hello')
    expect(cache.getThread('nope')).toBeNull()
  })

  it('listRecent orders by date desc and filters by label', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      { id: 't1', snippet: '', fromAddr: '', subject: '', lastDateMs: 5, labelIds: ['INBOX'], unread: false },
      { id: 't2', snippet: '', fromAddr: '', subject: '', lastDateMs: 50, labelIds: ['INBOX'], unread: false },
      { id: 't3', snippet: '', fromAddr: '', subject: '', lastDateMs: 999, labelIds: ['SENT'], unread: false },
    ])
    const recent = cache.listRecent({ limit: 10, label: 'INBOX' })
    expect(recent.map((t) => t.id)).toEqual(['t2', 't1'])
  })

  it('upsert is idempotent and updates fields', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      { id: 't1', snippet: 'old', fromAddr: '', subject: '', lastDateMs: 1, labelIds: ['INBOX'], unread: true },
    ])
    cache.upsertThreads([
      { id: 't1', snippet: 'new', fromAddr: '', subject: '', lastDateMs: 1, labelIds: ['INBOX'], unread: false },
    ])
    const t = cache.getThread('t1')
    expect(t?.thread.snippet).toBe('new')
    expect(t?.thread.unread).toBe(false)
  })

  it('stats round-trips', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.setStats({ messageCount: 7, lastSyncAt: 123 })
    expect(cache.stats()).toEqual({ messageCount: 7, lastSyncAt: 123 })
  })
})

describe('analyses cache', () => {
  it('round-trips an analysis keyed by message id', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      { id: 't1', snippet: '', fromAddr: '', subject: '', lastDateMs: 1, labelIds: [], unread: false },
    ])
    cache.upsertMessages([
      {
        id: 'm1',
        threadId: 't1',
        fromAddr: '',
        toAddrs: [],
        subject: '',
        snippet: '',
        bodyText: '',
        htmlBody: '',
        dateMs: 1,
        labelIds: [],
      },
    ])
    cache.saveAnalysis('m1', '## 摘要\nhi')
    const map = cache.getAnalyses('t1')
    expect(map.m1.analysis).toBe('## 摘要\nhi')
    expect(map.m1.updatedAt).toBeGreaterThan(0)
  })

  it('overwrites on re-analyze and only returns the thread’s messages', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      { id: 't1', snippet: '', fromAddr: '', subject: '', lastDateMs: 1, labelIds: [], unread: false },
      { id: 't2', snippet: '', fromAddr: '', subject: '', lastDateMs: 1, labelIds: [], unread: false },
    ])
    cache.upsertMessages([
      {
        id: 'm1',
        threadId: 't1',
        fromAddr: '',
        toAddrs: [],
        subject: '',
        snippet: '',
        bodyText: '',
        htmlBody: '',
        dateMs: 1,
        labelIds: [],
      },
      {
        id: 'm2',
        threadId: 't2',
        fromAddr: '',
        toAddrs: [],
        subject: '',
        snippet: '',
        bodyText: '',
        htmlBody: '',
        dateMs: 1,
        labelIds: [],
      },
    ])
    cache.saveAnalysis('m1', 'old')
    cache.saveAnalysis('m1', 'new')
    cache.saveAnalysis('m2', 'other thread')
    expect(cache.getAnalyses('t1').m1.analysis).toBe('new')
    expect(cache.getAnalyses('t1').m2).toBeUndefined()
  })
})
