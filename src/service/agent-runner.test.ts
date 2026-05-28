import { describe, it, expect, vi } from 'vitest'
import { createAgentRunner } from './agent-runner'
import type { Task } from '@shared/types/task'
import type { ProviderInjection } from '@shared/types/provider'

const mkTask = (id: string): Task => ({
  id, parentId: null, agentDefId: 'default', goal: 'test goal',
  status: 'pending', assignedWorkerId: null, toolAllowlist: [],
  budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [], result: null, createdAt: Date.now(), startedAt: null, endedAt: null,
})

describe('AgentRunner', () => {
  it('emits task.error when setup fails (bad provider)', async () => {
    const emitted: Array<{ event: string; data: unknown }> = []
    const runner = createAgentRunner({
      task: mkTask('t-1'),
      provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: '' },
      agentDefinition: { id: 'default', name: 'Default', systemPrompt: '', toolScope: 'all', maxIterations: 1 },
      emit: (event, data) => emitted.push({ event, data }),
      permissionRegistry: { request: vi.fn(), resolve: vi.fn() },
      spawnChild: vi.fn(),
      sessionId: 'ses-1',
    })
    await runner.run()
    const errEvent = emitted.find((e) => e.event === 'task.error')
    expect(errEvent).toBeTruthy()
  })
})
