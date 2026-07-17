// Thread-level analysis: thin config over the shared analysis-run factory
// (service/analysis/run.ts), keyed by threadId. The agent streams a natural-language
// markdown summary (shown to the user, kept on completion) and emits its structured
// fields via a render_ui({type:'analysis', props:{todos, suggest}}) tool call. The
// streamed markdown IS the summary; the card adds todos/suggest. No card → tolerated:
// empty todos/suggest (summary intact) — never blocks the user-facing summary.
//
// Persistence: onComplete calls the 'gmail.save_thread_analysis' RPC so the result
// lands in Main's SQLite cache. The renderer no longer needs to persist on its own.
import type {
  AnalyzeThreadRequest,
  AnalyzeThreadResult,
  CallMainFn,
  ThreadAnalysisPayload,
  Todo,
} from '@swarm/protocol'

import type { AgentStore } from '../agents/store'
import { type AnalysisConfig, type AnalysisDeps, createAnalysisRun } from '../analysis/run'
import type { Broadcaster } from '../ipc/broadcaster'
import type { OneShotRunner } from '../session-agent/one-shot'
import type { ToolRegistry } from '../tools/registry'

// The card captures todos + a suggested reply. When the agent emits no card,
// tolerate with empty defaults (the summary is still useful on its own).
type ThreadCard = { todos: Todo[]; suggest: string }

const GMAIL_THREAD_CONFIG: AnalysisConfig<ThreadCard> = {
  agentId: 'gmail-thread-analyst',
  events: {
    delta: 'gmail.threadAnalysisDelta',
    complete: 'gmail.threadAnalysisComplete',
    error: 'gmail.threadAnalysisError',
  },
  idKey: 'threadId',
  validateCard: (props) => ({
    todos: Array.isArray(props.todos) ? (props.todos as Todo[]) : [],
    suggest: typeof props.suggest === 'string' ? props.suggest : '',
  }),
  buildCompletePayload: (card, accumulated) => ({
    summary: accumulated,
    todos: card?.todos ?? [],
    suggest: card?.suggest ?? '',
  }),
  accumulateSummary: true,
  noCardBehavior: 'tolerate',
}

export type AnalyzeThreadDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  toolRegistry: ToolRegistry
  /** Global concurrency pool shared with the session runs. */
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  /** Cross-process RPC to Main (for persisting the thread analysis result). */
  callMain: CallMainFn
  /** Injectable so tests can drive the adapter without a real provider/agent. */
  runOneShot?: OneShotRunner
}

export function createAnalyzeThread(deps: AnalyzeThreadDeps): (req: AnalyzeThreadRequest) => AnalyzeThreadResult {
  const analysisDeps: AnalysisDeps = {
    broadcaster: deps.broadcaster,
    agentStore: deps.agentStore,
    toolRegistry: deps.toolRegistry,
    acquireSlot: deps.acquireSlot,
    runOneShot: deps.runOneShot,
    onComplete: (threadId, card, accumulated) => {
      const c = (card ?? { todos: [], suggest: '' }) as ThreadCard
      const payload: ThreadAnalysisPayload = {
        summary: accumulated,
        todos: c.todos,
        suggest: c.suggest,
      }
      void deps.callMain('gmail.save_thread_analysis', [threadId, payload])
    },
  }
  const run = createAnalysisRun(analysisDeps, GMAIL_THREAD_CONFIG)
  return (req) => {
    const threadText = req.messages
      .map((m) => `---\nFrom: ${m.from}\nDate: ${new Date(m.dateMs).toLocaleString()}\n\n${m.bodyText}`)
      .join('\n\n')
    const prompt = `分析下面这个邮件线程。\n\nSubject: ${req.subject}\n\n${threadText}`
    const result = run({ provider: req.provider, id: req.threadId, prompt })
    if (!result.ok) return result
    return { ok: true }
  }
}
