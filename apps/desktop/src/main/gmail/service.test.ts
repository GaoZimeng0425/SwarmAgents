// src/main/gmail/service.test.ts

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCache } from './cache'
import { createService } from './service'
import { createStore } from './store'

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
}))

let dir: string
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

function fakeAuth(overrides: Partial<{ login: () => Promise<void>; logout: () => Promise<void> }> = {}) {
  const noop = async (): Promise<void> => {}
  return {
    login: overrides.login ?? noop,
    logout: overrides.logout ?? noop,
    getAccessToken: async () => 'AT',
    refreshAccessToken: async () => {},
  }
}

function fakeApi(overrides: Partial<{ markThreadRead: (id: string) => Promise<void> }> = {}) {
  return {
    getProfile: async () => ({ emailAddress: 'me@x', historyId: '1' }),
    getHistory: async () => ({
      expired: false as const,
      changedThreadIds: [],
      readThreadIds: [],
      unreadThreadIds: [],
      newHistoryId: '1',
    }),
    listThreads: async () => ({ threadIds: [], nextPageToken: null }),
    getInboxTotal: async () => 0,
    fetchThread: async () => ({
      thread: { id: '', snippet: '', fromAddr: '', subject: '', lastDateMs: 0, labelIds: [], unread: false },
      messages: [],
    }),
    markThreadRead: overrides.markThreadRead ?? (async () => {}),
  }
}

describe('gmail service', () => {
  it('setClientCreds persists and updates view', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.json') })
    const cache = createCache({ filePath: ':memory:' })
    const daemon = { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn(), getPage: vi.fn(), onSynced: () => () => {} }
    const svc = await createService({ store, cache, auth: fakeAuth(), daemon, api: fakeApi() })
    const r = await svc.setClientCreds({ clientId: 'cid', clientSecret: 'sec' })
    expect(r.ok).toBe(true)
    expect(svc.getView().hasClientCreds).toBe(true)
    expect(svc.getView().loggedIn).toBe(false)
    cache.close()
  })

  it('linkAccount starts daemon; unlink stops it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.json') })
    await store.save({ clientCreds: { clientId: 'cid', clientSecret: 'sec' }, tokens: null, accountEmail: null })
    const cache = createCache({ filePath: ':memory:' })
    const daemon = { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn(), getPage: vi.fn(), onSynced: () => () => {} }
    const auth = fakeAuth({ login: async () => {} })
    const svc = await createService({ store, cache, auth, daemon, api: fakeApi() })
    await svc.linkAccount()
    expect(daemon.start).toHaveBeenCalledTimes(1)
    await svc.unlinkAccount()
    expect(daemon.stop).toHaveBeenCalledTimes(1)
    cache.close()
  })

  it('query methods read cache', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.json') })
    const cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      { id: 't1', snippet: 'invoice', fromAddr: '', subject: '', lastDateMs: 1, labelIds: ['INBOX'], unread: false },
    ])
    const svc = await createService({
      store,
      cache,
      auth: fakeAuth(),
      daemon: { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn(), getPage: vi.fn(), onSynced: () => () => {} },
      api: fakeApi(),
    })
    expect(svc.search('invoice', 10).map((t) => t.id)).toEqual(['t1'])
    expect(svc.getThread('t1')?.thread.id).toBe('t1')
    expect(svc.listRecent({ limit: 5 }).map((t) => t.id)).toEqual(['t1'])
    cache.close()
  })

  it('markThreadRead flips the cache unread flag and calls the Gmail API', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.json') })
    const cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      { id: 't1', snippet: '', fromAddr: '', subject: '', lastDateMs: 1, labelIds: ['INBOX', 'UNREAD'], unread: true },
    ])
    const markThreadRead = vi.fn().mockResolvedValue(undefined)
    const svc = await createService({
      store,
      cache,
      auth: fakeAuth(),
      daemon: { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn(), getPage: vi.fn(), onSynced: () => () => {} },
      api: fakeApi({ markThreadRead }),
    })
    expect(svc.getThread('t1')?.thread.unread).toBe(true)
    await svc.markThreadRead('t1')
    expect(markThreadRead).toHaveBeenCalledWith('t1')
    expect(svc.getThread('t1')?.thread.unread).toBe(false)
    cache.close()
  })
})
