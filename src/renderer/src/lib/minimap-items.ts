import type { TaskRecord } from './apply-event'

export type MinimapItem = { taskId: string; text: string; ts: number }

// One item per top-level user turn (sub-agent tasks carry parentTaskId and are
// excluded). The user message text is the task goal. Ordered oldest-first to
// match the transcript's top-to-bottom layout.
export function minimapItems(tasks: TaskRecord[]): MinimapItem[] {
  return tasks
    .filter((t) => !t.parentTaskId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t) => ({ taskId: t.id, text: t.goal, ts: t.startedAt }))
}
