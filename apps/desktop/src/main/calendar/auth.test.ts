import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CALENDAR_SCOPE, createAuth, exchangeCode, extractCode, isReauthRequired, refreshTokens } from './auth'
import { createStore } from './store'

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    isEncryptionAvailable: () => true,
  },
  shell: { openExternal: () => Promise.resolve() },
}))

let dir: string
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

const creds = { clientId: 'cid', clientSecret: 'sec' }

describe('calendar auth helpers', () => {
  it('uses the calendar.readonly scope', () => {
    expect(CALENDAR_SCOPE).toBe('https://www.googleapis.com/auth/calendar.readonly')
  })

  it('extractCode pulls code from callback query', () => {
    expect(extractCode('/?code=4/0abc&scope=foo')).toBe('4/0abc')
    expect(extractCode('/?error=access_denied')).toBeNull()
  })

  it('exchangeCode posts and returns tokens', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
    } as Response)
    const r = await exchangeCode({ creds, code: 'C', redirectUri: 'http://127.0.0.1:3999' })
    expect(r).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresAt: expect.any(Number) })
    expect(r.expiresAt).toBeGreaterThan(Date.now())
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
  })

  it('refreshTokens returns refreshed accessToken', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'AT2', expires_in: 100 }),
    } as Response)
    const r = await refreshTokens({ creds, refreshToken: 'RT' })
    expect(r.accessToken).toBe('AT2')
  })

  it('refreshTokens throws with body on non-OK (e.g. invalid_grant)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    } as Response)
    await expect(refreshTokens({ creds, refreshToken: 'RT' })).rejects.toThrow(/refresh failed: 400.*invalid_grant/)
  })
})

describe('createAuth token handling', () => {
  it('getAccessToken refreshes when expired', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const store = createStore({ filePath: join(dir, 'calendar.enc') })
    await store.save({
      clientCreds: creds,
      tokens: { accessToken: 'old', refreshToken: 'RT', expiresAt: Date.now() - 1000 },
      accountEmail: 'me@x.com',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh', expires_in: 3600 }),
    } as Response)
    const auth = createAuth({ store, onProfile: async () => ({ emailAddress: 'me@x.com' }) })
    const at = await auth.getAccessToken()
    expect(at).toBe('fresh')
    const after = await store.load()
    expect(after.tokens?.accessToken).toBe('fresh')
  })

  it('clears tokens and signals reauth when refresh returns invalid_grant', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const store = createStore({ filePath: join(dir, 'calendar.enc') })
    await store.save({
      clientCreds: creds,
      tokens: { accessToken: 'old', refreshToken: 'RT', expiresAt: Date.now() - 1000 },
      accountEmail: 'me@x.com',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
    } as Response)
    const auth = createAuth({ store, onProfile: async () => ({ emailAddress: 'me@x.com' }) })
    const err = await auth.getAccessToken().catch((e) => e)
    expect(isReauthRequired(err)).toBe(true)
    // Dead tokens cleared; creds + email kept so the user can re-link.
    const after = await store.load()
    expect(after.tokens).toBeNull()
    expect(after.clientCreds).toEqual(creds)
    expect(after.accountEmail).toBe('me@x.com')
  })

  it('getAccessToken throws when not linked', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-'))
    const store = createStore({ filePath: join(dir, 'calendar.enc') })
    const auth = createAuth({ store, onProfile: async () => ({ emailAddress: '' }) })
    await expect(auth.getAccessToken()).rejects.toThrow(/not linked/i)
  })
})
