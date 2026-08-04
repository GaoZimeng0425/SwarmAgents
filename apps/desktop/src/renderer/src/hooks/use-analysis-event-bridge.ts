// Global subscription bridge for the four analysis flows' streaming events
// (article / bilibili / trending / gmail-thread). Subscribes once at the app
// root and dispatches delta/complete/error events into the analysis-stream
// store — the single source of truth — so an entry keeps being updated even
// when the user switches away from its panel mid-analysis (the "切走丢失" fix).
//
// This is deliberately a separate subscription from useEventsSubscription: that
// hook depends on router/toast and is heavy to mount in tests; this one only
// needs a QueryClientProvider, so panels' tests can wire it up directly.

import { useEffect } from 'react'
import type { UIEvent } from '@swarm/protocol'
import { useQueryClient } from '@tanstack/react-query'

import { streamKey, useAnalysisStreamStore } from '@/stores/analysis-stream'

// Each flow's namespace is its Complete event kind, so entries never collide
// (article id '1' ≠ bilibili bvid '1'). The result shapes mirror what each
// panel used to extract via parseComplete, so the typed cast in useAnalysisStream
// stays valid.
export function useAnalysisEventBridge(enabled = true): void {
  const qc = useQueryClient()

  useEffect(() => {
    if (!enabled) return
    return window.swarm.subscribeEvents((e: UIEvent) => {
      const store = useAnalysisStreamStore.getState()
      if (e.kind === 'article.analysisDelta') {
        store.update(streamKey('article.analysisComplete', e.articleId), (p) => ({
          phase: 'streaming',
          streamText: (p.phase === 'streaming' ? p.streamText : '') + e.text,
        }))
      } else if (e.kind === 'article.analysisComplete') {
        store.set(streamKey('article.analysisComplete', e.articleId), {
          phase: 'done',
          result: e.summary,
          streamText: e.summary.gist,
        })
        void qc.invalidateQueries({ queryKey: ['articles', 'list'] })
      } else if (e.kind === 'article.analysisError') {
        store.set(streamKey('article.analysisComplete', e.articleId), { phase: 'error', error: e.error })
      } else if (e.kind === 'bilibili.analysisDelta') {
        store.update(streamKey('bilibili.analysisComplete', e.bvid), (p) => ({
          phase: 'streaming',
          streamText: (p.phase === 'streaming' ? p.streamText : '') + e.text,
        }))
      } else if (e.kind === 'bilibili.analysisComplete') {
        store.set(streamKey('bilibili.analysisComplete', e.bvid), {
          phase: 'done',
          result: e.summary,
          streamText: e.summary.gist,
        })
        void qc.invalidateQueries({ queryKey: ['bilibili', 'analyzedBvids'] })
      } else if (e.kind === 'bilibili.analysisError') {
        store.set(streamKey('bilibili.analysisComplete', e.bvid), { phase: 'error', error: e.error })
      } else if (e.kind === 'trending.researchDelta') {
        store.update(streamKey('trending.researchComplete', e.repoName), (p) => ({
          phase: 'streaming',
          streamText: (p.phase === 'streaming' ? p.streamText : '') + e.text,
        }))
      } else if (e.kind === 'trending.researchComplete') {
        store.set(streamKey('trending.researchComplete', e.repoName), {
          phase: 'done',
          result: e.research,
          streamText: e.summary,
        })
        void qc.invalidateQueries({ queryKey: ['trending', 'research', e.repoName] })
        void qc.invalidateQueries({ queryKey: ['trending', 'researchedNames'] })
      } else if (e.kind === 'trending.researchError') {
        store.set(streamKey('trending.researchComplete', e.repoName), { phase: 'error', error: e.error })
      } else if (e.kind === 'gmail.threadAnalysisDelta') {
        store.update(streamKey('gmail.threadAnalysisComplete', e.threadId), (p) => ({
          phase: 'streaming',
          streamText: (p.phase === 'streaming' ? p.streamText : '') + e.text,
        }))
      } else if (e.kind === 'gmail.threadAnalysisComplete') {
        store.set(streamKey('gmail.threadAnalysisComplete', e.threadId), {
          phase: 'done',
          result: { summary: e.summary, todos: e.todos, suggest: e.suggest },
          streamText: e.summary,
        })
        // Persist the completed analysis so it survives reload/restart. The other
        // flows (article/bilibili/trending) persist server-side via their own
        // complete handlers; gmail thread analysis is cached locally via this call.
        void window.swarm.gmail.saveThreadAnalysis(e.threadId, {
          summary: e.summary,
          todos: e.todos,
          suggest: e.suggest,
        })
        void qc.invalidateQueries({ queryKey: ['gmail', 'threadAnalysis', e.threadId] })
        void qc.invalidateQueries({ queryKey: ['gmail', 'analyzedThreadIds'] })
      } else if (e.kind === 'gmail.threadAnalysisError') {
        store.set(streamKey('gmail.threadAnalysisComplete', e.threadId), { phase: 'error', error: e.error })
      }
    })
  }, [qc, enabled])
}
