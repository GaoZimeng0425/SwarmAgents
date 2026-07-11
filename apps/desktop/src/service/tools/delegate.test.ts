import { describe, expect, it, vi } from 'vitest'

import { delegateSpec } from './delegate'

const ctx = (overrides: Record<string, unknown>) => ({ sessionId: 's', ...overrides }) as never
const build = (overrides: Record<string, unknown>) => delegateSpec().build(ctx(overrides))

describe('delegate', () => {
  it('topLevel=true routes to ctx.createTask (top-level work run)', async () => {
    const createTask = vi.fn().mockResolvedValue({ runId: 'r1', status: 'completed', summary: 'done', artifacts: [] })
    const tool = build({ createTask, spawnChild: vi.fn() })
    await tool.execute('c1', { prompt: 'build it', topLevel: true })
    expect(createTask).toHaveBeenCalledWith('build it', undefined)
  })

  it('topLevel=true forwards agentType to ctx.createTask', async () => {
    const createTask = vi.fn().mockResolvedValue({ runId: 'r1', status: 'completed', summary: 'done', artifacts: [] })
    const tool = build({ createTask, spawnChild: vi.fn() })
    await tool.execute('c1', { prompt: 'build it', topLevel: true, agentType: 'pm' })
    expect(createTask).toHaveBeenCalledWith('build it', 'pm')
  })

  it('default (no topLevel) routes to ctx.spawnChild with an options object', async () => {
    const spawnChild = vi.fn().mockResolvedValue({ runId: 'c1', status: 'completed', summary: 'ok', artifacts: [] })
    const tool = build({ createTask: vi.fn(), spawnChild })
    await tool.execute('c1', {
      prompt: 'research',
      agentType: 'researcher',
      suggestedTools: ['peekaboo'],
      providerKey: 'openai',
    })
    expect(spawnChild).toHaveBeenCalledWith('research', {
      suggestedTools: ['peekaboo'],
      providerKey: 'openai',
      agentType: 'researcher',
    })
  })

  it('topLevel omitted defaults to the spawn path', async () => {
    const spawnChild = vi.fn().mockResolvedValue({ runId: 'c1', status: 'completed', summary: 'ok', artifacts: [] })
    const tool = build({ createTask: vi.fn(), spawnChild })
    await tool.execute('c1', { prompt: 'do it' })
    expect(spawnChild).toHaveBeenCalledWith('do it', {
      suggestedTools: undefined,
      providerKey: undefined,
      agentType: undefined,
    })
  })

  it('returns summary text and { runId, status, summary } details on the top-level path', async () => {
    const createTask = vi.fn().mockResolvedValue({ runId: 't1', status: 'completed', summary: 'done', artifacts: [] })
    const tool = build({ createTask, spawnChild: vi.fn() })
    const res = await tool.execute('id', { prompt: 'build it', topLevel: true })
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toBe('done')
    expect(res.details).toMatchObject({ runId: 't1', status: 'completed', summary: 'done' })
  })

  it('returns summary text and { runId, status, summary } details on the spawn path', async () => {
    const spawnChild = vi.fn().mockResolvedValue({ runId: 'c1', status: 'completed', summary: 'ok', artifacts: [] })
    const tool = build({ createTask: vi.fn(), spawnChild })
    const res = await tool.execute('id', { prompt: 'do it' })
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toBe('ok')
    expect(res.details).toMatchObject({ runId: 'c1', status: 'completed', summary: 'ok' })
  })

  it('prefixes the summary with [failed] when the child run failed', async () => {
    const spawnChild = vi
      .fn()
      .mockResolvedValue({ runId: 'c1', status: 'failed', summary: 'ran out of budget', artifacts: [] })
    const tool = build({ createTask: vi.fn(), spawnChild })
    const res = await tool.execute('id', { prompt: 'do it' })
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toBe('[failed] ran out of budget')
    expect(res.details).toMatchObject({ status: 'failed' })
  })

  it('prefixes the summary with [cancelled] when the child run was cancelled', async () => {
    const createTask = vi
      .fn()
      .mockResolvedValue({ runId: 't1', status: 'cancelled', summary: 'stopped', artifacts: [] })
    const tool = build({ createTask, spawnChild: vi.fn() })
    const res = await tool.execute('id', { prompt: 'x', topLevel: true })
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toBe('[cancelled] stopped')
  })

  it('errors loudly when topLevel=true and ctx.createTask is unwired', async () => {
    const tool = build({ spawnChild: vi.fn() })
    const res = await tool.execute('id', { prompt: 'x', topLevel: true })
    expect(res.details).toMatchObject({ error: 'not_wired' })
  })

  it('errors loudly when the default path is taken and ctx.spawnChild is unwired', async () => {
    const tool = build({ createTask: vi.fn() })
    const res = await tool.execute('id', { prompt: 'x' })
    expect(res.details).toMatchObject({ error: 'not_wired' })
  })
})
