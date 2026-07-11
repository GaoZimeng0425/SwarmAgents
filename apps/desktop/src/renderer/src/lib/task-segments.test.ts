import type { MessageRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { taskSegments } from './task-segments'

function rec(events: MessageRecord['events'], attachments: MessageRecord['attachments'] = []): MessageRecord {
  return {
    id: 't1',
    sessionId: 's1',
    prompt: 'do x',
    status: 'running',
    summary: null,
    createdAt: 1,
    attachments,
    order: 1,
    events,
  }
}
const prog = (event: unknown) =>
  ({ kind: 'message.progress', sessionId: 's1', messageId: 't1', event, ts: 1 }) as MessageRecord['events'][number]

describe('taskSegments', () => {
  it('emits the goal as the first user segment when there is no user-message event (sub-agent path)', () => {
    const segs = taskSegments(rec([]))
    expect(segs[0]).toMatchObject({ kind: 'user', text: 'do x' })
  })

  it('carries attachments on the synthetic goal segment (sub-agent path)', () => {
    const segs = taskSegments(rec([], [{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }]))
    const user = segs.find((s) => s.kind === 'user')
    expect(user && 'attachments' in user && user.attachments).toEqual([
      { data: 'AAAA', mimeType: 'image/png', name: 'a.png' },
    ])
  })

  it('coalesces consecutive assistant deltas into one segment', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'llm.message', role: 'assistant', content: 'Hel', ts: 1 }),
        prog({ kind: 'llm.message', role: 'assistant', content: 'lo', ts: 2 }),
      ])
    )
    const assistant = segs.filter((s) => s.kind === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]).toMatchObject({ text: 'Hello' })
  })

  it('coalesces consecutive reasoning deltas into one reasoning segment', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'reasoning', content: 'Let me ', ts: 1 }),
        prog({ kind: 'reasoning', content: 'think.', ts: 2 }),
      ])
    )
    const reasoning = segs.filter((s) => s.kind === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({ text: 'Let me think.' })
  })

  it('renders a follow-up user message (role:user) as its own user segment', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'llm.message', role: 'user', content: 'do x', ts: 1 }),
        prog({ kind: 'llm.message', role: 'assistant', content: 'done', ts: 2 }),
        prog({ kind: 'llm.message', role: 'user', content: '继续', ts: 3 }),
      ])
    )
    const users = segs.filter((s) => s.kind === 'user')
    // Both user messages come from real events (no synthetic goal bubble).
    expect(users).toHaveLength(2)
    expect(users[1]).toMatchObject({ kind: 'user', text: '继续' })
  })

  it('renders the first user message from its real event, not a synthetic goal bubble', () => {
    const segs = taskSegments(
      rec([
        {
          kind: 'message.progress',
          sessionId: 's1',
          messageId: 't1',
          event: { kind: 'llm.message', role: 'user', content: 'hello', ts: 5 },
          ts: 5,
          seq: 7,
        } as MessageRecord['events'][number],
      ])
    )
    const users = segs.filter((s) => s.kind === 'user')
    // No synthetic goal bubble (task.prompt is 'do x'); the single user segment is
    // the real event, carrying the event's seq (7), not the createdAt fallback (1).
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ kind: 'user', text: 'hello' })
    expect((users[0] as unknown as { order: number }).order).toBe(7)
  })

  it('carries task attachments on the first (event-derived) user segment', () => {
    const segs = taskSegments({
      ...rec([prog({ kind: 'llm.message', role: 'user', content: 'hi', ts: 1 })]),
      attachments: [{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }],
    })
    const users = segs.filter((s) => s.kind === 'user')
    // One user segment (from the event), and it carries the task's attachments
    // (preserves image rendering now that the bubble comes from the event).
    expect(users).toHaveLength(1)
    expect(users[0] && 'attachments' in users[0] && users[0].attachments).toEqual([
      { data: 'AAAA', mimeType: 'image/png', name: 'a.png' },
    ])
  })

  it('pairs a tool.call with its tool.result into one tool segment', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'fs', tool: 'read_file', args: { path: 'a' }, ts: 1 }),
        prog({ kind: 'tool.result', ok: true, payload: { text: 'contents' }, ts: 2 }),
      ])
    )
    const tools = segs.filter((s) => s.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ tool: 'read_file', ok: true, output: 'contents' })
    expect((tools[0] as { input: unknown }).input).toEqual({ path: 'a' })
  })

  it('carries an imagePath from the tool.result payload onto the tool segment', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'agent', tool: 'see_screen', args: {}, ts: 1 }),
        prog({
          kind: 'tool.result',
          ok: true,
          payload: { text: 'Screenshot at /tmp/s.png.', imagePath: '/tmp/s.png' },
          ts: 2,
        }),
      ])
    )
    expect(segs.find((s) => s.kind === 'tool')).toMatchObject({ tool: 'see_screen', imagePath: '/tmp/s.png' })
  })

  it('marks a failed tool result with ok:false', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'fs', tool: 'read_file', args: {}, ts: 1 }),
        prog({ kind: 'tool.result', ok: false, payload: { text: 'boom' }, ts: 2 }),
      ])
    )
    expect(segs.find((s) => s.kind === 'tool')).toMatchObject({ ok: false, output: 'boom' })
  })

  it('suppresses the update_plan call and its following result', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'plan', tool: 'update_plan', args: {}, ts: 1 }),
        prog({ kind: 'tool.result', ok: true, payload: {}, ts: 2 }),
      ])
    )
    expect(segs.some((s) => s.kind === 'tool' || s.kind === 'event')).toBe(false)
  })

  it('labels a cancelled task.error as "stopped", others as "error"', () => {
    const stopped = taskSegments(
      rec([
        {
          kind: 'message.error',
          sessionId: 's1',
          messageId: 't1',
          error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' },
          ts: 1,
          seq: 1,
        },
      ])
    )
    expect(stopped.find((s) => s.kind === 'error')).toMatchObject({ label: 'stopped', detail: 'Stopped by user.' })

    const failed = taskSegments(
      rec([
        {
          kind: 'message.error',
          sessionId: 's1',
          messageId: 't1',
          error: { code: 'boom', message: 'nope', tier: 'fatal' },
          ts: 1,
          seq: 1,
        },
      ])
    )
    expect(failed.find((s) => s.kind === 'error')).toMatchObject({ label: 'error', detail: 'nope' })
  })

  it('renders a persisted kind:error progress event like a live task.error', () => {
    const failed = taskSegments(
      rec([prog({ kind: 'error', error: { code: 'boom', message: 'nope', tier: 'fatal' }, ts: 1 })])
    )
    expect(failed.find((s) => s.kind === 'error')).toMatchObject({ label: 'error', detail: 'nope' })

    const stopped = taskSegments(
      rec([prog({ kind: 'error', error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' }, ts: 1 })])
    )
    expect(stopped.find((s) => s.kind === 'error')).toMatchObject({ label: 'stopped', detail: 'Stopped by user.' })
  })

  it('renders a permission_request as an event segment', () => {
    const segs = taskSegments(
      rec([
        {
          kind: 'message.permission_request',
          sessionId: 's1',
          messageId: 't1',
          actionId: 'a',
          risk: 'medium',
          summary: 'run rm',
          payload: {},
          ts: 1,
          seq: 1,
        },
      ])
    )
    expect(segs.find((s) => s.kind === 'event')).toMatchObject({ label: 'permission (medium)', detail: 'run rm' })
  })

  it('does not swallow a later tool result when update_plan had no result', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'plan', tool: 'update_plan', args: {}, ts: 1 }),
        prog({ kind: 'tool.call', server: 'fs', tool: 'read_file', args: { path: 'a' }, ts: 2 }),
        prog({ kind: 'tool.result', ok: true, payload: { text: 'contents' }, ts: 3 }),
      ])
    )
    const tools = segs.filter((s) => s.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ tool: 'read_file', ok: true, output: 'contents' })
  })

  it('leaves an unpaired tool.call as running (ok:null) when a new call follows', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'fs', tool: 'first', args: {}, ts: 1 }),
        prog({ kind: 'tool.call', server: 'fs', tool: 'second', args: {}, ts: 2 }),
      ])
    )
    const tools = segs.filter((s) => s.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ tool: 'first', ok: null, output: null })
    expect(tools[1]).toMatchObject({ tool: 'second', ok: null, output: null })
  })

  it('serializes a non-string tool payload as pretty JSON', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'fs', tool: 'list', args: {}, ts: 1 }),
        prog({ kind: 'tool.result', ok: true, payload: { count: 3 }, ts: 2 }),
      ])
    )
    expect(segs.find((s) => s.kind === 'tool')).toMatchObject({ output: '{\n  "count": 3\n}' })
  })

  it('pairs parallel tool calls by callId even when results arrive out of order', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'fs', tool: 'first', args: {}, callId: 'c1', ts: 1 }),
        prog({ kind: 'tool.call', server: 'fs', tool: 'second', args: {}, callId: 'c2', ts: 2 }),
        // Parallel execution: the second call finishes first.
        prog({ kind: 'tool.result', ok: true, payload: { text: 'from second' }, callId: 'c2', ts: 3 }),
        prog({ kind: 'tool.result', ok: true, payload: { text: 'from first' }, callId: 'c1', ts: 4 }),
      ])
    )
    const tools = segs.filter((s) => s.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ tool: 'first', ok: true, output: 'from first' })
    expect(tools[1]).toMatchObject({ tool: 'second', ok: true, output: 'from second' })
    // No stray "tool result" rows: every result paired with its call.
    expect(segs.some((s) => s.kind === 'event')).toBe(false)
  })

  it('falls back to FIFO pairing for calls without a callId', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'fs', tool: 'first', args: {}, ts: 1 }),
        prog({ kind: 'tool.call', server: 'fs', tool: 'second', args: {}, ts: 2 }),
        prog({ kind: 'tool.result', ok: true, payload: { text: 'a' }, ts: 3 }),
        prog({ kind: 'tool.result', ok: true, payload: { text: 'b' }, ts: 4 }),
      ])
    )
    const tools = segs.filter((s) => s.kind === 'tool')
    // Both resolve (no card stuck running), each to the FIFO-matched result.
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ ok: true, output: 'a' })
    expect(tools[1]).toMatchObject({ ok: true, output: 'b' })
    expect(segs.some((s) => s.kind === 'event')).toBe(false)
  })
})

describe('taskSegments order', () => {
  it('carries order from the UIEvent seq onto the segment', () => {
    const segs = taskSegments(
      rec([
        {
          kind: 'message.progress',
          sessionId: 's1',
          messageId: 't1',
          event: { kind: 'tool.call', server: 'fs', tool: 'read_file', args: {}, ts: 5 },
          ts: 1,
          seq: 42,
        } as MessageRecord['events'][number],
      ])
    )
    const tool = segs.find((s) => s.kind === 'tool') as unknown as { order?: number }
    expect(tool.order).toBe(42)
  })

  it('gives the goal segment the message.created order', () => {
    // MessageRecord.order is stamped once from message.created (see applyEvent);
    // the goal bubble takes task.order, so they match.
    const segs = taskSegments({
      ...rec([
        {
          kind: 'message.created',
          sessionId: 's1',
          messageId: 't1',
          prompt: 'do x',
          ts: 10,
          seq: 7,
        } as MessageRecord['events'][number],
      ]),
      order: 7,
    })
    expect((segs[0] as unknown as { order?: number }).order).toBe(7)
  })
})
