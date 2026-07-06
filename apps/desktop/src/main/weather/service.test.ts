import { defaultWeatherConfigOnDisk } from '@swarm/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Store } from './store'

// qweather + geo are mocked at the top level (vitest v4 hoists `vi.mock` to
// module-eval time and `await import` is cached, so per-test inline mocks can't
// rewire an already-evaluated `./service`). The mock fns are re-seeded per test
// via vi.resetAllMocks() in beforeEach.
vi.mock('./qweather', () => ({
  fetchHourly: vi.fn(),
  fetchWarnings: vi.fn(),
  fetchIndices: vi.fn(),
  fetchAir: vi.fn(),
  fetchMinutely: vi.fn(),
}))
vi.mock('./geo', () => ({ locateByIp: vi.fn(), reverseGeocode: vi.fn(), geocodeCity: vi.fn() }))

import { geocodeCity, locateByIp, reverseGeocode } from './geo'
import { fetchAir, fetchHourly, fetchIndices, fetchMinutely, fetchWarnings } from './qweather'
import { createService } from './service'

// vi.mocked() narrows the imported (real-typed) functions to their Mock type so
// .mockResolvedValue / .mockImplementation typecheck against the real signature.
const fetchHourlyMock = vi.mocked(fetchHourly)
const fetchWarningsMock = vi.mocked(fetchWarnings)
const fetchIndicesMock = vi.mocked(fetchIndices)
const fetchAirMock = vi.mocked(fetchAir)
const fetchMinutelyMock = vi.mocked(fetchMinutely)
const locateByIpMock = vi.mocked(locateByIp)
const reverseGeocodeMock = vi.mocked(reverseGeocode)
const geocodeCityMock = vi.mocked(geocodeCity)

// Supplementary fetchers default to empty/null so getForecast resolves; tests
// that assert on them override per-case. Re-seeded after resetAllMocks().
function seedSupplementary(): void {
  fetchWarningsMock.mockResolvedValue([])
  fetchIndicesMock.mockResolvedValue([])
  fetchAirMock.mockResolvedValue(null)
  fetchMinutelyMock.mockResolvedValue(null)
}

// In-memory store; the on-disk store is covered by store.test.ts.
function memStore(
  initial: Store['load'] extends () => Promise<infer S> ? S : never = defaultWeatherConfigOnDisk()
): Store {
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
    location: '',
  },
}

