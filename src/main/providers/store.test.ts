import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    // Identity encryption for tests so we can assert content shape.
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const s = b.toString('utf-8')
      if (!s.startsWith('enc:')) throw new Error('decrypt failed')
      return s.slice('enc:'.length)
    }),
  },
}))

import { createStore } from './store'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'providers-store-'))
  path = join(dir, 'providers.enc')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('store', () => {
  it('returns defaults when file does not exist', async () => {
    const store = createStore({ filePath: path })
    const state = await store.load()
    expect(state).toEqual({
      version: 2,
      active: null,
      builtins: { anthropic: null, openai: null },
      custom: [],
    })
  })

  it('round-trips state through write → load', async () => {
    const store = createStore({ filePath: path })
    await store.save({
      version: 2,
      active: 'anthropic',
      builtins: { anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-rt' }, openai: null },
      custom: [],
    })
    expect(existsSync(path)).toBe(true)
    const reread = await store.load()
    expect(reread.builtins.anthropic?.apiKey).toBe('sk-rt')
  })

  it('migrates a legacy v1 file on load', async () => {
    const v1 = JSON.stringify({
      version: 1,
      active: 'custom',
      providers: {
        anthropic: null,
        openai: null,
        custom: { model: 'glm-4', apiKey: 'sk-c', baseUrl: 'https://x.com/v4', apiStyle: 'openai' },
      },
    })
    writeFileSync(path, Buffer.from(`enc:${v1}`))
    const store = createStore({ filePath: path })
    const state = await store.load()
    expect(state.version).toBe(2)
    expect(state.custom).toHaveLength(1)
    expect(state.custom[0].name).toBe('Custom')
    expect(state.active).toBe(state.custom[0].id)
  })

  it('save writes atomically via rename', async () => {
    const store = createStore({ filePath: path })
    await store.save({
      version: 2,
      active: null,
      builtins: { anthropic: null, openai: null },
      custom: [],
    })
    // Atomic write should leave no tmp file behind.
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it('returns { ok: false, reason: "decrypt_failed" } on corrupt file and does NOT delete it', async () => {
    // Put garbage on disk that the identity-decrypt mock will reject.
    writeFileSync(path, Buffer.from('bogus-bytes'))
    const store = createStore({ filePath: path })
    const result = await store.loadOrRecover()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('decrypt_failed')
    }
    expect(existsSync(path)).toBe(true) // file preserved
  })

  it('returns { ok: false, reason: "schema_invalid" } when JSON is valid but schema fails', async () => {
    // Write a payload that decrypts cleanly but is the wrong shape.
    const ciphertext = Buffer.from(`enc:${JSON.stringify({ version: 99 })}`)
    writeFileSync(path, ciphertext)
    const store = createStore({ filePath: path })
    const result = await store.loadOrRecover()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('schema_invalid')
    }
    expect(existsSync(path)).toBe(true)
  })
})
