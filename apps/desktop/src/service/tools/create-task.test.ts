import { describe, expect, it, vi } from 'vitest'

import { createTaskSpec } from './create-task'

const ctx = (createTask: ReturnType<typeof vi.fn>) => ({ sessionId: 's', createTask }) as never

describe('create_task', () => {
  it('delegates to ctx.createTask and returns the summary', async () => {
    const createTask = vi.fn(async () => ({ taskId: 't1', result: { summary: 'done', artifacts: [] } }))
    const tool = createTaskSpec().build(ctx(createTask))
    const res = await tool.execute('id', { goal: 'build it' })
    expect(createTask).toHaveBeenCalledWith('build it')
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toBe('done')
    expect(res.details).toMatchObject({ taskId: 't1', summary: 'done' })
  })

  it('returns a not-available result when ctx.createTask is unwired', async () => {
    const tool = createTaskSpec().build({ sessionId: 's' } as never)
    const res = await tool.execute('id', { goal: 'x' })
    expect(res.details).toMatchObject({ error: 'not_wired' })
  })
})
