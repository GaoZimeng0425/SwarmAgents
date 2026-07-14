// Pure selector turning the global MessageRecord cache + sessions store into
// the rows the dashboard's 进行中 section renders. Top-level messages only
// (sub-agents are nested inside their parent's transcript). Running/pending →
// `running`; awaiting_user → `awaiting` (amber approval cards). Sorted
// newest-first.
//
// Counting rule (locked in the spec): "running" = pending+running only;
// awaiting_user renders in the section but does NOT count toward the headline.

import type { MessageRecord, MessageStatus } from '@shared/lib/apply-event'
import type { PlanTodo, SessionSummary, UIEvent } from '@swarm/protocol'

import type { TeamOption } from '@/hooks/use-agents'

export type { TeamOption }

export type DashboardMessage = {
  id: string
  sessionId: string
  prompt: string
  status: MessageStatus
  /** Elapsed wall time in ms (now - startedAt); ticks via useNow. */
  wallMs: number
  /** Joined from SessionSummary.cwd via sessionId; undefined when no session match. */
  cwd: string | undefined
  /** Display label for the entry agent (team head), resolved via teamOptions. */
  agentLabel: string | undefined
  /** `"${completed}/${total}"` plan progress, or null when the message has no plan. */
  steps: string | null
  /** Latest tool activity (e.g. `Bash pnpm vitest …`), or null when none yet. */
  activity: string | null
}

const ACTIVE_RUNNING: ReadonlySet<MessageStatus> = new Set(['pending', 'running'])

export function selectDashboardMessages(
  messages: MessageRecord[],
  sessions: SessionSummary[],
  teamOptions: TeamOption[],
  now: number
): { running: DashboardMessage[]; awaiting: DashboardMessage[] } {
  const cwdBySession = new Map(sessions.map((s) => [s.id, s.cwd]))
  const agentBySession = new Map(sessions.map((s) => [s.id, s.agentType]))
  const labelByAgent = new Map(teamOptions.map((t) => [t.id, t.label]))

  const toRow = (r: MessageRecord): DashboardMessage => {
    const agentType = agentBySession.get(r.sessionId)
    return {
      id: r.id,
      sessionId: r.sessionId,
      prompt: r.prompt,
      status: r.status,
      wallMs: now - r.createdAt,
      cwd: cwdBySession.get(r.sessionId),
      agentLabel: agentType ? (labelByAgent.get(agentType) ?? agentType) : undefined,
      steps: planSteps(r.plan),
      activity: latestActivity(r.events),
    }
  }

  // Top-level messages only (sub-agents carry parentMessageId and render inside
  // the parent's transcript, not as their own dashboard cards).
  const topLevel = messages.filter((r) => !r.parentMessageId)
  const running = topLevel
    .filter((r) => ACTIVE_RUNNING.has(r.status))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toRow)
  const awaiting = topLevel
    .filter((r) => r.status === 'awaiting_user')
    .sort((a, b) => b.createdAt - a.createdAt)
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

// The message's most recent tool call, formatted as a one-line activity hint
// (`"${tool} ${arg}"`, e.g. `Bash pnpm vitest auth.test.ts`). Scans events
// newest-first for the last tool.call inside a message.progress; returns null
// when the message hasn't invoked a tool yet. Pure — the card renders it
// verbatim (with a ▸ prefix).
export function latestActivity(events: UIEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind === 'message.progress' && e.event.kind === 'tool.call') {
      const hint = toolArgHint(e.event.args)
      return hint ? `${e.event.tool} ${hint}` : e.event.tool
    }
  }
  return null
}

// Best-effort single-line argument hint from a tool call's args. Reads the
// common "primary input" fields across tools (Bash→command, Read/Edit→file_path,
// Grep→pattern, WebFetch→url, …). Returns '' when args carries no display string,
// so latestActivity falls back to the bare tool name.
function toolArgHint(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  const candidate = a.command ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.description
  return typeof candidate === 'string' ? candidate.replace(/\s+/g, ' ').trim() : ''
}
