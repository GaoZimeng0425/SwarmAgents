import { describe, expect, it } from 'vitest'

import { deriveAllowlist } from './agent'

describe('deriveAllowlist', () => {
  it('all -> wildcard', () => {
    expect(deriveAllowlist('all')).toEqual(['*'])
  })
  it('peekaboo -> observation tools only (no interaction)', () => {
    expect(deriveAllowlist('peekaboo')).toEqual(['peekaboo.see_screen', 'peekaboo.list_apps'])
  })
  it('web -> web + agent', () => {
    expect(deriveAllowlist('web')).toEqual(['web.*', 'agent.*'])
  })
  it('fs -> fs + agent', () => {
    expect(deriveAllowlist('fs')).toEqual(['fs.*', 'agent.*'])
  })
  it('memory -> memory + agent', () => {
    expect(deriveAllowlist('memory')).toEqual(['memory.*', 'agent.*'])
  })
})
