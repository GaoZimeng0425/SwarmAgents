import { SkillSchema } from '@shared/types/skill'
import { describe, expect, it } from 'vitest'

import { builtinSkills } from './builtins'

describe('builtinSkills', () => {
  const skills = builtinSkills({ mcpConfigPath: '/tmp/mcp.json' })
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]))

  it('ships the design-agent-team skill as a valid Skill', () => {
    const skill = byName['design-agent-team']
    expect(skill).toBeDefined()
    expect(SkillSchema.safeParse(skill).success).toBe(true)
  })

  it('design-agent-team has a trigger-first description within the length limit', () => {
    const { description } = byName['design-agent-team']
    expect(description.length).toBeLessThanOrEqual(1024)
    expect(description).toMatch(/Use when/i)
  })

  it('design-agent-team body covers the five authoring steps', () => {
    const { body } = byName['design-agent-team']
    for (const anchor of [
      'Step 1 — Dedup',
      'Step 2 — Pick a team architecture pattern',
      'Step 3 — Authoring conventions',
      'Step 4 — Static dry-run validation',
      'Step 5 — Evolution',
    ]) {
      expect(body, `missing section: ${anchor}`).toContain(anchor)
    }
  })

  it('still ships the operations manual alongside it', () => {
    expect(byName['swarmagent-operations']).toBeDefined()
  })
})
