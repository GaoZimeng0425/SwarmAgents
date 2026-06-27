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

  it('coordinators carry the borrowed coordination protocol', () => {
    // CEO + every head + the planner delegate, so they get the shared protocol.
    expect(byId.ceo.systemPrompt).toContain('retry once')
    expect(byId.planner.systemPrompt).toContain('retry once')
    for (const a of defaultAgents) {
      if (a.teamRole === 'head') {
        expect(a.systemPrompt, `head ${a.id} missing protocol`).toContain('retry once')
      }
    }
  })

  it('only the CEO carries the goal-integration addendum', () => {
    expect(byId.ceo.systemPrompt).toContain('assumptions you are delegating under')
    // No head and not the planner carry the CEO-only addendum.
    for (const a of defaultAgents) {
      if (a.teamRole === 'head' || a.id === 'planner') {
        expect(a.systemPrompt, `${a.id} should not have the CEO addendum`).not.toContain(
          'assumptions you are delegating under'
        )
      }
    }
  })

  it('non-coordinating ICs do not get the coordination protocol', () => {
    expect(byId.engineer.systemPrompt).not.toContain('retry once')
    expect(byId.reviewer.systemPrompt).not.toContain('retry once')
  })

  it('pure-delegator coordinators use the least-privilege coordinate scope', () => {
    const coordinators = ['ceo', 'planner', 'engineering-lead', 'product-lead', 'design-lead', 'qa-lead', 'ops-lead', 'docs-lead', 'security-lead', 'data-lead']
    for (const id of coordinators) {
      expect(byId[id].toolScope, `${id} should be coordinate`).toBe('coordinate')
    }
    // The training head stays privileged; ICs keep full access.
    expect(byId['training-head'].toolScope).toBe('authoring')
    expect(byId.engineer.toolScope).toBe('all')
    expect(byId['worker-fast'].toolScope).toBe('all')
  })

  it('the CEO description no longer references the renamed PM role', () => {
    expect(byId.ceo.description).not.toContain('PM')
  })
})
