import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createTerminalRegistry } from '../session/terminal-registry'
import { createTaskWaiterService } from './task-waiters'

const tmpDb = () => join(tmpdir(), `swarm-test-${Date.now()}-${Math.random()}.db`)

describe('task waiter integration (store ↔ service ↔ registry ↔ deliver)', () => {
  it('a registered waiter is woken when the registry later marks the run terminal', () => {
    const store = createConversationStore(tmpDb())
    store.createSession('ses-1', { id: 'anthropic' as const, apiStyle: 'anthropic', model: 'm', apiKey: 'k' })

    const deliver = vi.fn()
    const registry = createTerminalRegistry([])
    const svc = createTaskWaiterService({ store, deliver, terminalRegistry: registry })
    // Wire exactly as the bootstrap does: the registry fires onTerminal.
    registry.onTerminal((runId, status) => svc.onTaskTerminal(runId, status))

    svc.register({ sessionId: 'ses-1', waiterAddress: 'addr-A', taskId: 'r-X', goal: null })
    expect(deliver).not.toHaveBeenCalled()

    registry.markTerminal('r-X', 'completed')

    expect(deliver).toHaveBeenCalledWith('ses-1', 'addr-A', expect.stringContaining('completed'))
    expect(store.listTaskWaitersForTask('r-X')).toEqual([])
    store.close()
  })
})
