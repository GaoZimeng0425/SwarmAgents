import { applyEvent, type MessageRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

const baseEvent = { ts: 1, seq: 1, messageId: 't1' as const, sessionId: 'ses-1' }

// A seeded message record in a given status, mirroring what message.created would build.
function seed(status: MessageRecord['status'], over: Partial<MessageRecord> = {}): MessageRecord[] {
  return [
    {
      id: 't1',
      sessionId: 'ses-1',
      prompt: 'g',
      status,
      summary: null,
      createdAt: 1,
      attachments: [],
      order: 1,
      events: [],
      ...over,
    },
  ]
}

describe('applyEvent', () => {
  it('creates a message on message.created', () => {
    const next = applyEvent([], { kind: 'message.created', ...baseEvent, prompt: 'do x' })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 't1', prompt: 'do x', status: 'pending' })
  })

  it('stamps order from e.seq on message.created', () => {
    const next = applyEvent([], { kind: 'message.created', ...baseEvent, seq: 42, prompt: 'do x' })
    expect(next[0].order).toBe(42)
  })

  it('carries parentMessageId + agentDefId for a spawned sub-agent message.created', () => {
    const next = applyEvent([], {
      kind: 'message.created',
      ...baseEvent,
      parentMessageId: 'parent-1',
      prompt: 'sub goal',
      agentDefId: 'researcher',
    })
    expect(next[0]).toMatchObject({ id: 't1', parentMessageId: 'parent-1', agentDefId: 'researcher' })
  })

  it('marks running on message.dispatched', () => {
    const next = applyEvent(seed('pending'), { kind: 'message.dispatched', ...baseEvent })
    expect(next[0].status).toBe('running')
  })

  it('sets summary + completed on message.complete', () => {
    const next = applyEvent(seed('running'), { kind: 'message.complete', ...baseEvent, summary: 'done' })
    expect(next[0].status).toBe('completed')
    expect(next[0].summary).toBe('done')
  })

  it('flips to failed on message.error', () => {
    const next = applyEvent(seed('running'), {
      kind: 'message.error',
      ...baseEvent,
      error: { code: 'x', message: 'm', tier: 'fatal' },
    })
    expect(next[0].status).toBe('failed')
  })

  it('flips to cancelled on message.error with code "cancelled"', () => {
    const next = applyEvent(seed('running'), {
      kind: 'message.error',
      ...baseEvent,
      error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' },
    })
    expect(next[0].status).toBe('cancelled')
  })

  it('stays failed on message.error with a non-cancelled code', () => {
    const next = applyEvent(seed('running'), {
      kind: 'message.error',
      ...baseEvent,
      error: { code: 'budget_exhausted', message: 'm', tier: 'gave_up' },
    })
    expect(next[0].status).toBe('failed')
  })

  it('flips to awaiting_user on message.permission_request', () => {
    const next = applyEvent(seed('running'), {
      kind: 'message.permission_request',
      ...baseEvent,
      actionId: 'a1',
      risk: 'medium',
      summary: 's',
      payload: {},
    })
    expect(next[0].status).toBe('awaiting_user')
  })

  it('resets awaiting_user back to running on the next message.progress', () => {
    const next = applyEvent(seed('awaiting_user'), {
      kind: 'message.progress',
      ...baseEvent,
      event: { kind: 'tool.result', ok: true, payload: {}, ts: 2 },
    })
    expect(next[0].status).toBe('running')
  })

  it('does not resurrect a finished message on a late message.progress', () => {
    const next = applyEvent(seed('completed', { summary: 'done' }), {
      kind: 'message.progress',
      ...baseEvent,
      event: { kind: 'tool.result', ok: true, payload: {}, ts: 2 },
    })
    expect(next[0].status).toBe('completed')
  })

  it('keeps unknown messageId events as stubs', () => {
    const next = applyEvent([], { kind: 'message.dispatched', ...baseEvent })
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('t1')
  })

  it('applies a terminal event to a freshly-stubbed unknown message (no stuck running)', () => {
    const next = applyEvent([], { kind: 'message.complete', ...baseEvent, summary: 'done' })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 't1', status: 'completed', summary: 'done' })
  })

  it('stamps order from e.seq on an unknown-message stub', () => {
    const next = applyEvent([], { kind: 'message.dispatched', ...baseEvent, seq: 7 })
    expect(next[0].order).toBe(7)
  })

  it('stamps sessionId onto the created record', () => {
    const out = applyEvent([], { kind: 'message.created', ...baseEvent, prompt: 'g' })
    expect(out[0].sessionId).toBe('ses-1')
  })

  it('records resource usage on message.usage without changing status', () => {
    const used = { tokens: 900, calls: 2, wallMs: 1500, usdCents: 3, cacheRead: 0, cacheWrite: 0 }
    const next = applyEvent(seed('running', { prompt: 'do x' }), {
      kind: 'message.usage',
      ...baseEvent,
      used,
      contextTokens: 1200,
      contextWindow: 200_000,
    })
    expect(next[0].used).toEqual(used)
    expect(next[0].status).toBe('running')
  })

  it('stores the plan on message.plan and replaces it wholesale on the next plan', () => {
    const first = applyEvent(seed('running', { prompt: 'do x' }), {
      kind: 'message.plan',
      ...baseEvent,
      todos: [{ content: 'step one', status: 'in_progress' }],
    })
    expect(first[0].plan).toEqual([{ content: 'step one', status: 'in_progress' }])
    expect(first[0].status).toBe('running')

    const second = applyEvent(first, {
      kind: 'message.plan',
      ...baseEvent,
      todos: [
        { content: 'step one', status: 'completed' },
        { content: 'step two', status: 'in_progress' },
      ],
    })
    expect(second[0].plan).toHaveLength(2)
    expect(second[0].plan?.[0]).toEqual({ content: 'step one', status: 'completed' })
  })

  it('records message.spawned append-only on the parent without changing status', () => {
    const next = applyEvent(seed('running'), { kind: 'message.spawned', ...baseEvent, childMessageId: 'child-1' })
    expect(next[0].status).toBe('running')
    expect(next[0].events).toHaveLength(1)
    expect(next[0].events[0]).toMatchObject({ kind: 'message.spawned', childMessageId: 'child-1' })
  })

  it('stubs + appends for a conversation turn (message.progress under a fresh messageId)', () => {
    // A live conversation turn arrives as message.progress with messageId:
    // turnId and no preceding message.created (there is no message row). The
    // unknown-message fallback must stub a record so the inner event renders,
    // and a later progress event for the same turn appends to the same record
    // (message-id namespace).
    const ev1 = applyEvent([], {
      kind: 'message.progress',
      ts: 1,
      seq: 1,
      messageId: 'turn-1',
      sessionId: 'ses-1',
      event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 },
    })
    expect(ev1).toHaveLength(1)
    expect(ev1[0].id).toBe('turn-1')
    expect(ev1[0].events).toHaveLength(1)
    const ev2 = applyEvent(ev1, {
      kind: 'message.progress',
      ts: 2,
      seq: 2,
      messageId: 'turn-1',
      sessionId: 'ses-1',
      event: { kind: 'llm.message', role: 'assistant', content: 'yo', ts: 2 },
    })
    expect(ev2[0].events).toHaveLength(2)
  })
})
