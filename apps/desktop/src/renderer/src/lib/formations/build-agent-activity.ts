// apps/desktop/src/renderer/src/lib/formations/build-agent-activity.ts
// Pure builder: resolves each active message to an agent id and aggregates the
// newest activity per agent. Sub-agent messages carry agentDefId; top-level
// messages resolve via their session's agentType.

import type { MessageRecord } from '@shared/lib/apply-event'
import type { SessionSummary } from '@swarm/protocol'

export type AgentActivity = {
  status: 'running' | 'idle'
  /** Newest active message's prompt, truncated to 40 chars. */
  currentTask?: string
  /** "n/m 步" from that message's plan; omitted when the message has no plan. */
  stepProgress?: string
}

const ACTIVE = new Set(['pending', 'running'])
const MAX_TASK = 40

function truncate(s: string): string {
  return s.length > MAX_TASK ? s.slice(0, MAX_TASK - 1) + '…' : s
}

function stepProgressOf(plan: { status: string }[] | undefined): string | undefined {
  if (!plan || plan.length === 0) return undefined
  const done = plan.filter((p) => p.status === 'completed').length
  return `${done}/${plan.length} 步`
}

/** Resolve the agent id for a message: agentDefId (sub-agent) or session.agentType (top-level). */
function agentIdOf(message: MessageRecord, sessionAgentBySession: Map<string, string | undefined>): string | undefined {
  return message.agentDefId ?? sessionAgentBySession.get(message.sessionId)
}

/** Build a Map<agentId, AgentActivity> from active messages. Idle agents are absent. */
export function buildAgentActivity(messages: MessageRecord[], sessions: SessionSummary[]): Map<string, AgentActivity> {
  const sessionAgent = new Map(sessions.map((s) => [s.id, s.agentType]))
  // Track the newest active message per agent.
  const newest = new Map<string, MessageRecord>()
  for (const r of messages) {
    if (!ACTIVE.has(r.status)) continue
    const aid = agentIdOf(r, sessionAgent)
    if (!aid) continue
    const prev = newest.get(aid)
    if (!prev || r.createdAt > prev.createdAt) newest.set(aid, r)
  }
  const out = new Map<string, AgentActivity>()
  for (const [aid, r] of newest) {
    out.set(aid, {
      status: 'running',
      currentTask: truncate(r.prompt),
      stepProgress: stepProgressOf(r.plan),
    })
  }
  return out
}
