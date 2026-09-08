import { describe, expect, it } from 'vitest'

import { accentForeground, relativeLuminance } from './use-accent'

// The macOS system accent palette (as returned by Electron's
// systemPreferences.getAccentColor, RRGGBB). Bright accents must flip the
// foreground to near-black; mid/dark accents keep the mode CSS defaults.
describe('accentForeground', () => {
  it.each([
    ['blue', '0a60ff'],
    ['purple', 'bf5af2'],
    ['pink', 'ff375f'],
    ['red', 'ff453a'],
    ['graphite', '8e8e93'],
  ])('keeps the default foreground for %s', (_name, hex) => {
    expect(accentForeground(hex)).toBeNull()
  })

  it.each([
    ['green', '28c840'],
    ['orange', 'ff9f0a'],
    ['yellow', 'ffd60a'],
  ])('flips to near-black for %s', (_name, hex) => {
    expect(accentForeground(hex)).toBe('oklch(0.145 0 0)')
  })

  it('ignores the alpha channel in RRGGBBAA input', () => {
    expect(accentForeground('ffd60aff')).toBe('oklch(0.145 0 0)')
    expect(accentForeground('0a60ffff')).toBeNull()
  })
})

describe('relativeLuminance', () => {
  it('orders accents by perceived brightness', () => {
    expect(relativeLuminance('ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('000000')).toBe(0)
    // yellow must read brighter than blue for the 0.3 cutoff to make sense
    expect(relativeLuminance('ffd60a')).toBeGreaterThan(relativeLuminance('0a60ff'))
  })
})
