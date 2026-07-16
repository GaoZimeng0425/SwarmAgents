import type { AgentWireEvent, EntryRow } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { applyWireEvent, emptySessionView, hydrate } from './session-view'

const scope = { sessionId: 's1', runId: 'r1' }

function entryRow(rowId: number, id = `e${rowId}`): EntryRow {
  return {
    rowId,
    entry: {
      type: 'message',
      id,
      parentId: null,
      timestamp: '2026-07-16T00:00:00Z',
      message: { role: 'user', content: 'hi' },
    },
  }
}

describe('emptySessionView', () => {
  it('starts empty with cursor 0 and no gap', () => {
    const view = emptySessionView()
    expect(view).toEqual({
      entries: [],
      cursor: 0,
      running: false,
      pendingTools: {},
      gapDetected: false,
    })
  })
})

describe('applyWireEvent — entry_appended', () => {
  it('appends the first entry and advances the cursor', () => {
    const view = emptySessionView()
    const e: AgentWireEvent = { kind: 'entry_appended', sessionId: 's1', rowId: 1, entry: entryRow(1).entry }
    const next = applyWireEvent(view, e)
    expect(next.entries).toEqual([entryRow(1)])
    expect(next.cursor).toBe(1)
    expect(next.gapDetected).toBe(false)
  })

  it('appends a contiguous entry (rowId === cursor + 1) and advances the cursor', () => {
    const view = { ...emptySessionView(), entries: [entryRow(1)], cursor: 1 }
    const e: AgentWireEvent = { kind: 'entry_appended', sessionId: 's1', rowId: 2, entry: entryRow(2).entry }
    const next = applyWireEvent(view, e)
    expect(next.entries).toEqual([entryRow(1), entryRow(2)])
    expect(next.cursor).toBe(2)
  })

  it('sets gapDetected when rowId > cursor + 1, without appending', () => {
    const view = { ...emptySessionView(), entries: [entryRow(1)], cursor: 1 }
    const e: AgentWireEvent = { kind: 'entry_appended', sessionId: 's1', rowId: 5, entry: entryRow(5).entry }
    const next = applyWireEvent(view, e)
    expect(next.gapDetected).toBe(true)
    expect(next.entries).toEqual([entryRow(1)])
    expect(next.cursor).toBe(1)
  })

  it('ignores a duplicate/stale rowId <= cursor (idempotent replay)', () => {
    const view = { ...emptySessionView(), entries: [entryRow(1)], cursor: 1 }
    const e: AgentWireEvent = { kind: 'entry_appended', sessionId: 's1', rowId: 1, entry: entryRow(1).entry }
    const next = applyWireEvent(view, e)
    expect(next.entries).toEqual([entryRow(1)])
    expect(next.cursor).toBe(1)
    expect(next.gapDetected).toBe(false)
  })

  it('anchors the cursor at the first-ever rowId even when it is not 1 (mid-session subscription)', () => {
    const view = emptySessionView()
    const e: AgentWireEvent = { kind: 'entry_appended', sessionId: 's1', rowId: 7, entry: entryRow(7).entry }
    const next = applyWireEvent(view, e)
    expect(next.entries).toEqual([entryRow(7)])
    expect(next.cursor).toBe(7)
    expect(next.gapDetected).toBe(false)
  })
})

describe('hydrate', () => {
  it('clears gapDetected and merges in rows newer than the cursor', () => {
    const view = { ...emptySessionView(), entries: [entryRow(1)], cursor: 1, gapDetected: true }
    const next = hydrate(view, [entryRow(1), entryRow(2), entryRow(3)])
    expect(next.entries).toEqual([entryRow(1), entryRow(2), entryRow(3)])
    expect(next.cursor).toBe(3)
    expect(next.gapDetected).toBe(false)
  })

  it('is idempotent when called again with the same rows', () => {
    const view = { ...emptySessionView(), entries: [entryRow(1)], cursor: 1 }
    const once = hydrate(view, [entryRow(1), entryRow(2)])
    const twice = hydrate(once, [entryRow(1), entryRow(2)])
    expect(twice.entries).toEqual([entryRow(1), entryRow(2)])
    expect(twice.cursor).toBe(2)
  })

  it('anchors an empty view at the first batch even when it does not start at rowId 1 (mid-session subscription)', () => {
    const view = emptySessionView()
    const next = hydrate(view, [entryRow(5), entryRow(6)])
    expect(next.entries).toEqual([entryRow(5), entryRow(6)])
    expect(next.cursor).toBe(6)
    expect(next.gapDetected).toBe(false)
  })
})

