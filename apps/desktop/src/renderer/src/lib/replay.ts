import type { TaskRecord, TaskStatus } from '@shared/lib/apply-event'
import type { ConversationEvent, Task, UIEvent } from '@swarm/protocol'
import { orderBy } from 'es-toolkit'

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
        // Order the task at its first real event (the persisted stamped seq), not
        // at wall-clock createdAt. buildTimelineItems keys sub-agent blocks off
        // events[0].seq; using createdAt (ms) would sort reloaded blocks far past
        // the conversation turn's small counter seqs, shoving them to the end.
        seq: t.history[0]?.seq ?? t.createdAt,
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

/** A persisted conversation-events row (the session-level conversation stream). */

/**
 * Group session-conversation events by turnId into TaskRecord-shaped turns the
 * existing taskSegments / buildTimelineItems pipeline renders unchanged. Each
 * turn is a pseudo-task keyed by its turnId — the SAME id the service stamps on
 * live conversation events (task.progress with taskId: turnId), so a live
 * in-flight turn and its replayed record merge into one entry in the cache.
 */
export function conversationTurnsToRecords(sessionId: string, rows: ConversationEvent[]): TaskRecord[] {
  const byTurn = new Map<string, ConversationEvent[]>()
  for (const r of rows) {
    const list = byTurn.get(r.turnId) ?? []
    list.push(r)
    byTurn.set(r.turnId, list)
  }
  const records: TaskRecord[] = []
  for (const [turnId, evs] of byTurn) {
    const firstUser = evs.find(
      (r) => (r.event as { kind?: string }).kind === 'llm.message' && (r.event as { role?: string }).role === 'user'
    )
    const events: UIEvent[] = evs.map((r) => ({
      kind: 'task.progress',
      sessionId,
      taskId: turnId,
      event: r.event,
      ts: r.ts,
      seq: r.seq,
    }))
    records.push({
      id: turnId,
      sessionId,
      goal: firstUser ? String((firstUser.event as { content?: unknown }).content ?? '') : '',
      status: 'running',
      workerId: null,
      summary: null,
      startedAt: evs[0]?.ts ?? 0,
      attachments: [],
      events,
      // Marker so the task panel (planGroups/verifyGroups) can exclude
      // conversation turns — they never carry a plan or acceptance criteria.
      isConversation: true,
    })
  }
  return orderBy(records, ['startedAt'], ['desc'])
}
