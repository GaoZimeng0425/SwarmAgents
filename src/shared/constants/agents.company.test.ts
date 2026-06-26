import { AgentDefinitionSchema } from '@shared/types/agent'
import { describe, expect, it } from 'vitest'

import { defaultAgents } from './agents'

const COMPANY_IDS = ['ceo', 'pm', 'engineer', 'reviewer'] as const

describe('company role agent definitions', () => {
  it('ships ceo/pm/engineer/reviewer as valid, full-scope definitions', () => {
    for (const id of COMPANY_IDS) {
      const def = defaultAgents.find((a) => a.id === id)
      expect(def, `missing role ${id}`).toBeDefined()
      // Each role parses against the schema.
      expect(() => AgentDefinitionSchema.parse(def)).not.toThrow()
      expect(def?.toolScope).toBe('all')
      expect(def?.description.length).toBeGreaterThan(0)
      expect(def?.systemPrompt.length).toBeGreaterThan(0)
    }
  })

  it('the dev-team head prompt names its teammates and caps the review loop', () => {
    const pm = defaultAgents.find((a) => a.id === 'pm')!
    // The PM coordinates engineer + reviewer, so both teammate roles appear in its prompt.
    expect(pm.systemPrompt).toContain('engineer')
    expect(pm.systemPrompt).toContain('reviewer')
    // The spec mandates a 10-round cap on the fix/review loop.
    expect(pm.systemPrompt).toContain('10')
    // The CEO no longer names the PM directly — it discovers team heads by tag.
    const ceo = defaultAgents.find((a) => a.id === 'ceo')!
    expect(ceo.systemPrompt).toContain("teamRole: 'head'")
  })

  it('keeps the pre-existing builtin roles intact', () => {
    for (const id of ['default', 'researcher', 'executor']) {
      expect(
        defaultAgents.find((a) => a.id === id),
        `lost builtin ${id}`
      ).toBeDefined()
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

  it('CEO and PM prompts discover teammates via find_agents (no hardcoded names)', () => {
    const ceo = defaultAgents.find((a) => a.id === 'ceo')!
    const pm = defaultAgents.find((a) => a.id === 'pm')!
    expect(ceo.systemPrompt).toContain('find_agents')
    expect(pm.systemPrompt).toContain('find_agents')
    // The PM must look up both teammates by role.
    expect(pm.systemPrompt).toContain("role: 'engineer'")
    expect(pm.systemPrompt).toContain("role: 'reviewer'")
  })
})
