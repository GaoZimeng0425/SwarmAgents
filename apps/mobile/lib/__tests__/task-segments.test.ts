import type { MessageEvent, MessageWireEvent } from '@swarm/protocol'

import { buildSegments } from '../task-segments'

// Helper: build a MessageEvent wrapping a MessageWireEvent.
function msg(wire: MessageWireEvent, seq = 1): MessageEvent {
  return { messageId: wire.messageId, parentMessageId: null, seq, ts: wire.ts, event: wire }
}

const base = { sessionId: 's1', messageId: 'm1', seq: 1, ts: 1000 }

describe('buildSegments', () => {
  it('produces a user segment from message.created', () => {
    const events = [msg({ ...base, kind: 'message.created', prompt: 'hello' })]
    const segs = buildSegments(events)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'user', text: 'hello' })
  })

  it('coalesces consecutive assistant llm.message chunks into one segment', () => {
    const events = [
      msg({ ...base, kind: 'message.progress', event: { kind: 'llm.message', role: 'assistant', content: 'Hello ', ts: 1000 } }, 1),
      msg({ ...base, kind: 'message.progress', event: { kind: 'llm.message', role: 'assistant', content: 'World', ts: 1001 } }, 2),
    ]
    const segs = buildSegments(events)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'assistant', text: 'Hello World' })
  })

  it('coalesces consecutive reasoning chunks into one segment', () => {
    const events = [
      msg({ ...base, kind: 'message.progress', event: { kind: 'reasoning', content: 'Thinking ', ts: 1000 } }, 1),
      msg({ ...base, kind: 'message.progress', event: { kind: 'reasoning', content: 'more', ts: 1001 } }, 2),
    ]
    const segs = buildSegments(events)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'reasoning', text: 'Thinking more' })
  })

  it('pairs tool.call and tool.result by callId', () => {
    const events = [
      msg({ ...base, kind: 'message.progress', event: { kind: 'tool.call', tool: 'Read', args: { path: '/a.ts' }, callId: 'c1', ts: 1000 } }, 1),
      msg({ ...base, kind: 'message.progress', event: { kind: 'tool.call', tool: 'Write', args: { path: '/b.ts' }, callId: 'c2', ts: 1001 } }, 2),
      msg({ ...base, kind: 'message.progress', event: { kind: 'tool.result', ok: true, payload: { text: 'done' }, callId: 'c2', ts: 1002 } }, 3),
      msg({ ...base, kind: 'message.progress', event: { kind: 'tool.result', ok: true, payload: { text: 'ok' }, callId: 'c1', ts: 1003 } }, 4),
    ]
    const segs = buildSegments(events)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ kind: 'tool', tool: 'Read', ok: true, output: 'ok' })
    expect(segs[1]).toMatchObject({ kind: 'tool', tool: 'Write', ok: true, output: 'done' })
  })

  it('falls back to FIFO pairing when callId is absent', () => {
    const events = [
      msg({ ...base, kind: 'message.progress', event: { kind: 'tool.call', tool: 'Read', args: {}, ts: 1000 } }, 1),
      msg({ ...base, kind: 'message.progress', event: { kind: 'tool.result', ok: false, payload: { text: 'err' }, ts: 1001 } }, 2),
    ]
    const segs = buildSegments(events)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'tool', tool: 'Read', ok: false, output: 'err' })
  })

  it('produces an error segment from message.error', () => {
    const events = [
      msg({ ...base, kind: 'message.error', error: { code: 'fatal', message: 'boom', tier: 'fatal' } }),
    ]
    const segs = buildSegments(events)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'error', label: 'error', detail: 'boom' })
  })

  it('labels cancelled errors as "stopped"', () => {
    const events = [
      msg({ ...base, kind: 'message.error', error: { code: 'cancelled', message: 'user stopped', tier: 'gave_up' } }),
    ]
    const segs = buildSegments(events)
    expect(segs[0]).toMatchObject({ kind: 'error', label: 'stopped' })
  })

  it('produces an event segment for permission_request', () => {
    const events = [
      msg({ ...base, kind: 'message.permission_request', actionId: 'a1', risk: 'high', summary: 'run rm -rf', payload: {} }),
    ]
    const segs = buildSegments(events)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'event', label: 'permission (high)', detail: 'run rm -rf' })
  })

  it('does not produce a segment for message.complete', () => {
    const events = [
      msg({ ...base, kind: 'message.progress', event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1000 } }, 1),
      msg({ ...base, kind: 'message.complete', summary: 'hi' }, 2),
    ]
    const segs = buildSegments(events)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'assistant', text: 'hi' })
  })

  it('produces an orphan event segment for a tool result without a matching call', () => {
    const events = [
      msg({ ...base, kind: 'message.progress', event: { kind: 'tool.result', ok: true, payload: { text: 'orphan' }, callId: 'unknown', ts: 1000 } }, 1),
    ]
    const segs = buildSegments(events)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'event', label: 'tool result', detail: 'orphan' })
  })

  it('interleaves user, reasoning, assistant, and tool segments in order', () => {
    const events = [
      msg({ ...base, kind: 'message.created', prompt: 'do something' }, 1),
      msg({ ...base, kind: 'message.progress', event: { kind: 'reasoning', content: 'planning', ts: 1000 } }, 2),
      msg({ ...base, kind: 'message.progress', event: { kind: 'tool.call', tool: 'Bash', args: { cmd: 'ls' }, callId: 'c1', ts: 1001 } }, 3),
      msg({ ...base, kind: 'message.progress', event: { kind: 'tool.result', ok: true, payload: { text: 'file.ts' }, callId: 'c1', ts: 1002 } }, 4),
      msg({ ...base, kind: 'message.progress', event: { kind: 'llm.message', role: 'assistant', content: 'Done!', ts: 1003 } }, 5),
    ]
    const segs = buildSegments(events)
    expect(segs.map((s) => s.kind)).toEqual(['user', 'reasoning', 'tool', 'assistant'])
  })
})
