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
})

describe('allowlistForAgent — claude-code is reserved for the dev engineer', () => {
  it('grants claude-code.* to the dev team engineer', () => {
    expect(allowlistForAgent({ toolScope: 'all', team: 'dev', role: 'engineer' })).toEqual(['*', 'claude-code.*'])
  })
  it('does not grant it to other dev-team roles (pm/reviewer)', () => {
    expect(allowlistForAgent({ toolScope: 'all', team: 'dev', role: 'pm' })).toEqual(['*'])
    expect(allowlistForAgent({ toolScope: 'all', team: 'dev', role: 'reviewer' })).toEqual(['*'])
  })
  it('does not grant it to an engineer on another team', () => {
    expect(allowlistForAgent({ toolScope: 'all', team: 'training', role: 'engineer' })).toEqual(['*'])
  })
  it('does not grant it to the ceo or unteamed agents', () => {
    expect(allowlistForAgent({ toolScope: 'all', role: 'ceo' })).toEqual(['*'])
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
