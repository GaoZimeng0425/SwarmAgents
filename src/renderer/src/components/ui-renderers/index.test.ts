import { describe, expect, it } from 'vitest'

import { getUiRenderer } from './index'

describe('getUiRenderer', () => {
  it('returns a component for known types', () => {
    expect(typeof getUiRenderer('choice')).toBe('function')
    expect(typeof getUiRenderer('weather')).toBe('function')
  })

  it('returns undefined for unknown types', () => {
    expect(getUiRenderer('nope')).toBeUndefined()
  })
})
