import { describe, expect, it } from 'vitest'

import { AgentDefinitionSchema, allowlistForAgent, deriveAllowlist } from './agent'

describe('deriveAllowlist', () => {
  // Every agent gets the full standard tool set regardless of scope; toolScope
  // no longer restricts capabilities (a coordinator/researcher can use shell,
  // fs, web, UI, screen capture directly, not only delegate). Only authoring
  // adds its privileged group, which '*' excludes (see registry PRIVILEGED_GROUPS).
  it('all -> wildcard', () => {
    expect(deriveAllowlist('all')).toEqual(['*'])
  })
  it('peekaboo -> full tool set (was observation-only)', () => {
    expect(deriveAllowlist('peekaboo')).toEqual(['*'])
  })
  it('web -> full tool set (was web + agent)', () => {
    expect(deriveAllowlist('web')).toEqual(['*'])
  })
  it('fs -> full tool set (was fs + agent)', () => {
    expect(deriveAllowlist('fs')).toEqual(['*'])
  })
  it('memory -> full tool set (was memory + agent)', () => {
    expect(deriveAllowlist('memory')).toEqual(['*'])
  })
  it('authoring -> full tool set plus the privileged authoring group', () => {
    expect(deriveAllowlist('authoring')).toEqual(['*', 'authoring.*'])
  })
  it('coordinate -> full tool set (was delegation + skill only)', () => {
    expect(deriveAllowlist('coordinate')).toEqual(['*'])
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

describe('allowlistForAgent — authoring gate', () => {
  it('grants the privileged authoring group via the authoring flag', () => {
    expect(allowlistForAgent({ authoring: true })).toEqual(['*', 'authoring.*'])
  })
  it('back-compat: grants it for a legacy on-disk agent with toolScope "authoring" and no flag', () => {
    expect(allowlistForAgent({ toolScope: 'authoring' })).toEqual(['*', 'authoring.*'])
  })
  it('does not grant it for a plain agent (no authoring flag, no legacy scope)', () => {
    expect(allowlistForAgent({})).toEqual(['*'])
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

  it('parses without toolScope (now optional — collapsed to the authoring gate)', () => {
    const withoutScope: Record<string, unknown> = { ...base }
    delete withoutScope.toolScope
    const def = AgentDefinitionSchema.parse(withoutScope)
    expect(def.toolScope).toBeUndefined()
  })

  it('accepts the authoring flag', () => {
    const def = AgentDefinitionSchema.parse({ ...base, authoring: true })
    expect(def.authoring).toBe(true)
  })
})
