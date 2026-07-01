import type { AgentDefinition } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildOrgForest } from './org-tree'

const a = (over: Partial<AgentDefinition> & { id: string }): AgentDefinition => ({
  name: over.id,
  description: 'd',
  systemPrompt: 'p',
  toolScope: 'all',
  maxIterations: 25,
  ...over,
})

// Flatten a forest to "id:parentId-or-root" pairs for order-independent assertions.
const edges = (forest: ReturnType<typeof buildOrgForest>): string[] => {
  const out: string[] = []
  const walk = (n: ReturnType<typeof buildOrgForest>[number], parent: string): void => {
    out.push(`${n.agent.id}:${parent}`)
    for (const c of n.children) walk(c, n.agent.id)
  }
  for (const r of forest) walk(r, 'root')
  return out.sort()
}

describe('buildOrgForest', () => {
  it('builds an arbitrary-depth tree from parentId', () => {
    const forest = buildOrgForest([
      a({ id: 'ceo' }),
      a({ id: 'pm', parentId: 'ceo' }),
      a({ id: 'eng', parentId: 'pm' }),
      a({ id: 'intern', parentId: 'eng' }),
    ])
    expect(edges(forest)).toEqual(['ceo:root', 'eng:pm', 'intern:eng', 'pm:ceo'].sort())
  })

  it('falls back to team/teamRole inference when parentId is absent', () => {
    const forest = buildOrgForest([
      a({ id: 'ceo', role: 'ceo' }),
      a({ id: 'pm', role: 'pm', team: 'dev', teamRole: 'head' }),
      a({ id: 'engineer', role: 'engineer', team: 'dev' }),
      a({ id: 'reviewer', role: 'reviewer', team: 'dev' }),
    ])
    expect(edges(forest)).toEqual(['ceo:root', 'engineer:pm', 'pm:ceo', 'reviewer:pm'].sort())
  })

  it('mixes explicit parentId with fallback inference', () => {
    const forest = buildOrgForest([
      a({ id: 'ceo', role: 'ceo' }),
      a({ id: 'pm', team: 'dev', teamRole: 'head' }), // inferred -> ceo
      a({ id: 'specialist', parentId: 'pm' }), // explicit -> pm, no team
    ])
    expect(edges(forest)).toEqual(['ceo:root', 'pm:ceo', 'specialist:pm'].sort())
  })

  it('treats an independent agent (no team, not ceo) as a root', () => {
    const forest = buildOrgForest([a({ id: 'researcher', role: 'researcher' })])
    expect(edges(forest)).toEqual(['researcher:root'])
  })

  it('does not loop on a cyclic parentId; breaks the cycle into roots', () => {
    const forest = buildOrgForest([
      a({ id: 'a', parentId: 'b' }),
      a({ id: 'b', parentId: 'a' }),
    ])
    // No infinite loop; both nodes appear exactly once.
    const ids = edges(forest).map((e) => e.split(':')[0]).sort()
    expect(ids).toEqual(['a', 'b'])
  })
})
