import { describe, expect, it } from 'vitest'

import { withSkills } from './prompt'

describe('withSkills', () => {
  it('returns the base unchanged when there are no skills', () => {
    expect(withSkills('base prompt', [])).toBe('base prompt')
  })

  it('appends a skills section listing name + description', () => {
    const out = withSkills('base', [
      { name: 'a', description: 'does a', body: '' },
      { name: 'b', description: 'does b', body: '' },
    ])
    expect(out).toContain('base')
    expect(out).toContain('use_skill')
    expect(out).toContain('- a: does a')
    expect(out).toContain('- b: does b')
  })

  it('produces a standalone section when the base is empty', () => {
    const out = withSkills('', [{ name: 'a', description: 'does a', body: '' }])
    expect(out.startsWith('# Skills')).toBe(true)
  })

  it('omits skills flagged disableModelInvocation from the list', () => {
    const out = withSkills('base', [
      { name: 'a', description: 'does a', body: '' },
      { name: 'hidden', description: 'secret', body: '', disableModelInvocation: true },
    ])
    expect(out).toContain('- a: does a')
    expect(out).not.toContain('hidden')
  })

  it('returns the base unchanged when every skill is hidden', () => {
    expect(withSkills('base', [{ name: 'h', description: 'd', body: '', disableModelInvocation: true }])).toBe('base')
  })
})
