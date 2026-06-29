import { describe, expect, it } from 'vitest'

import { AgentDefinitionSchema, allowlistForAgent, deriveAllowlist } from './agent'

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
  it('maps the authoring scope to the authoring group plus coordination tools', () => {
    expect(deriveAllowlist('authoring')).toEqual(['authoring.*', 'agent.*', 'fs.*', 'web.*', 'shell.*'])
  })
  it('coordinate grants only the delegation and skill groups', () => {
    expect(deriveAllowlist('coordinate')).toEqual(['agent.*', 'skill.*'])
  })
})

describe('allowlistForAgent — claude-code is reserved for developer (code) agents', () => {
  it('grants claude-code.* to agents with the code capability (builtin engineer, FE/BE engineers)', () => {
    expect(allowlistForAgent({ toolScope: 'all', capabilities: ['code', 'tests', 'shell'] })).toEqual([
      '*',
      'claude-code.*',
    ])
    expect(allowlistForAgent({ toolScope: 'all', capabilities: ['frontend', 'code', 'react'] })).toEqual([
      '*',
      'claude-code.*',
    ])
  })
  it('does not grant it to non-code roles (qa, designer, pm, head)', () => {
    expect(allowlistForAgent({ toolScope: 'all', capabilities: ['testing', 'qa', 'automation'] })).toEqual(['*'])
    expect(allowlistForAgent({ toolScope: 'all', capabilities: ['design', 'ux'] })).toEqual(['*'])
    expect(allowlistForAgent({ toolScope: 'all', capabilities: ['planning', 'coordination'] })).toEqual(['*'])
  })
  it('does not grant it when capabilities are absent', () => {
    expect(allowlistForAgent({ toolScope: 'all' })).toEqual(['*'])
  })
})

describe('AgentDefinition role + capabilities', () => {
  const base = {
    id: 'eng',
    name: 'Engineer',
    description: 'Use when code must be written.',
    systemPrompt: 'x',
    toolScope: 'all' as const,
  }

  it('accepts role and capabilities', () => {
    const def = AgentDefinitionSchema.parse({ ...base, role: 'engineer', capabilities: ['code', 'tests'] })
    expect(def.role).toBe('engineer')
    expect(def.capabilities).toEqual(['code', 'tests'])
  })

  it('leaves role and capabilities undefined when omitted (no forced default)', () => {
    const def = AgentDefinitionSchema.parse(base)
    expect(def.role).toBeUndefined()
    expect(def.capabilities).toBeUndefined()
  })
})
