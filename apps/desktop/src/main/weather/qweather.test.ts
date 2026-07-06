import { describe, expect, it } from 'vitest'

import {
  normalizeAir,
  normalizeHourly,
  normalizeIndices,
  normalizeMinutely,
  normalizeNow,
  normalizeWarnings,
} from './qweather'

// A representative QWeather /v7/weather/24h `hourly` entry. Field names mirror
// the upstream payload (fxTime, temp, icon, text, windScale, windDir, pop,
// precip, humidity, pressure).
const sampleHour = {
  fxTime: '2026-07-06T06:00+00:00', // UTC — normalizer must convert to local tz
  temp: '24',
  icon: '100',
  text: '晴',
  windScale: '3',
  windDir: '东北',
  pop: '10',
  precip: '0.0',
  humidity: '35',
  pressure: '1013',
}

describe('normalizeHourly', () => {
  it('maps a raw hour to a WeatherHour, converting fxTime to local ISO', () => {
    const [h] = normalizeHourly([sampleHour])
    expect(h.tempC).toBe(24)
    expect(h.icon).toBe('100')
    expect(h.text).toBe('晴')
    expect(h.pop).toBe(10)
    expect(h.precipMm).toBe(0)
    expect(h.humidity).toBe(35)
    expect(h.windScale).toBe('3')
    expect(h.windDir).toBe('东北')
    expect(h.pressure).toBe(1013)
    // time is an ISO string with a timezone offset (not UTC Z).
    expect(h.time).toContain('T')
    expect(h.time).not.toContain('Z')
  })

  it('defaults pop to 0 when the source omits it', () => {
    const { pop: _drop, ...withoutPop } = sampleHour
    const [h] = normalizeHourly([withoutPop])
    expect(h.pop).toBe(0)
  })

  it('treats an empty pop string as 0', () => {
    const [h] = normalizeHourly([{ ...sampleHour, pop: '' }])
    expect(h.pop).toBe(0)
  })

  it('skips entries lacking a fxTime', () => {
    const out = normalizeHourly([{ ...sampleHour, fxTime: '' }, sampleHour])
    expect(out.length).toBe(1)
  })

  it('returns [] for an empty input', () => {
    expect(normalizeHourly([])).toEqual([])
  })
})

describe('normalizeWarnings', () => {
  it('maps raw warnings, defaulting missing fields to empty strings', () => {
    const [w] = normalizeWarnings([
      { id: '1', title: 't', typeName: '冰雹', level: '黄色', severityColor: 'Yellow', text: 'x' },
    ])
    expect(w).toMatchObject({ id: '1', typeName: '冰雹', severityColor: 'Yellow', status: '' })
  })
  it('returns [] for no warnings', () => {
    expect(normalizeWarnings([])).toEqual([])
  })
})

describe('normalizeIndices', () => {
  it('maps raw indices', () => {
    const [i] = normalizeIndices([{ type: '1', name: '运动指数', level: '3', category: '较不宜', text: 'x' }])
    expect(i).toEqual({ type: '1', name: '运动指数', level: '3', category: '较不宜', text: 'x' })
  })
})

describe('normalizeAir', () => {
  it('numifies concentrations and keeps category/primary', () => {
    const a = normalizeAir({
      aqi: '99',
      category: '良',
      primary: 'O3',
      pm2p5: '18',
      pm10: '31',
      o3: '199',
      no2: '11',
      so2: '3',
      co: '0.4',
      pubTime: 'x',
    })
    expect(a).toMatchObject({ aqi: 99, category: '良', primary: 'O3', pm2p5: 18, co: 0.4 })
  })
  it('returns null when the now object is absent', () => {
    expect(normalizeAir(undefined)).toBeNull()
  })
})

describe('normalizeMinutely', () => {
  it('maps summary + points and numifies precip', () => {
    const m = normalizeMinutely({
      summary: '80分钟后雨就停了',
      minutely: [{ fxTime: '2026-07-06T17:50+08:00', precip: '0.25', type: 'rain' }],
    })
    expect(m?.summary).toBe('80分钟后雨就停了')
    expect(m?.points[0]).toEqual({ time: '2026-07-06T17:50+08:00', precipMm: 0.25, type: 'rain' })
  })
  it('returns null when minutely is empty', () => {
    expect(normalizeMinutely({ summary: 'x', minutely: [] })).toBeNull()
    expect(normalizeMinutely({})).toBeNull()
  })
})

describe('normalizeNow', () => {
  const raw = {
    obsTime: '2026-07-07T02:00+00:00',
    temp: '28',
    feelsLike: '31',
    icon: '101',
    text: '多云',
    humidity: '58',
    windScale: '3',
    windDir: '东南风',
    windSpeed: '12',
    pressure: '1006',
    vis: '16',
    precip: '0.0',
  }

  it('coerces numeric strings and keeps labels', () => {
    const n = normalizeNow(raw)
    expect(n).not.toBeNull()
    expect(n).toMatchObject({
      temp: 28,
      feelsLike: 31,
      humidity: 58,
      windSpeed: 12,
      pressure: 1006,
      vis: 16,
      precip: 0,
      windScale: '3',
      windDir: '东南风',
      icon: '101',
      text: '多云',
    })
    // obsTime is normalized to an ISO string with a local offset
    expect(typeof n?.obsTime).toBe('string')
  })

  it('returns null when raw is undefined', () => {
    expect(normalizeNow(undefined)).toBeNull()
  })
})
