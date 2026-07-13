// src/main/gmail/store.test.ts

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createStore } from './store'

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('gmail store', () => {
  it('load returns defaults when file absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.json') })
    const state = await store.load()
    expect(state.clientCreds).toBeNull()
    expect(state.tokens).toBeNull()
  })

  it('save then load round-trips with secrets', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const filePath = join(dir, 'gmail.json')
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
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const filePath = join(dir, 'gmail.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, 'not valid json')
    const store = createStore({ filePath })
    const state = await store.load()
    expect(state.clientCreds).toBeNull()
    expect(state.tokens).toBeNull()
  })
})
