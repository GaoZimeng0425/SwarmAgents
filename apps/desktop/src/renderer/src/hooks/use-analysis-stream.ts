// Generic streaming-analysis hook shared by the four card-based analysis panels
// (article / trending / bilibili / gmail-thread). Owns the phase state machine
// (idle → streaming → done | error), surfaces cached results, and triggers
// analysis.
//
// State lives in a global zustand store (not useState) so it survives panel
// unmount/remount — the "切走丢失" fix. The store is the single source of truth;
// streaming events (delta/complete/error) are dispatched into the store by the
// global useEventsSubscription hook, NOT here — so entries keep updating even
// when the user switches away from the panel mid-analysis.

import { useCallback, useEffect } from 'react'

import { type AnalysisStreamState, streamKey, useAnalysisStreamStore } from '@/stores/analysis-stream'

export type AnalysisPhase = 'idle' | 'streaming' | 'done' | 'error'

export type { AnalysisStreamState }

export type AnalysisStreamConfig<TResult> = {
  /** The analysis-target id, or null when nothing is selected. */
  id: string | null
  /** Event kinds for this flow. Only `complete` is used here — as the store
   *  namespace (so article-id '1' ≠ bilibili-bvid '1'). delta/complete/error
   *  are handled centrally by useEventsSubscription. */
  events: { delta: string; complete: string; error: string }
  /** Trigger the analysis (returns the sync ack). */
  trigger: () => Promise<{ ok: true } | { ok: false; message: string }>
  /** Previously-analyzed cached result, or null when none. The caller decides
   *  how to obtain it (object property, useQuery, etc.). */
  cachedResult: TResult | null
}

export type AnalysisStreamStateTyped<TResult> =
  | { phase: 'idle' }
  | { phase: 'streaming'; streamText: string }
  | { phase: 'done'; result: TResult; streamText: string }
  | { phase: 'error'; error: string }

export type UseAnalysisStream<TResult> = {
  state: AnalysisStreamStateTyped<TResult>
  /** Kick off (or re-run) analysis. */
  analyze: () => void
}

export function useAnalysisStream<TResult>(config: AnalysisStreamConfig<TResult>): UseAnalysisStream<TResult> {
  const { id, events, trigger, cachedResult } = config
  const key = id ? streamKey(events.complete, id) : null

  // Read from the global store (survives unmount). Cast result back to TResult —
  // the store holds unknown; the hook restores the typed view for callers.
  const rawState = useAnalysisStreamStore((s) => (key ? s.entries.get(key) : undefined)) ?? {
    phase: 'idle' as const,
  }
  const state = rawState as AnalysisStreamStateTyped<TResult>
  const storeSet = useAnalysisStreamStore((s) => s.set)

  // Surface a cached result as `done` once the cache resolves (and again after a
  // completed run invalidates the cache). This only ever UPGRADES to done — it
  // never downgrades — so a cache miss resolving mid-analysis can't clobber a
  // streaming/error state. Only applies when the store entry is idle (fresh open).
  useEffect(() => {
    if (!key || !cachedResult) return
    const current = useAnalysisStreamStore.getState().get(key)
    if (current.phase === 'idle') {
      storeSet(key, { phase: 'done', result: cachedResult, streamText: '' })
    }
  }, [key, cachedResult, storeSet])

  const analyze = useCallback(() => {
    if (id === null || !key) return
    storeSet(key, { phase: 'streaming', streamText: '' })
    void (async () => {
      const ack = await trigger()
      if (!ack.ok) storeSet(key, { phase: 'error', error: ack.message })
    })()
  }, [id, key, trigger, storeSet])

  return { state, analyze }
}
