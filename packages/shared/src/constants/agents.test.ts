import { AgentDefinitionSchema, allowlistForAgent } from '@swarm/protocol'
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
    expect(byId['training-head']).toMatchObject({ team: 'training', teamRole: 'head', authoring: true })
    expect(byId['training-author']).toMatchObject({ team: 'training', authoring: true })
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

  it('pure-delegator coordinators are not authoring-privileged; only the training team is', () => {
    const coordinators = [
      'ceo',
      'planner',
      'engineering-lead',
      'product-lead',
      'design-lead',
      'qa-lead',
      'ops-lead',
      'docs-lead',
      'security-lead',
      'data-lead',
    ]
    for (const id of coordinators) {
      expect(allowlistForAgent(byId[id]), `${id} should not be authoring-privileged`).not.toContain('authoring.*')
    }
    // The training head stays privileged; ICs keep full (non-authoring) access.
    expect(allowlistForAgent(byId['training-head'])).toContain('authoring.*')
    expect(allowlistForAgent(byId.engineer)).not.toContain('authoring.*')
    expect(allowlistForAgent(byId['worker-fast'])).not.toContain('authoring.*')
  })

  it('the CEO description no longer references the renamed PM role', () => {
    expect(byId.ceo.description).not.toContain('PM')
  })

  it('CEO prompt drives the top-level delegation pipeline', () => {
    const p = byId.ceo.systemPrompt
    expect(p).toMatch(/delegate/)
    expect(p).toMatch(/find_agents\(\{ teamRole: 'head' \}\)/)
    // Post-3b: no system verify loop, no criteria tool. The CEO spot-checks
    // deliverables and asks Leaders for evidence instead.
    expect(p).not.toMatch(/set_acceptance_criteria/)
    expect(p).not.toMatch(/verify=true/)
    expect(p).toMatch(/spot-check|evidence/)
  })

  it('team heads drive delegation-plan + parallel wave dispatch', () => {
    const p = byId['engineering-lead'].systemPrompt
    expect(p).toMatch(/set_delegation_plan/)
    expect(p).toMatch(/in parallel/)
    // Every head is a potential Leader, not just dev.
    for (const a of defaultAgents) {
      if (a.teamRole === 'head') {
        expect(a.systemPrompt, `head ${a.id} missing delegation plan guidance`).toMatch(/set_delegation_plan/)
      }
    }
  })
})

describe('gmail-analyst builtin', () => {
  it('ships a low-iteration analysis agent', () => {
    const a = defaultAgents.find((d) => d.id === 'gmail-analyst')
    expect(a).toBeDefined()
    expect(a?.maxIterations).toBe(2)
    expect(a?.capabilities).toContain('gmail-analyze')
    expect(a?.systemPrompt).toMatch(/中文/)
    expect(a?.systemPrompt).toMatch(/摘要/)
  })
})
