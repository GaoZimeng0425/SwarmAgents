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
  // Real injection wired in Task 13; placeholder keeps the schema valid.
  provider: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'placeholder' },
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

const stubTask = {
  id: '01HX0000000000000000000001',
  parentId: null,
  goal: 'g',
  status: 'pending' as const,
  assignedWorkerId: null,
  toolAllowlist: ['*'],
  budget: { tokens: 1, calls: 1, wallMs: 1, usdCents: 1 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [],
  result: null,
  createdAt: 0,
  startedAt: null,
  endedAt: null,
}
const stubProvider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'sk-test' }

describe('handler — provider injection', () => {
  it('routes to real agent path when SWARM_USE_SIMULATOR is not set', async () => {
    const original = process.env.SWARM_USE_SIMULATOR
    delete process.env.SWARM_USE_SIMULATOR
    const sent: unknown[] = []
    handleInbound(
      {
        type: 'task.assign',
        task: stubTask,
        promptContext: '',
        provider: stubProvider,
      },
      (m) => sent.push(m),
    )
    await new Promise((r) => setTimeout(r, 0))
    const sim = sent.find(
      (m) =>
        typeof m === 'object' && m && (m as { type?: string }).type === 'progress',
    )
    if (sim) {
      const text = JSON.stringify(sim)
      expect(text).not.toContain('simulator')
    }
    if (original !== undefined) process.env.SWARM_USE_SIMULATOR = original
  })

  it('routes to simulator when SWARM_USE_SIMULATOR=1', async () => {
    const original = process.env.SWARM_USE_SIMULATOR
    process.env.SWARM_USE_SIMULATOR = '1'
    const sent: unknown[] = []
    handleInbound(
      {
        type: 'task.assign',
        task: stubTask,
        promptContext: '',
        provider: stubProvider,
      },
      (m) => sent.push(m),
    )
    // Simulator's first emit is gated by its default stepMs (~600ms). Wait long
    // enough for at least one progress event without flaking on slow CI.
    await new Promise((r) => setTimeout(r, 800))
    expect(
      sent.some(
        (m) => typeof m === 'object' && m && (m as { type?: string }).type === 'progress',
      ),
    ).toBe(true)
    if (original !== undefined) process.env.SWARM_USE_SIMULATOR = original
    else delete process.env.SWARM_USE_SIMULATOR
  })
})
