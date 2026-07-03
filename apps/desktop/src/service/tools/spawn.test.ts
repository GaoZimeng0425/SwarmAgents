import { describe, expect, it, vi } from 'vitest'

import { spawnAgentSpec } from './spawn'

const ctx = (spawnChild: ReturnType<typeof vi.fn>) => ({ sessionId: 's', spawnChild }) as never

describe('spawn_sub_agent', () => {
  it('delegates to ctx.spawnChild and returns the summary', async () => {
    const spawnChild = vi.fn(async () => ({ childTaskId: 'c', result: { summary: 'done', artifacts: [] } }))
    const tool = spawnAgentSpec().build(ctx(spawnChild))
    const res = await tool.execute('id', { goal: 'do it' })
    expect(spawnChild).toHaveBeenCalledWith('do it', undefined, undefined, undefined)
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toBe('done')
  })

  it('forwards agentType and providerKey positionally', async () => {
    const spawnChild = vi.fn(async () => ({ childTaskId: 'c', result: { summary: 'done', artifacts: [] } }))
    const tool = spawnAgentSpec().build(ctx(spawnChild))
    await tool.execute('id', { goal: 'do it', agentType: 'pm', providerKey: 'pk' })
    expect(spawnChild).toHaveBeenCalledWith('do it', undefined, 'pk', 'pm')
  })
})
