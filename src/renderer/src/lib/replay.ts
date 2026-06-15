import type { Task } from '@shared/types/task'
import type { UIEvent } from '@shared/types/ui'
import type { TaskRecord, TaskStatus } from './apply-event'

// Keys are the persisted Task['status'] string values, so snake_case is required here.
// biome-ignore lint/style/useNamingConvention: keys mirror stored status values verbatim
const STORED_TO_UI_STATUS: Partial<Record<Task['status'], TaskStatus>> = {
  pending: 'pending',
  planning: 'running',
  dispatched: 'running',
  running: 'running',
  awaiting_user: 'awaiting_user',
  paused: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'failed',
}

/** Rebuild renderer TaskRecords from persisted tasks (for session replay on switch). */
export function tasksToRecords(sessionId: string, tasks: Task[]): TaskRecord[] {
  const records = tasks.map((t): TaskRecord => {
    const events: UIEvent[] = [{ kind: 'task.created', sessionId, taskId: t.id, goal: t.goal, ts: t.createdAt }]
    for (const ev of t.history) {
      events.push({ kind: 'task.progress', sessionId, taskId: t.id, event: ev, ts: ev.ts })
    }
    if (t.result) {
      events.push({ kind: 'task.complete', sessionId, taskId: t.id, summary: t.result.summary, ts: t.endedAt ?? t.createdAt })
    }
    return {
      id: t.id,
      sessionId,
      goal: t.goal,
      status: STORED_TO_UI_STATUS[t.status] ?? 'failed',
      workerId: t.assignedWorkerId,
      summary: t.result?.summary ?? null,
      startedAt: t.createdAt,
      events,
    }
  })
  records.sort((a, b) => b.startedAt - a.startedAt)
  return records
}
