import { AgentDefinitionSchema } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { defaultAgents } from './agents'

// Coordinators only dispatch work — they don't call code/shell tools themselves.
// Doers (engineer, reviewer) carry the full tool scope.
const COMPANY_SCOPES = [
  ['ceo', 'coordinate'],
  ['engineering-lead', 'coordinate'],
  ['engineer', 'all'],
  ['reviewer', 'all'],
] as const

describe('company role agent definitions', () => {
  it('ships ceo/engineering-lead/engineer/reviewer as valid definitions with role-appropriate tool scope', () => {
    for (const [id, scope] of COMPANY_SCOPES) {
      const def = defaultAgents.find((a) => a.id === id)
      expect(def, `missing role ${id}`).toBeDefined()
      // Each role parses against the schema.
      expect(() => AgentDefinitionSchema.parse(def)).not.toThrow()
      expect(def?.toolScope).toBe(scope)
      expect(def?.description.length).toBeGreaterThan(0)
      expect(def?.systemPrompt.length).toBeGreaterThan(0)
    }
  })

  it('the dev-team head prompt names its teammates and caps the review loop', () => {
    const lead = defaultAgents.find((a) => a.id === 'engineering-lead')!
    // The engineering lead coordinates engineer + reviewer, so both teammate roles appear in its prompt.
    expect(lead.systemPrompt).toContain('engineer')
    expect(lead.systemPrompt).toContain('reviewer')
    // The spec mandates a 10-round cap on the fix/review loop.
    expect(lead.systemPrompt).toContain('10')
    // The CEO no longer names the dev head directly — it discovers team heads by tag.
    const ceo = defaultAgents.find((a) => a.id === 'ceo')!
    expect(ceo.systemPrompt).toContain("teamRole: 'head'")
  })

  it('keeps the generic default fallback agent (not a company member)', () => {
    const def = defaultAgents.find((a) => a.id === 'default')
    expect(def, 'lost builtin default').toBeDefined()
    expect(def?.team).toBeUndefined()
    // The retired generic agents are no longer shipped as builtins.
    for (const id of ['researcher', 'executor']) {
      expect(
        defaultAgents.find((a) => a.id === id),
        `unexpected retired builtin ${id}`
      ).toBeUndefined()
    }
  })
})

describe('builtin role + capability metadata', () => {
  it('every builtin validates and carries role (= id) and a capabilities array', () => {
    for (const a of defaultAgents) {
      expect(() => AgentDefinitionSchema.parse(a)).not.toThrow()
      expect(a.role).toBe(a.id)
      expect(Array.isArray(a.capabilities)).toBe(true)
    }
  })

  it('CEO and dev-head prompts discover teammates via find_agents (no hardcoded names)', () => {
    const ceo = defaultAgents.find((a) => a.id === 'ceo')!
    const lead = defaultAgents.find((a) => a.id === 'engineering-lead')!
    expect(ceo.systemPrompt).toContain('find_agents')
    expect(lead.systemPrompt).toContain('find_agents')
    // The engineering lead must look up both teammates by role.
    expect(lead.systemPrompt).toContain("role: 'engineer'")
    expect(lead.systemPrompt).toContain("role: 'reviewer'")
  })
})
