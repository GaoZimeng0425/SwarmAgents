import type { Risk } from './ipc'
import type {
  Artifact,
  Attachment,
  ConsumedResources,
  DelegationItem,
  DelegationItemStatus,
  PlanTodo,
  TaskEvent,
} from './task'

/**
 * Wire protocol v2: message.* events (run-engine rewrite spec §5).
 *
 * The message vocabulary replaces the legacy "run" / "task" terms. A message
 * is one conversational turn: user prompt → agent execution → result.
 */

export type TerminalStatus = 'completed' | 'failed' | 'cancelled'

export type MessageErrorInfo = {
  code: string
  message: string
  tier: 'transient' | 'recoverable' | 'fatal' | 'gave_up'
}

/** Identity + ordering fields, stamped exactly once by the engine's emit factory. */
export type MessageEventBase = {
  sessionId: string
  messageId: string
  /** Set on child messages; links to the parent for grouped rendering. */
  parentMessageId?: string
  /** Session-scoped monotonic order (the replay sort key). */
  seq: number
  ts: number
}

export type MessageWireEvent =
  | (MessageEventBase & {
      kind: 'message.created'
      prompt: string
      attachments?: Attachment[]
      /** Agent definition id (e.g. 'researcher'), labels child-message blocks. */
      agentDefId?: string
    })
  | (MessageEventBase & { kind: 'message.dispatched' })
  | (MessageEventBase & { kind: 'message.progress'; event: TaskEvent })
  | (MessageEventBase & { kind: 'message.tool_call'; tool: string; args: unknown })
  | (MessageEventBase & {
      kind: 'message.permission_request'
      actionId: string
      risk: Risk
      summary: string
      payload: unknown
    })
  | (MessageEventBase & { kind: 'message.complete'; summary: string })
  | (MessageEventBase & { kind: 'message.error'; error: MessageErrorInfo })
  | (MessageEventBase & {
      kind: 'message.usage'
      used: ConsumedResources
      contextTokens?: number
      contextWindow?: number
      /** Resolved message model id, for per-model usage attribution. */
      model?: string
    })
  | (MessageEventBase & { kind: 'message.plan'; todos: PlanTodo[] })
  | (MessageEventBase & { kind: 'message.delegation_plan'; plan: DelegationItem[] })
  | (MessageEventBase & {
      kind: 'message.delegation_update'
      itemId: string
      status: DelegationItemStatus
      result: Artifact[]
    })
  | (MessageEventBase & { kind: 'message.spawned'; childMessageId: string })

/**
 * The single source of truth for event→terminal-status (bug ledger #9: three
 * hand-synced copies of this rule drifted once already). The store's boot-scan
 * SQL CASE and the renderer reducer are asserted equivalent to this function
 * by tests when they adopt message.* (W3/W4).
 */
export function terminalStatusForMessageEvent(e: { kind: string; error?: unknown }): TerminalStatus | undefined {
  if (e.kind === 'message.complete') return 'completed'
  if (e.kind === 'message.error') {
    const code =
      typeof e.error === 'object' && e.error !== null && 'code' in e.error
        ? (e.error as { code?: unknown }).code
        : undefined
    return code === 'cancelled' ? 'cancelled' : 'failed'
  }
  return undefined
}
