import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { EntryRow } from '@swarm/protocol'

/**
 * entries → pi AgentMessage[] (spec §3.2). Linear history: table order IS the
 * path. P1 projects `message` entries only; `custom` entries are app-data
 * (model-invisible by default, pi semantics); `compaction`/`custom_message`
 * projection lands in P4 with transformContext.
 */
export function messagesFromEntries(rows: EntryRow[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const { entry } of rows) {
    // Wire schema's `message` is a loose `{ role: string, ... }` (opaque
    // JSON, per session-entry.ts); double-cast through unknown since it
    // doesn't structurally overlap with pi's concrete AgentMessage union.
    if (entry.type === 'message') out.push(entry.message as unknown as AgentMessage)
  }
  return out
}

/** True when the transcript ends with user message(s) no run has answered yet. */
export function hasUnansweredUserTail(rows: EntryRow[]): boolean {
  const msgs = messagesFromEntries(rows)
  const last = msgs[msgs.length - 1] as { role?: string } | undefined
  return last?.role === 'user'
}
