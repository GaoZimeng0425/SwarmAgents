import { AgentDefinitionSchema } from '@shared/types/agent'
import { describe, expect, it } from 'vitest'

import { builtinAgents } from './builtins'

const COMPANY_IDS = ['ceo', 'pm', 'engineer', 'reviewer'] as const

describe('company role agent definitions', () => {
  it('ships ceo/pm/engineer/reviewer as valid, full-scope definitions', () => {
    for (const id of COMPANY_IDS) {
      const def = builtinAgents.find((a) => a.id === id)
      expect(def, `missing role ${id}`).toBeDefined()
      // Each role parses against the schema.
      expect(() => AgentDefinitionSchema.parse(def)).not.toThrow()
      expect(def?.toolScope).toBe('all')
      expect(def?.description.length).toBeGreaterThan(0)
      expect(def?.systemPrompt.length).toBeGreaterThan(0)
    }
  })

  it('each company role prompt names its delegation teammates by fixed name', () => {
    const pm = builtinAgents.find((a) => a.id === 'pm')!
    // The PM coordinates engineer + reviewer, so both fixed names appear in its prompt.
    expect(pm.systemPrompt).toContain('engineer')
    expect(pm.systemPrompt).toContain('reviewer')
    // The spec mandates a 10-round cap on the fix/review loop.
    expect(pm.systemPrompt).toContain('10')
    const ceo = builtinAgents.find((a) => a.id === 'ceo')!
    expect(ceo.systemPrompt).toContain('pm')
  })

  it('keeps the pre-existing builtin roles intact', () => {
    for (const id of ['default', 'researcher', 'executor']) {
      expect(
        builtinAgents.find((a) => a.id === id),
        `lost builtin ${id}`
      ).toBeDefined()
    }
  })
})
