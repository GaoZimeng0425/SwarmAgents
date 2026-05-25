import type { Inbound, Outbound } from '@shared/types/ipc'
import { describe, expect, it, vi } from 'vitest'

import { handleInbound } from './handler'
import * as piAgent from './pi-agent'
import * as simulator from './simulator'
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
  it('routes to runPiAgent when SWARM_USE_SIMULATOR is not set', () => {
    const original = process.env.SWARM_USE_SIMULATOR
    delete process.env.SWARM_USE_SIMULATOR
    const piSpy = vi.spyOn(piAgent, 'runPiAgent').mockResolvedValue(undefined)
    const simSpy = vi.spyOn(simulator, 'simulateThinking').mockResolvedValue(undefined)
    try {
      handleInbound(
        { type: 'task.assign', task: stubTask, promptContext: '', provider: stubProvider },
        () => {},
      )
      expect(piSpy).toHaveBeenCalledTimes(1)
      expect(simSpy).not.toHaveBeenCalled()
      const args = piSpy.mock.calls[0]
      expect(args[1].provider).toEqual(stubProvider)
    } finally {
      piSpy.mockRestore()
      simSpy.mockRestore()
      if (original !== undefined) process.env.SWARM_USE_SIMULATOR = original
    }
  })

  it('routes to simulateThinking when SWARM_USE_SIMULATOR=1', () => {
    const original = process.env.SWARM_USE_SIMULATOR
    process.env.SWARM_USE_SIMULATOR = '1'
    const piSpy = vi.spyOn(piAgent, 'runPiAgent').mockResolvedValue(undefined)
    const simSpy = vi.spyOn(simulator, 'simulateThinking').mockResolvedValue(undefined)
    try {
      handleInbound(
        { type: 'task.assign', task: stubTask, promptContext: '', provider: stubProvider },
        () => {},
      )
      expect(simSpy).toHaveBeenCalledTimes(1)
      expect(piSpy).not.toHaveBeenCalled()
    } finally {
      piSpy.mockRestore()
      simSpy.mockRestore()
      if (original !== undefined) process.env.SWARM_USE_SIMULATOR = original
      else delete process.env.SWARM_USE_SIMULATOR
    }
  })
})
