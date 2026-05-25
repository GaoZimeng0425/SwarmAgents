import type { Outbound } from '@shared/types/ipc'
import type { Task } from '@shared/types/task'
import { describe, expect, it } from 'vitest'

import { runPiAgent } from './index'

const mkTask = (goal: string): Task => ({
  id: '01HX00000000000000000PIAGT',
  parentId: null,
  goal,
  status: 'dispatched',
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [],
  result: null,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
})

describe('runPiAgent', () => {
  it('emits task.error when ANTHROPIC_API_KEY is missing', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const sent: Outbound[] = []
      await runPiAgent(mkTask('test'), {
        send: (m) => {
          sent.push(m)
        },
        permissionClient: { request: async () => 'grant', resolve: () => {} },
        provider: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-test' },
      })
      const errs = sent.filter((m) => m.type === 'task.error')
      expect(errs).toHaveLength(1)
      if (errs[0].type !== 'task.error') throw new Error('unreachable')
      expect(errs[0].error.code).toBe('missing_api_key')
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })
})
