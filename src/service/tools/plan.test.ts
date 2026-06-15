import { describe, expect, it } from 'vitest'

import { updatePlanSpec } from './plan'
import type { ToolRunContext } from './registry'

const ctx: ToolRunContext = {
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
}

const tool = () => updatePlanSpec().build(ctx)
const textOf = (r: { content: Array<{ text?: string }> }): string => r.content[0]?.text ?? ''

describe('update_plan tool', () => {
  it('is a low-risk agent tool', () => {
    const spec = updatePlanSpec()
    expect(spec.group).toBe('agent')
    expect(spec.name).toBe('update_plan')
    expect(spec.risk).toBe('low')
  })

  it('renders the todo list as a checklist with per-status markers', async () => {
    const result = await tool().execute('c1', {
      todos: [
        { content: 'gather files', status: 'completed' },
        { content: 'edit config', status: 'in_progress' },
        { content: 'run tests', status: 'pending' },
      ],
    })
    const text = textOf(result)
    expect(text).toContain('[x] gather files')
    expect(text).toContain('[→] edit config')
    expect(text).toContain('[ ] run tests')
    expect((result.details as { todos: unknown[] }).todos).toHaveLength(3)
  })

  it('returns an error result when todos is empty', async () => {
    const result = await tool().execute('c2', { todos: [] })
    expect(textOf(result).toLowerCase()).toContain('error')
  })

  it('returns an error result on an unknown status', async () => {
    const result = await tool().execute('c3', { todos: [{ content: 'x', status: 'bogus' }] })
    expect(textOf(result).toLowerCase()).toContain('error')
  })

  it('returns an error result when an item has empty content', async () => {
    const result = await tool().execute('c4', { todos: [{ content: '  ', status: 'pending' }] })
    expect(textOf(result).toLowerCase()).toContain('error')
  })
})
