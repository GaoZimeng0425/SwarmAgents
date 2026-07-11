// apps/desktop/src/renderer/src/lib/workspace/build-timeline.test.ts

import type { RunRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { buildTimeline } from './build-timeline'

function mkRun(over: Partial<RunRecord> & Pick<RunRecord, 'id'>): RunRecord {
  return {
    sessionId: 's1',
    prompt: 'g',
    status: 'running',
    summary: null,
    startedAt: 1000,
    attachments: [],
    events: [],
    ...over,
  }
}

describe('buildTimeline', () => {
  it('returns an empty list for runs with no events', () => {
    expect(buildTimeline([mkRun({ id: 'r1' })])).toEqual([])
  })

  it('maps run.created → start row with the goal', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'run.created', sessionId: 's1', runId: 'r1', seq: 1, ts: 100, prompt: '修复登录' } as any,
      ],
    })
    const rows = buildTimeline([run])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'start', label: '修复登录', ts: 100 })
  })

  it('maps run.tool_call → tool row with the tool name', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'run.tool_call', sessionId: 's1', runId: 'r1', seq: 2, ts: 200, tool: 'shell', args: {} } as any,
      ],
    })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'tool', label: 'shell', ts: 200 })
  })

  it('maps run.permission_request → permission row', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'run.permission_request',
          sessionId: 's1',
          runId: 'r1',
          seq: 3,
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

  it('maps run.complete → complete row with summary', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'run.complete', sessionId: 's1', runId: 'r1', seq: 4, ts: 400, summary: '完成' } as any,
      ],
    })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'complete', label: '完成', ts: 400 })
  })

  it('maps run.error → error row with the message', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'run.error',
          sessionId: 's1',
          runId: 'r1',
          seq: 5,
          ts: 500,
          error: { code: 'X', message: '炸了', tier: 'fatal' },
        } as any,
      ],
    })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'error', label: '炸了', ts: 500 })
  })

  it('filters out run.progress events (too dense)', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'run.progress',
          sessionId: 's1',
          runId: 'r1',
          seq: 6,
          ts: 600,
          event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 600 },
        } as any,
      ],
    })
    expect(buildTimeline([run])).toEqual([])
  })

  it('also filters run.usage / run.plan / run.delegation_plan / run.spawned', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'run.usage',
          sessionId: 's1',
          runId: 'r1',
          seq: 7,
          ts: 700,
          used: { inputTokens: 1, outputTokens: 1 },
        } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'run.plan', sessionId: 's1', runId: 'r1', seq: 8, ts: 800, todos: [] } as any,
      ],
    })
    expect(buildTimeline([run])).toEqual([])
  })

  it('flattens multiple runs and sorts by ts ascending', () => {
    const r1 = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'run.created', sessionId: 's1', runId: 'r1', seq: 1, ts: 300, prompt: '晚的' } as any,
      ],
    })
    const r2 = mkRun({
      id: 'r2',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'run.created', sessionId: 's1', runId: 'r2', seq: 1, ts: 100, prompt: '早的' } as any,
      ],
    })
    const rows = buildTimeline([r1, r2])
    expect(rows.map((r) => r.label)).toEqual(['早的', '晚的'])
  })

  it('each row has a unique id (runId + seq)', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'run.created', sessionId: 's1', runId: 'r1', seq: 1, ts: 100, prompt: 'a' } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { kind: 'run.complete', sessionId: 's1', runId: 'r1', seq: 2, ts: 200, summary: 'b' } as any,
      ],
    })
    const rows = buildTimeline([run])
    expect(rows.map((r) => r.id)).toEqual(['r1:1', 'r1:2'])
  })
})
