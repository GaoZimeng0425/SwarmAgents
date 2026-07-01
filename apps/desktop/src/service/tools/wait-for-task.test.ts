import { describe, expect, it, vi } from 'vitest'

import type { TaskWaiterService } from '../loop/task-waiters'
import type { ToolRunContext } from './registry'
import { waitForTaskSpecs } from './wait-for-task'

const baseCtx: ToolRunContext = {
  sessionId: 'ses-1',
  taskId: 't',
  selfAddress: 'addr-A',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
  sendMessage: async () => undefined,
  sendAndWait: async () => '',
  findPeers: () => [],
}

function fakeService(firedImmediately = false): TaskWaiterService {
  return {
    register: vi.fn(() => ({ id: 'w1', firedImmediately })),
    onTaskTerminal: vi.fn(),
    start: vi.fn(),
  }
}

const buildTool = (svc: TaskWaiterService, ctx: ToolRunContext) => {
  const spec = waitForTaskSpecs(svc)[0]
  return spec.build(ctx)
}

describe('wait_for_task tool', () => {
  it('registers a waiter for the calling agent address', async () => {
    const svc = fakeService(false)
    const tool = buildTool(svc, baseCtx)
    const res = (await tool.execute('1', { taskId: 'task-X' })) as { content: [{ text: string }] }
    expect(svc.register).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      waiterAddress: 'addr-A',
      taskId: 'task-X',
      goal: null,
    })
    expect(res.content[0].text).toContain('waiting for task task-X')
  })

  it('passes an agent-supplied goal through', async () => {
    const svc = fakeService(false)
    const tool = buildTool(svc, baseCtx)
    await tool.execute('1', { taskId: 'task-X', goal: 'then do Y' })
    expect(svc.register).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      waiterAddress: 'addr-A',
      taskId: 'task-X',
      goal: 'then do Y',
    })
  })

  it('errors when taskId is missing', async () => {
    const svc = fakeService()
    const tool = buildTool(svc, baseCtx)
    const res = (await tool.execute('1', {})) as { content: [{ text: string }] }
    expect(res.content[0].text).toContain('error')
    expect(svc.register).not.toHaveBeenCalled()
  })

  it('errors when the agent is not addressable', async () => {
    const svc = fakeService()
    const tool = buildTool(svc, { ...baseCtx, selfAddress: undefined })
    const res = (await tool.execute('1', { taskId: 'task-X' })) as { content: [{ text: string }] }
    expect(res.content[0].text).toContain('not addressable')
    expect(svc.register).not.toHaveBeenCalled()
  })
})
