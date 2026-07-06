import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// safeStorage is only available in Electron's main process. Identity mock with
// an `enc:` sentinel prefix so encrypt/decrypt round-trip in tests AND garbage
// bytes fail at decrypt (mirrors real Keychain behavior and the sibling module
// store.test.ts mocks in calendar/gmail/providers).
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

describe('weather store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weather-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads defaults when the file is missing', async () => {
    const { createStore } = await import('./store')
    const store = createStore({ filePath: join(dir, 'weather.enc') })
    const r = await store.loadOrRecover()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.state.weather.host).toBe('https://devapi.qweather.com')
  })

  it('round-trips a saved config through load()', async () => {
    const { createStore } = await import('./store')
    const { defaultWeatherConfigOnDisk } = await import('@swarm/protocol')
    const store = createStore({ filePath: join(dir, 'weather.enc') })
    const state = {
      weather: { ...defaultWeatherConfigOnDisk().weather, projectId: 'p1', credentialId: 'c1' },
    }
    await store.save(state)
    const loaded = await store.load()
    expect(loaded.weather.projectId).toBe('p1')
  })

  it('reports decrypt_failed on garbage bytes', async () => {
    const { createStore } = await import('./store')
    const { writeFile } = await import('node:fs/promises')
    const fp = join(dir, 'weather.enc')
    await writeFile(fp, Buffer.from([0x00, 0x01, 0x02]))
    const store = createStore({ filePath: fp })
    const r = await store.loadOrRecover()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('decrypt_failed')
  })
})
