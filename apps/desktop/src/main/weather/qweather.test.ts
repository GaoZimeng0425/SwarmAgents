import { describe, expect, it } from 'vitest'

import { normalizeHourly } from './qweather'

// A representative QWeather /v7/grid-forecast/24h `hourly` entry. Field names
// mirror the upstream payload (fxTime, temp, icon, text, windScale, windDir,
// pop, precip, humidity, pressure, feelsLike).
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
  feelsLike: '22',
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
    expect(h.feelsLikeC).toBe(22)
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
