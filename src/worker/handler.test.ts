import type { Inbound, Outbound } from '@shared/types/ipc'
import { describe, expect, it, vi } from 'vitest'

import { handleInbound } from './handler'

describe('worker handler (echo behavior for foundation)', () => {
  it('emits task.complete when assigned a task', () => {
    const sent: Outbound[] = []
    const send = vi.fn((m: Outbound) => sent.push(m))

    const msg: Inbound = {
      type: 'task.assign',
      task: {
        id: '01HX0000000000000000000000',
        parentId: null,
        goal: 'echo',
        status: 'dispatched',
        assignedWorkerId: 'w1',
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: 1,
        startedAt: null,
        endedAt: null,
      },
      promptContext: '',
    }

    handleInbound(msg, send)
    expect(send).toHaveBeenCalled()
    const completion = sent.find((m) => m.type === 'task.complete')
    expect(completion).toBeDefined()
    if (completion?.type === 'task.complete') {
      expect(completion.taskId).toBe('01HX0000000000000000000000')
      expect(completion.result.summary).toContain('echo')
    }
  })

  it('responds to shutdown by sending no outbound', () => {
    const send = vi.fn()
    handleInbound({ type: 'shutdown' }, send)
    expect(send).not.toHaveBeenCalled()
  })
})
