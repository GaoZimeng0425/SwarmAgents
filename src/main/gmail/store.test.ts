// src/main/gmail/store.test.ts

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createStore } from './store'

// Identity safeStorage with an `enc:` sentinel prefix so encrypt/decrypt
// round-trip in tests AND garbage bytes fail at decrypt (mirrors real Keychain
// behavior and the providers/store.test.ts mock).
vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('decrypt failed')
      return s.slice('enc:'.length)
    },
    isEncryptionAvailable: () => true,
  },
}))

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('gmail store', () => {
  it('load returns defaults when file absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.enc') })
    const state = await store.load()
    expect(state.clientCreds).toBeNull()
    expect(state.tokens).toBeNull()
  })

  it('save then load round-trips with secrets', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const filePath = join(dir, 'gmail.enc')
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

  it('loadOrRecover reports decrypt_failed on garbage', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const filePath = join(dir, 'gmail.enc')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, Buffer.from('not-encrypted-garbage'))
    const store = createStore({ filePath })
    const r = await store.loadOrRecover()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('decrypt_failed')
  })
})
