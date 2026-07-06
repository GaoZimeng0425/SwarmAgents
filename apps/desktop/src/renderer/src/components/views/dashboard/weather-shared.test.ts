import { describe, expect, it } from 'vitest'

import { aqiHex, weatherEmoji } from './weather-shared'

describe('weatherEmoji', () => {
  it('maps clear/cloud/rain/snow ranges', () => {
    expect(weatherEmoji('100')).toBe('☀️')
    expect(weatherEmoji('101')).toBe('⛅')
    expect(weatherEmoji('305')).toBe('🌧️')
    expect(weatherEmoji('400')).toBe('🌨️')
  })
  it('falls back for unknown codes', () => {
    expect(weatherEmoji('zzz')).toBe('🌡️')
  })
})

describe('aqiHex', () => {
  it('returns distinct bands for 优 vs 良', () => {
    expect(aqiHex('优')).not.toBe(aqiHex('良'))
  })
})
