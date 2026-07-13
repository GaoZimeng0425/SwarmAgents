// src/main/calendar/store.test.ts

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createStore } from './store'

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('calendar store', () => {
  it('load returns defaults when file absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const store = createStore({ filePath: join(dir, 'calendar.json') })
    const state = await store.load()
    expect(state.clientCreds).toBeNull()
    expect(state.tokens).toBeNull()
  })

  it('save then load round-trips with secrets', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const filePath = join(dir, 'calendar.json')
    const store = createStore({ filePath })
    await store.save({
      clientCreds: { clientId: 'cid', clientSecret: 'sec' },
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 123 },
      accountEmail: 'me@x.com',
    })
    const state = await store.load()
    expect(state.clientCreds?.clientId).toBe('cid')
    expect(state.tokens?.refreshToken).toBe('rt')
    expect(state.accountEmail).toBe('me@x.com')
  })

  it('load returns defaults on unparseable file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const filePath = join(dir, 'calendar.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, 'not valid json')
    const store = createStore({ filePath })
    const state = await store.load()
    expect(state.clientCreds).toBeNull()
    expect(state.tokens).toBeNull()
  })
})
