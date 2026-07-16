// Shared types for the analysis-run factory. The four card-based analysis flows
// (article / trending / bilibili / gmail-thread) all share the same skeleton:
// a one-shot pi Agent run (session-agent/one-shot.ts, no persistence) whose pi
// AgentEvents an adapter translates into domain *.analysis* events, fire-and-forget.
// This file defines the config that parameterizes the per-flow differences.

import type { Logger } from 'pino'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { OneShotRunner } from '../session-agent/one-shot'
import type { ToolRegistry } from '../tools/registry'

/** The broadcast event names + the field name carrying the analysis id. */
export type AnalysisEvents = {
  /** e.g. 'article.analysisDelta' */
  delta: string
  /** e.g. 'article.analysisComplete' */
  complete: string
  /** e.g. 'article.analysisError' */
  error: string
}

/**
 * Per-flow configuration that the factory uses to specialize the shared run
 * skeleton. `TSummary` is the structured card type (ArticleSummary, RepoResearch,
 * BiliSummary, or gmail's {todos, suggest}).
 */
export type AnalysisConfig<TSummary> = {
  /** Roster id, e.g. 'article-analyst'. */
  agentId: string
  /** Event names + the payload id key ('articleId' / 'repoName' / 'bvid' / 'threadId'). */
  events: AnalysisEvents
  idKey: string
  /** Coerce render_ui card props into the typed summary, or null if invalid. */
  validateCard: (props: Record<string, unknown>) => TSummary | null
  /** Build the broadcast payload for the Complete event from the card + accumulated text.
   *  `card` is null when noCardBehavior is 'tolerate' and the agent emitted no card. */
  buildCompletePayload: (card: TSummary | null, accumulated: string) => Record<string, unknown>
  /** Whether to accumulate streamed markdown prose alongside the card. */
  accumulateSummary: boolean
  /** What to do when message.complete arrives without a valid card. */
  noCardBehavior: 'error' | 'tolerate'
}

/** Shared deps every analysis flow needs. */
export type AnalysisDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  toolRegistry: ToolRegistry
  /** Global concurrency pool — a one-shot analysis run competes for it like any run. */
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  /** Injectable so tests can drive the adapter without a real provider/agent. */
  runOneShot?: OneShotRunner
  /** Optional persistence callback fired on a completed run with the valid card.
   *  `extra` carries per-request data from AnalysisRunRequest.extra. */
  onComplete?: (id: string, summary: unknown, accumulated: string, extra: unknown, log: Logger) => void | Promise<void>
}
