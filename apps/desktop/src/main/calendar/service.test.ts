// src/main/calendar/service.test.ts

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCache } from './cache'
import { createService } from './service'
import { createStore } from './store'

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    isEncryptionAvailable: () => true,
  },
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

const fakeDaemon = () => ({
  start: vi.fn(),
  stop: vi.fn(),
  pollOnce: vi.fn(),
  onSynced: () => () => {},
})

describe('calendar service', () => {
  it('setClientCreds persists and updates view', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const store = createStore({ filePath: join(dir, 'calendar.enc') })
    const cache = createCache({ filePath: ':memory:' })
    const svc = await createService({ store, cache, auth: fakeAuth(), daemon: fakeDaemon() })
    const r = await svc.setClientCreds({ clientId: 'cid', clientSecret: 'sec' })
    expect(r.ok).toBe(true)
    expect(svc.getView().hasClientCreds).toBe(true)
    expect(svc.getView().loggedIn).toBe(false)
    cache.close()
  })

  it('linkAccount rejects without creds; starts daemon when present', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const store = createStore({ filePath: join(dir, 'calendar.enc') })
    const daemon = fakeDaemon()
    const svc = await createService({ store, cache: createCache({ filePath: ':memory:' }), auth: fakeAuth(), daemon })
    const r = await svc.linkAccount()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_linked')

    await svc.setClientCreds({ clientId: 'cid', clientSecret: 'sec' })
    await svc.linkAccount()
    expect(daemon.start).toHaveBeenCalledTimes(1)
  })

  it('createLocal then listInRange returns it; getView counts it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const store = createStore({ filePath: join(dir, 'calendar.enc') })
    const cache = createCache({ filePath: ':memory:' })
    const svc = await createService({ store, cache, auth: fakeAuth(), daemon: fakeDaemon() })
    const created = svc.createLocal({ title: 'M', startMs: 100, endMs: 200 })
    expect(svc.listInRange(0, 1000).map((e) => e.id)).toContain(created.id)
    expect(svc.getView().localEventCount).toBe(1)
    // state-change broadcast fires on local CRUD
    const cb = vi.fn()
    svc.onStateChanged(cb)
    svc.createLocal({ title: 'M2', startMs: 10, endMs: 20 })
    expect(cb).toHaveBeenCalled()
    cache.close()
  })

  it('deleteLocal removes the event', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const store = createStore({ filePath: join(dir, 'calendar.enc') })
    const cache = createCache({ filePath: ':memory:' })
    const svc = await createService({ store, cache, auth: fakeAuth(), daemon: fakeDaemon() })
    const created = svc.createLocal({ title: 'M', startMs: 1, endMs: 2 })
    expect(svc.deleteLocal(created.id)).toBe(true)
    expect(svc.getEvent(created.id)).toBeNull()
    // count is 0 -> view reports null (mirrors gmail's `count || null` -> "—")
    expect(svc.getView().localEventCount).toBeNull()
    cache.close()
  })
})
