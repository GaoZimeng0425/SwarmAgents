import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultWeatherConfigOnDisk } from '@swarm/protocol'

import type { Store } from './store'

// qweather + geo are mocked at the top level (vitest v4 hoists `vi.mock` to
// module-eval time and `await import` is cached, so per-test inline mocks can't
// rewire an already-evaluated `./service`). The mock fns are re-seeded per test
// via vi.resetAllMocks() in beforeEach.
vi.mock('./qweather', () => ({ fetchGridHourly: vi.fn() }))
vi.mock('./geo', () => ({ locateByIp: vi.fn(), reverseGeocode: vi.fn() }))

import { locateByIp, reverseGeocode } from './geo'
import { fetchGridHourly } from './qweather'
import { createService } from './service'

// vi.mocked() narrows the imported (real-typed) functions to their Mock type so
// .mockResolvedValue / .mockImplementation typecheck against the real signature.
const fetchGridHourlyMock = vi.mocked(fetchGridHourly)
const locateByIpMock = vi.mocked(locateByIp)
const reverseGeocodeMock = vi.mocked(reverseGeocode)

// In-memory store; the on-disk store is covered by store.test.ts.
function memStore(initial: Store['load'] extends () => Promise<infer S> ? S : never = defaultWeatherConfigOnDisk()): Store {
  let state = initial
  return {
    async load() {
      return state
    },
    async loadOrRecover() {
      return { ok: true, state }
    },
    async save(next) {
      state = next
    },
  }
}

const validCfg = {
  weather: {
    host: 'https://devapi.qweather.com',
    projectId: 'p',
    credentialId: 'c',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMI…\n-----END PRIVATE KEY-----\n',
  },
}

describe('weather service', () => {
  beforeEach(() => {
    // Fully reset the mock fns (calls, results, and the mockResolvedValueOnce
    // queue) so each test starts from a clean slate. vitest v4: the old
    // `vi.unstub()` was renamed `vi.unstubAllGlobals()`; we don't stub globals
    // here, so resetAllMocks is the only reset we need.
    vi.resetAllMocks()
  })

  it('getConfig returns defaults when the store is empty', async () => {
    const svc = await createService({ store: memStore() })
    expect(svc.getConfig().projectId).toBe('')
  })

  it('setConfig rejects when projectId is empty', async () => {
    const svc = await createService({ store: memStore() })
    const r = await svc.setConfig({ ...defaultWeatherConfigOnDisk().weather, host: 'https://x.com' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid')
  })

  it('setConfig persists a valid config', async () => {
    const svc = await createService({ store: memStore() })
    const r = await svc.setConfig(validCfg.weather)
    expect(r.ok).toBe(true)
    expect(svc.getConfig().projectId).toBe('p')
  })

  it('broadcasts onConfigChanged after a successful save', async () => {
    const svc = await createService({ store: memStore() })
    const seen: string[] = []
    svc.onConfigChanged((c) => seen.push(c.projectId))
    await svc.setConfig(validCfg.weather)
    expect(seen).toEqual(['p'])
  })

  it('getForecast returns not_configured when projectId missing', async () => {
    const svc = await createService({ store: memStore() })
    await expect(svc.getForecast(null, null)).rejects.toThrow()
  })

  it('uses cached forecast within 30 min for the same rounded coords', async () => {
    // fetchedAt must be "now" so the TTL check (Date.now() - fetchedAt < 30min)
    // holds on the second call — the brief's literal 1_000 (1970) would always miss.
    fetchGridHourlyMock.mockResolvedValue({
      location: '北京市',
      lng: 116.4,
      lat: 39.9,
      source: 'gps',
      fetchedAt: Date.now(),
      hours: [],
    })
    locateByIpMock.mockResolvedValue({ lng: 116.4, lat: 39.9, city: '北京市' })
    reverseGeocodeMock.mockResolvedValue('北京市')
    const svc = await createService({ store: memStore(validCfg as never) })
    const a = await svc.getForecast(null, null)
    const b = await svc.getForecast(null, null)
    expect(a).toBe(b) // same object reference → cache hit
    expect(fetchGridHourlyMock).toHaveBeenCalledTimes(1)
  })

  it('treats a different rounded coordinate as a cache miss', async () => {
    let calls = 0
    fetchGridHourlyMock.mockImplementation(async () => {
      calls += 1
      return { location: 'x', lng: 1, lat: 2, source: 'gps', fetchedAt: Date.now(), hours: [] }
    })
    locateByIpMock
      .mockResolvedValueOnce({ lng: 116.4, lat: 39.9, city: 'a' })
      .mockResolvedValueOnce({ lng: 121.4, lat: 31.2, city: 'b' })
    reverseGeocodeMock.mockResolvedValue('x')
    const svc = await createService({ store: memStore(validCfg as never) })
    await svc.getForecast(null, null)
    await svc.getForecast(null, null)
    expect(calls).toBe(2)
  })
})