describe('applyWireEvent — run lifecycle', () => {
  it('agent_start sets running and runId', () => {
    const view = emptySessionView()
    const next = applyWireEvent(view, { ...scope, kind: 'agent_start' })
    expect(next.running).toBe(true)
    expect(next.runId).toBe('r1')
  })

  it('agent_end clears running and captures the error message on failure', () => {
    const view = { ...emptySessionView(), running: true, runId: 'r1' }
    const next = applyWireEvent(view, { ...scope, kind: 'agent_end', status: 'failed', errorMessage: 'boom' })
    expect(next.running).toBe(false)
    expect(next.lastError).toBe('boom')
  })

  it('agent_end on completed status leaves lastError unset', () => {
    const view = { ...emptySessionView(), running: true, runId: 'r1' }
    const next = applyWireEvent(view, { ...scope, kind: 'agent_end', status: 'completed' })
    expect(next.running).toBe(false)
    expect(next.lastError).toBeUndefined()
  })

  it('turn_end sets usage', () => {
    const view = emptySessionView()
    const used = { tokens: 100, calls: 1, wallMs: 500, usdCents: 2, cacheRead: 0, cacheWrite: 0 }
    const next = applyWireEvent(view, {
      ...scope,
      kind: 'turn_end',
      used,
      contextTokens: 100,
      contextWindow: 200000,
      model: 'claude',
    })
    expect(next.usage).toEqual({ used, contextTokens: 100, contextWindow: 200000, model: 'claude' })
  })
})

describe('applyWireEvent — streaming', () => {
  it('message_update sets streaming', () => {
    const view = emptySessionView()
    const message = { role: 'assistant', content: [{ type: 'text', text: 'partial' }] }
    const next = applyWireEvent(view, { ...scope, kind: 'message_update', message })
    expect(next.streaming).toEqual(message)
  })

  it('message_end clears streaming', () => {
    const view = { ...emptySessionView(), streaming: { role: 'assistant', content: [] } }
    const next = applyWireEvent(view, { ...scope, kind: 'message_end', message: { role: 'assistant', content: [] } })
    expect(next.streaming).toBeUndefined()
  })

  it('agent_end clears streaming', () => {
    const view = { ...emptySessionView(), streaming: { role: 'assistant', content: [] } }
    const next = applyWireEvent(view, { ...scope, kind: 'agent_end', status: 'completed' })
    expect(next.streaming).toBeUndefined()
  })
})

describe('applyWireEvent — pendingTools', () => {
  it('tool_execution_start adds a pending tool', () => {
    const view = emptySessionView()
    const next = applyWireEvent(view, {
      ...scope,
      kind: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    })
    expect(next.pendingTools.t1).toEqual({ toolName: 'read_file', args: { path: 'a.ts' } })
  })

  it('tool_execution_update sets partialResult on the pending tool', () => {
    const view = {
      ...emptySessionView(),
      pendingTools: { t1: { toolName: 'read_file', args: { path: 'a.ts' } } },
    }
    const next = applyWireEvent(view, {
      ...scope,
      kind: 'tool_execution_update',
      toolCallId: 't1',
      toolName: 'read_file',
      partialResult: 'chunk',
    })
    expect(next.pendingTools.t1.partialResult).toBe('chunk')
  })

  it('tool_execution_update with no prior tool_execution_start creates an orphan pending tool with args left undefined', () => {
    // Post-gap race: the start fell in a dropped/un-hydrated window, so we
    // only ever see the update. args must not be fabricated (see the
    // PendingTool comment) — it stays undefined rather than `{}`.
    const view = emptySessionView()
    const next = applyWireEvent(view, {
      ...scope,
      kind: 'tool_execution_update',
      toolCallId: 't2',
      toolName: 'write_file',
      partialResult: 'chunk',
    })
    expect(next.pendingTools.t2).toEqual({ toolName: 'write_file', args: undefined, partialResult: 'chunk' })
  })

  it('tool_execution_end removes the pending tool', () => {
    const view = {
      ...emptySessionView(),
      pendingTools: { t1: { toolName: 'read_file', args: { path: 'a.ts' } } },
    }
    const next = applyWireEvent(view, {
      ...scope,
      kind: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'read_file',
      result: 'done',
      isError: false,
    })
    expect(next.pendingTools.t1).toBeUndefined()
  })
})
