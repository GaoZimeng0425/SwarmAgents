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
import type { Logger } from 'pino'
import { ulid } from 'ulid'

export type RunHooksOpts = {
  sessionId: string
  runId: string
  risk: (toolName: string, args: unknown) => Risk
  permissionMode: () => PermissionMode
  // actionId is the SAME id createRunHooks broadcasts in the permission_request
  // event — the caller must thread it through to wherever the decision is
  // eventually resolved (permission-registry.ts's resolve()), so a later
  // resolve(actionId, decision) can find the pending request. Without this the
  // broadcast id and the resolution id would never correlate (dead-end gate).
  requestPermission: (req: {
    actionId: string
    toolName: string
    risk: Risk
    summary: string
    payload: unknown
  }) => Promise<PermissionDecision>
  budget: ResourceBudget
  // Live accumulator, owned, reset, and INCREMENTED (calls) by the caller
  // (SessionAgent) — the single point of truth for call counting, so
  // turn_end usage still reports calls>0 even when no gate hook is wired.
  // createRunHooks only READS `used` for its budget gate (and lets
  // usageSnapshot()'s cost tracking feed the same object for the usdCents
  // check); it never increments `calls` itself.
  used: ConsumedResources
  broadcast: (e: AgentWireEvent) => void
  log: Logger
  signal: () => AbortSignal | undefined
  // Ends the whole run (not just this tool call) with `reason` — ported from
  // engine.ts:205-210's `agent.abort()` on over-budget. The caller wires this
  // to its own run-abort mechanism (SessionAgent.abortRun).
  abortRun: (reason: string) => void
  onPlanTodos: (todos: PlanTodo[]) => void
}

export type RunHooks = {
  beforeToolCall: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>
  afterToolCall: (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>
  used: ConsumedResources
}

/**
 * Permission gate + resource budget + plan capture, as a pair of pi Agent
 * hooks. One instance per run — ported verbatim in behavior from
 * message-engine/engine.ts:199-236 (deleted in Task 9), with the old
 * `emit('message.permission_request', ...)` replaced by a v3 `AgentWireEvent`
 * broadcast.
 */
export function createRunHooks(opts: RunHooksOpts): RunHooks {
  const startedAt = Date.now()
  const used = opts.used

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
      opts.log.info({
        msg: 'tool call cancelled before dispatch',
        sessionId: opts.sessionId,
        runId: opts.runId,
        toolName,
      })
      return { block: true, reason: 'Stopped by user.' }
    }
    // NOT incremented here — the caller (SessionAgent) already bumped
    // used.calls unconditionally before invoking this hook (single point of
    // counting; see SessionAgentDeps.hooks / buildAgent's beforeToolCall).
    const dim = overBudget()
    if (dim) {
      const reason = `Budget exhausted (${dim}).`
      opts.log.warn({
        msg: 'tool call blocked: budget exhausted',
        sessionId: opts.sessionId,
        runId: opts.runId,
        toolName,
        dim,
      })
      // Ported from engine.ts:205-210: an over-budget tool call ends the
      // WHOLE run, not just this one call — a single blocked call would
      // otherwise let the model keep retrying other tools forever.
      opts.abortRun(reason)
      return { block: true, reason }
    }
    const risk = opts.risk(toolName, ctx.args)
    if (risk === 'low') return undefined
    if (opts.permissionMode() === 'full') return undefined

    const actionId = ulid()
    const summary = `Run tool: ${toolName}`
    opts.log.info({
      msg: 'permission requested',
      sessionId: opts.sessionId,
      runId: opts.runId,
      actionId,
      toolName,
      risk,
    })
    opts.broadcast({
      kind: 'permission_request',
      sessionId: opts.sessionId,
      runId: opts.runId,
      actionId,
      risk,
      summary,
      payload: ctx.args,
    })

    let decision: PermissionDecision
    try {
      decision = await opts.requestPermission({ actionId, toolName, risk, summary, payload: ctx.args })
    } catch (err) {
      // Fail-safe deny: an external requestPermission failure must never be
      // mistaken for a grant.
      opts.log.error({
        msg: 'requestPermission threw',
        sessionId: opts.sessionId,
        runId: opts.runId,
        actionId,
        toolName,
        err: err instanceof Error ? err.message : String(err),
      })
      return { block: true, reason: 'permission flow failed' }
    }

    if (opts.signal()?.aborted) {
      opts.log.info({
        msg: 'tool call cancelled awaiting approval',
        sessionId: opts.sessionId,
        runId: opts.runId,
        toolName,
      })
      return { block: true, reason: 'Stopped by user.' }
    }
    if (decision === 'grant') {
      opts.log.info({ msg: 'tool call approved', sessionId: opts.sessionId, runId: opts.runId, toolName, risk })
      return undefined
    }
    opts.log.warn({
      msg: 'tool call blocked by user',
      sessionId: opts.sessionId,
      runId: opts.runId,
      toolName,
      risk,
      decision,
    })
    return { block: true, reason: `User ${decision} the action.` }
  }

  const afterToolCall = async (ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    if (ctx.toolCall.name === 'update_plan') {
      const todos = (ctx.result.details as { todos?: unknown } | undefined)?.todos
      if (Array.isArray(todos)) {
        try {
          opts.onPlanTodos(todos as PlanTodo[])
          opts.log.debug({
            msg: 'plan todos captured',
            sessionId: opts.sessionId,
            runId: opts.runId,
            count: todos.length,
          })
        } catch (err) {
          // Logged, not rethrown: a broken plan-capture path must not corrupt
          // the tool result the model already received.
          opts.log.error({
            msg: 'onPlanTodos threw',
            sessionId: opts.sessionId,
            runId: opts.runId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    return undefined
  }

  return { beforeToolCall, afterToolCall, used }
}
