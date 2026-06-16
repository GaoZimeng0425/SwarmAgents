import { describe, expect, it } from 'vitest'

import type { TaskRecord } from './apply-event'
import { taskSegments } from './task-segments'

function rec(events: TaskRecord['events'], attachments: TaskRecord['attachments'] = []): TaskRecord {
  return {
    id: 't1',
    sessionId: 's1',
    goal: 'do x',
    status: 'running',
    workerId: null,
    summary: null,
    startedAt: 1,
    attachments,
    events,
  }
}
const prog = (event: unknown) =>
  ({ kind: 'task.progress', sessionId: 's1', taskId: 't1', event, ts: 1 }) as TaskRecord['events'][number]

describe('taskSegments', () => {
  it('emits the goal as the first user segment', () => {
    const segs = taskSegments(rec([]))
    expect(segs[0]).toMatchObject({ kind: 'user', text: 'do x' })
  })

  it('carries attachments on the user segment', () => {
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
          kind: 'task.error',
          sessionId: 's1',
          taskId: 't1',
          error: { code: 'cancelled', message: 'Stopped by user.' },
          ts: 1,
        },
      ])
    )
    expect(stopped.find((s) => s.kind === 'error')).toMatchObject({ label: 'stopped', detail: 'Stopped by user.' })

    const failed = taskSegments(
      rec([{ kind: 'task.error', sessionId: 's1', taskId: 't1', error: { code: 'boom', message: 'nope' }, ts: 1 }])
    )
    expect(failed.find((s) => s.kind === 'error')).toMatchObject({ label: 'error', detail: 'nope' })
  })

  it('renders a permission_request as an event segment', () => {
    const segs = taskSegments(
      rec([
        {
          kind: 'task.permission_request',
          sessionId: 's1',
          taskId: 't1',
          workerId: 'w',
          actionId: 'a',
          risk: 'medium',
          summary: 'run rm',
          payload: {},
          ts: 1,
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
})
