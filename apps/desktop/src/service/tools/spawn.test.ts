import { describe, expect, it, vi } from 'vitest'

import type { AcceptanceCriterion, SpawnChildOptions, TaskResult } from '@swarm/protocol'

import { spawnAgentSpec } from './spawn'

const ctx = (spawnChild: ReturnType<typeof vi.fn>) => ({ sessionId: 's', spawnChild } as never)

describe('spawn_sub_agent', () => {
  it('delegates to ctx.spawnChild and returns the summary', async () => {
    const spawnChild = vi.fn(async () => ({ childTaskId: 'c', result: { summary: 'done', artifacts: [] } }))
    const tool = spawnAgentSpec().build(ctx(spawnChild))
    const res = await tool.execute('id', { goal: 'do it' })
    expect(spawnChild).toHaveBeenCalledWith('do it', undefined, undefined, undefined, undefined)
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toBe('done')
  })
})

describe('spawn_sub_agent options', () => {
  it('passes acceptanceCriteria and verify=true through as options', async () => {
    const spawnChild = vi.fn(
      async (
        _goal: string,
        _suggestedTools?: string[],
        _providerKey?: string,
        _agentType?: string,
        _options?: SpawnChildOptions
      ): Promise<{ childTaskId: string; result: TaskResult }> => ({
        childTaskId: 'c',
        result: { summary: 'done', artifacts: [] },
      })
    )
    const tool = spawnAgentSpec().build(ctx(spawnChild))
    const criteria: AcceptanceCriterion[] = [{ id: 'c1', description: 'ships' }]
    await tool.execute('id', { goal: 'do it', agentType: 'pm', acceptanceCriteria: criteria, verify: true })
    expect(spawnChild).toHaveBeenCalledTimes(1)
    const args = spawnChild.mock.calls[0]
    // [goal, suggestedTools, providerKey, agentType, options]
    expect(args[0]).toBe('do it')
    expect(args[3]).toBe('pm')
    expect(args[4]).toMatchObject({ acceptanceCriteria: criteria, maxVerifyRounds: 3 })
  })

  it('omits options when neither acceptanceCriteria nor verify is supplied', async () => {
    const spawnChild = vi.fn(
      async (
        _goal: string,
        _suggestedTools?: string[],
        _providerKey?: string,
        _agentType?: string,
        _options?: SpawnChildOptions
      ): Promise<{ childTaskId: string; result: TaskResult }> => ({
        childTaskId: 'c',
        result: { summary: 'done', artifacts: [] },
      })
    )
    const tool = spawnAgentSpec().build(ctx(spawnChild))
    await tool.execute('id', { goal: 'do it' })
    const args = spawnChild.mock.calls[0]
    expect(args[4]).toBeUndefined()
  })
})
