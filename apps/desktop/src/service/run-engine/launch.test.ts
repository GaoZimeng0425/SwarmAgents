import { beforeEach, describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import type { RunWireEvent } from '@swarm/protocol'

import type { ToolRunContext } from '../tools/registry'
import { type LaunchPorts, launchRun, type RunSpec } from './launch'

// Auto-completing pi mock (engine runs to a clean completion unless held).
let holdPrompt = false
let resolveHeldPrompt: () => void = () => undefined
function installAgent(reply = 'done.') {
  MockAgent.mockImplementation(function (
    this: Record<string, unknown>,
    opts: { initialState?: { messages?: unknown[] } }
  ) {
    let sub: ((e: unknown) => void) | null = null
    this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])], model: undefined }
    this.subscribe = (fn: (e: unknown) => void) => {
      sub = fn
    }
    this.abort = () => undefined
    this.prompt = async (goal: string) => {
      ;(this.state as { messages: unknown[] }).messages.push({ role: 'user', content: goal })
      if (holdPrompt) await new Promise<void>((r) => (resolveHeldPrompt = r))
      const ok = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }
      ;(this.state as { messages: unknown[] }).messages.push(ok)
      if (reply) sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

type Sink = { events: RunWireEvent[]; ports: LaunchPorts['emit'] }
const sink = (): Sink => {
  const events: RunWireEvent[] = []
  let seq = 0
  return {
    events,
    ports: {
      nextSeq: () => ++seq,
      appendEvent: (e) => events.push(e),
      markTerminal: vi.fn(),
      broadcast: vi.fn(),
    },
  }
}

const kinds = (s: Sink) => s.events.map((e) => e.kind)
const terminals = (s: Sink) => s.events.filter((e) => e.kind === 'run.complete' || e.kind === 'run.error')

// Fake ports: single-slot pool that records acquire/release, capturing the tool ctx.
function makePorts(
  s: Sink,
  over: Partial<LaunchPorts> = {}
): { ports: LaunchPorts; slotLog: string[]; getCtx: () => ToolRunContext } {
  const slotLog: string[] = []
  let ctx: ToolRunContext | undefined
  const ports: LaunchPorts = {
    emit: s.ports,
    toolRegistry: {
      resolve: (_allow: string[], c: ToolRunContext) => {
        ctx = c
        return { tools: [], riskOf: () => 'low' as const }
      },
    } as never,
    permissionRegistry: { request: vi.fn(async () => 'grant'), resolve: vi.fn() } as never,
    acquireSlot: async () => {
      slotLog.push('acquire')
      return () => slotLog.push('release')
    },
    registerAbort: vi.fn(),
    unregisterAbort: vi.fn(),
    ...over,
  }
  return { ports, slotLog, getCtx: () => ctx as ToolRunContext }
}

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  kind: 'work',
  sessionId: 's1',
  agent: { id: 'default', name: 'd', description: 'd', systemPrompt: '', toolScope: 'all', maxIterations: 25 } as never,
  provider: { id: 'c1', model: 'test-model', apiStyle: 'anthropic', apiKey: 'k' } as never,
  prompt: 'go',
  budget: { tokens: 1e9, calls: 100, wallMs: 600_000, usdCents: 100_000 } as never,
  retry: { maxRetries: 0, delayMs: 0 },
  ...over,
})

beforeEach(() => {
  MockAgent.mockReset()
  holdPrompt = false
})

