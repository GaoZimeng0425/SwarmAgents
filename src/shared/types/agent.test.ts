import { describe, expect, it } from 'vitest'

import { deriveAllowlist } from './agent'

describe('deriveAllowlist', () => {
  it('all -> wildcard', () => {
    expect(deriveAllowlist('all')).toEqual(['*'])
  })
  it('peekaboo -> peekaboo group only', () => {
    expect(deriveAllowlist('peekaboo')).toEqual(['peekaboo.*'])
  })
  it('web -> web + agent', () => {
    expect(deriveAllowlist('web')).toEqual(['web.*', 'agent.*'])
  })
  it('fs -> fs + agent', () => {
    expect(deriveAllowlist('fs')).toEqual(['fs.*', 'agent.*'])
  })
})
