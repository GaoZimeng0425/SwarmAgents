import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WeatherConfig } from '@swarm/protocol'

// reverseGeocode's tests assert fetch/parse logic, not JWT signing (covered in
// jwt.test.ts); the test cfg carries an empty PEM, so stub the signer to keep
// these unit tests isolated from the crypto path.
vi.mock('./jwt', () => ({ signQWeatherJwt: vi.fn().mockResolvedValue('mock-token') }))

import { locateByIp, reverseGeocode } from './geo'

const cfg: WeatherConfig = {
  host: 'https://devapi.qweather.com',
  projectId: 'p', credentialId: 'c', privateKeyPem: '',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals() // vitest v4 renamed `vi.unstub()` → `unstubAllGlobals()`
})

describe('locateByIp', () => {
  it('returns lng/lat/city from ip-api.com', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({ query: '1.2.3.4', lat: 39.9, lon: 116.4, city: '北京市' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const r = await locateByIp()
    expect(r).toEqual({ lng: 116.4, lat: 39.9, city: '北京市' })
  })

  it('throws on non-200', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    await expect(locateByIp()).rejects.toThrow(/ip-api/)
  })

  it('throws on missing lat/lon', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ query: '1.2.3.4' }), { status: 200 }),
    )
    await expect(locateByIp()).rejects.toThrow()
  })
})

describe('reverseGeocode', () => {
  it('returns the first QWeather GeoAPI match name', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({ code: '200', location: [{ name: '北京市', id: '101010100' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const name = await reverseGeocode(cfg, 116.4, 39.9)
    expect(name).toBe('北京市')
  })

  it('throws on QWeather code !== 200', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ code: '404' }), { status: 200 }),
    )
    await expect(reverseGeocode(cfg, 1, 2)).rejects.toThrow(/404/)
  })
})
