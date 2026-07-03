import { applyEvent, type TaskRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

const baseEvent = { ts: 1, taskId: 't1' as const, sessionId: 'ses-1' }

describe('applyEvent', () => {
  it('creates a task on task.created', () => {
    const next = applyEvent([], { kind: 'task.created', ...baseEvent, goal: 'do x' })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 't1', goal: 'do x', status: 'pending' })
  })

  it('carries parentTaskId + agentDefId for a spawned sub-agent task.created', () => {
    const next = applyEvent([], {
      kind: 'task.created',
      ...baseEvent,
      goal: 'sub goal',
      parentTaskId: 'parent-1',
      agentDefId: 'researcher',
    })
    expect(next[0]).toMatchObject({ id: 't1', parentTaskId: 'parent-1', agentDefId: 'researcher' })
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
        attachments: [],
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
        attachments: [],
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
        attachments: [],
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

  it('flips to cancelled on task.error with code "cancelled"', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'g',
        status: 'running',
        workerId: 'w1',
        summary: null,
        startedAt: 1,
        attachments: [],
        events: [],
      },
    ]
    const next = applyEvent(seed, {
      kind: 'task.error',
      ...baseEvent,
      error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' },
    })
    expect(next[0].status).toBe('cancelled')
  })

  it('stays failed on task.error with a non-cancelled code', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'g',
        status: 'running',
        workerId: 'w1',
        summary: null,
        startedAt: 1,
        attachments: [],
        events: [],
      },
    ]
    const next = applyEvent(seed, {
      kind: 'task.error',
      ...baseEvent,
      error: { code: 'budget_exhausted', message: 'm', tier: 'gave_up' },
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
        attachments: [],
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

  it('resets awaiting_user back to running on the next task.progress', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'g',
        status: 'awaiting_user',
        workerId: 'w1',
        summary: null,
        startedAt: 1,
        attachments: [],
        events: [],
      },
    ]
    const next = applyEvent(seed, {
      kind: 'task.progress',
      ...baseEvent,
      event: { kind: 'tool.result', ok: true, payload: {}, ts: 2 },
    })
    expect(next[0].status).toBe('running')
  })

  it('does not resurrect a finished task on a late task.progress', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'g',
        status: 'completed',
        workerId: 'w1',
        summary: 'done',
        startedAt: 1,
        attachments: [],
        events: [],
      },
    ]
    const next = applyEvent(seed, {
      kind: 'task.progress',
      ...baseEvent,
      event: { kind: 'tool.result', ok: true, payload: {}, ts: 2 },
    })
    expect(next[0].status).toBe('completed')
  })

  it('keeps unknown taskId events as stubs', () => {
    const next = applyEvent([], { kind: 'task.dispatched', ...baseEvent, workerId: 'w1' })
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('t1')
  })

  it('applies a terminal event to a freshly-stubbed unknown task (no stuck running)', () => {
    const next = applyEvent([], { kind: 'task.complete', ...baseEvent, summary: 'done' })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 't1', status: 'completed', summary: 'done' })
  })

  it('stamps sessionId onto the created record', () => {
    const out = applyEvent([], {
      kind: 'task.created',
      sessionId: 'ses-1',
      taskId: 't1',
      goal: 'g',
      ts: 1,
    })
    expect(out[0].sessionId).toBe('ses-1')
  })

  it('records resource usage on task.usage without changing status', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'do x',
        status: 'running',
        workerId: null,
        summary: null,
        startedAt: 1,
        attachments: [],
        events: [],
      },
    ]
    const used = { tokens: 900, calls: 2, wallMs: 1500, usdCents: 3, cacheRead: 0, cacheWrite: 0 }
    const next = applyEvent(seed, {
      kind: 'task.usage',
      ...baseEvent,
      used,
      contextTokens: 1200,
      contextWindow: 200_000,
    })
    expect(next[0].used).toEqual(used)
    expect(next[0].contextTokens).toBe(1200)
    expect(next[0].contextWindow).toBe(200_000)
    expect(next[0].status).toBe('running')
  })

  it('stores the plan on task.plan and replaces it wholesale on the next plan', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'do x',
        status: 'running',
        workerId: null,
        summary: null,
        startedAt: 1,
        attachments: [],
        events: [],
      },
    ]
    const first = applyEvent(seed, {
      kind: 'task.plan',
      ...baseEvent,
      todos: [{ content: 'step one', status: 'in_progress' }],
    })
    expect(first[0].plan).toEqual([{ content: 'step one', status: 'in_progress' }])
    expect(first[0].status).toBe('running')

    const second = applyEvent(first, {
      kind: 'task.plan',
      ...baseEvent,
      todos: [
        { content: 'step one', status: 'completed' },
        { content: 'step two', status: 'in_progress' },
      ],
    })
    expect(second[0].plan).toHaveLength(2)
    expect(second[0].plan?.[0]).toEqual({ content: 'step one', status: 'completed' })
  })
})

