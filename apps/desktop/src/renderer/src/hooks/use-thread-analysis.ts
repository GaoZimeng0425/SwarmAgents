// Thread analysis, manually triggered. Thin wrapper over the shared
// useAnalysisStream hook that maps the generic AnalysisStreamState back to the
// ThreadAnalysisState shape GmailAssistantCard consumes. The caller passes the
// already-loaded thread (subject + messages) so the hook can fill the
// analyzeThread input without a duplicate fetch.

import type { Todo } from '@swarm/protocol'
import { useQuery } from '@tanstack/react-query'

import { useAnalysisStream } from '@/hooks/use-analysis-stream'
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

type ThreadResult = { summary: string; todos: Todo[]; suggest: string }

export function useThreadAnalysis(thread: ThreadAnalysisInput | null): UseThreadAnalysis {
  const threadId = thread?.id ?? null

  const cache = useQuery({
    queryKey: ['gmail', 'threadAnalysis', threadId],
    queryFn: () => (threadId ? swarmApi.gmailGetThreadAnalysis(threadId) : Promise.resolve(null)),
    enabled: threadId !== null,
  })

  const { state, analyze } = useAnalysisStream<ThreadResult>({
    id: threadId,
    events: {
      delta: 'gmail.threadAnalysisDelta',
      complete: 'gmail.threadAnalysisComplete',
      error: 'gmail.threadAnalysisError',
    },
    idField: 'threadId',
    parseComplete: (e) => {
      const ev = e as { summary: string; todos: Todo[]; suggest: string }
      return { summary: ev.summary, todos: ev.todos, suggest: ev.suggest }
    },
    trigger: async () => {
      if (!thread) return { ok: false, message: 'no thread' }
      return swarmApi.analyzeThread({ threadId: thread.id, subject: thread.subject, messages: thread.messages })
    },
    cachedResult: cache.data ?? null,
    invalidateOnComplete: [
      ['gmail', 'threadAnalysis', threadId],
      ['gmail', 'analyzedThreadIds'],
    ],
  })

  // Map the generic AnalysisStreamState back to the ThreadAnalysisState shape
  // GmailAssistantCard expects.
  const mapped: ThreadAnalysisState =
    state.phase === 'idle'
      ? { phase: 'idle' }
      : state.phase === 'streaming'
        ? { phase: 'streaming', summaryText: state.streamText }
        : state.phase === 'done'
          ? { phase: 'done', summary: state.result.summary, todos: state.result.todos, suggest: state.result.suggest }
          : { phase: 'error', error: state.error }

  return { state: mapped, analyze }
}
