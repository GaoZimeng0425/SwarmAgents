import type { Risk } from './ipc'
import type { SessionEntry } from './session-entry'
import type { ConsumedResources } from './task'

export const runStatusValues = ['completed', 'failed', 'cancelled'] as const
export type RunStatus = (typeof runStatusValues)[number]

type RunScope = { sessionId: string; runId: string }

/**
 * Wire protocol v3: pi AgentEvents pass through with sessionId/runId scope
 * attached, plus SwarmAgents-owned events (entry_appended, permission_request).
 * Delta-class events (message_update, tool_execution_update) are broadcast-only
 * and frame-coalesced; entry_appended is persist-then-broadcast.
 */
export type AgentWireEvent =
  | (RunScope & { kind: 'agent_start' })
  | (RunScope & { kind: 'agent_end'; status: RunStatus; errorMessage?: string })
  | (RunScope & { kind: 'turn_start' })
  | (RunScope & {
      kind: 'turn_end'
      used: ConsumedResources
      contextTokens?: number
      contextWindow?: number
      model?: string
    })
  | (RunScope & { kind: 'message_start'; message: unknown })
  | (RunScope & { kind: 'message_update'; message: unknown })
  | (RunScope & { kind: 'message_end'; message: unknown })
  | (RunScope & { kind: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown })
  | (RunScope & { kind: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult: unknown })
  | (RunScope & { kind: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean })
  | { kind: 'entry_appended'; sessionId: string; rowId: number; entry: SessionEntry }
  | (RunScope & { kind: 'permission_request'; actionId: string; risk: Risk; summary: string; payload: unknown })

export const AGENT_WIRE_KINDS = new Set<AgentWireEvent['kind']>([
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'entry_appended',
  'permission_request',
])

export function isAgentWireEvent(e: { kind: string }): e is AgentWireEvent {
  return AGENT_WIRE_KINDS.has(e.kind as AgentWireEvent['kind'])
}
