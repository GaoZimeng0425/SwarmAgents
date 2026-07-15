// Thread analysis, manually triggered. On selection the hook resolves any
// cached analysis (cache hit = instant `done`); a cache miss stays `idle` until
// the caller invokes `analyze()`. A subscription to gmail.threadAnalysis*
// events is kept alive for the whole time a thread is selected, so a manual
// analyze() (or re-run) streams in without re-subscribing. The hook owns the
// phase state machine (idle/streaming/done/error).
//
// Option A signature: the caller passes the already-loaded thread (subject +
// messages) so the hook can fill the analyzeThread input without a duplicate
// fetch — gmail-inbox-view already has the thread via its getThread query.

import { useCallback, useEffect, useState } from 'react'
import type { Todo, UIEvent } from '@swarm/protocol'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'

/** The thread handed to the hook: just enough to drive analysis. */
export type ThreadAnalysisInput = {
  id: string
  subject: string
  messages: { from: string; dateMs: number; bodyText: string }[]
}

export type ThreadAnalysisState =
  | { phase: 'idle' }
  | { phase: 'streaming'; summaryText: string }
  | { phase: 'done'; summary: string; todos: Todo[]; suggest: string }
  | { phase: 'error'; error: string }

export type UseThreadAnalysis = {
  state: ThreadAnalysisState
  /** Kick off (or re-run) analysis for the current thread. No-op when no thread. */
  analyze: () => void
}

export function useThreadAnalysis(thread: ThreadAnalysisInput | null): UseThreadAnalysis {
  const threadId = thread?.id ?? null
  const qc = useQueryClient()
  const [state, setState] = useState<ThreadAnalysisState>({ phase: 'idle' })

  // Hooks are called unconditionally; the null thread is handled via `enabled`.
  const cache = useQuery({
    queryKey: ['gmail', 'threadAnalysis', threadId],
    queryFn: () => (threadId ? swarmApi.gmailGetThreadAnalysis(threadId) : Promise.resolve(null)),
    enabled: threadId !== null,
  })

  // Reset to idle whenever the selected thread changes. Analysis is manual, so a
  // fresh thread starts idle behind the "AI 分析" button.
  useEffect(() => {
    setState({ phase: 'idle' })
  }, [threadId])

  // Surface a cached analysis as `done` once the cache resolves (and again after
  // a completed run invalidates the cache). This only ever UPGRADES to done — it
  // never downgrades — so a cache miss resolving mid-analysis can't clobber a
  // streaming/error state set by analyze().
  useEffect(() => {
    if (cache.data) {
      setState({ phase: 'done', summary: cache.data.summary, todos: cache.data.todos, suggest: cache.data.suggest })
    }
  }, [cache.data])

  // Keep one subscription alive per selected thread so a manual analyze() streams
  // in. Delta events accumulate onto the streaming text; complete persists +
  // invalidates the cache so the resolution effect settles on `done`.
  useEffect(() => {
    if (threadId === null) return
    return window.swarm.subscribeEvents((e: UIEvent) => {
      if (e.kind === 'gmail.threadAnalysisDelta' && e.threadId === threadId) {
        setState((prev) => ({
          phase: 'streaming',
          summaryText: (prev.phase === 'streaming' ? prev.summaryText : '') + e.text,
        }))
      } else if (e.kind === 'gmail.threadAnalysisComplete' && e.threadId === threadId) {
        setState({ phase: 'done', summary: e.summary, todos: e.todos, suggest: e.suggest })
        // Refresh the cache so the analyzed badge + a later revisit see the result.
        void qc.invalidateQueries({ queryKey: ['gmail', 'threadAnalysis', threadId] })
        void qc.invalidateQueries({ queryKey: ['gmail', 'analyzedThreadIds'] })
      } else if (e.kind === 'gmail.threadAnalysisError' && e.threadId === threadId) {
        setState({ phase: 'error', error: e.error })
      }
    })
  }, [threadId, qc])

  const analyze = useCallback(() => {
    if (threadId === null || !thread) return
    setState({ phase: 'streaming', summaryText: '' })
    void (async () => {
      // Await the ack: a missing provider (or other preflight failure) returns
      // {ok:false} with NO follow-up event, so surface a retryable error instead
      // of hanging on "分析中…".
      const ack = await swarmApi.analyzeThread({ threadId, subject: thread.subject, messages: thread.messages })
      if (!ack.ok) setState({ phase: 'error', error: ack.message })
    })()
  }, [thread, threadId])

  return { state, analyze }
}
