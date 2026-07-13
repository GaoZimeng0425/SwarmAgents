import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
    const store = createStore({ filePath: join(dir, 'weather.json') })
    const state = await store.load()
    expect(state.weather.host).toBe('https://devapi.qweather.com')
  })

  it('round-trips a saved config through load()', async () => {
    const { createStore } = await import('./store')
    const { defaultWeatherConfigOnDisk } = await import('@swarm/protocol')
    const store = createStore({ filePath: join(dir, 'weather.json') })
    const state = {
      weather: { ...defaultWeatherConfigOnDisk().weather, projectId: 'p1', credentialId: 'c1' },
    }
    await store.save(state)
    const loaded = await store.load()
    expect(loaded.weather.projectId).toBe('p1')
  })

  it('returns defaults on unparseable file', async () => {
    const { createStore } = await import('./store')
    const { writeFile } = await import('node:fs/promises')
    const fp = join(dir, 'weather.json')
    await writeFile(fp, 'not valid json')
    const store = createStore({ filePath: fp })
    const state = await store.load()
    expect(state.weather.host).toBe('https://devapi.qweather.com')
  })
})