describe('weather service', () => {
  beforeEach(() => {
    // Fully reset the mock fns (calls, results, and the mockResolvedValueOnce
    // queue) so each test starts from a clean slate. vitest v4: the old
    // `vi.unstub()` was renamed `vi.unstubAllGlobals()`; we don't stub globals
    // here, so resetAllMocks is the only reset we need.
    vi.resetAllMocks()
    seedSupplementary()
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

  it('keeps the stored key when setConfig sends an empty PEM (partial edit)', async () => {
    const svc = await createService({ store: memStore(validCfg as never) })
    // Simulate the renderer saving a host change with a blank PEM textarea.
    const r = await svc.setConfig({ ...validCfg.weather, host: 'https://api.qweather.com', privateKeyPem: '' })
    expect(r.ok).toBe(true)
    // Forecast still works, proving the stored key was preserved (signable).
    fetchHourlyMock.mockResolvedValue({
      location: 'x',
      lng: 1,
      lat: 2,
      source: 'ip',
      fetchedAt: Date.now(),
      hours: [],
      warnings: [],
      indices: [],
      air: null,
      minutely: null,
      now: null,
    })
    locateByIpMock.mockResolvedValue({ lng: 1, lat: 2, city: 'x' })
    await expect(svc.getForecast(null, null)).resolves.toBeDefined()
    expect(svc.getConfig().host).toBe('https://api.qweather.com')
  })

  it('rejects a first-time save with an empty PEM (no stored key to keep)', async () => {
    const svc = await createService({ store: memStore() })
    const r = await svc.setConfig({ ...validCfg.weather, privateKeyPem: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid')
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
    fetchHourlyMock.mockResolvedValue({
      location: '北京市',
      lng: 116.4,
      lat: 39.9,
      source: 'gps',
      fetchedAt: Date.now(),
      hours: [],
      warnings: [],
      indices: [],
      air: null,
      minutely: null,
      now: null,
    })
    locateByIpMock.mockResolvedValue({ lng: 116.4, lat: 39.9, city: '北京市' })
    reverseGeocodeMock.mockResolvedValue('北京市')
    const svc = await createService({ store: memStore(validCfg as never) })
    const a = await svc.getForecast(null, null)
    const b = await svc.getForecast(null, null)
    expect(a).toBe(b) // same object reference → cache hit
    expect(fetchHourlyMock).toHaveBeenCalledTimes(1)
  })

  it('prefers the custom location over GPS + IP (source=custom)', async () => {
    geocodeCityMock.mockResolvedValue({ lng: 116.41, lat: 39.9, name: '北京市' })
    fetchHourlyMock.mockImplementation(async (opts) => ({
      location: opts.locationLabel,
      lng: opts.lng,
      lat: opts.lat,
      source: opts.source,
      fetchedAt: Date.now(),
      hours: [],
      warnings: [],
      indices: [],
      air: null,
      minutely: null,
      now: null,
    }))
    const svc = await createService({
      store: memStore({ weather: { ...validCfg.weather, location: '北京' } } as never),
    })
    // Pass GPS coords too: the custom location must still win.
    const f = await svc.getForecast(121.4, 31.2)
    expect(geocodeCityMock).toHaveBeenCalledWith(expect.objectContaining({ location: '北京' }), '北京')
    expect(locateByIpMock).not.toHaveBeenCalled()
    expect(f.source).toBe('custom')
    expect(f.location).toBe('北京市')
    expect([f.lng, f.lat]).toEqual([116.41, 39.9])
  })

  it('surfaces a geocode failure when the custom location is unresolvable', async () => {
    geocodeCityMock.mockRejectedValue(new Error('QWeather GeoAPI code 404'))
    const svc = await createService({
      store: memStore({ weather: { ...validCfg.weather, location: 'Nowhereville' } } as never),
    })
    await expect(svc.getForecast(null, null)).rejects.toThrow(/GeoAPI/)
  })

  it('merges warnings/indices/air/minutely into the forecast', async () => {
    fetchHourlyMock.mockResolvedValue({
      location: '北京市',
      lng: 116.4,
      lat: 39.9,
      source: 'ip',
      fetchedAt: Date.now(),
      hours: [],
      warnings: [],
      indices: [],
      air: null,
      minutely: null,
      now: null,
    })
    fetchWarningsMock.mockResolvedValue([
      {
        id: '1',
        title: 't',
        typeName: '冰雹',
        level: '黄色',
        severityColor: 'Yellow',
        text: 'x',
        pubTime: '',
        startTime: '',
        endTime: '',
        status: 'active',
      },
    ])
    fetchIndicesMock.mockResolvedValue([{ type: '1', name: '运动指数', level: '3', category: '较不宜', text: 'x' }])
    fetchAirMock.mockResolvedValue({
      aqi: 99,
      category: '良',
      primary: 'O3',
      pm2p5: 18,
      pm10: 31,
      no2: 11,
      so2: 3,
      co: 0.4,
      o3: 199,
      pubTime: '',
    })
    fetchMinutelyMock.mockResolvedValue({ summary: '80分钟后雨就停了', points: [] })
    locateByIpMock.mockResolvedValue({ lng: 116.4, lat: 39.9, city: '北京市' })
    const svc = await createService({ store: memStore(validCfg as never) })
    const f = await svc.getForecast(null, null)
    expect(f.warnings).toHaveLength(1)
    expect(f.indices[0]?.name).toBe('运动指数')
    expect(f.air?.aqi).toBe(99)
    expect(f.minutely?.summary).toBe('80分钟后雨就停了')
  })

  it('still returns the forecast when a supplementary fetch fails (graceful degrade)', async () => {
    fetchHourlyMock.mockResolvedValue({
      location: 'x',
      lng: 1,
      lat: 2,
      source: 'ip',
      fetchedAt: Date.now(),
      hours: [],
      warnings: [],
      indices: [],
      air: null,
      minutely: null,
      now: null,
    })
    fetchAirMock.mockRejectedValue(new Error('QWeather HTTP 402'))
    fetchMinutelyMock.mockRejectedValue(new Error('QWeather code 404')) // China-only endpoint elsewhere
    locateByIpMock.mockResolvedValue({ lng: 1, lat: 2, city: 'x' })
    const svc = await createService({ store: memStore(validCfg as never) })
    const f = await svc.getForecast(null, null)
    expect(f.air).toBeNull()
    expect(f.minutely).toBeNull()
    expect(f.location).toBe('x') // core forecast still returned
  })

  it('treats a different rounded coordinate as a cache miss', async () => {
    let calls = 0
    fetchHourlyMock.mockImplementation(async () => {
      calls += 1
      return {
        location: 'x',
        lng: 1,
        lat: 2,
        source: 'gps',
        fetchedAt: Date.now(),
        hours: [],
        warnings: [],
        indices: [],
        air: null,
        minutely: null,
        now: null,
      }
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
