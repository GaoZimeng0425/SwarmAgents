import type { Attachment, ConsumedResources, PlanTodo, UIEvent } from '@swarm/protocol'

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled'

export type RunRecord = {
  id: string
  sessionId: string
  goal: string
  status: RunStatus
  summary: string | null
  startedAt: number
  attachments: Attachment[]
  used?: ConsumedResources
  contextTokens?: number
  contextWindow?: number
  plan?: PlanTodo[]
  /** Set when this run is a spawned sub-agent (links to its parent). */
  parentRunId?: string
  /** Sub-agent definition id, used to label the subagent block. */
  agentDefId?: string
  events: UIEvent[]
}

function setStatus(run: RunRecord, status: RunStatus): RunRecord {
  return { ...run, status }
}

export function applyEvent(runs: RunRecord[], e: UIEvent): RunRecord[] {
  // Only run.* events carry a runId; session.*/gmail.*/*.changed do not and are
  // ignored. Narrowing on the presence of runId also narrows `e` to RunWireEvent.
  if (!('runId' in e)) return runs
  const runId = e.runId

  if (e.kind === 'run.created') {
    const created: RunRecord = {
      id: e.runId,
      sessionId: e.sessionId,
      goal: e.goal,
      status: 'pending',
      summary: null,
      startedAt: e.ts,
      attachments: e.attachments ?? [],
      parentRunId: e.parentRunId,
      agentDefId: e.agentDefId,
      events: [e],
    }
    const without = runs.filter((r) => r.id !== e.runId)
    return [created, ...without]
  }

  // Event for a run we have no record of (e.g. forwarded out of order, or a
  // sub-agent whose run.created was missed). Create a stub and then fall through
  // to apply this event's semantics — crucially so a terminal event (complete/
  // error) doesn't leave the stub stuck 'running', which would keep the composer
  // in a loading state forever.
  let workingRuns = runs
  let idx = runs.findIndex((r) => r.id === runId)
  if (idx === -1) {
    const stub: RunRecord = {
      id: runId,
      sessionId: e.sessionId,
      goal: '(unknown run)',
      status: 'running',
      summary: null,
      startedAt: e.ts,
      attachments: [],
      events: [],
    }
    workingRuns = [stub, ...runs]
    idx = 0
  }

  let updated: RunRecord = { ...workingRuns[idx], events: [...workingRuns[idx].events, e] }

  switch (e.kind) {
    case 'run.dispatched':
      updated = setStatus(updated, 'running')
      break
    case 'run.complete':
      updated = setStatus({ ...updated, summary: e.summary }, 'completed')
      break
    case 'run.error':
      updated = setStatus(updated, e.error.code === 'cancelled' ? 'cancelled' : 'failed')
      break
    case 'run.usage':
      updated = {
        ...updated,
        used: e.used,
        contextTokens: e.contextTokens ?? updated.contextTokens,
        contextWindow: e.contextWindow ?? updated.contextWindow,
      }
      break
    case 'run.plan':
      updated = { ...updated, plan: e.todos }
      break
    case 'run.permission_request':
      updated = setStatus(updated, 'awaiting_user')
      break
    case 'run.progress':
      // A streamed progress event means the run resumed: a run parked on a
      // permission prompt is executing again once the operator decides (the
      // granted tool runs, or the model keeps going after a deny). Nothing else
      // resets it, so without this the run stays 'awaiting_user' for the rest
      // of the run and the composer's submit button never leaves its stop state
      // until the terminal event. Only a parked run flips; a live run is untouched.
      if (updated.status === 'awaiting_user') updated = setStatus(updated, 'running')
      break
    // run.spawned is append-only: the parent→child linkage rides parentRunId on
    // the child's run.created, so here we only record the event on the parent.
    default:
      break
  }

  const next = [...workingRuns]
  next[idx] = updated
  return next
}
