// apps/desktop/src/renderer/src/lib/workspace/build-timeline.ts
// Pure builder: flattens a session's MessageRecord[].events into a flat timeline.
// message.progress / message.usage / message.plan / message.delegation_plan / message.spawned are
// filtered out — too dense for a glanceable log, and their substance shows
// elsewhere (plan tab, transcript).

import type { MessageRecord } from '@shared/lib/apply-event'
import type { UIEvent } from '@swarm/protocol'

export type TimelineKind = 'start' | 'dispatch' | 'tool' | 'permission' | 'complete' | 'error'

export type TimelineRow = {
  /** `${messageId}:${seq}` — unique within the session. */
  id: string
  ts: number
  kind: TimelineKind
  label: string
}

const KEEP: Record<string, TimelineKind | undefined> = {
  'message.created': 'start',
  'message.dispatched': 'dispatch',
  'message.tool_call': 'tool',
  'message.permission_request': 'permission',
  'message.complete': 'complete',
  'message.error': 'error',
}

function label(e: UIEvent & { ts: number }): string {
  // Narrow per kind; the KEEP guard above guarantees these members.
  switch (e.kind) {
    case 'message.created':
      return e.prompt
    case 'message.dispatched':
      return '派发'
    case 'message.tool_call':
      return e.tool
    case 'message.permission_request':
      return e.summary
    case 'message.complete':
      return e.summary
    case 'message.error':
      return e.error.message
    default:
      return e.kind
  }
}

/** Flatten all messages' events into one timeline, filtering noisy kinds, sorted by ts. */
export function buildTimeline(messages: MessageRecord[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const message of messages) {
    for (const e of message.events) {
      const kind = KEEP[e.kind]
      if (!kind) continue
      rows.push({ id: `${message.id}:${e.seq}`, ts: e.ts, kind, label: label(e) })
    }
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows
}
