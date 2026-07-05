// Pure selector turning the global RunRecord cache + sessions store into the
// rows the dashboard's 进行中 section renders. Top-level runs only (sub-agents
// are nested inside their parent's transcript). Running/pending → `running`;
// awaiting_user → `awaiting` (amber approval cards). Sorted newest-first.
//
// Counting rule (locked in the spec): "running" = pending+running only;
// awaiting_user renders in the section but does NOT count toward the headline.

import type { RunRecord, RunStatus } from '@shared/lib/apply-event'
import type { PlanTodo, SessionSummary } from '@swarm/protocol'

export type TeamOption = { id: string; label: string }

export type DashboardRun = {
  id: string
  sessionId: string
  goal: string
  status: RunStatus
  /** Elapsed wall time in ms (now - startedAt); ticks via useNow. */
  wallMs: number
  /** Joined from SessionSummary.cwd via sessionId; undefined when no session match. */
  cwd: string | undefined
  /** Display label for the entry agent (team head), resolved via teamOptions. */
  agentLabel: string | undefined
  /** `"${completed}/${total}"` plan progress, or null when the run has no plan. */
  steps: string | null
}

const ACTIVE_RUNNING: ReadonlySet<RunStatus> = new Set(['pending', 'running'])

export function selectDashboardRuns(
  runs: RunRecord[],
  sessions: SessionSummary[],
  teamOptions: TeamOption[],
  now: number
): { running: DashboardRun[]; awaiting: DashboardRun[] } {
  const cwdBySession = new Map(sessions.map((s) => [s.id, s.cwd]))
  const agentBySession = new Map(sessions.map((s) => [s.id, s.agentType]))
  const labelByAgent = new Map(teamOptions.map((t) => [t.id, t.label]))

  const toRow = (r: RunRecord): DashboardRun => {
    const agentType = agentBySession.get(r.sessionId)
    return {
      id: r.id,
      sessionId: r.sessionId,
      goal: r.goal,
      status: r.status,
      wallMs: now - r.startedAt,
      cwd: cwdBySession.get(r.sessionId),
      agentLabel: agentType ? (labelByAgent.get(agentType) ?? agentType) : undefined,
      steps: planSteps(r.plan),
    }
  }

  // Top-level runs only (sub-agents carry parentRunId and render inside the
  // parent's transcript, not as their own dashboard cards).
  const topLevel = runs.filter((r) => !r.parentRunId)
  const running = topLevel
    .filter((r) => ACTIVE_RUNNING.has(r.status))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toRow)
  const awaiting = topLevel
    .filter((r) => r.status === 'awaiting_user')
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toRow)

  return { running, awaiting }
}

// `"${completed}/${total}"` step progress, matching PlanStatusBar's semantics.
// Returns null when there is no plan (or it is empty) so cards can omit it.
function planSteps(plan: PlanTodo[] | undefined): string | null {
  if (!plan || plan.length === 0) return null
  const completed = plan.filter((t) => t.status === 'completed').length
  return `${completed}/${plan.length}`
}
