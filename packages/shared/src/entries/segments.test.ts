import type { EntryRow, SessionEntry } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildSegments } from './segments'
import type { SessionView } from './session-view'
import { emptySessionView } from './session-view'

function row(rowId: number, entry: SessionEntry): EntryRow {
  return { rowId, entry }
}

function viewWithEntries(rows: EntryRow[]): SessionView {
  return { ...emptySessionView(), entries: rows, cursor: rows.length }
}

describe('buildSegments — messages', () => {
  it('maps a user message entry to a user segment', () => {
    const rows = [
      row(1, {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-07-16T00:00:00Z',
        message: { role: 'user', content: 'hello there' },
      }),
    ]
    const segments = buildSegments(viewWithEntries(rows))
    expect(segments).toEqual([expect.objectContaining({ kind: 'user', text: 'hello there' })])
  })

  it('splits an assistant message into text/thinking/toolCall segments', () => {
    const rows = [
      row(1, {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-07-16T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me think' },
            { type: 'text', text: 'here is the answer' },
            { type: 'toolCall', id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } },
          ],
        },
      }),
    ]
    const segments = buildSegments(viewWithEntries(rows))
    expect(segments).toEqual([
      expect.objectContaining({ kind: 'reasoning', text: 'let me think' }),
      expect.objectContaining({ kind: 'assistant', text: 'here is the answer' }),
      expect.objectContaining({
        kind: 'tool',
        tool: 'read_file',
        ok: null,
        input: { path: 'a.ts' },
        toolCallId: 'tc1',
      }),
    ])
  })

  it('closes the matching open tool segment when a toolResult entry arrives (by toolCallId)', () => {
    const rows = [
      row(1, {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-07-16T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } }],
        },
      }),
      row(2, {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2026-07-16T00:00:01Z',
        message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'file contents' }] },
      }),
    ]
    const segments = buildSegments(viewWithEntries(rows))
    expect(segments).toEqual([
      expect.objectContaining({
        kind: 'tool',
        tool: 'read_file',
        ok: true,
        output: 'file contents',
        toolCallId: 'tc1',
      }),
    ])
  })

  it('closes the oldest open tool segment via FIFO fallback when toolCallId is missing', () => {
    const rows = [
      row(1, {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-07-16T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'read_file', arguments: {} }],
        },
      }),
      row(2, {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2026-07-16T00:00:01Z',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] },
      }),
    ]
    const segments = buildSegments(viewWithEntries(rows))
    expect(segments).toEqual([expect.objectContaining({ kind: 'tool', tool: 'read_file', ok: true, output: 'ok' })])
  })
})

describe('buildSegments — custom entries', () => {
  it('renders a labeled event segment for a known customType (delegation)', () => {
    const rows = [
      row(1, {
        type: 'custom',
        id: 'e1',
        parentId: null,
        timestamp: '2026-07-16T00:00:00Z',
        customType: 'delegation',
        data: { childSessionId: 's2', agentDefId: 'engineer', prompt: 'do it' },
      }),
    ]
    const segments = buildSegments(viewWithEntries(rows))
    expect(segments).toEqual([expect.objectContaining({ kind: 'event', label: 'delegation' })])
  })

  it('renders a generic labeled event segment for an unknown customType (open-union bet)', () => {
    const rows = [
      row(1, {
        type: 'custom',
        id: 'e1',
        parentId: null,
        timestamp: '2026-07-16T00:00:00Z',
        customType: 'something_new',
        data: { foo: 'bar' },
      }),
    ]
    const segments = buildSegments(viewWithEntries(rows))
    expect(segments).toEqual([expect.objectContaining({ kind: 'event', label: 'something_new' })])
  })
})

describe('buildSegments — streaming overlay + pendingTools', () => {
  it('appends a trailing assistant segment for the streaming partial message', () => {
    const view: SessionView = {
      ...emptySessionView(),
      streaming: { role: 'assistant', content: [{ type: 'text', text: 'still typing' }] },
    }
    const segments = buildSegments(view)
    expect(segments).toEqual([expect.objectContaining({ kind: 'assistant', text: 'still typing' })])
  })

  it('renders pendingTools as running tool segments', () => {
    const view: SessionView = {
      ...emptySessionView(),
      pendingTools: { t1: { toolName: 'read_file', args: { path: 'a.ts' } } },
    }
    const segments = buildSegments(view)
    expect(segments).toEqual([
      expect.objectContaining({ kind: 'tool', tool: 'read_file', ok: null, input: { path: 'a.ts' }, toolCallId: 't1' }),
    ])
  })

  it('does not duplicate a pending tool already represented by an open entry-based tool segment', () => {
    const rows = [
      row(1, {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-07-16T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc1', name: 'read_file', arguments: {} }],
        },
      }),
    ]
    const view: SessionView = {
      ...viewWithEntries(rows),
      pendingTools: { tc1: { toolName: 'read_file', args: {} } },
    }
    const segments = buildSegments(view)
    expect(segments.filter((s) => s.kind === 'tool')).toHaveLength(1)
  })
})
