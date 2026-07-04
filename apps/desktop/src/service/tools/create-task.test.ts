import { describe, expect, it, vi } from 'vitest'

import { createTaskSpec } from './create-task'

const ctx = (overrides: Record<string, unknown>) => ({ sessionId: 's', ...overrides }) as never

describe('create_task (merged)', () => {
  it('asTopLevel=true routes to ctx.createTask (top-level work run)', async () => {
    const createTask = vi.fn().mockResolvedValue({ taskId: 'r1', result: { summary: 'done', artifacts: [] } })
    const tool = createTaskSpec().build(ctx({ createTask, spawnChild: vi.fn() }))
    await tool.execute('c1', { goal: 'build it', asTopLevel: true })
    expect(createTask).toHaveBeenCalledWith('build it', undefined)
  })

  it('asTopLevel=true forwards agentType to ctx.createTask', async () => {
    const createTask = vi.fn().mockResolvedValue({ taskId: 'r1', result: { summary: 'done', artifacts: [] } })
    const tool = createTaskSpec().build(ctx({ createTask, spawnChild: vi.fn() }))
    await tool.execute('c1', { goal: 'build it', asTopLevel: true, agentType: 'pm' })
    expect(createTask).toHaveBeenCalledWith('build it', 'pm')
  })

  it('asTopLevel=false (default) routes to ctx.spawnChild with overrides', async () => {
    const spawnChild = vi.fn().mockResolvedValue({ childTaskId: 'c1', result: { summary: 'ok', artifacts: [] } })
    const tool = createTaskSpec().build(ctx({ createTask: vi.fn(), spawnChild }))
    await tool.execute('c1', {
      goal: 'research',
      agentType: 'researcher',
      suggestedTools: ['peekaboo'],
      providerKey: 'openai',
    })
    expect(spawnChild).toHaveBeenCalledWith('research', ['peekaboo'], 'openai', 'researcher')
  })

  it('asTopLevel omitted defaults to spawn path', async () => {
    const spawnChild = vi.fn().mockResolvedValue({ childTaskId: 'c1', result: { summary: 'ok', artifacts: [] } })
    const tool = createTaskSpec().build(ctx({ createTask: vi.fn(), spawnChild }))
    await tool.execute('c1', { goal: 'do it' })
    expect(spawnChild).toHaveBeenCalledWith('do it', undefined, undefined, undefined)
  })

  it('returns summary text and taskId details on the top-level path', async () => {
    const createTask = vi.fn().mockResolvedValue({ taskId: 't1', result: { summary: 'done', artifacts: [] } })
    const tool = createTaskSpec().build(ctx({ createTask, spawnChild: vi.fn() }))
    const res = await tool.execute('id', { goal: 'build it', asTopLevel: true })
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toBe('done')
    expect(res.details).toMatchObject({ taskId: 't1', summary: 'done' })
  })

  it('returns summary text and childTaskId details on the spawn path', async () => {
    const spawnChild = vi.fn().mockResolvedValue({ childTaskId: 'c1', result: { summary: 'ok', artifacts: [] } })
    const tool = createTaskSpec().build(ctx({ createTask: vi.fn(), spawnChild }))
    const res = await tool.execute('id', { goal: 'do it' })
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toBe('ok')
    expect(res.details).toMatchObject({ childTaskId: 'c1', summary: 'ok' })
  })

  it('returns a not-available result when asTopLevel=true and ctx.createTask is unwired', async () => {
    const tool = createTaskSpec().build(ctx({ spawnChild: vi.fn() }))
    const res = await tool.execute('id', { goal: 'x', asTopLevel: true })
    expect(res.details).toMatchObject({ error: 'not_wired' })
  })

  it('returns a not-available result when asTopLevel=false and ctx.spawnChild is unwired', async () => {
    const tool = createTaskSpec().build(ctx({ createTask: vi.fn() }))
    const res = await tool.execute('id', { goal: 'x' })
    expect(res.details).toMatchObject({ error: 'not_wired' })
  })
})
