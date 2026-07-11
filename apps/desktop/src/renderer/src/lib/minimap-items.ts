import type { MessageRecord } from '@shared/lib/apply-event'
import { sortBy } from 'es-toolkit'

export type MinimapItem = { messageId: string; text: string; ts: number }

// One item per top-level user turn (sub-agent messages carry parentMessageId
// and are excluded). The user message text is the message goal. Sorted by the
// message's seq — the same causal order buildTimelineItems uses — so the
// minimap's top-to-bottom order matches the transcript.
export function minimapItems(tasks: MessageRecord[]): MinimapItem[] {
  return sortBy(
    tasks.filter((t) => !t.parentMessageId),
    [(t) => t.order]
  ).map((t) => ({ messageId: t.id, text: t.prompt ?? '', ts: t.createdAt }))
}
