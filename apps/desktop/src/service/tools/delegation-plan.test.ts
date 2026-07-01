import { describe, expect, it, vi } from 'vitest'

import { delegationPlanSpec } from './delegation-plan'
import type { ToolRunContext } from './registry'

const ctx = (_over: Partial<ToolRunContext> = {}): ToolRunContext =>
  ({ sessionId: 's', setDelegationPlan: vi.fn(), spawnChild: vi.fn() } as unknown as ToolRunContext)

describe('set_delegation_plan tool', () => {
  it('has the expected name and group', () => {
    const spec = delegationPlanSpec()
    expect(spec.name).toBe('set_delegation_plan')
    expect(spec.group).toBe('agent')
  })

  it('records the plan and assigns stable ids', async () => {
    const c = ctx()
    const tool = delegationPlanSpec().build(c)
    const res = (await tool.execute('id', {
      items: [
        { goal: 'build api', ownerAgentType: 'engineer', acceptanceCriteria: [{ description: 'tests pass' }] },
        { goal: 'review api', dependsOn: ['d1'] },
      ],
    })) as { details: { plan?: unknown } }
    expect(c.setDelegationPlan).toHaveBeenCalledWith([
      { id: 'd1', goal: 'build api', ownerAgentType: 'engineer', dependsOn: [], acceptanceCriteria: [{ id: 'c1', description: 'tests pass' }] },
      { id: 'd2', goal: 'review api', dependsOn: ['d1'] },
    ])
    expect((res.details.plan as unknown[]).length).toBe(2)
  })

  it('rejects an empty list', async () => {
    const tool = delegationPlanSpec().build(ctx())
    const res = (await tool.execute('id', { items: [] })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })

  it('rejects an item without a goal', async () => {
    const tool = delegationPlanSpec().build(ctx())
    const res = (await tool.execute('id', { items: [{ ownerAgentType: 'engineer' }] })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })

  it('rejects a dependsOn referencing an unknown item', async () => {
    const tool = delegationPlanSpec().build(ctx())
    const res = (await tool.execute('id', { items: [{ goal: 'a', dependsOn: ['nope'] }] })) as { details: { error?: string } }
    expect(res.details.error).toMatch(/unknown id/)
  })
})
