import type { AgentDefinition } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { createAgentDirectory } from './receptionist'

const def = (id: string, role: string, capabilities: string[], description = ''): AgentDefinition => ({
  id,
  name: id,
  description,
  systemPrompt: 'x',
  toolScope: 'all',
  maxIterations: 25,
  role,
  capabilities,
})

const build = (defs: AgentDefinition[]) => createAgentDirectory({ listAgentDefs: () => defs })

describe('createAgentDirectory.find', () => {
  it('filters by exact role', () => {
    const dir = build([def('engineer', 'engineer', ['code', 'tests']), def('reviewer', 'reviewer', ['review'])])
    const res = dir.find({ role: 'reviewer' })
    expect(res.map((p) => p.address)).toEqual(['reviewer'])
  })

  it('filters by capability tag', () => {
    const dir = build([def('engineer', 'engineer', ['code', 'tests']), def('reviewer', 'reviewer', ['review'])])
    expect(dir.find({ capability: 'tests' }).map((p) => p.address)).toEqual(['engineer'])
  })

  it('every discovered peer is active (no live/dormant distinction post-actor-removal)', () => {
    const dir = build([def('engineer', 'engineer', [])])
    expect(dir.find({})[0].status).toBe('active')
  })

  it('ranks an exact role mention in the query above prose matches', () => {
    const dir = build([
      def('engineer', 'engineer', [], 'Writes code and runs tests.'),
      def('reviewer', 'reviewer', [], 'Reviews code against acceptance criteria.'),
    ])
    // "reviewer" names the reviewer's role → reviewer ranks first
    const res = dir.find({ query: 'need a reviewer' })
    expect(res[0].address).toBe('reviewer')
  })

  it('empty query returns every agent def', () => {
    const dir = build([def('engineer', 'engineer', []), def('reviewer', 'reviewer', [])])
    const res = dir.find({})
    expect(res.map((p) => p.address).sort()).toEqual(['engineer', 'reviewer'])
  })

  it('filters peers by team and by teamRole', () => {
    const defs: AgentDefinition[] = [
      { ...def('pm', 'pm', []), team: 'dev', teamRole: 'head' },
      { ...def('engineer', 'engineer', []), team: 'dev' },
      { ...def('training-head', 'training-head', []), team: 'training', teamRole: 'head' },
    ]
    const dir = build(defs)
    expect(
      dir
        .find({ team: 'dev' })
        .map((p) => p.role)
        .sort()
    ).toEqual(['engineer', 'pm'])
    expect(
      dir
        .find({ teamRole: 'head' })
        .map((p) => p.role)
        .sort()
    ).toEqual(['pm', 'training-head'])
    expect(dir.find({ team: 'dev', teamRole: 'head' }).map((p) => p.role)).toEqual(['pm'])
  })
})
