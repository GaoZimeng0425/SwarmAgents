import { describe, expect, it } from 'vitest'

import { applyEvent, type TaskRecord } from './apply-event'

const baseEvent = { ts: 1, taskId: 't1' as const, sessionId: 'ses-1' }

describe('applyEvent', () => {
  it('creates a task on task.created', () => {
    const next = applyEvent([], { kind: 'task.created', ...baseEvent, goal: 'do x' })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 't1', goal: 'do x', status: 'pending' })
  })

  it('marks running on task.dispatched', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'do x',
        status: 'pending',
        workerId: null,
        summary: null,
        startedAt: 1,
        events: [],
      },
    ]
    const next = applyEvent(seed, { kind: 'task.dispatched', ...baseEvent, workerId: 'w1' })
    expect(next[0].status).toBe('running')
    expect(next[0].workerId).toBe('w1')
  })

  it('sets summary + completed on task.complete', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'g',
        status: 'running',
        workerId: 'w1',
        summary: null,
        startedAt: 1,
        events: [],
      },
    ]
    const next = applyEvent(seed, { kind: 'task.complete', ...baseEvent, summary: 'done' })
    expect(next[0].status).toBe('completed')
    expect(next[0].summary).toBe('done')
  })

  it('flips to failed on task.error', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'g',
        status: 'running',
        workerId: 'w1',
        summary: null,
        startedAt: 1,
        events: [],
      },
    ]
    const next = applyEvent(seed, {
      kind: 'task.error',
      ...baseEvent,
      error: { code: 'x', message: 'm', tier: 'fatal' },
    })
    expect(next[0].status).toBe('failed')
  })

  it('flips to awaiting_user on task.permission_request', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'g',
        status: 'running',
        workerId: 'w1',
        summary: null,
        startedAt: 1,
        events: [],
      },
    ]
    const next = applyEvent(seed, {
      kind: 'task.permission_request',
      ...baseEvent,
      actionId: 'a1',
      workerId: 'w1',
      risk: 'medium',
      summary: 's',
      payload: {},
    })
    expect(next[0].status).toBe('awaiting_user')
  })

  it('keeps unknown taskId events as stubs', () => {
    const next = applyEvent([], { kind: 'task.dispatched', ...baseEvent, workerId: 'w1' })
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('t1')
  })

  it('stamps sessionId onto the created record', () => {
    const out = applyEvent([], {
      kind: 'task.created', sessionId: 'ses-1', taskId: 't1', goal: 'g', ts: 1,
    })
    expect(out[0].sessionId).toBe('ses-1')
  })
})
