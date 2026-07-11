// apps/desktop/src/renderer/src/lib/workspace/build-timeline.test.ts

import type { MessageRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { buildTimeline } from './build-timeline'

function mkRun(over: Partial<MessageRecord> & Pick<MessageRecord, 'id'>): MessageRecord {
  return {
    sessionId: 's1',
    prompt: 'g',
    status: 'running',
    summary: null,
    createdAt: 1000,
    attachments: [],
    order: 0,
    events: [],
    ...over,
  }
}

describe('buildTimeline', () => {
  it('returns an empty list for runs with no events', () => {
    expect(buildTimeline([mkRun({ id: 'r1' })])).toEqual([])
  })

  it('maps message.created → start row with the prompt', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'message.created', sessionId: 's1', messageId: 'r1', order: 1, ts: 100, prompt: '修复登录' } as any,
      ],
    })
    const rows = buildTimeline([run])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'start', label: '修复登录', ts: 100 })
  })

  it('maps message.tool_call → tool row with the tool name', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.tool_call',
          sessionId: 's1',
          messageId: 'r1',
          order: 2,
          ts: 200,
          tool: 'shell',
          args: {},
        } as any,
      ],
    })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'tool', label: 'shell', ts: 200 })
  })

  it('maps message.permission_request → permission row', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.permission_request',
          sessionId: 's1',
          messageId: 'r1',
          order: 3,
          ts: 300,
          actionId: 'a1',
          risk: 'high',
          summary: 'rm -rf',
          payload: null,
        } as any,
      ],
    })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'permission', label: 'rm -rf', ts: 300 })
  })

  it('maps message.complete → complete row with summary', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'message.complete', sessionId: 's1', messageId: 'r1', order: 4, ts: 400, summary: '完成' } as any,
      ],
    })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'complete', label: '完成', ts: 400 })
  })

  it('maps message.error → error row with the message', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.error',
          sessionId: 's1',
          messageId: 'r1',
          order: 5,
          ts: 500,
          error: { code: 'X', message: '炸了', tier: 'fatal' },
        } as any,
      ],
    })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'error', label: '炸了', ts: 500 })
  })

  it('filters out message.progress events (too dense)', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.progress',
          sessionId: 's1',
          messageId: 'r1',
          order: 6,
          ts: 600,
          event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 600 },
        } as any,
      ],
    })
    expect(buildTimeline([run])).toEqual([])
  })

  it('also filters message.usage / message.plan / message.delegation_plan / message.spawned', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.usage',
          sessionId: 's1',
          messageId: 'r1',
          order: 7,
          ts: 700,
          used: { inputTokens: 1, outputTokens: 1 },
        } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'message.plan', sessionId: 's1', messageId: 'r1', order: 8, ts: 800, todos: [] } as any,
      ],
    })
    expect(buildTimeline([run])).toEqual([])
  })

  it('flattens multiple runs and sorts by ts ascending', () => {
    const r1 = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'message.created', sessionId: 's1', messageId: 'r1', order: 1, ts: 300, prompt: '晚的' } as any,
      ],
    })
    const r2 = mkRun({
      id: 'r2',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'message.created', sessionId: 's1', messageId: 'r2', order: 1, ts: 100, prompt: '早的' } as any,
      ],
    })
    const rows = buildTimeline([r1, r2])
    expect(rows.map((r) => r.label)).toEqual(['早的', '晚的'])
  })

  it('each row has a unique id (messageId + seq)', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'message.created', sessionId: 's1', messageId: 'r1', order: 1, ts: 100, prompt: 'a' } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'message.complete', sessionId: 's1', messageId: 'r1', order: 2, ts: 200, summary: 'b' } as any,
      ],
    })
    const rows = buildTimeline([run])
    expect(rows.map((r) => r.id)).toEqual(['r1:1', 'r1:2'])
  })
})
