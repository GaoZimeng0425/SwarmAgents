import { describe, expect, it } from 'vitest'

import {
  defaultWeatherConfig,
  defaultWeatherConfigOnDisk,
  WeatherConfig,
  WeatherConfigOnDisk,
  WeatherForecast,
  WeatherHour,
} from './weather'

describe('WeatherConfig', () => {
  it('uses defaults for an empty object', () => {
    const c = WeatherConfig.parse({})
    expect(c).toEqual({
      host: 'https://devapi.qweather.com',
      projectId: '',
      credentialId: '',
      privateKeyPem: '',
      location: '',
    })
  })

  it('accepts a fully populated config', () => {
    const c = WeatherConfig.parse({
      host: 'https://api.qweather.com',
      projectId: 'proj_123',
      credentialId: 'cred_456',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\nfoo\n-----END PRIVATE KEY-----\n',
    })
    expect(c.projectId).toBe('proj_123')
    expect(c.host).toBe('https://api.qweather.com')
  })

  it('rejects a non-URL host', () => {
    expect(() => WeatherConfig.parse({ host: 'not-a-url' })).toThrow()
  })
})

describe('defaultWeatherConfigOnDisk', () => {
  it('wraps the default config under `weather`', () => {
    expect(defaultWeatherConfigOnDisk()).toEqual({ weather: defaultWeatherConfig() })
  })

  it('round-trips through WeatherConfigOnDisk', () => {
    const parsed = WeatherConfigOnDisk.parse(defaultWeatherConfigOnDisk())
    expect(parsed.weather.host).toBe('https://devapi.qweather.com')
  })
})

describe('WeatherHour', () => {
  it('normalizes a complete hour', () => {
    const h = WeatherHour.parse({
      time: '2026-07-06T14:00+08:00',
      tempC: 24,
      icon: '100',
      text: '晴',
      precipMm: 0,
      pop: 10,
      humidity: 35,
      windScale: '3',
      windDir: 'NE',
      pressure: 1013,
      feelsLikeC: 22,
    })
    expect(h.tempC).toBe(24)
  })

  it('rejects a missing tempC', () => {
    expect(() => WeatherHour.parse({ time: 'x' })).toThrow()
  })
})

describe('WeatherForecast', () => {
  it('accepts a forecast with hours', () => {
    const f = WeatherForecast.parse({
      location: '北京市',
      lng: 116.4,
      lat: 39.9,
      source: 'gps',
      fetchedAt: 1_700_000_000_000,
      hours: [],
    })
    expect(f.source).toBe('gps')
  })

  it('rejects an invalid source', () => {
    expect(() =>
      WeatherForecast.parse({
        location: 'x',
        lng: 1,
        lat: 2,
        source: 'wifi',
        fetchedAt: 1,
        hours: [],
      })
    ).toThrow()
  })

  it('rejects more than 24 hours', () => {
    const hours = Array.from({ length: 25 }, (_, i) => ({
      time: `${i}`,
      tempC: 1,
      icon: '100',
      text: 'x',
      precipMm: 0,
      pop: 0,
      humidity: 0,
      windScale: '0',
      windDir: 'N',
      pressure: 1000,
      feelsLikeC: 1,
    }))
    expect(() => WeatherForecast.parse({ location: 'x', lng: 1, lat: 2, source: 'gps', fetchedAt: 1, hours })).toThrow()
  })
})
