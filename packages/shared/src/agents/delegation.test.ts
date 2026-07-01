import type { AgentDefinition } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildDelegationEdges } from './delegation'

const a = (over: Partial<AgentDefinition> & { id: string }): AgentDefinition => ({
  name: over.id,
  description: 'd',
  systemPrompt: '',
  toolScope: 'all',
  maxIterations: 25,
  ...over,
})

describe('buildDelegationEdges', () => {
  it('resolves a teamRole query to every matching head, excluding self', () => {
    const edges = buildDelegationEdges([
      a({ id: 'ceo', role: 'ceo', systemPrompt: "call find_agents({ teamRole: 'head' }) to find leads" }),
      a({ id: 'pm', team: 'dev', teamRole: 'head' }),
      a({ id: 'training-head', team: 'training', teamRole: 'head' }),
      a({ id: 'engineer', team: 'dev' }),
    ])
    expect(edges).toEqual([
      { from: 'ceo', to: 'pm' },
      { from: 'ceo', to: 'training-head' },
    ])
  })

  it('intersects team and role', () => {
    const edges = buildDelegationEdges([
      a({ id: 'pm', systemPrompt: "find_agents({ team: 'dev', role: 'engineer' })" }),
      a({ id: 'engineer', team: 'dev', role: 'engineer' }),
      a({ id: 'reviewer', team: 'dev', role: 'reviewer' }),
      a({ id: 'other-eng', team: 'ops', role: 'engineer' }),
    ])
    expect(edges).toEqual([{ from: 'pm', to: 'engineer' }])
  })

  it('matches by capability membership', () => {
    const edges = buildDelegationEdges([
      a({ id: 'lead', systemPrompt: "find_agents({ capability: 'translation' })" }),
      a({ id: 'tr', capabilities: ['translation', 'ocr'] }),
      a({ id: 'nope', capabilities: ['ocr'] }),
    ])
    expect(edges).toEqual([{ from: 'lead', to: 'tr' }])
  })

  it('ignores no-arg and query-only find_agents calls', () => {
    const edges = buildDelegationEdges([
      a({ id: 'x', systemPrompt: 'find_agents() then find_agents({ query: "anyone good" })' }),
      a({ id: 'y', role: 'helper' }),
    ])
    expect(edges).toEqual([])
  })

  it('dedupes when two queries resolve to the same target', () => {
    const edges = buildDelegationEdges([
      a({ id: 'm', systemPrompt: "find_agents({ team: 'dev' }) ... find_agents({ role: 'eng' })" }),
      a({ id: 'eng', team: 'dev', role: 'eng' }),
    ])
    expect(edges).toEqual([{ from: 'm', to: 'eng' }])
  })
})
