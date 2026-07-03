import type { Attachment, ConsumedResources, PlanTodo, UIEvent } from '@swarm/protocol'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled'

export type RunRecord = {
  id: string
  sessionId: string
  goal: string
  status: TaskStatus
  workerId: string | null
  summary: string | null
  startedAt: number
  attachments: Attachment[]
  used?: ConsumedResources
  contextTokens?: number
  contextWindow?: number
  plan?: PlanTodo[]
  /** Set when this task is a spawned sub-agent (links to its parent). */
  parentTaskId?: string
  /** Sub-agent definition id, used to label the subagent block. */
  agentDefId?: string
  events: UIEvent[]
}

function setStatus(task: RunRecord, status: TaskStatus): RunRecord {
  return { ...task, status }
}

export function applyEvent(tasks: RunRecord[], e: UIEvent): RunRecord[] {
  const taskId = 'taskId' in e ? e.taskId : null
  if (!taskId) return tasks

  if (e.kind === 'task.created') {
    const created: RunRecord = {
      id: e.taskId,
      sessionId: e.sessionId,
      goal: e.goal,
      status: 'pending',
      workerId: null,
      summary: null,
      startedAt: e.ts,
      attachments: e.attachments ?? [],
      parentTaskId: e.parentTaskId,
      agentDefId: e.agentDefId,
      events: [e],
    }
    const without = tasks.filter((t) => t.id !== e.taskId)
    return [created, ...without]
  }

  // Event for a task we have no record of (e.g. forwarded out of order, or a
  // sub-agent whose task.created was missed). Create a stub and then fall through
  // to apply this event's semantics — crucially so a terminal event (complete/
  // error) doesn't leave the stub stuck 'running', which would keep the composer
  // in a loading state forever.
  let workingTasks = tasks
  let idx = tasks.findIndex((t) => t.id === taskId)
  if (idx === -1) {
    const stub: RunRecord = {
      id: taskId,
      sessionId: 'sessionId' in e ? (e.sessionId as string) : '',
      goal: '(unknown task)',
      status: 'running',
      workerId: null,
      summary: null,
      startedAt: e.ts,
      attachments: [],
      events: [],
    }
    workingTasks = [stub, ...tasks]
    idx = 0
  }

  let updated: RunRecord = { ...workingTasks[idx], events: [...workingTasks[idx].events, e] }

  switch (e.kind) {
    case 'task.dispatched':
      updated = { ...updated, status: 'running', workerId: e.workerId }
      break
    case 'task.complete':
      updated = setStatus({ ...updated, summary: e.summary }, 'completed')
      break
    case 'task.error': {
      const code =
        typeof e.error === 'object' && e.error && 'code' in e.error ? (e.error as { code: unknown }).code : undefined
      updated = setStatus(updated, code === 'cancelled' ? 'cancelled' : 'failed')
      break
    }
    case 'task.usage':
      updated = {
        ...updated,
        used: e.used,
        contextTokens: e.contextTokens ?? updated.contextTokens,
        contextWindow: e.contextWindow ?? updated.contextWindow,
      }
      break
    case 'task.plan':
      updated = { ...updated, plan: e.todos }
      break
    case 'task.permission_request':
      updated = setStatus(updated, 'awaiting_user')
      break
    case 'task.progress':
      // A streamed progress event means the run resumed: a task parked on a
      // permission prompt is executing again once the operator decides (the
      // granted tool runs, or the model keeps going after a deny). Nothing else
      // resets it, so without this the task stays 'awaiting_user' for the rest
      // of the run and the composer's submit button never leaves its stop state
      // until the terminal event. Only a parked task flips; a live run is untouched.
      if (updated.status === 'awaiting_user') updated = setStatus(updated, 'running')
      break
    default:
      break
  }

  const next = [...workingTasks]
  next[idx] = updated
  return next
}
