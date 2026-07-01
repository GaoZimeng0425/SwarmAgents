import type { Task, UIEvent } from '@swarm/protocol'
import { orderBy } from 'es-toolkit'

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
    const events: UIEvent[] = [
      {
        kind: 'task.created',
        sessionId,
        taskId: t.id,
        goal: t.goal,
        attachments: t.attachments,
        parentTaskId: t.parentId ?? undefined,
        agentDefId: t.agentDefId,
        ts: t.createdAt,
        seq: t.createdAt,
      },
    ]
    for (const ev of t.history) {
      // History is JSON-parsed from storage without zod re-validation, so a
      // legacy/corrupt event may lack a finite ts. Anchor it to the task's
      // createdAt (always present) rather than emit an invalid timestamp.
      const ts = Number.isFinite(ev.ts) ? ev.ts : t.createdAt
      events.push({ kind: 'task.progress', sessionId, taskId: t.id, event: ev, ts, seq: ev.seq ?? ts })
    }
    if (t.result) {
      events.push({
        kind: 'task.complete',
        sessionId,
        taskId: t.id,
        summary: t.result.summary,
        ts: t.endedAt ?? t.createdAt,
        seq: t.endedAt ?? t.createdAt,
      })
    }
    return {
      id: t.id,
      sessionId,
      goal: t.goal,
      status: STORED_TO_UI_STATUS[t.status] ?? 'failed',
      workerId: t.assignedWorkerId,
      summary: t.result?.summary ?? null,
      startedAt: t.createdAt,
      attachments: t.attachments,
      parentTaskId: t.parentId ?? undefined,
      agentDefId: t.agentDefId,
      plan: t.plan.length ? t.plan : undefined,
      // Restore the usage display: `used` and the window were persisted, and
      // used.tokens is the last turn's context snapshot (the ring's numerator).
      used: t.used,
      contextTokens: t.used.tokens,
      contextWindow: t.contextWindow,
      events,
    }
  })
  return orderBy(records, ['startedAt'], ['desc'])
}
