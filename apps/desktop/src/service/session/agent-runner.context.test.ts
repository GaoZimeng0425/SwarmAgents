import { describe, expect, it, vi } from 'vitest'

// Verify the runner builds a ToolRunContext exposing selfAddress + messaging,
// bridged onto the deps.sendMessage callback.
describe('agent-runner tool context messaging bridge', () => {
  it('sendAndWait bridges to deps.sendMessage with kind rpc and returns reply', async () => {
    const sendMessage = vi.fn(async (_from: string | null, _to: string, _payload: string, kind: string) =>
      kind === 'rpc' ? { reply: 'pong' } : { delivered: true as const }
    )
    // buildToolContext is the (exported-for-test) helper that assembles ToolRunContext from deps.
    const { buildToolContext } = await import('./agent-runner')
    const ctx = buildToolContext({ selfAddress: 'me', sendMessage } as any)
    const reply = await ctx.sendAndWait('peer', 'ping')
    expect(reply).toBe('pong')
    expect(sendMessage).toHaveBeenCalledWith('me', 'peer', 'ping', 'rpc')
  })

  it('sendMessage bridges to deps.sendMessage with kind send (fire-and-forget)', async () => {
    const sendMessage = vi.fn(async (_from: string | null, _to: string, _payload: string, kind: string) =>
      kind === 'rpc' ? { reply: '' } : { delivered: true as const }
    )
    const { buildToolContext } = await import('./agent-runner')
    const ctx = buildToolContext({ selfAddress: 'me', sendMessage } as any)
    await ctx.sendMessage('peer', 'hello')
    expect(sendMessage).toHaveBeenCalledWith('me', 'peer', 'hello', 'send')
  })

  it('selfAddress is exposed on the context', async () => {
    const { buildToolContext } = await import('./agent-runner')
    const ctx = buildToolContext({ selfAddress: 'agent-42' } as any)
    expect(ctx.selfAddress).toBe('agent-42')
  })

  it('sendAndWait returns empty string when deps.sendMessage is absent', async () => {
    const { buildToolContext } = await import('./agent-runner')
    const ctx = buildToolContext({} as any)
    const reply = await ctx.sendAndWait('peer', 'ping')
    expect(reply).toBe('')
  })

  it('exposes findPeers that delegates to deps.findPeers', async () => {
    const { buildToolContext } = await import('./agent-runner')
    const peer = {
      name: 'pm',
      address: 'a1',
      role: 'pm',
      capabilities: [],
      description: '',
      status: 'active' as const,
    }
    const ctx = buildToolContext({
      task: { id: 't1', goal: 'g', cwd: undefined, attachments: [] },
      sessionId: 's1',
      findPeers: (q) => (q.role === 'pm' ? [peer] : []),
      spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
    } as never)
    expect(ctx.findPeers({ role: 'pm' })).toEqual([peer])
    expect(ctx.findPeers({ role: 'none' })).toEqual([])
  })

  it('findPeers returns [] when no delegate is wired', async () => {
    const { buildToolContext } = await import('./agent-runner')
    const ctx = buildToolContext({
      task: { id: 't1', goal: 'g', cwd: undefined, attachments: [] },
      sessionId: 's1',
      spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
    } as never)
    expect(ctx.findPeers({})).toEqual([])
  })
})