describe('goal-verify events', () => {
  const seed: TaskRecord[] = [
    {
      id: 't1',
      sessionId: 'ses-1',
      goal: 'ship feature',
      status: 'running',
      workerId: null,
      summary: null,
      startedAt: 1,
      attachments: [],
      events: [],
    },
  ]
  const baseEvent = { ts: 1, taskId: 't1' as const, sessionId: 'ses-1' }

  const criteria = [
    { id: 'c1', description: 'Tests pass' },
    { id: 'c2', description: 'No lint errors', check: { kind: 'command' as const, command: 'npm run lint' } },
  ]

  it('sets acceptanceCriteria on task.criteria', () => {
    const next = applyEvent(seed, { kind: 'task.criteria', ...baseEvent, criteria })
    expect(next[0].acceptanceCriteria).toEqual(criteria)
    expect(next[0].status).toBe('running')
  })

  it('appends verification rounds in order on task.verification', () => {
    const round0 = {
      round: 0,
      verdict: 'fail' as const,
      results: [{ criterionId: 'c1', pass: false, detail: 'failing' }],
      gaps: ['fix tests'],
      ts: 2,
    }
    const round1 = {
      round: 1,
      verdict: 'pass' as const,
      results: [{ criterionId: 'c1', pass: true, detail: 'ok' }],
      gaps: [],
      ts: 3,
    }

    const after0 = applyEvent(seed, { kind: 'task.verification', ...baseEvent, round: round0 })
    expect(after0[0].verifications).toHaveLength(1)
    expect(after0[0].verifications?.[0].round).toBe(0)

    const after1 = applyEvent(after0, { kind: 'task.verification', ...baseEvent, round: round1 })
    expect(after1[0].verifications).toHaveLength(2)
    expect(after1[0].verifications?.[0].round).toBe(0)
    expect(after1[0].verifications?.[1].round).toBe(1)
  })

  it('stubs + appends for a conversation turn (task.progress under a fresh taskId)', () => {
    // A live conversation turn arrives as task.progress with taskId: turnId and
    // no preceding task.created (there is no Task row). The unknown-task fallback
    // must stub a record so the inner event renders, and a later progress event
    // for the same turn appends to the same record (task-id namespace).
    const ev1 = applyEvent([], {
      kind: 'task.progress',
      ts: 1,
      seq: 1,
      taskId: 'turn-1',
      sessionId: 'ses-1',
      event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 },
    })
    expect(ev1).toHaveLength(1)
    expect(ev1[0].id).toBe('turn-1')
    expect(ev1[0].events).toHaveLength(1)
    const ev2 = applyEvent(ev1, {
      kind: 'task.progress',
      ts: 2,
      seq: 2,
      taskId: 'turn-1',
      sessionId: 'ses-1',
      event: { kind: 'llm.message', role: 'assistant', content: 'yo', ts: 2 },
    })
    expect(ev2[0].events).toHaveLength(2)
  })
})
