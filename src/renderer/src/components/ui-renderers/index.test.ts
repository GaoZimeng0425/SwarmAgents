import { describe, expect, it } from 'vitest'

import { coerceProps, getUiRenderer } from './index'

describe('getUiRenderer', () => {
  it('returns a component for known types', () => {
    expect(typeof getUiRenderer('choice')).toBe('function')
    expect(typeof getUiRenderer('weather')).toBe('function')
  })

  it('returns undefined for unknown types', () => {
    expect(getUiRenderer('nope')).toBeUndefined()
  })
})

describe('coerceProps', () => {
  it('parses a JSON-object string into the object', () => {
    expect(coerceProps('{"city":"Tokyo","tempC":24}')).toEqual({ city: 'Tokyo', tempC: 24 })
  })

  it('passes a real object through unchanged', () => {
    const obj = { city: 'Tokyo', tempC: 24 }
    expect(coerceProps(obj)).toEqual(obj)
  })

  it('returns a non-JSON string unchanged', () => {
    expect(coerceProps('hello')).toBe('hello')
  })

  it('passes undefined through as undefined', () => {
    expect(coerceProps(undefined)).toBeUndefined()
  })
})
