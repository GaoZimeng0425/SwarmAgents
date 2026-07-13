import { describe, expect, it, vi } from 'vitest'

import type { ToolRunContext } from './registry'
import { reportResultSpec } from './report-result'

const ctx = (_overrides: Partial<ToolRunContext> = {}): ToolRunContext =>
  ({ sessionId: 's', reportResult: vi.fn() }) as unknown as ToolRunContext

describe('report_result tool', () => {
  it('calls ctx.reportResult with artifacts', async () => {
    const c = ctx()
    const tool = reportResultSpec().build(c)
    const res = (await tool.execute('call1', {
      artifacts: [{ kind: 'note', text: 'result text' }],
    })) as { details: { artifacts: unknown[] } }
    expect(c.reportResult).toHaveBeenCalledWith([{ kind: 'note', text: 'result text' }])
    expect(res.details.artifacts).toHaveLength(1)
  })

  it('works with empty artifacts array', async () => {
    const c = ctx()
    const tool = reportResultSpec().build(c)
    await tool.execute('call2', { artifacts: [] })
    expect(c.reportResult).toHaveBeenCalledWith([])
  })

  it('returns error when reportResult not available', async () => {
    const c = { sessionId: 's' } as unknown as ToolRunContext
    const tool = reportResultSpec().build(c)
    const res = (await tool.execute('call3', { artifacts: [] })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })
})
