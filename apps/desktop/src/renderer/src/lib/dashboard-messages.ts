// Pure selector turning the live running/awaiting session sets + the sessions
// store into the rows the dashboard's 进行中 section renders. On the wire-v3
// rails there is no global cross-session message cache: run state comes from
// useRunningSessions() (agent_start/agent_end) and awaiting comes from the
// permission queue. Per-run detail (step progress, latest tool activity) is
// re-sourced from per-session views in a later phase.
//
// Counting rule (locked in the spec): "running" = active runs only; awaiting
// renders in the section but does NOT count toward the headline.

import type { SessionSummary } from '@swarm/protocol'
import type { MessageStatus } from '@swarm/shared'

import type { TeamOption } from '@/hooks/use-agents'

export type { TeamOption }

export type DashboardMessage = {
  id: string
  sessionId: string
  prompt: string
  status: MessageStatus
  /** Elapsed wall time in ms (now - lastActiveAt); ticks via useNow. */
  wallMs: number
  /** SessionSummary.cwd; undefined when unset. */
  cwd: string | undefined
  /** Display label for the entry agent (team head), resolved via teamOptions. */
  agentLabel: string | undefined
  /** Plan progress — deferred on the entry rails, always null for now. */
  steps: string | null
  /** Latest tool activity — deferred on the entry rails, always null for now. */
  activity: string | null
}

export function selectDashboardMessages(
  runningSessionIds: Set<string>,
  awaitingSessionIds: Set<string>,
  sessions: SessionSummary[],
  teamOptions: TeamOption[],
  now: number
): { running: DashboardMessage[]; awaiting: DashboardMessage[] } {
  const labelByAgent = new Map(teamOptions.map((t) => [t.id, t.label]))

  const toRow = (s: SessionSummary, status: MessageStatus): DashboardMessage => ({
    id: s.id,
    sessionId: s.id,
    prompt: s.title ?? 'Untitled chat',
    status,
    wallMs: Math.max(0, now - s.lastActiveAt),
    cwd: s.cwd,
    agentLabel: s.agentType ? (labelByAgent.get(s.agentType) ?? s.agentType) : undefined,
    steps: null,
    activity: null,
  })

  const visible = sessions.filter((s) => !s.isSystem)
  // Awaiting outranks running for a session with both a live run and a pending
  // prompt (a paused turn is still "your move").
  const running = visible
    .filter((s) => runningSessionIds.has(s.id) && !awaitingSessionIds.has(s.id))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((s) => toRow(s, 'running'))
  const awaiting = visible
    .filter((s) => awaitingSessionIds.has(s.id))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((s) => toRow(s, 'awaiting_user'))

  return { running, awaiting }
}
