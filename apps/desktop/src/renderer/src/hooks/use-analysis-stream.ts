// Generic streaming-analysis hook shared by the four card-based analysis panels
// (article / trending / bilibili / gmail-thread). Owns the phase state machine
// (idle → streaming → done | error), accumulates streamed deltas, surfaces cached
// results, and invalidates query caches on completion. Replaces the per-panel
// useState + subscribeEvents + reset-effect boilerplate that was duplicated 4×.
//
// The hook is parameterized by:
// - TResult: the structured result carried on the Complete event (ArticleSummary,
//   RepoResearch, BiliSummary, or gmail's {summary, todos, suggest}).
// - The event kinds, id field name, trigger API, and cache query are passed in
//   via AnalysisStreamConfig.

import { useCallback, useEffect, useState } from 'react'
import type { UIEvent } from '@swarm/protocol'
import { useQueryClient } from '@tanstack/react-query'

export type AnalysisPhase = 'idle' | 'streaming' | 'done' | 'error'

export type AnalysisStreamState<TResult> =
  | { phase: 'idle' }
  | { phase: 'streaming'; streamText: string }
  | { phase: 'done'; result: TResult; streamText: string }
  | { phase: 'error'; error: string }

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

export type UseAnalysisStream<TResult> = {
  state: AnalysisStreamState<TResult>
  /** Kick off (or re-run) analysis. */
  analyze: () => void
}

export function useAnalysisStream<TResult>(config: AnalysisStreamConfig<TResult>): UseAnalysisStream<TResult> {
  const { id, events, idField, parseComplete, trigger, cachedResult, invalidateOnComplete } = config
  const qc = useQueryClient()
  const [state, setState] = useState<AnalysisStreamState<TResult>>({ phase: 'idle' })

  // Reset to idle whenever the selected id changes.
  useEffect(() => {
    setState({ phase: 'idle' })
  }, [id])

  // Surface a cached result as `done` once the cache resolves (and again after a
  // completed run invalidates the cache). This only ever UPGRADES to done — it
  // never downgrades — so a cache miss resolving mid-analysis can't clobber a
  // streaming/error state set by analyze().
  useEffect(() => {
    if (cachedResult) {
      setState({ phase: 'done', result: cachedResult, streamText: '' })
    }
  }, [cachedResult])

  // Subscribe to stream events for the current id; events for other ids are ignored.
  useEffect(() => {
    if (id === null) return
    return window.swarm.subscribeEvents((e: UIEvent) => {
      const eventObj = e as Record<string, unknown>
      if (eventObj[idField] !== id) return
      if (e.kind === events.delta) {
        const text = (e as unknown as { text?: string }).text ?? ''
        setState((prev) => ({
          phase: 'streaming',
          streamText: (prev.phase === 'streaming' ? prev.streamText : '') + text,
        }))
      } else if (e.kind === events.complete) {
        const result = parseComplete(e)
        const streamText = (e as unknown as { summary?: string }).summary ?? ''
        setState({ phase: 'done', result, streamText })
        for (const key of invalidateOnComplete ?? []) {
          void qc.invalidateQueries({ queryKey: key })
        }
      } else if (e.kind === events.error) {
        const error = (e as unknown as { error?: string }).error ?? 'analysis failed'
        setState({ phase: 'error', error })
      }
    })
  }, [id, events, idField, parseComplete, qc, invalidateOnComplete])

  const analyze = useCallback(() => {
    if (id === null) return
    setState({ phase: 'streaming', streamText: '' })
    void (async () => {
      const ack = await trigger()
      if (!ack.ok) setState({ phase: 'error', error: ack.message })
    })()
  }, [id, trigger])

  return { state, analyze }
}
