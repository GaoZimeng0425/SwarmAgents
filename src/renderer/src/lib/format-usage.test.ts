import { describe, expect, it } from 'vitest'

import { formatUsage } from './format-usage'

describe('formatUsage', () => {
  it('abbreviates thousands of tokens and renders calls + cost', () => {
    expect(formatUsage({ tokens: 1500, calls: 3, wallMs: 0, usdCents: 7 })).toBe('1.5k tok · 3 calls · $0.07')
  })

  it('keeps sub-1k token counts raw, singularizes one call, and omits zero cost', () => {
    expect(formatUsage({ tokens: 800, calls: 1, wallMs: 0, usdCents: 0 })).toBe('800 tok · 1 call')
  })

  it('renders an all-zero budget without a cost segment', () => {
    expect(formatUsage({ tokens: 0, calls: 0, wallMs: 0, usdCents: 0 })).toBe('0 tok · 0 calls')
  })
})
