import { describe, expect, it } from 'vitest'

// Verify the runner builds a ToolRunContext exposing findPeers, bridged onto
// the deps.findPeers callback.
describe('agent-runner tool context', () => {
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
      correlationId: 't1',
      cwd: undefined,
      attachments: [],
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
      correlationId: 't1',
      cwd: undefined,
      attachments: [],
      sessionId: 's1',
      spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
    } as never)
    expect(ctx.findPeers({})).toEqual([])
  })
})
