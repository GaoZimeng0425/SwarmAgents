import { describe, expect, it } from 'vitest'

import { AgentDefinitionSchema } from '@shared/types/agent'
import { defaultAgents } from './agents'

describe('builtin roster', () => {
  const byId = Object.fromEntries(defaultAgents.map((a) => [a.id, a]))

  it('every builtin is a valid AgentDefinition with a unique id', () => {
    const ids = defaultAgents.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of defaultAgents) expect(AgentDefinitionSchema.safeParse(a).success).toBe(true)
  })

  it('dev team is tagged with pm as head', () => {
    expect(byId.pm).toMatchObject({ team: 'dev', teamRole: 'head' })
    expect(byId.engineer).toMatchObject({ team: 'dev' })
    expect(byId.reviewer).toMatchObject({ team: 'dev' })
    expect(byId.ceo.team).toBeUndefined()
  })

  it('ships a training team with a head and an authoring IC', () => {
    expect(byId['training-head']).toMatchObject({ team: 'training', teamRole: 'head', toolScope: 'authoring' })
    expect(byId['training-author']).toMatchObject({ team: 'training', toolScope: 'authoring' })
  })

  it('exactly two teams have a head (dev, training)', () => {
    const heads = defaultAgents.filter((a) => a.teamRole === 'head').map((a) => a.team).sort()
    expect(heads).toEqual(['dev', 'training'])
  })

  it('CEO discovers heads and PM discovers the dev team by tag', () => {
    expect(byId.ceo.systemPrompt).toContain("teamRole: 'head'")
    expect(byId.pm.systemPrompt).toContain("team: 'dev'")
  })
})
