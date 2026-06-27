import { AgentDefinitionSchema } from '@shared/types/agent'
import { describe, expect, it } from 'vitest'

import { defaultAgents } from './agents'

describe('builtin roster', () => {
  const byId = Object.fromEntries(defaultAgents.map((a) => [a.id, a]))

  it('every builtin is a valid AgentDefinition with a unique id', () => {
    const ids = defaultAgents.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of defaultAgents) expect(AgentDefinitionSchema.safeParse(a).success).toBe(true)
  })

  it('dev team is tagged with pm as head', () => {
    expect(byId['engineering-lead']).toMatchObject({ team: 'dev', teamRole: 'head' })
    expect(byId.engineer).toMatchObject({ team: 'dev' })
    expect(byId.reviewer).toMatchObject({ team: 'dev' })
    expect(byId.ceo.team).toBeUndefined()
  })

  it('ships a training team with a head and an authoring IC', () => {
    expect(byId['training-head']).toMatchObject({ team: 'training', teamRole: 'head', toolScope: 'authoring' })
    expect(byId['training-author']).toMatchObject({ team: 'training', toolScope: 'authoring' })
  })

  it('each company team has exactly one head', () => {
    const heads = defaultAgents
      .filter((a) => a.teamRole === 'head')
      .map((a) => a.team)
      .sort()
    expect(heads).toEqual(['data', 'design', 'dev', 'docs', 'ops', 'product', 'qa', 'security', 'training'])
    // No team has two heads.
    expect(new Set(heads).size).toBe(heads.length)
  })

  it('every team member (head or IC) carries a team tag', () => {
    for (const a of defaultAgents) {
      if (a.teamRole === 'head') expect(a.team, `head ${a.id} missing team`).toBeTruthy()
    }
  })

  it('CEO discovers heads and the engineering lead discovers the dev team by tag', () => {
    expect(byId.ceo.systemPrompt).toContain("teamRole: 'head'")
    expect(byId['engineering-lead'].systemPrompt).toContain("team: 'dev'")
  })

  it('the training team is pointed at the design-agent-team skill', () => {
    expect(byId['training-head'].systemPrompt).toContain('design-agent-team')
    expect(byId['training-author'].systemPrompt).toContain('design-agent-team')
  })
})
