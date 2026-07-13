import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createStore } from './store'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'providers-store-'))
  path = join(dir, 'providers.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('store', () => {
  it('returns defaults when file does not exist', async () => {
    const store = createStore({ filePath: path })
    const state = await store.load()
    expect(state).toEqual({
      version: 4,
      active: null,
      providers: [],
    })
  })

  it('round-trips state through write → load', async () => {
    const store = createStore({ filePath: path })
    await store.save({
      version: 4,
      active: 'anthropic',
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          registry: 'anthropic',
          apiStyle: 'anthropic',
          apiKey: 'sk-rt',
          models: ['claude-sonnet-4-5'],
          model: 'claude-sonnet-4-5',
        },
      ],
    })
    expect(existsSync(path)).toBe(true)
    const reread = await store.load()
    expect(reread.providers.find((p) => p.id === 'anthropic')?.apiKey).toBe('sk-rt')
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
    writeFileSync(path, v1)
    const store = createStore({ filePath: path })
    const state = await store.load()
    expect(state.version).toBe(4)
    const custom = state.providers.filter((p) => !p.registry)
    expect(custom).toHaveLength(1)
    expect(custom[0].name).toBe('Custom')
    expect(state.active).toBe(custom[0].id)
  })

  it('save writes atomically via rename', async () => {
    const store = createStore({ filePath: path })
    await store.save({
      version: 4,
      active: null,
      providers: [],
    })
    // Atomic write should leave no tmp file behind.
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it('returns defaults when JSON is valid but schema fails', async () => {
    writeFileSync(path, JSON.stringify({ version: 99 }))
    const store = createStore({ filePath: path })
    const state = await store.load()
    expect(state).toEqual({
      version: 4,
      active: null,
      providers: [],
    })
    expect(existsSync(path)).toBe(true) // file preserved
  })
})
