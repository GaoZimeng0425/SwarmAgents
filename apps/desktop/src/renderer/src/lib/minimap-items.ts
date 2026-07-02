import { sortBy } from 'es-toolkit'

import type { TaskRecord } from '@shared/lib/apply-event'

export type MinimapItem = { taskId: string; text: string; ts: number }

// One item per top-level user turn (sub-agent tasks carry parentTaskId and are
// excluded). The user message text is the task goal. Ordered oldest-first to
// match the transcript's top-to-bottom layout.
export function minimapItems(tasks: TaskRecord[]): MinimapItem[] {
  return sortBy(
    tasks.filter((t) => !t.parentTaskId),
    ['startedAt']
  ).map((t) => ({ taskId: t.id, text: t.goal, ts: t.startedAt }))
}
