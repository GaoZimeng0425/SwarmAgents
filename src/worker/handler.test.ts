import type { Inbound, Outbound } from '@shared/types/ipc'
import { describe, expect, it, vi } from 'vitest'

import { handleInbound } from './handler'
import { simulateThinking } from './simulator'

type TaskAssign = Extract<Inbound, { type: 'task.assign' }>

const sampleTaskAssign = (goal = 'do a thing'): TaskAssign => ({
  type: 'task.assign',
  task: {
    id: '01HX0000000000000000000000',
    parentId: null,
    goal,
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
})

describe('worker handler', () => {
  it('responds to shutdown by sending no outbound', () => {
    const send = vi.fn()
    handleInbound({ type: 'shutdown' }, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('simulator emits the documented event sequence', async () => {
    const sent: Outbound[] = []
    await simulateThinking(
      sampleTaskAssign('plan ahead').task,
      (m) => sent.push(m),
      { stepMs: 0 },
    )
    const progressKinds = sent
      .filter((m): m is Outbound & { type: 'progress' } => m.type === 'progress')
      .map((m) => m.event.kind)
    expect(progressKinds).toEqual([
      'llm.message',
      'llm.message',
      'tool.call',
      'tool.result',
      'llm.message',
    ])
    expect(sent[sent.length - 1].type).toBe('task.complete')
  })
})
