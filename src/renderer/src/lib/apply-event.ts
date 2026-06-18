import type { Attachment, ConsumedResources, PlanTodo } from '@shared/types/task'
import type { UIEvent } from '@shared/types/ui'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled'

export type TaskRecord = {
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
  events: UIEvent[]
}

function setStatus(task: TaskRecord, status: TaskStatus): TaskRecord {
  return { ...task, status }
}

export function applyEvent(tasks: TaskRecord[], e: UIEvent): TaskRecord[] {
  const taskId = 'taskId' in e ? e.taskId : null
  if (!taskId) return tasks

  if (e.kind === 'task.created') {
    const created: TaskRecord = {
      id: e.taskId,
      sessionId: e.sessionId,
      goal: e.goal,
      status: 'pending',
      workerId: null,
      summary: null,
      startedAt: e.ts,
      attachments: e.attachments ?? [],
      events: [e],
    }
    const without = tasks.filter((t) => t.id !== e.taskId)
    return [created, ...without]
  }

  const idx = tasks.findIndex((t) => t.id === taskId)
  if (idx === -1) {
    const stub: TaskRecord = {
      id: taskId,
      sessionId: 'sessionId' in e ? (e.sessionId as string) : '',
      goal: '(unknown task)',
      status: 'running',
      workerId: null,
      summary: null,
      startedAt: e.ts,
      attachments: [],
      events: [e],
    }
    return [stub, ...tasks]
  }

  let updated: TaskRecord = { ...tasks[idx], events: [...tasks[idx].events, e] }

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
    default:
      break
  }

  const next = [...tasks]
  next[idx] = updated
  return next
}
