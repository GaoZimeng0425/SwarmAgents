import { describe, expect, it, vi } from 'vitest'

import { acceptanceCriteriaSpec } from './acceptance-criteria'
import type { ToolRunContext } from './registry'

const ctx = (_over: Partial<ToolRunContext> = {}): ToolRunContext =>
  ({ sessionId: 's', setAcceptanceCriteria: vi.fn(), spawnChild: vi.fn() }) as unknown as ToolRunContext

describe('set_acceptance_criteria tool', () => {
  it('has the expected name and group', () => {
    const spec = acceptanceCriteriaSpec()
    expect(spec.name).toBe('set_acceptance_criteria')
    expect(spec.group).toBe('agent')
  })

  it('records criteria and assigns stable ids', async () => {
    const c = ctx()
    const tool = acceptanceCriteriaSpec().build(c)
    const res = (await tool.execute('id', {
      criteria: [
        { description: 'tests pass', check: { kind: 'command', command: 'npm test' } },
        { description: 'reads clearly' },
      ],
    })) as { details: { criteria?: unknown } }
    expect(c.setAcceptanceCriteria).toHaveBeenCalledWith([
      { id: 'c1', description: 'tests pass', check: { kind: 'command', command: 'npm test' } },
      { id: 'c2', description: 'reads clearly' },
    ])
    expect((res.details.criteria as unknown[]).length).toBe(2)
  })

  it('rejects an empty list', async () => {
    const tool = acceptanceCriteriaSpec().build(ctx())
    const res = (await tool.execute('id', { criteria: [] })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })

  it('rejects an invalid check', async () => {
    const tool = acceptanceCriteriaSpec().build(ctx())
    const res = (await tool.execute('id', {
      criteria: [{ description: 'x', check: { kind: 'command' } }],
    })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })
})
