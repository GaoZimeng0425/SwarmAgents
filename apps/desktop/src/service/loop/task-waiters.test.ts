import { describe, expect, it, vi } from 'vitest'

import type { ConversationStore, StoredTaskWaiter } from '../conversation/store'
import { createTerminalRegistry } from '../session/terminal-registry'
import { createTaskWaiterService } from './task-waiters'

// Minimal in-memory fake of the store surface the service uses. Post-4b the
// waiter never reads getTask; the registry is the source of truth for "is this
// run terminal?", so no Task rows are seeded here.
function fakeStore() {
  const waiters: StoredTaskWaiter[] = []
  return {
    saveTaskWaiter: vi.fn((w: StoredTaskWaiter) => void waiters.push(w)),
    listTaskWaitersForTask: vi.fn((taskId: string) => waiters.filter((w) => w.taskId === taskId)),
    listAllTaskWaiters: vi.fn(() => [...waiters]),
    deleteTaskWaiter: vi.fn((id: string) => {
      const i = waiters.findIndex((w) => w.id === id)
      if (i >= 0) waiters.splice(i, 1)
    }),
    _waiters: waiters,
  } as unknown as ConversationStore & { _waiters: StoredTaskWaiter[] }
}

describe('TaskWaiterService', () => {
  it('persists a waiter when the awaited run is not yet terminal', () => {
    const store = fakeStore()
    const registry = createTerminalRegistry([])
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver, terminalRegistry: registry })
    const res = svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'r-X', goal: null })
    expect(res.firedImmediately).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    expect(store.listTaskWaitersForTask('r-X')).toHaveLength(1)
  })

  it('fires immediately when the registry says the run is already terminal (no Task row)', () => {
    const store = fakeStore()
    const registry = createTerminalRegistry([{ runId: 'r-done', status: 'completed' }])
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver, terminalRegistry: registry })
    const res = svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'r-done', goal: null })
    expect(res.id).toBeNull()
    expect(res.firedImmediately).toBe(true)
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('completed'))
    expect((store as unknown as { _waiters: unknown[] })._waiters).toHaveLength(0)
  })

  it('uses the agent-supplied goal verbatim when provided', () => {
    const store = fakeStore()
    const registry = createTerminalRegistry([{ runId: 'r-done', status: 'completed' }])
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver, terminalRegistry: registry })
    svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'r-done', goal: 'do the next thing' })
    expect(deliver).toHaveBeenCalledWith('s', 'a', 'do the next thing')
  })

  it('delivers to all waiters and deletes them on terminal', () => {
    const store = fakeStore()
    const registry = createTerminalRegistry([])
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver, terminalRegistry: registry })
    svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'r-X', goal: null })
    svc.onTaskTerminal('r-X', 'failed')
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('failed'))
    expect(store.listTaskWaitersForTask('r-X')).toEqual([])
  })

  it('re-arms on start: fires for runs the registry already considers terminal, keeps pending ones', () => {
    const store = fakeStore()
    // Two persisted waiters from a prior boot: one whose target has since
    // terminated, one still running.
    store.saveTaskWaiter({
      id: 'w1',
      sessionId: 's',
      waiterAddress: 'a',
      taskId: 'r-done',
      goal: null,
      createdAt: 1,
    })
    store.saveTaskWaiter({
      id: 'w2',
      sessionId: 's',
      waiterAddress: 'b',
      taskId: 'r-live',
      goal: null,
      createdAt: 2,
    })
    const registry = createTerminalRegistry([{ runId: 'r-done', status: 'completed' }])
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver, terminalRegistry: registry })
    svc.start()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('completed'))
    expect(store.listTaskWaitersForTask('r-live')).toHaveLength(1)
  })
})
