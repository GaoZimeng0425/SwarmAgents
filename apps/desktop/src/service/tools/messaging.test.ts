import { describe, expect, it, vi } from 'vitest'

import { findAgentsSpec, sendAndWaitSpec, sendMessageSpec, whoamiSpec } from './messaging'

const ctx = (over: Partial<any> = {}) =>
  ({
    selfAddress: 'me',
    sendMessage: vi.fn(async () => {}),
    sendAndWait: vi.fn(async () => 'the-reply'),
    ...over,
  }) as any

/** Narrow a content item to its text, matching mcp/manager.ts:textOf. */
const textOf = (c: { type: string; text?: string }): string => (c.type === 'text' ? (c.text ?? '') : '')

describe('messaging tools', () => {
  it('send_message calls ctx.sendMessage and reports delivery', async () => {
    const c = ctx()
    const tool = sendMessageSpec().build(c)
    const res = await tool.execute('id', { to: 'peer', payload: 'hi' })
    expect(c.sendMessage).toHaveBeenCalledWith('peer', 'hi')
    expect(textOf(res.content[0])).toMatch(/delivered/i)
  })

  it('send_and_wait returns the reply text', async () => {
    const c = ctx()
    const tool = sendAndWaitSpec().build(c)
    const res = await tool.execute('id', { to: 'peer', payload: 'ping' })
    expect(c.sendAndWait).toHaveBeenCalledWith('peer', 'ping')
    expect(textOf(res.content[0])).toBe('the-reply')
  })

  it('whoami returns the agent self address', async () => {
    const tool = whoamiSpec().build(ctx())
    const res = await tool.execute('id', {})
    expect(textOf(res.content[0])).toContain('me')
  })

  it('whoami returns the fallback when selfAddress is absent', async () => {
    const tool = whoamiSpec().build(ctx({ selfAddress: undefined }))
    const res = await tool.execute('id', {})
    expect(textOf(res.content[0])).toContain('no address: this agent is not addressable')
  })
})

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
    expect(text).toContain('active')
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
