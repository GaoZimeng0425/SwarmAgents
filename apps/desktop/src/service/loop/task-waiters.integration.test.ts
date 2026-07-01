import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@swarm/protocol'

import { createConversationStore } from '../conversation/store'
import { createTaskWaiterService } from './task-waiters'

const tmpDb = () => join(tmpdir(), `swarm-test-${Date.now()}-${Math.random()}.db`)

const mkTask = (id: string, status: Task['status']): Task => ({
  id,
  parentId: null,
  agentDefId: 'default',
  goal: 'g',
  status,
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
  history: [],
  attachments: [],
  plan: [],
  result: null,
  createdAt: Date.now(),
  startedAt: null,
  endedAt: null,
})

describe('task waiter integration (store ↔ service ↔ deliver)', () => {
  it('a registered waiter is woken when its awaited task goes terminal', () => {
    const store = createConversationStore(tmpDb())
    store.createSession('ses-1', { id: 'anthropic' as const, apiStyle: 'anthropic', model: 'm', apiKey: 'k' })
    store.saveTask(mkTask('task-X', 'running'), 'ses-1')

    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    // Wire exactly as the bootstrap does:
    store.setTaskTerminalListener((taskId, status) => svc.onTaskTerminal(taskId, status))

    svc.register({ sessionId: 'ses-1', waiterAddress: 'addr-A', taskId: 'task-X', goal: null })
    expect(deliver).not.toHaveBeenCalled()

    store.updateTaskStatus('task-X', 'completed')

    expect(deliver).toHaveBeenCalledWith('ses-1', 'addr-A', expect.stringContaining('completed'))
    expect(store.listTaskWaitersForTask('task-X')).toEqual([])
    store.close()
  })
})
