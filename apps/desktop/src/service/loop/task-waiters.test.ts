import { describe, expect, it, vi } from 'vitest'

import type { ConversationStore, StoredTaskWaiter } from '../conversation/store'
import { createTaskWaiterService } from './task-waiters'

// Minimal in-memory fake of the store surface the service uses.
function fakeStore(tasks: Record<string, { status: string } | undefined>) {
  const waiters: StoredTaskWaiter[] = []
  return {
    getTask: vi.fn((id: string) => (tasks[id] ? ({ status: tasks[id]!.status } as never) : undefined)),
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
  it('persists a waiter when the awaited task is still pending', () => {
    const store = fakeStore({ 'task-X': { status: 'running' } })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    const res = svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: null })
    expect(res.firedImmediately).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    expect(store.listTaskWaitersForTask('task-X')).toHaveLength(1)
  })

  it('fires immediately when the awaited task is already terminal', () => {
    const store = fakeStore({ 'task-X': { status: 'completed' } })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    const res = svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: null })
    expect(res.id).toBeNull()
    expect(res.firedImmediately).toBe(true)
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('completed'))
    expect((store as unknown as { _waiters: unknown[] })._waiters).toHaveLength(0)
  })

  it('fires immediately with a not-found message when the task is missing', () => {
    const store = fakeStore({})
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    const res = svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'gone', goal: null })
    expect(res.id).toBeNull()
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('could not be found'))
  })

  it('uses the agent-supplied goal verbatim when provided', () => {
    const store = fakeStore({ 'task-X': { status: 'completed' } })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: 'do the next thing' })
    expect(deliver).toHaveBeenCalledWith('s', 'a', 'do the next thing')
  })

  it('delivers to all waiters and deletes them on terminal', () => {
    const store = fakeStore({ 'task-X': { status: 'running' } })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: null })
    svc.onTaskTerminal('task-X', 'failed')
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('failed'))
    expect(store.listTaskWaitersForTask('task-X')).toEqual([])
  })

  it('re-arms on start: fires for already-terminal tasks, keeps pending ones', () => {
    const store = fakeStore({ 'done-task': { status: 'completed' }, 'live-task': { status: 'running' } })
    // Seed two persisted waiters directly.
    store.saveTaskWaiter({
      id: 'w1',
      sessionId: 's',
      waiterAddress: 'a',
      taskId: 'done-task',
      goal: null,
      createdAt: 1,
    })
    store.saveTaskWaiter({
      id: 'w2',
      sessionId: 's',
      waiterAddress: 'b',
      taskId: 'live-task',
      goal: null,
      createdAt: 2,
    })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    svc.start()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('completed'))
    expect(store.listTaskWaitersForTask('live-task')).toHaveLength(1)
  })
})
