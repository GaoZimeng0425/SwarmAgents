import type {
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core'
import type {
  AgentWireEvent,
  ConsumedResources,
  PermissionDecision,
  PermissionMode,
  PlanTodo,
  ResourceBudget,
  Risk,
} from '@swarm/protocol'
import { emptyUsed } from '@swarm/protocol'
import type { Logger } from 'pino'
import { ulid } from 'ulid'

export type RunHooksOpts = {
  sessionId: string
  runId: string
  risk: (toolName: string, args: unknown) => Risk
  permissionMode: () => PermissionMode
  requestPermission: (req: {
    toolName: string
    risk: Risk
    summary: string
    payload: unknown
  }) => Promise<PermissionDecision>
  budget: ResourceBudget
  broadcast: (e: AgentWireEvent) => void
  log: Logger
  signal: () => AbortSignal | undefined
  onPlanTodos: (todos: PlanTodo[]) => void
}

export type RunHooks = {
  beforeToolCall: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>
  afterToolCall: (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>
  used: ConsumedResources
}

/**
 * Permission gate + resource budget + plan capture, as a pair of pi Agent
 * hooks. One instance per run (fresh `used` each time) — ported verbatim in
 * behavior from message-engine/engine.ts:199-236 (deleted in Task 9), with the
 * old `emit('message.permission_request', ...)` replaced by a v3
 * `AgentWireEvent` broadcast.
 */
export function createRunHooks(opts: RunHooksOpts): RunHooks {
  const startedAt = Date.now()
  const used: ConsumedResources = emptyUsed()

  // Runaway guards only (calls/time/cost); token spend is deliberately absent
  // (ResourceBudget has no `tokens` field — see task.ts's ResourceBudgetSchema).
  const overBudget = (): string | null => {
    if (used.calls > opts.budget.calls) return 'calls'
    if (Date.now() - startedAt > opts.budget.wallMs) return 'wallMs'
    if (used.usdCents > opts.budget.usdCents) return 'usdCents'
    return null
  }

  const beforeToolCall = async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const toolName = ctx.toolCall.name
    if (opts.signal()?.aborted) {
      opts.log.info({ msg: 'tool call cancelled before dispatch', sessionId: opts.sessionId, runId: opts.runId, toolName })
      return { block: true, reason: 'Stopped by user.' }
    }
    used.calls += 1
    const dim = overBudget()
    if (dim) {
      opts.log.warn({
        msg: 'tool call blocked: budget exhausted',
        sessionId: opts.sessionId,
        runId: opts.runId,
        toolName,
        dim,
      })
      return { block: true, reason: `Budget exhausted (${dim}).` }
    }
    const risk = opts.risk(toolName, ctx.args)
    if (risk === 'low') return undefined
    if (opts.permissionMode() === 'full') return undefined

    const actionId = ulid()
    const summary = `Run tool: ${toolName}`
    opts.log.info({ msg: 'permission requested', sessionId: opts.sessionId, runId: opts.runId, actionId, toolName, risk })
    opts.broadcast({
      kind: 'permission_request',
      sessionId: opts.sessionId,
      runId: opts.runId,
      actionId,
      risk,
      summary,
      payload: ctx.args,
    })
    const decision = await opts.requestPermission({ toolName, risk, summary, payload: ctx.args })
    if (opts.signal()?.aborted) {
      opts.log.info({ msg: 'tool call cancelled awaiting approval', sessionId: opts.sessionId, runId: opts.runId, toolName })
      return { block: true, reason: 'Stopped by user.' }
    }
    if (decision === 'grant') {
      opts.log.info({ msg: 'tool call approved', sessionId: opts.sessionId, runId: opts.runId, toolName, risk })
      return undefined
    }
    opts.log.warn({ msg: 'tool call blocked by user', sessionId: opts.sessionId, runId: opts.runId, toolName, risk, decision })
    return { block: true, reason: `User ${decision} the action.` }
  }

  const afterToolCall = async (ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    if (ctx.toolCall.name === 'update_plan') {
      const todos = (ctx.result.details as { todos?: unknown } | undefined)?.todos
      if (Array.isArray(todos)) opts.onPlanTodos(todos as PlanTodo[])
    }
    return undefined
  }

  return { beforeToolCall, afterToolCall, used }
}
