import { describe, expect, it } from 'vitest'
import type { AgentDefinition } from '@swarm/protocol'
import type { Actor } from '@swarm/protocol'
import { createAgentDirectory } from './receptionist'

const actor = (address: string, agentDefId: string, name: string | null, createdAt = 0): Actor => ({
  address,
  agentDefId,
  sessionId: 's1',
  name,
  state: null,
  lastTaskId: null,
  createdAt,
  updatedAt: createdAt,
})

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

const defs: Record<string, AgentDefinition> = {
  engineer: def('engineer', 'engineer', ['code', 'tests'], 'Writes code and runs tests.'),
  reviewer: def('reviewer', 'reviewer', ['review'], 'Reviews code against acceptance criteria.'),
}

const build = (actors: Actor[], live: string[] = []) =>
  createAgentDirectory({
    listActors: () => actors,
    isLive: (a) => live.includes(a),
    getAgentDef: (id) => defs[id],
  })

describe('createAgentDirectory.find', () => {
  it('filters by exact role', () => {
    const dir = build([actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')])
    const res = dir.find('s1', { role: 'reviewer' })
    expect(res.map((p) => p.address)).toEqual(['a2'])
  })

  it('filters by capability tag', () => {
    const dir = build([actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')])
    expect(dir.find('s1', { capability: 'tests' }).map((p) => p.address)).toEqual(['a1'])
  })

  it('derives status from isLive', () => {
    const dir = build([actor('a1', 'engineer', 'eng')], ['a1'])
    expect(dir.find('s1', {})[0].status).toBe('active')
    expect(build([actor('a1', 'engineer', 'eng')], []).find('s1', {})[0].status).toBe('dormant')
  })

  it('excludes self', () => {
    const dir = build([actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')])
    expect(dir.find('s1', {}, 'a1').map((p) => p.address)).toEqual(['a2'])
  })

  it('ranks an exact role mention in the query above prose matches, active first', () => {
    const dir = build(
      [actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')],
      ['a1', 'a2']
    )
    // "reviewer" names the reviewer's role → reviewer ranks first
    const res = dir.find('s1', { query: 'need a reviewer' })
    expect(res[0].address).toBe('a2')
  })

  it('empty query returns all, active before dormant', () => {
    const dir = build([actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')], ['a2'])
    const res = dir.find('s1', {})
    expect(res[0].status).toBe('active')
    expect(res.map((p) => p.address).sort()).toEqual(['a1', 'a2'])
  })

  it('falls back to agentDefId/[]/"" when the agent def is unknown', () => {
    const dir = build([actor('a1', 'ghost', 'g')])
    const p = dir.find('s1', {})[0]
    expect(p.role).toBe('ghost')
    expect(p.capabilities).toEqual([])
    expect(p.description).toBe('')
  })

  it('filters peers by team and by teamRole', () => {
    const teamDefs: Record<string, AgentDefinition> = {
      pm: { ...def('pm', 'pm', []), team: 'dev', teamRole: 'head' },
      engineer: { ...def('engineer', 'engineer', []), team: 'dev' },
      'training-head': { ...def('training-head', 'training-head', []), team: 'training', teamRole: 'head' },
    }
    const dir = createAgentDirectory({
      listActors: () => [
        actor('a1', 'pm', 'pm'),
        actor('a2', 'engineer', 'eng'),
        actor('a3', 'training-head', 'th'),
      ],
      isLive: () => true,
      getAgentDef: (id) => teamDefs[id],
    })
    expect(dir.find('s1', { team: 'dev' }).map((p) => p.role).sort()).toEqual(['engineer', 'pm'])
    expect(dir.find('s1', { teamRole: 'head' }).map((p) => p.role).sort()).toEqual(['pm', 'training-head'])
    expect(dir.find('s1', { team: 'dev', teamRole: 'head' }).map((p) => p.role)).toEqual(['pm'])
  })
})
