// apps/desktop/src/renderer/src/lib/workspace/build-timeline.ts
// Pure builder for the workspace timeline tab. v3: the per-event timeline was
// flattened from v2 message.* events; on the entry rails this component is fed no
// messages and renders empty. Rebuilding a timeline from session entries is P2+
// (see task-9 report); the v2 event flattening has been removed.

import type { MessageRecord } from '@shared/lib/apply-event'

export type TimelineKind = 'start' | 'dispatch' | 'tool' | 'permission' | 'complete' | 'error'

export type TimelineRow = {
  /** `${messageId}:${seq}` — unique within the session. */
  id: string
  ts: number
  kind: TimelineKind
  label: string
}

/** v3 stub: fed no messages on the entry rails, so the timeline is empty. */
export function buildTimeline(_messages: MessageRecord[]): TimelineRow[] {
  return []
}
