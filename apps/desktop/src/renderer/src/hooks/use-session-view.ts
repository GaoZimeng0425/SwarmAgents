import { useEffect, useMemo } from 'react'
import { buildSegments, emptySessionView, hydrate, type Segment, type SessionView } from '@swarm/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'

/** TanStack Query key for one session's live SessionView (wire-v3 reducer state). */
export const sessionViewKey = (sessionId: string): readonly ['session-view', string] => ['session-view', sessionId]

/** Key for the set of currently-running session ids, fed by agent_start/agent_end. */
export const RUNNING_SESSIONS_KEY = ['running-sessions'] as const

/**
 * The live SessionView for one session, kept in the query cache keyed by
 * sessionId. Two write paths feed the same cache entry:
 *  - this hook's effects: a full catch-up load on mount (getSessionEntries →
 *    hydrate) and a gap self-heal (re-pull from cursor when gapDetected).
 *  - use-events-subscription: folds each live AgentWireEvent through
 *    applyWireEvent into `sessionViewKey(sessionId)`.
 *
 * Returns the current view plus its flattened render segments. When no session
 * is selected, returns an empty view.
 */
export function useSessionView(sessionId: string | null): { view: SessionView; segments: Segment[] } {
  const qc = useQueryClient()

  // The query is a passive state container: it never fetches (enabled:false),
  // starting from an empty view. All content is written with qc.setQueryData —
  // by the catch-up effect below and by use-events-subscription's live folding.
  // (A fetching queryFn would clobber those setQueryData writes when it
  // resolved, so the loading is driven from the effect instead.)
  //
  // The empty seed is `placeholderData`, NOT `initialData`: placeholderData is
  // returned as `data` but is NOT written to the cache, so `qc.getQueryData`
  // stays undefined until the catch-up hydrate lands. That keeps
  // use-events-subscription's `prev ? applyWireEvent(prev, e) : prev` guard
  // dropping live events until history is loaded — otherwise a mid-stream
  // entry_appended would anchor the cursor on the empty view before catch-up,
  // permanently stranding the rows below it (the "open a running session" case).
  const { data } = useQuery<SessionView>({
    queryKey: sessionId ? sessionViewKey(sessionId) : (['session-view', '__none__'] as const),
    queryFn: () => emptySessionView(),
    enabled: false,
    placeholderData: emptySessionView,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  })

  const view = data ?? emptySessionView()

  // Catch-up load on session switch: pull the full entry log and merge it in.
  // hydrate() drops rows at/before the current cursor, so any live events that
  // folded in first are preserved and this stays idempotent.
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    void swarmApi.getSessionEntries(sessionId).then((rows) => {
      if (!alive) return
      qc.setQueryData<SessionView>(sessionViewKey(sessionId), (prev) => hydrate(prev ?? emptySessionView(), rows))
    })
    return () => {
      alive = false
    }
  }, [sessionId, qc])

  // Gap self-heal: applyWireEvent sets gapDetected when an entry_appended
  // arrives non-contiguously (a dropped broadcast). Re-pull from the cursor to
  // fill the hole; hydrate() clears gapDetected.
  const gapDetected = view.gapDetected
  const cursor = view.cursor
  useEffect(() => {
    if (!sessionId || !gapDetected) return
    let alive = true
    void swarmApi.getSessionEntries(sessionId, cursor).then((rows) => {
      if (!alive) return
      qc.setQueryData<SessionView>(sessionViewKey(sessionId), (prev) => hydrate(prev ?? emptySessionView(), rows))
    })
    return () => {
      alive = false
    }
  }, [sessionId, gapDetected, cursor, qc])

  const segments = useMemo(() => buildSegments(view), [view])
  return { view, segments }
}

/** The set of session ids with an in-flight run, fed by agent_start/agent_end. */
export function useRunningSessions(): Set<string> {
  const { data } = useQuery<Set<string>>({
    queryKey: RUNNING_SESSIONS_KEY,
    queryFn: () => new Set<string>(),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  })
  return data ?? new Set<string>()
}
