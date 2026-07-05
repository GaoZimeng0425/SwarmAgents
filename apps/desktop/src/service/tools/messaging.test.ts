import { describe, expect, it } from 'vitest'

import { findAgentsSpec } from './messaging'

const fakeCtx = (overrides: Partial<import('./registry').ToolRunContext>) =>
  ({ sessionId: 's1', findPeers: () => [], ...overrides }) as unknown as import('./registry').ToolRunContext

describe('find_agents tool', () => {
  it('formats discovered peers into readable lines and passes the query through', async () => {
    let seen: unknown
    const fCtx = fakeCtx({
      findPeers: (q) => {
        seen = q
        return [
          {
            name: 'pm',
            address: 'a1',
            role: 'pm',
            capabilities: ['planning'],
            description: 'Coordinates work.',
            status: 'active',
          },
          {
            name: 'eng',
            address: 'a2',
            role: 'engineer',
            capabilities: [],
            description: 'Writes code.',
            status: 'dormant',
          },
        ]
      },
    })
    const tool = findAgentsSpec().build(fCtx)
    const res = await tool.execute('id', { role: 'pm' })
    expect(seen).toEqual({ role: 'pm' })
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toContain('pm (role pm)')
    expect(text).toContain('a1')
    expect(text).toContain('caps: planning')
  })

  it('reports clearly when nobody matches', async () => {
    const tool = findAgentsSpec().build(fakeCtx({ findPeers: () => [] }))
    const res = await tool.execute('id', {})
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toMatch(/no matching agents/i)
  })

  it('forwards team/teamRole to findPeers and shows team in output', async () => {
    const seen: unknown[] = []
    const fCtx = fakeCtx({
      findPeers: (q) => {
        seen.push(q)
        return [
          {
            name: 'PM',
            address: 'a1',
            role: 'pm',
            capabilities: [],
            description: 'lead',
            status: 'active',
            team: 'dev',
            teamRole: 'head',
          },
        ]
      },
    })
    const tool = findAgentsSpec().build(fCtx)
    const res = await tool.execute('1', { team: 'dev', teamRole: 'head' })
    expect(seen[0]).toEqual({ team: 'dev', teamRole: 'head' })
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toContain('team dev')
  })
})
