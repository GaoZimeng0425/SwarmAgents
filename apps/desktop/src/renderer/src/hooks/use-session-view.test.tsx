// @vitest-environment jsdom

import type { AgentWireEvent, EntryRow } from '@swarm/protocol'
import { applyWireEvent, type SessionView } from '@swarm/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '../lib/api'
import { sessionViewKey, useSessionView } from './use-session-view'

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

// A finalized user-message row.
function userRow(rowId: number, text: string): EntryRow {
  return {
    rowId,
    entry: {
      id: `e${rowId}`,
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: { role: 'user', content: text },
    },
  }
}

function newQc(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSessionView', () => {
  it('hydrates from getSessionEntries on mount', async () => {
    vi.spyOn(api.swarmApi, 'getSessionEntries').mockResolvedValue([userRow(1, 'hello'), userRow(2, 'world')])
    const qc = newQc()
    const { result } = renderHook(() => useSessionView('s1'), { wrapper: makeWrapper(qc) })

    await waitFor(() => expect(result.current.view.entries).toHaveLength(2))
    expect(result.current.view.cursor).toBe(2)
    expect(result.current.segments.map((s) => s.kind === 'user' && s.text)).toEqual(['hello', 'world'])
  })

  it('folds a live entry_appended event into the view', async () => {
    vi.spyOn(api.swarmApi, 'getSessionEntries').mockResolvedValue([userRow(1, 'hello')])
    const qc = newQc()
    const { result } = renderHook(() => useSessionView('s1'), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(result.current.view.entries).toHaveLength(1))

    const evt: AgentWireEvent = { kind: 'entry_appended', sessionId: 's1', rowId: 2, entry: userRow(2, 'live').entry }
    act(() => {
      qc.setQueryData<SessionView>(sessionViewKey('s1'), (prev) => applyWireEvent(prev ?? result.current.view, evt))
    })

    await waitFor(() => expect(result.current.view.entries).toHaveLength(2))
    expect(result.current.view.cursor).toBe(2)
  })

  it('re-pulls from the cursor and self-heals when a gap is detected', async () => {
    const getEntries = vi
      .spyOn(api.swarmApi, 'getSessionEntries')
      // Initial load returns only row 1.
      .mockResolvedValueOnce([userRow(1, 'one')])
      // Gap re-pull (afterRowId = 1) returns the missed rows 2 and 3.
      .mockResolvedValueOnce([userRow(2, 'two'), userRow(3, 'three')])

    const qc = newQc()
    const { result } = renderHook(() => useSessionView('s1'), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(result.current.view.entries).toHaveLength(1))

    // A non-contiguous entry_appended (rowId 4 while cursor is 1) trips gapDetected.
    const gapEvt: AgentWireEvent = {
      kind: 'entry_appended',
      sessionId: 's1',
      rowId: 4,
      entry: userRow(4, 'four').entry,
    }
    act(() => {
      qc.setQueryData<SessionView>(sessionViewKey('s1'), (prev) => applyWireEvent(prev ?? result.current.view, gapEvt))
    })

    // The hook's gap effect re-pulls from the cursor; rows 2+3 fill the hole.
    await waitFor(() => expect(result.current.view.entries.map((e) => e.rowId)).toEqual([1, 2, 3]))
    expect(result.current.view.gapDetected).toBe(false)
    expect(getEntries).toHaveBeenCalledWith('s1', 1)
  })

  it('does not strand early rows when a live entry_appended races the catch-up load (open a running session)', async () => {
    // Catch-up load is deferred: getSessionEntries resolves only when we say so,
    // so a live event can arrive first — the exact "open an actively-running
    // session" race. The empty seed must NOT be in the cache, or the live event
    // would anchor the cursor on it and the catch-up would drop rows below.
    let resolveEntries: (rows: EntryRow[]) => void = () => {}
    vi.spyOn(api.swarmApi, 'getSessionEntries').mockReturnValue(
      new Promise<EntryRow[]>((resolve) => {
        resolveEntries = resolve
      })
    )

    const qc = newQc()
    const { result } = renderHook(() => useSessionView('s1'), { wrapper: makeWrapper(qc) })

    // While the catch-up is still pending, a live entry_appended (rowId 5) folds
    // through the SAME guard use-events-subscription uses. With a persisted empty
    // seed this would anchor cursor=5; the placeholder keeps prev undefined so
    // the guard drops it (it will arrive in the catch-up rows anyway).
    const live: AgentWireEvent = { kind: 'entry_appended', sessionId: 's1', rowId: 5, entry: userRow(5, 'five').entry }
    act(() => {
      qc.setQueryData<SessionView>(sessionViewKey('s1'), (prev) => (prev ? applyWireEvent(prev, live) : prev))
    })

    // The catch-up resolves with the full log rows 1..5.
    await act(async () => {
      resolveEntries([
        userRow(1, 'one'),
        userRow(2, 'two'),
        userRow(3, 'three'),
        userRow(4, 'four'),
        userRow(5, 'five'),
      ])
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.view.entries.map((e) => e.rowId)).toEqual([1, 2, 3, 4, 5]))
    expect(result.current.view.cursor).toBe(5)
    expect(result.current.view.gapDetected).toBe(false)
  })

  it('streams an in-place assistant message, then finalizes it via entry_appended', async () => {
    vi.spyOn(api.swarmApi, 'getSessionEntries').mockResolvedValue([userRow(1, 'hi')])
    const qc = newQc()
    const { result } = renderHook(() => useSessionView('s1'), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(result.current.view.entries).toHaveLength(1))

    // Partial streaming message renders as a trailing assistant segment.
    const upd: AgentWireEvent = {
      kind: 'message_update',
      sessionId: 's1',
      runId: 'r1',
      message: { role: 'assistant', content: 'partial…' },
    }
    act(() => {
      qc.setQueryData<SessionView>(sessionViewKey('s1'), (prev) => applyWireEvent(prev ?? result.current.view, upd))
    })
    await waitFor(() => {
      const assistants = result.current.segments.filter((s) => s.kind === 'assistant')
      expect(assistants.map((s) => s.kind === 'assistant' && s.text)).toContain('partial…')
    })

    // The finalized entry lands, and the streaming overlay clears (message_end).
    const finalRow = {
      rowId: 2,
      entry: {
        id: 'a2',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'message' as const,
        message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
      },
    }
    const appended: AgentWireEvent = { kind: 'entry_appended', sessionId: 's1', rowId: 2, entry: finalRow.entry }
    const ended: AgentWireEvent = { kind: 'message_end', sessionId: 's1', runId: 'r1', message: {} }
    act(() => {
      qc.setQueryData<SessionView>(sessionViewKey('s1'), (prev) => {
        const base = prev ?? result.current.view
        return applyWireEvent(applyWireEvent(base, appended), ended)
      })
    })

    await waitFor(() => {
      const assistants = result.current.segments.filter((s) => s.kind === 'assistant')
      expect(assistants.map((s) => s.kind === 'assistant' && s.text)).toContain('final answer')
    })
    expect(result.current.view.streaming).toBeUndefined()
  })
})
