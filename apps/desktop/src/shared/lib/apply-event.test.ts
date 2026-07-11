import { applyEvent, type RunRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

const baseEvent = { ts: 1, seq: 1, runId: 't1' as const, sessionId: 'ses-1' }

// A seeded run record in a given status, mirroring what run.created would build.
function seed(status: RunRecord['status'], over: Partial<RunRecord> = {}): RunRecord[] {
  return [
    {
      id: 't1',
      sessionId: 'ses-1',
      prompt: 'g',
      status,
      summary: null,
      startedAt: 1,
      attachments: [],
      events: [],
      ...over,
    },
  ]
}

describe('applyEvent', () => {
  it('creates a run on run.created', () => {
    const next = applyEvent([], { kind: 'run.created', ...baseEvent, prompt: 'do x' })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 't1', prompt: 'do x', status: 'pending' })
  })

  it('carries parentRunId + agentDefId for a spawned sub-agent run.created', () => {
    const next = applyEvent([], {
      kind: 'run.created',
      ...baseEvent,
      parentRunId: 'parent-1',
      prompt: 'sub goal',
      agentDefId: 'researcher',
    })
    expect(next[0]).toMatchObject({ id: 't1', parentRunId: 'parent-1', agentDefId: 'researcher' })
  })

  it('marks running on run.dispatched', () => {
    const next = applyEvent(seed('pending'), { kind: 'run.dispatched', ...baseEvent })
    expect(next[0].status).toBe('running')
  })

  it('sets summary + completed on run.complete', () => {
    const next = applyEvent(seed('running'), { kind: 'run.complete', ...baseEvent, summary: 'done' })
    expect(next[0].status).toBe('completed')
    expect(next[0].summary).toBe('done')
  })

  it('flips to failed on run.error', () => {
    const next = applyEvent(seed('running'), {
      kind: 'run.error',
      ...baseEvent,
      error: { code: 'x', message: 'm', tier: 'fatal' },
    })
    expect(next[0].status).toBe('failed')
  })

  it('flips to cancelled on run.error with code "cancelled"', () => {
    const next = applyEvent(seed('running'), {
      kind: 'run.error',
      ...baseEvent,
      error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' },
    })
    expect(next[0].status).toBe('cancelled')
  })

  it('stays failed on run.error with a non-cancelled code', () => {
    const next = applyEvent(seed('running'), {
      kind: 'run.error',
      ...baseEvent,
      error: { code: 'budget_exhausted', message: 'm', tier: 'gave_up' },
    })
    expect(next[0].status).toBe('failed')
  })

  it('flips to awaiting_user on run.permission_request', () => {
    const next = applyEvent(seed('running'), {
      kind: 'run.permission_request',
      ...baseEvent,
      actionId: 'a1',
      risk: 'medium',
      summary: 's',
      payload: {},
    })
    expect(next[0].status).toBe('awaiting_user')
  })

  it('resets awaiting_user back to running on the next run.progress', () => {
    const next = applyEvent(seed('awaiting_user'), {
      kind: 'run.progress',
      ...baseEvent,
      event: { kind: 'tool.result', ok: true, payload: {}, ts: 2 },
    })
    expect(next[0].status).toBe('running')
  })

  it('does not resurrect a finished run on a late run.progress', () => {
    const next = applyEvent(seed('completed', { summary: 'done' }), {
      kind: 'run.progress',
      ...baseEvent,
      event: { kind: 'tool.result', ok: true, payload: {}, ts: 2 },
    })
    expect(next[0].status).toBe('completed')
  })

  it('keeps unknown runId events as stubs', () => {
    const next = applyEvent([], { kind: 'run.dispatched', ...baseEvent })
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('t1')
  })

  it('applies a terminal event to a freshly-stubbed unknown run (no stuck running)', () => {
    const next = applyEvent([], { kind: 'run.complete', ...baseEvent, summary: 'done' })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 't1', status: 'completed', summary: 'done' })
  })

  it('stamps sessionId onto the created record', () => {
    const out = applyEvent([], { kind: 'run.created', ...baseEvent, prompt: 'g' })
    expect(out[0].sessionId).toBe('ses-1')
  })

  it('records resource usage on run.usage without changing status', () => {
    const used = { tokens: 900, calls: 2, wallMs: 1500, usdCents: 3, cacheRead: 0, cacheWrite: 0 }
    const next = applyEvent(seed('running', { prompt: 'do x' }), {
      kind: 'run.usage',
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

  it('stores the plan on run.plan and replaces it wholesale on the next plan', () => {
    const first = applyEvent(seed('running', { prompt: 'do x' }), {
      kind: 'run.plan',
      ...baseEvent,
      todos: [{ content: 'step one', status: 'in_progress' }],
    })
    expect(first[0].plan).toEqual([{ content: 'step one', status: 'in_progress' }])
    expect(first[0].status).toBe('running')

    const second = applyEvent(first, {
      kind: 'run.plan',
      ...baseEvent,
      todos: [
        { content: 'step one', status: 'completed' },
        { content: 'step two', status: 'in_progress' },
      ],
    })
    expect(second[0].plan).toHaveLength(2)
    expect(second[0].plan?.[0]).toEqual({ content: 'step one', status: 'completed' })
  })

  it('records run.spawned append-only on the parent without changing status', () => {
    const next = applyEvent(seed('running'), { kind: 'run.spawned', ...baseEvent, childRunId: 'child-1' })
    expect(next[0].status).toBe('running')
    expect(next[0].events).toHaveLength(1)
    expect(next[0].events[0]).toMatchObject({ kind: 'run.spawned', childRunId: 'child-1' })
  })

  it('stubs + appends for a conversation turn (run.progress under a fresh runId)', () => {
    // A live conversation turn arrives as run.progress with runId: turnId and
    // no preceding run.created (there is no run row). The unknown-run fallback
    // must stub a record so the inner event renders, and a later progress event
    // for the same turn appends to the same record (run-id namespace).
    const ev1 = applyEvent([], {
      kind: 'run.progress',
      ts: 1,
      seq: 1,
      runId: 'turn-1',
      sessionId: 'ses-1',
      event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 },
    })
    expect(ev1).toHaveLength(1)
    expect(ev1[0].id).toBe('turn-1')
    expect(ev1[0].events).toHaveLength(1)
    const ev2 = applyEvent(ev1, {
      kind: 'run.progress',
      ts: 2,
      seq: 2,
      runId: 'turn-1',
      sessionId: 'ses-1',
      event: { kind: 'llm.message', role: 'assistant', content: 'yo', ts: 2 },
    })
    expect(ev2[0].events).toHaveLength(2)
  })
})
