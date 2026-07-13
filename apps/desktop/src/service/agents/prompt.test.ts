import type { AgentDefinition } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { withAgentTypes } from './prompt'

const def = (id: string, description: string): AgentDefinition => ({
  id,
  name: id,
  description,
  systemPrompt: '',
  toolScope: 'all',
  maxIterations: 25,
})

describe('withAgentTypes', () => {
  it('returns the base prompt unchanged when there are no types', () => {
    expect(withAgentTypes('base', [])).toBe('base')
  })

  it('appends a catalog of id: description lines and the delegate guidance', () => {
    const out = withAgentTypes('base', [def('researcher', 'Use when investigating.')])
    expect(out).toContain('base')
    expect(out).toContain('# Sub-agent types')
    expect(out).toContain('delegate')
    expect(out).toContain('- researcher: Use when investigating.')
  })

  it('emits the section alone when the base is empty', () => {
    expect(withAgentTypes('', [def('x', 'd')]).startsWith('# Sub-agent types')).toBe(true)
  })

  it('mentions report_result in delegation instructions', () => {
    // The section only renders when defs is non-empty, so a non-empty list
    // is required to exercise the delegation guidance text.
    const result = withAgentTypes('base', [def('x', 'd')])
    expect(result).toContain('report_result')
  })
})
