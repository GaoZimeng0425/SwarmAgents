import type { RunRecord } from '@shared/lib/apply-event'
import { sortBy } from 'es-toolkit'

export type MinimapItem = { runId: string; text: string; ts: number }

// One item per top-level user turn (sub-agent runs carry parentRunId and are
// excluded). The user message text is the run goal. Ordered oldest-first to
// match the transcript's top-to-bottom layout.
export function minimapItems(tasks: RunRecord[]): MinimapItem[] {
  return sortBy(
    tasks.filter((t) => !t.parentRunId),
    ['startedAt']
  ).map((t) => ({ runId: t.id, text: t.prompt, ts: t.startedAt }))
}
