// Auto-triggers thread analysis on selection: cache hit = instant; cache miss =
// fire analyzeThread + subscribe to gmail.threadAnalysis* events (keyed by
// threadId). Switching threads unsubscribes the previous subscription. The hook
// owns the phase state machine (idle/streaming/done/error).
//
// Option A signature: the caller passes the already-loaded thread (subject +
// messages) so the hook can fill the analyzeThread input without a duplicate
// fetch — gmail-inbox-view already has the thread via its getThread query.

import { useEffect, useState } from 'react'
import type { Todo, UIEvent } from '@swarm/protocol'
import { useQuery } from '@tanstack/react-query'

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

export function useThreadAnalysis(thread: ThreadAnalysisInput | null): ThreadAnalysisState {
  const threadId = thread?.id ?? null
  const [state, setState] = useState<ThreadAnalysisState>({ phase: 'idle' })

  // Hooks are called unconditionally; the null thread is handled via `enabled`.
  const cache = useQuery({
    queryKey: ['gmail', 'threadAnalysis', threadId],
    queryFn: () => (threadId ? swarmApi.gmailGetThreadAnalysis(threadId) : Promise.resolve(null)),
    enabled: threadId !== null,
  })

  useEffect(() => {
    if (threadId === null) {
      setState({ phase: 'idle' })
      return
    }
    // Cache hit: done immediately, no analyze call.
    if (cache.data) {
      setState({
        phase: 'done',
        summary: cache.data.summary,
        todos: cache.data.todos,
        suggest: cache.data.suggest,
      })
      return
    }
    if (cache.isPending) return // wait for the cache query to resolve

    // Cache miss: trigger analysis and stream the deltas. `thread` is non-null
    // here (threadId !== null implies thread !== null). The effect can't be
    // async (it must return the cleanup synchronously), so the analyze call is
    // awaited inside an inner async function that populates a closure-local
    // `off` once the subscription is actually created.
    setState({ phase: 'streaming', summaryText: '' })

    let summaryText = ''
    let off: (() => void) | undefined
    void (async () => {
      // Await the ack: a missing provider (or other preflight failure) returns
      // {ok:false} synchronously with NO follow-up event, so without branching
      // here the card would hang on "分析中…" forever. Show a retryable error
      // instead and never subscribe.
      const ack = await swarmApi.analyzeThread({
        threadId,
        subject: thread!.subject,
        messages: thread!.messages,
      })
      if (!ack.ok) {
        setState({ phase: 'error', error: ack.message })
        return
      }

      off = window.swarm.subscribeEvents((e: UIEvent) => {
        if (e.kind === 'gmail.threadAnalysisDelta' && e.threadId === threadId) {
          // The streamed markdown IS the summary; structured fields (todos/
          // suggest) ride a separate render_ui tool call, so nothing needs to be
          // stripped here and the done summary equals this streamed text.
          summaryText += e.text
          setState({ phase: 'streaming', summaryText })
        } else if (e.kind === 'gmail.threadAnalysisComplete' && e.threadId === threadId) {
          setState({ phase: 'done', summary: e.summary, todos: e.todos, suggest: e.suggest })
          // Persist via the preload bridge directly (matches MessageAnalysis's
          // saveAnalysis call site — not routed through swarmApi).
          void window.swarm.gmail.saveThreadAnalysis(threadId, {
            summary: e.summary,
            todos: e.todos,
            suggest: e.suggest,
          })
        } else if (e.kind === 'gmail.threadAnalysisError' && e.threadId === threadId) {
          setState({ phase: 'error', error: e.error })
        }
      })
    })()
    return () => {
      off?.()
    }
  }, [thread, threadId, cache.data, cache.isPending])

  return state
}
