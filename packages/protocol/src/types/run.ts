import type { Risk } from './ipc'
import type { Attachment, ConsumedResources, DelegationItem, PlanTodo, TaskEvent } from './task'

/**
 * Wire protocol v2: run.* events (run-engine rewrite spec §5).
 *
 * Unused by the app until the W4 switchover — the run-engine emits these
 * natively. session.* / gmail.* events stay on the UIEvent union; at
 * switchover, UIEvent's task.* members are replaced by this union and the
 * persisted task.* rows are migrated by SQL.
 */

export type TerminalStatus = 'completed' | 'failed' | 'cancelled'

export type RunErrorInfo = {
  code: string
  message: string
  tier: 'transient' | 'recoverable' | 'fatal' | 'gave_up'
}

/** Identity + ordering fields, stamped exactly once by the engine's emit factory. */
export type RunEventBase = {
  sessionId: string
  runId: string
  /** Set on child runs; links to the parent for grouped rendering. */
  parentRunId?: string
  /** Session-scoped monotonic order (the replay sort key). */
  seq: number
  ts: number
}

export type RunWireEvent =
  | (RunEventBase & {
      kind: 'run.created'
      prompt: string
      attachments?: Attachment[]
      /** Agent definition id (e.g. 'researcher'), labels child-run blocks. */
      agentDefId?: string
    })
  | (RunEventBase & { kind: 'run.dispatched' })
  | (RunEventBase & { kind: 'run.progress'; event: TaskEvent })
  | (RunEventBase & { kind: 'run.tool_call'; tool: string; args: unknown })
  | (RunEventBase & {
      kind: 'run.permission_request'
      actionId: string
      risk: Risk
      summary: string
      payload: unknown
    })
  | (RunEventBase & { kind: 'run.complete'; summary: string })
  | (RunEventBase & { kind: 'run.error'; error: RunErrorInfo })
  | (RunEventBase & {
      kind: 'run.usage'
      used: ConsumedResources
      contextTokens?: number
      contextWindow?: number
      /** Resolved run model id, for per-model usage attribution. */
      model?: string
    })
  | (RunEventBase & { kind: 'run.plan'; todos: PlanTodo[] })
  | (RunEventBase & { kind: 'run.delegation_plan'; plan: DelegationItem[] })
  | (RunEventBase & { kind: 'run.spawned'; childRunId: string })

/**
 * The single source of truth for event→terminal-status (bug ledger #9: three
 * hand-synced copies of this rule drifted once already). The store's boot-scan
 * SQL CASE and the renderer reducer are asserted equivalent to this function
 * by tests when they adopt run.* (W3/W4).
 */
export function terminalStatusForRunEvent(e: { kind: string; error?: unknown }): TerminalStatus | undefined {
  if (e.kind === 'run.complete') return 'completed'
  if (e.kind === 'run.error') {
    const code =
      typeof e.error === 'object' && e.error !== null && 'code' in e.error
        ? (e.error as { code?: unknown }).code
        : undefined
    return code === 'cancelled' ? 'cancelled' : 'failed'
  }
  return undefined
}
