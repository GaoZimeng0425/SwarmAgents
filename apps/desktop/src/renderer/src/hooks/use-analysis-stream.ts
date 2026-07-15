// Generic streaming-analysis hook shared by the four card-based analysis panels
// (article / trending / bilibili / gmail-thread). Owns the phase state machine
// (idle → streaming → done | error), accumulates streamed deltas, surfaces cached
// results, and invalidates query caches on completion.
//
// State lives in a global zustand store (not useState) so it survives panel
// unmount/remount — the "切走丢失" fix. When the user switches away mid-analysis
// and comes back, the streaming progress / result is still there.

import { useCallback, useEffect } from 'react'
import type { UIEvent } from '@swarm/protocol'
import { useQueryClient } from '@tanstack/react-query'

import { type AnalysisStreamState, streamKey, useAnalysisStreamStore } from '@/stores/analysis-stream'

export type AnalysisPhase = 'idle' | 'streaming' | 'done' | 'error'

export type { AnalysisStreamState }

export type AnalysisStreamConfig<TResult> = {
  /** The analysis-target id, or null when nothing is selected. */
  id: string | null
  /** Event kinds to subscribe to. */
  events: { delta: string; complete: string; error: string }
  /** The field name on the event payload carrying the id ('articleId' / 'bvid' / ...). */
  idField: string
  /** Extract the structured result from a Complete event. */
  parseComplete: (e: UIEvent) => TResult
  /** Trigger the analysis (returns the sync ack). */
  trigger: () => Promise<{ ok: true } | { ok: false; message: string }>
  /** Previously-analyzed cached result, or null when none. The caller decides
   *  how to obtain it (object property, useQuery, etc.). */
  cachedResult: TResult | null
  /** Query keys to invalidate on Complete (e.g. the list-badge key). */
  invalidateOnComplete?: unknown[][]
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
  const { id, events, idField, parseComplete, trigger, cachedResult, invalidateOnComplete } = config
  const qc = useQueryClient()
  const key = id ? streamKey(events.complete, id) : null

  // Read from the global store (survives unmount). Cast result back to TResult —
  // the store holds unknown; the hook restores the typed view for callers.
  const rawState = useAnalysisStreamStore((s) => (key ? s.entries.get(key) : undefined)) ?? {
    phase: 'idle' as const,
  }
  const state = rawState as AnalysisStreamStateTyped<TResult>
  const storeSet = useAnalysisStreamStore((s) => s.set)
  const storeUpdate = useAnalysisStreamStore((s) => s.update)

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

  // Subscribe to stream events for the current id; events for other ids are ignored.
  useEffect(() => {
    if (id === null || !key) return
    return window.swarm.subscribeEvents((e: UIEvent) => {
      const eventObj = e as Record<string, unknown>
      if (eventObj[idField] !== id) return
      if (e.kind === events.delta) {
        const text = (e as unknown as { text?: string }).text ?? ''
        storeUpdate(key, (prev) => ({
          phase: 'streaming',
          streamText: (prev.phase === 'streaming' ? prev.streamText : '') + text,
        }))
      } else if (e.kind === events.complete) {
        const result = parseComplete(e)
        const streamText = (e as unknown as { summary?: string }).summary ?? ''
        storeSet(key, { phase: 'done', result, streamText })
        for (const k of invalidateOnComplete ?? []) {
          void qc.invalidateQueries({ queryKey: k })
        }
      } else if (e.kind === events.error) {
        const error = (e as unknown as { error?: string }).error ?? 'analysis failed'
        storeSet(key, { phase: 'error', error })
      }
    })
  }, [id, key, events, idField, parseComplete, qc, invalidateOnComplete, storeSet, storeUpdate])

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
