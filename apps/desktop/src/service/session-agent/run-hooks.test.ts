import type { AfterToolCallContext, BeforeToolCallContext } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type { AgentWireEvent, ConsumedResources, PermissionDecision, PlanTodo, ResourceBudget } from '@swarm/protocol'
import { emptyUsed } from '@swarm/protocol'
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

type RequestPermission = (req: {
  actionId: string
  toolName: string
  risk: string
  summary: string
  payload: unknown
}) => Promise<PermissionDecision>

function makeOpts(overrides: {
  risk?: (toolName: string, args: unknown) => 'low' | 'medium' | 'high'
  permissionMode?: () => 'ask' | 'full'
  requestPermission?: RequestPermission
  budget?: ResourceBudget
  used?: ConsumedResources
  signal?: () => AbortSignal | undefined
  abortRun?: (reason: string) => void
  onPlanTodos?: (todos: PlanTodo[]) => void
}) {
  const broadcasts: AgentWireEvent[] = []
  const abortRunCalls: string[] = []
  const opts = {
    sessionId: 's1',
    runId: 'r1',
    risk: overrides.risk ?? (() => 'low' as const),
    permissionMode: overrides.permissionMode ?? (() => 'ask' as const),
    requestPermission: overrides.requestPermission ?? (async () => 'grant' as const),
    budget: overrides.budget ?? bigBudget,
    used: overrides.used ?? emptyUsed(),
    broadcast: (e: AgentWireEvent) => broadcasts.push(e),
    log: silentLogger(),
    signal: overrides.signal ?? (() => undefined),
    abortRun: overrides.abortRun ?? ((reason: string) => abortRunCalls.push(reason)),
    onPlanTodos: overrides.onPlanTodos ?? (() => {}),
  }
  return { opts, broadcasts, abortRunCalls }
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

  it('medium risk in ask mode broadcasts permission_request and blocks on deny, correlated by actionId', async () => {
    const requestPermission = vi.fn(async () => 'deny' as const)
    const { opts, broadcasts } = makeOpts({
      risk: () => 'medium',
      permissionMode: () => 'ask',
      requestPermission,
    })

    const hooks = createRunHooks(opts)
    const result = await hooks.beforeToolCall(beforeCtx('write_file', { path: 'x' }))

    expect(result).toEqual({ block: true, reason: 'User deny the action.' })
    expect(broadcasts).toHaveLength(1)
    const bc = broadcasts[0]
    expect(bc.kind).toBe('permission_request')
    if (bc.kind !== 'permission_request') throw new Error('unreachable')
    expect(bc.sessionId).toBe('s1')
    expect(bc.runId).toBe('r1')
    expect(typeof bc.actionId).toBe('string')
    expect(bc.actionId.length).toBeGreaterThan(0)
    expect(bc.risk).toBe('medium')
    expect(bc.summary).toBe('Run tool: write_file')
    // Critical fix: requestPermission must receive the SAME actionId that was
    // broadcast, or a later resolve(actionId, decision) can never find this
    // pending request (dead-end gate).
    expect(requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: bc.actionId, toolName: 'write_file', risk: 'medium' })
    )
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

  it('blocks once the call budget is exceeded, with a budget reason, and aborts the run', async () => {
    const { opts, abortRunCalls } = makeOpts({ budget: { calls: 1, wallMs: 60_000, usdCents: 100_000 } })
    const hooks = createRunHooks(opts)

    const first = await hooks.beforeToolCall(beforeCtx('read_file'))
    expect(first).toBeUndefined()
    expect(abortRunCalls).toHaveLength(0)

    const second = await hooks.beforeToolCall(beforeCtx('read_file'))
    expect(second).toEqual({ block: true, reason: 'Budget exhausted (calls).' })
    expect(abortRunCalls).toEqual(['Budget exhausted (calls).'])
  })

  it('a shared usdCents overrun (tracked outside this call) blocks and aborts the run', async () => {
    // Simulates SessionAgent's usageSnapshot() having already written cost
    // onto the SAME `used` object this run's hooks read.
    const used: ConsumedResources = { ...emptyUsed(), usdCents: 10 }
    const { opts, abortRunCalls } = makeOpts({ used, budget: { calls: 100, wallMs: 60_000, usdCents: 5 } })
    const hooks = createRunHooks(opts)

    const result = await hooks.beforeToolCall(beforeCtx('read_file'))

    expect(result).toEqual({ block: true, reason: 'Budget exhausted (usdCents).' })
    expect(abortRunCalls).toEqual(['Budget exhausted (usdCents).'])
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

  it('a requestPermission throw is a fail-safe deny, logged, never a grant', async () => {
    const requestPermission = vi.fn(async () => {
      throw new Error('registry exploded')
    })
    const { opts } = makeOpts({ risk: () => 'medium', requestPermission })

    const hooks = createRunHooks(opts)
    const result = await hooks.beforeToolCall(beforeCtx('write_file'))

    expect(result).toEqual({ block: true, reason: 'permission flow failed' })
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

  it('an onPlanTodos throw is logged and swallowed — afterToolCall does not reject', async () => {
    const onPlanTodos = vi.fn(() => {
      throw new Error('append failed')
    })
    const { opts } = makeOpts({ onPlanTodos })
    const hooks = createRunHooks(opts)

    await expect(
      hooks.afterToolCall(afterCtx('update_plan', { todos: [{ content: 'x', status: 'pending' }] }))
    ).resolves.toBeUndefined()
    expect(onPlanTodos).toHaveBeenCalled()
  })
})
