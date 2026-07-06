import { describe, expect, it } from 'vitest'

import {
  defaultWeatherConfig,
  defaultWeatherConfigOnDisk,
  WeatherConfig,
  WeatherConfigOnDisk,
  WeatherForecast,
  WeatherHour,
  WeatherNow,
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
      warnings: [],
      indices: [],
      air: null,
      minutely: null,
      now: null,
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
        warnings: [],
        indices: [],
        air: null,
        minutely: null,
        now: null,
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
    }))
    expect(() =>
      WeatherForecast.parse({
        location: 'x',
        lng: 1,
        lat: 2,
        source: 'gps',
        fetchedAt: 1,
        hours,
        warnings: [],
        indices: [],
        air: null,
        minutely: null,
        now: null,
      })
    ).toThrow()
  })
})

describe('WeatherNow', () => {
  const sampleNow = {
    temp: 28,
    feelsLike: 31,
    icon: '101',
    text: '多云',
    humidity: 58,
    windScale: '3',
    windDir: '东南风',
    windSpeed: 12,
    pressure: 1006,
    vis: 16,
    precip: 0,
    obsTime: '2026-07-07T10:00:00+08:00',
  }

  it('parses a full now snapshot', () => {
    expect(WeatherNow.parse(sampleNow)).toEqual(sampleNow)
  })

  it('rejects a malformed now (missing vis)', () => {
    const { vis: _drop, ...bad } = sampleNow
    expect(WeatherNow.safeParse(bad).success).toBe(false)
  })

  it('WeatherForecast accepts now: null and a full now', () => {
    const base = {
      location: '北京市',
      lng: 116.4,
      lat: 39.9,
      source: 'gps' as const,
      fetchedAt: 1,
      hours: [],
      warnings: [],
      indices: [],
      air: null,
      minutely: null,
    }
    expect(WeatherForecast.parse({ ...base, now: null }).now).toBeNull()
    expect(WeatherForecast.parse({ ...base, now: sampleNow }).now).toEqual(sampleNow)
  })
})