describe('launchRun', () => {
  it('emits created → dispatched → complete in order, stamping identity', async () => {
    installAgent()
    const s = sink()
    const { ports } = makePorts(s)
    const r = await launchRun(spec(), ports)
    expect(r.status).toBe('completed')
    expect(kinds(s)).toEqual(['run.created', 'run.dispatched', 'run.progress', 'run.complete'])
    expect(s.events[0]).toMatchObject({ kind: 'run.created', goal: 'go', sessionId: 's1', runId: r.runId })
    expect('parentRunId' in s.events[0]).toBe(false)
  })

  it('stamps parentRunId + agentDefId for child runs and honors a provided runId', async () => {
    installAgent()
    const s = sink()
    const { ports } = makePorts(s)
    const r = await launchRun(spec({ kind: 'child', runId: 'child-1', parentRunId: 'parent-1' }), ports)
    expect(r.runId).toBe('child-1')
    expect(s.events[0]).toMatchObject({ runId: 'child-1', parentRunId: 'parent-1', agentDefId: 'default' })
  })

  it('registers the abort handle BEFORE waiting, and a cancel during the turn wait terminates without starting the engine', async () => {
    installAgent()
    const s = sink()
    let registeredAbort: (() => void) | null = null
    let sawRegisterBeforeWait = false
    const resolveCapture: { ctxResolved: boolean } = { ctxResolved: false }
    const { ports } = makePorts(s, {
      registerAbort: (_id, abort) => {
        registeredAbort = abort
      },
      waitTurn: async () => {
        sawRegisterBeforeWait = registeredAbort !== null
        registeredAbort?.()
        // never resolves normally; the launch must bail on the abort signal
      },
      toolRegistry: {
        resolve: () => {
          resolveCapture.ctxResolved = true
          return { tools: [], riskOf: () => 'low' as const }
        },
      } as never,
    })
    const r = await launchRun(spec({ kind: 'turn' }), ports)
    expect(sawRegisterBeforeWait).toBe(true)
    expect(r.status).toBe('cancelled')
    expect(resolveCapture.ctxResolved).toBe(false) // engine/tools never built
    const t = terminals(s)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'cancelled' } })
  })

  it('terminates promptly when cancelled during the slot wait, even if the pool port ignores the signal', async () => {
    installAgent()
    const s = sink()
    let registeredAbort: (() => void) | null = null
    let ctxResolved = false
    const { ports } = makePorts(s, {
      registerAbort: (_id, abort) => {
        registeredAbort = abort
      },
      // A non-compliant pool: parks forever, ignores the signal.
      acquireSlot: () => new Promise(() => undefined),
      toolRegistry: {
        resolve: () => {
          ctxResolved = true
          return { tools: [], riskOf: () => 'low' as const }
        },
      } as never,
    })
    const p = launchRun(spec(), ports)
    await vi.waitFor(() => expect(registeredAbort).not.toBeNull())
    registeredAbort!()
    const r = await p
    expect(r.status).toBe('cancelled')
    expect(ctxResolved).toBe(false)
    const t = terminals(s)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'cancelled' } })
  })

  it('emits agent_setup_failed when the engine cannot be constructed, releasing the slot', async () => {
    installAgent()
    const s = sink()
    const { ports, slotLog } = makePorts(s)
    const r = await launchRun(
      spec({ provider: { id: 'c1', model: 'm', apiStyle: 'anthropic', apiKey: '' } as never }),
      ports
    )
    expect(r.status).toBe('failed')
    const t = terminals(s)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'agent_setup_failed' } })
    expect(slotLog).toEqual(['acquire', 'release'])
    expect(ports.unregisterAbort).toHaveBeenCalled()
  })

  it("releases the parent's slot while a delegate call blocks and reacquires after (ledger #5)", async () => {
    installAgent()
    holdPrompt = true
    const s = sink()
    let finishDelegate: (r: { runId: string; status: 'completed'; summary: string }) => void = () => undefined
    const { ports, slotLog, getCtx } = makePorts(s, {
      delegate: () => new Promise((res) => (finishDelegate = res as never)),
    })
    const p = launchRun(spec(), ports)
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    const childP = getCtx().spawnChild('child goal')
    await vi.waitFor(() => expect(slotLog).toEqual(['acquire', 'release']))
    finishDelegate({ runId: 'c1', status: 'completed', summary: 'child done' })
    const child = await childP
    expect(child.result.summary).toBe('child done')
    await vi.waitFor(() => expect(slotLog).toEqual(['acquire', 'release', 'acquire']))
    resolveHeldPrompt()
    await p
    expect(slotLog).toEqual(['acquire', 'release', 'acquire', 'release'])
  })

  it('wires setDelegationPlan for every run: emits run.delegation_plan then the spec callback (ledger #12)', async () => {
    installAgent()
    holdPrompt = true
    const s = sink()
    const onDelegationPlan = vi.fn()
    const { ports, getCtx } = makePorts(s)
    const p = launchRun(spec({ onDelegationPlan }), ports)
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    const plan = [{ id: 'a', goal: 'g', dependsOn: [] }]
    getCtx().setDelegationPlan?.(plan as never)
    expect(s.events.some((e) => e.kind === 'run.delegation_plan')).toBe(true)
    expect(onDelegationPlan).toHaveBeenCalledWith(plan)
    resolveHeldPrompt()
    await p
  })

  it('wires ports.createTask into the tool context (wrapped for slot-yield, not a bare pass-through)', async () => {
    installAgent()
    holdPrompt = true
    const s = sink()
    const createTask = vi.fn(async () => ({ taskId: 't1', result: { summary: 'work done', artifacts: [] } }))
    const { ports, getCtx } = makePorts(s, { createTask })
    const p = launchRun(spec(), ports)
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    expect(getCtx().createTask).toBeDefined()
    const res = await getCtx().createTask!('goal', 'agentType')
    expect(createTask).toHaveBeenCalledWith('goal', 'agentType')
    expect(res.result.summary).toBe('work done')
    resolveHeldPrompt()
    await p
  })

  it("releases the parent's slot while a createTask call blocks and reacquires after (ledger #5, pool-wedge fix)", async () => {
    installAgent()
    holdPrompt = true
    const s = sink()
    let finishCreateTask: (r: { taskId: string; result: { summary: string; artifacts: never[] } }) => void = () =>
      undefined
    const { ports, slotLog, getCtx } = makePorts(s, {
      createTask: () => new Promise((res) => (finishCreateTask = res as never)),
    })
    const p = launchRun(spec(), ports)
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    const taskP = getCtx().createTask!('child goal')
    await vi.waitFor(() => expect(slotLog).toEqual(['acquire', 'release']))
    finishCreateTask({ taskId: 't1', result: { summary: 'work done', artifacts: [] } })
    const res = await taskP
    expect(res.result.summary).toBe('work done')
    await vi.waitFor(() => expect(slotLog).toEqual(['acquire', 'release', 'acquire']))
    resolveHeldPrompt()
    await p
    expect(slotLog).toEqual(['acquire', 'release', 'acquire', 'release'])
  })

  it('spawnChild rejects loudly when no delegate port is bound', async () => {
    installAgent()
    holdPrompt = true
    const s = sink()
    const { ports, getCtx } = makePorts(s)
    const p = launchRun(spec(), ports)
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    await expect(getCtx().spawnChild('g')).rejects.toThrow('delegate is not available')
    resolveHeldPrompt()
    await p
  })

  it('provides analyzeImage backed by a SILENT nested run for an image-capable provider', async () => {
    installAgent('ocr text')
    const s = sink()
    const { ports, getCtx } = makePorts(s)
    holdPrompt = true
    const p = launchRun(
      spec({
        provider: {
          id: 'anthropic',
          registry: 'anthropic',
          apiStyle: 'anthropic',
          model: (await import('@swarm/protocol')).ANTHROPIC_MODEL_SUGGESTIONS[0],
          apiKey: 'k',
        } as never,
      }),
      ports
    )
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    // Release the hold for NEW prompts: the outer run's prompt is already
    // parked on its own promise (unaffected), but the nested vision run must
    // complete — a module-level hold would park it too AND clobber the outer
    // run's resolver, deadlocking the test.
    holdPrompt = false
    expect(getCtx().analyzeImage).toBeDefined()
    const before = s.events.length
    const text = await getCtx().analyzeImage!('what is this', { data: 'AA==', mimeType: 'image/png' })
    expect(text).toBe('ocr text')
    expect(s.events.length).toBe(before) // the nested run emitted NOTHING to the parent sink
    resolveHeldPrompt()
    await p
  })

  it('resolves — never rejects — even when the emit port throws from the first event on', async () => {
    // A throwing store port (e.g. SQLite busy) must not escape launchRun as a
    // rejection: the created emit, the engine path, and the synthetic-terminal
    // emit in the catch are all covered.
    installAgent()
    const ports: LaunchPorts = {
      emit: {
        nextSeq: () => 1,
        appendEvent: () => {
          throw new Error('sqlite busy')
        },
        markTerminal: () => undefined,
        broadcast: () => undefined,
      },
      toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' as const }) } as never,
      permissionRegistry: { request: async () => 'grant', resolve: () => undefined } as never,
      acquireSlot: async () => () => undefined,
      registerAbort: () => undefined,
      unregisterAbort: () => undefined,
    }
    const r = await launchRun(spec(), ports)
    expect(r.status).toBe('failed')
  })
})
