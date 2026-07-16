import type { BeforeToolCallContext, AfterToolCallContext } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type { AgentWireEvent, PermissionDecision, PlanTodo, ResourceBudget } from '@swarm/protocol'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { createRunHooks } from './run-hooks'

function silentLogger(): Logger {
  const log = createLogger({ process: 'test' })
  log.level = 'silent'
  return log
}

/** Minimal BeforeToolCallContext — only fields the hook actually reads. */
function beforeCtx(toolName: string, args: unknown = {}): BeforeToolCallContext {
  return {
    assistantMessage: {} as never,
    toolCall: { type: 'toolCall', name: toolName } as never,
    args,
    context: {} as never,
  }
}

function afterCtx(toolName: string, details: unknown): AfterToolCallContext {
  return {
    assistantMessage: {} as never,
    toolCall: { type: 'toolCall', name: toolName } as never,
    args: {},
    result: { content: [], details },
    isError: false,
    context: {} as never,
  }
}

const bigBudget: ResourceBudget = { calls: 100, wallMs: 60_000, usdCents: 100_000 }

function makeOpts(overrides: {
  risk?: (toolName: string, args: unknown) => 'low' | 'medium' | 'high'
  permissionMode?: () => 'ask' | 'full'
  requestPermission?: (req: { toolName: string; risk: string; summary: string; payload: unknown }) => Promise<PermissionDecision>
  budget?: ResourceBudget
  signal?: () => AbortSignal | undefined
  onPlanTodos?: (todos: PlanTodo[]) => void
}) {
  const broadcasts: AgentWireEvent[] = []
  const opts = {
    sessionId: 's1',
    runId: 'r1',
    risk: overrides.risk ?? (() => 'low' as const),
    permissionMode: overrides.permissionMode ?? (() => 'ask' as const),
    requestPermission: overrides.requestPermission ?? (async () => 'grant' as const),
    budget: overrides.budget ?? bigBudget,
    broadcast: (e: AgentWireEvent) => broadcasts.push(e),
    log: silentLogger(),
    signal: overrides.signal ?? (() => undefined),
    onPlanTodos: overrides.onPlanTodos ?? (() => {}),
  }
  return { opts, broadcasts }
}

describe('createRunHooks', () => {
  it('low-risk tool calls pass through without a permission request', async () => {
    const requestPermission = vi.fn(async () => 'grant' as const)
    const { opts, broadcasts } = makeOpts({ risk: () => 'low', requestPermission })

    const hooks = createRunHooks(opts)
    const result = await hooks.beforeToolCall(beforeCtx('read_file'))

    expect(result).toBeUndefined()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
    expect(hooks.used.calls).toBe(1)
  })

  it('medium risk in ask mode broadcasts permission_request and blocks on deny', async () => {
    const { opts, broadcasts } = makeOpts({
      risk: () => 'medium',
      permissionMode: () => 'ask',
      requestPermission: async () => 'deny',
    })

    const hooks = createRunHooks(opts)
    const result = await hooks.beforeToolCall(beforeCtx('write_file', { path: 'x' }))

    expect(result).toEqual({ block: true, reason: 'User deny the action.' })
    expect(broadcasts).toHaveLength(1)
    const bc = broadcasts[0]
    expect(bc.kind).toBe('permission_request')
    if (bc.kind === 'permission_request') {
      expect(bc.sessionId).toBe('s1')
      expect(bc.runId).toBe('r1')
      expect(typeof bc.actionId).toBe('string')
      expect(bc.actionId.length).toBeGreaterThan(0)
      expect(bc.risk).toBe('medium')
      expect(bc.summary).toBe('Run tool: write_file')
    }
  })

  it('permissionMode full auto-allows medium/high risk without a permission request', async () => {
    const requestPermission = vi.fn(async () => 'grant' as const)
    const { opts, broadcasts } = makeOpts({ risk: () => 'high', permissionMode: () => 'full', requestPermission })

    const hooks = createRunHooks(opts)
    const result = await hooks.beforeToolCall(beforeCtx('run_shell'))

    expect(result).toBeUndefined()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
  })

  it('blocks once the call budget is exceeded, with a budget reason', async () => {
    const { opts } = makeOpts({ budget: { calls: 1, wallMs: 60_000, usdCents: 100_000 } })
    const hooks = createRunHooks(opts)

    const first = await hooks.beforeToolCall(beforeCtx('read_file'))
    expect(first).toBeUndefined()

    const second = await hooks.beforeToolCall(beforeCtx('read_file'))
    expect(second).toEqual({ block: true, reason: 'Budget exhausted (calls).' })
  })

  it('an aborted signal blocks with a fail-safe deny before any permission request', async () => {
    const requestPermission = vi.fn(async () => 'grant' as const)
    const controller = new AbortController()
    controller.abort()
    const { opts, broadcasts } = makeOpts({
      risk: () => 'high',
      signal: () => controller.signal,
      requestPermission,
    })

    const hooks = createRunHooks(opts)
    const result = await hooks.beforeToolCall(beforeCtx('run_shell'))

    expect(result).toEqual({ block: true, reason: 'Stopped by user.' })
    expect(requestPermission).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
    expect(hooks.used.calls).toBe(0)
  })

  it('afterToolCall forwards update_plan todos to onPlanTodos', async () => {
    const onPlanTodos = vi.fn()
    const { opts } = makeOpts({ onPlanTodos })
    const hooks = createRunHooks(opts)

    const todos: PlanTodo[] = [{ content: 'step one', status: 'pending' }]
    await hooks.afterToolCall(afterCtx('update_plan', { todos }))

    expect(onPlanTodos).toHaveBeenCalledWith(todos)
  })

  it('afterToolCall ignores non-update_plan tools and malformed details', async () => {
    const onPlanTodos = vi.fn()
    const { opts } = makeOpts({ onPlanTodos })
    const hooks = createRunHooks(opts)

    await hooks.afterToolCall(afterCtx('read_file', { todos: [{ content: 'x', status: 'pending' }] }))
    await hooks.afterToolCall(afterCtx('update_plan', { error: 'bad input' }))

    expect(onPlanTodos).not.toHaveBeenCalled()
  })
})
