import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { allowlistForAgent, type ProviderInjection, type UIEvent } from '@swarm/protocol'
import { DEFAULT_AGENT_DEF, SYSTEM_SESSION_ID } from '@swarm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import type { Broadcaster } from '../ipc/broadcaster'
import type { ToolRegistry, ToolRunContext } from '../tools/registry'
import { createSessionService } from './session-service'

// ---------------------------------------------------------------------------
// Configurable pi Agent mock (auto-completing, holdable, tool-call simulating).
// A held prompt resolves on its own instance abort so the engine can reach a
// cancelled terminal (mirrors the real pi Agent's abort semantics).
// ---------------------------------------------------------------------------
let holdPrompt = false
let simulateTool: string | null = null
const heldResolvers = new Set<() => void>()
const releaseAllHeld = (): void => {
  for (const r of [...heldResolvers]) {
    heldResolvers.delete(r)
    r()
  }
}

function installAgent(reply = 'done.'): void {
  MockAgent.mockImplementation(function (
    this: Record<string, unknown>,
    opts: {
      initialState?: { messages?: unknown[]; model?: unknown }
      beforeToolCall?: (a: { toolCall: { name: string }; args: unknown }) => Promise<unknown>
    }
  ) {
    let sub: ((e: unknown) => void) | null = null
    this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])], model: opts.initialState?.model }
    this.subscribe = (fn: (e: unknown) => void): void => {
      sub = fn
    }
    let myResolve: (() => void) | null = null
    this.abort = (): void => {
      if (myResolve) {
        const r = myResolve
        myResolve = null
        heldResolvers.delete(r)
        r()
      }
    }
    this.prompt = async (goal: string): Promise<void> => {
      ;(this.state as { messages: unknown[] }).messages.push({ role: 'user', content: goal })
      if (simulateTool) await opts.beforeToolCall?.({ toolCall: { name: simulateTool }, args: {} })
      if (holdPrompt) {
        await new Promise<void>((r) => {
          myResolve = r
          heldResolvers.add(r)
        })
      }
      const ok = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }
      ;(this.state as { messages: unknown[] }).messages.push(ok)
      if (reply) sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } })
      sub?.({ type: 'turn_end', message: { usage: undefined } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

// ---------------------------------------------------------------------------
// In-memory fake ConversationStore — only the ~15 methods the service touches.
// ---------------------------------------------------------------------------
type Row = { runId: string; parentRunId: string | null; seq: number; ts: number; event: UIEvent }
type FakeSession = {
  id: string
  providerSnapshot: ProviderInjection
  status: 'active' | 'interrupted' | 'ended'
  title: string | null
  settings?: { permissionMode?: string } & Record<string, unknown>
  agentSnapshot: AgentMessage[]
  lastActiveAt: number
  createdAt: number
}

function createFakeStore() {
  const sessions = new Map<string, FakeSession>()
  const rows = new Map<string, Row[]>()
  return {
    createSession(id: string, provider: ProviderInjection) {
      const s: FakeSession = {
        id,
        providerSnapshot: provider,
        status: 'active',
        title: null,
        agentSnapshot: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      }
      sessions.set(id, s)
      rows.set(id, [])
      return s
    },
    getSession: (id: string) => sessions.get(id),
    updateSessionStatus: (id: string, status: FakeSession['status']) => {
      const s = sessions.get(id)
      if (s) s.status = status
    },
    updateSessionProvider: (id: string, provider: ProviderInjection) => {
      const s = sessions.get(id)
      if (s) s.providerSnapshot = provider
    },
    updateSessionLastActive: (id: string) => {
      const s = sessions.get(id)
      if (s) s.lastActiveAt = Date.now()
    },
    getInterruptedSessions: () => [],
    listSessions: () =>
      [...sessions.values()].map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        pinned: false,
        lastActiveAt: s.lastActiveAt,
        createdAt: s.createdAt,
      })),
    setSessionTitle: (id: string, title: string) => {
      const s = sessions.get(id)
      if (s) s.title = title
    },
    setSessionPinned: () => undefined,
    setSessionSettings: (id: string, settings: FakeSession['settings']) => {
      const s = sessions.get(id)
      if (s) s.settings = settings
    },
    getSessionSettings: (id: string) => sessions.get(id)?.settings,
    reorderSessions: () => undefined,
    deleteSession: (id: string) => {
      sessions.delete(id)
      rows.delete(id)
    },
    saveAgentSnapshot: (id: string, messages: AgentMessage[]) => {
      const s = sessions.get(id)
      if (s) s.agentSnapshot = messages
    },
    getAgentSnapshot: (id: string) => sessions.get(id)?.agentSnapshot ?? [],
    appendRunEvent: (sessionId: string, runId: string, parentRunId: string | null, event: UIEvent) => {
      // run_events has NO foreign key on session_id: the real store INSERTS
      // unconditionally, even for a deleted session (mirrors store.ts). The
      // service — not the store — is what guards against post-delete writes.
      const list = rows.get(sessionId) ?? []
      rows.set(sessionId, list)
      const e = event as unknown as { seq: number; ts: number }
      list.push({ runId, parentRunId, seq: e.seq, ts: e.ts, event })
    },
    getRunEvents: (sessionId: string) => rows.get(sessionId) ?? [],
    getTerminalRunStatuses: () => [],
    getUsageStats: () => ({}) as never,
  }
}

// Stub tool registry: resolves NO tools but records every ToolRunContext AND
// allowlist it sees (parent, child, work-run …) and lets a test tag one tool risky.
function stubRegistry(riskyTool?: string): {
  registry: ToolRegistry
  ctxs: ToolRunContext[]
  allowlists: string[][]
} {
  const ctxs: ToolRunContext[] = []
  const allowlists: string[][] = []
  const registry = {
    resolve: (allow: string[], ctx: ToolRunContext) => {
      ctxs.push(ctx)
      allowlists.push(allow)
      return {
        tools: [],
        riskOf: (name: string) => (name === riskyTool ? ('medium' as const) : ('low' as const)),
      }
    },
  } as unknown as ToolRegistry
  return { registry, ctxs, allowlists }
}

const provider: ProviderInjection = {
  id: 'c1',
  model: 'test-model',
  apiStyle: 'anthropic',
  apiKey: 'k',
} as ProviderInjection

type Bcast = { event: string; data: unknown }
const stubBroadcaster = (): { broadcaster: Broadcaster; calls: Bcast[] } => {
  const calls: Bcast[] = []
  return { broadcaster: { broadcast: (event, data) => calls.push({ event, data }) }, calls }
}

const runKinds = (calls: Bcast[]): string[] =>
  calls.filter((c) => c.event.startsWith('run.')).map((c) => (c.data as { kind: string }).kind)

const makeService = (over: Partial<Parameters<typeof createSessionService>[0]> = {}) => {
  const store = createFakeStore()
  const { broadcaster, calls } = stubBroadcaster()
  const own = stubRegistry()
  const service = createSessionService({
    store: store as never,
    broadcaster,
    maxConcurrent: 5,
    getProvider: () => undefined,
    toolRegistry: own.registry,
    ...over,
  })
  return { service, store, calls, ctxs: own.ctxs, allowlists: own.allowlists }
}

beforeEach(() => {
  MockAgent.mockReset()
  holdPrompt = false
  simulateTool = null
  heldResolvers.clear()
  installAgent()
})

describe('SessionService', () => {
  it('1. submitPrompt happy path: ordered run.* events, store parity, buffer + titling', async () => {
    const { service, store, calls } = makeService()
    const { sessionId } = service.createSession(provider)
    const { runId } = service.submitPrompt(sessionId, 'hello world', undefined, undefined)
    await vi.waitFor(() => expect(runKinds(calls)).toContain('run.complete'))

    const kinds = runKinds(calls)
    expect(kinds[0]).toBe('run.created')
    expect(kinds[1]).toBe('run.progress')
    const userEvt = calls.find((c) => c.event === 'run.progress')?.data as {
      event: { kind: string; role: string; content: string }
    }
    expect(userEvt.event).toMatchObject({ kind: 'llm.message', role: 'user', content: 'hello world' })
    expect(kinds[2]).toBe('run.dispatched')
    expect(kinds[kinds.length - 1]).toBe('run.complete')

    // Store received the exact same run.* rows the broadcaster saw.
    const storeRunEvents = store.getRunEvents(sessionId).map((r) => r.event)
    const broadcastRunEvents = calls.filter((c) => c.event.startsWith('run.')).map((c) => c.data)
    expect(storeRunEvents).toEqual(broadcastRunEvents)

    // Buffer updated via saveSnapshot; prompt NOT double-seeded (one user turn).
    const snap = store.getAgentSnapshot(sessionId)
    expect(snap.filter((m) => m.role === 'user')).toHaveLength(1)

    // First goal titles the session + broadcasts session.updated.
    expect(store.getSession(sessionId)?.title).toBe('hello world')
    expect(calls.some((c) => c.event === 'session.updated')).toBe(true)
    expect(runId).toBeTruthy()
  })

  it('2. FIFO: the second turn dispatches only after the first reaches a terminal', async () => {
    const { service, calls } = makeService()
    const { sessionId } = service.createSession(provider)
    const a = service.submitPrompt(sessionId, 'A').runId
    const b = service.submitPrompt(sessionId, 'B').runId
    await vi.waitFor(() => expect(runKinds(calls).filter((k) => k === 'run.complete')).toHaveLength(2))

    const seqOf = (runId: string, kind: string): number => {
      const c = calls.find(
        (x) =>
          x.event.startsWith('run.') &&
          (x.data as { runId: string }).runId === runId &&
          (x.data as { kind: string }).kind === kind
      )
      return (c!.data as { seq: number }).seq
    }
    expect(seqOf(b, 'run.dispatched')).toBeGreaterThan(seqOf(a, 'run.complete'))
  })

  it('3. cancelRun on the QUEUED second run: it cancels without dispatching; the first is unaffected', async () => {
    holdPrompt = true
    const { service, calls } = makeService()
    const { sessionId } = service.createSession(provider)
    const a = service.submitPrompt(sessionId, 'A').runId
    const b = service.submitPrompt(sessionId, 'B').runId
    await vi.waitFor(() => expect(runKinds(calls)).toContain('run.dispatched')) // A dispatched

    service.cancelRun(sessionId, b)
    await vi.waitFor(() => expect(service.terminalRegistry.getStatus(b)).toBe('cancelled'))

    // B never dispatched; A still running (no terminal yet).
    const bDispatched = calls.some((c) => c.event === 'run.dispatched' && (c.data as { runId: string }).runId === b)
    expect(bDispatched).toBe(false)
    expect(service.terminalRegistry.getStatus(a)).toBeUndefined()
    releaseAllHeld()
  })

  it('4. interruptWith: A running (held) + B queued → A cancels, B dispatches next', async () => {
    holdPrompt = true
    const { service, calls } = makeService()
    const { sessionId } = service.createSession(provider)
    const a = service.submitPrompt(sessionId, 'A').runId
    const b = service.submitPrompt(sessionId, 'B').runId
    await vi.waitFor(() => expect(runKinds(calls)).toContain('run.dispatched')) // A dispatched

    service.interruptWith(sessionId, b)
    holdPrompt = false // let the promoted B complete
    await vi.waitFor(() => expect(service.terminalRegistry.getStatus(a)).toBe('cancelled'))
    await vi.waitFor(() => expect(service.terminalRegistry.getStatus(b)).toBe('completed'))

    const bDispatched = calls.find((c) => c.event === 'run.dispatched' && (c.data as { runId: string }).runId === b)
    expect(bDispatched).toBeDefined()
  })

  it('5. runWork bypasses the turn queue: dispatches while a turn is held, returns status+summary', async () => {
    holdPrompt = true
    const { service, calls } = makeService()
    const { sessionId } = service.createSession(provider)
    const turn = service.submitPrompt(sessionId, 'held turn').runId
    await vi.waitFor(() => expect(runKinds(calls)).toContain('run.dispatched')) // turn dispatched

    holdPrompt = false
    const r = await service.runWork(sessionId, 'do work')
    expect(r.status).toBe('completed')
    expect(typeof r.summary).toBe('string')
    expect(r.summary.length).toBeGreaterThan(0)
    // The held turn is still running — runWork did not wait behind it.
    expect(service.terminalRegistry.getStatus(turn)).toBeUndefined()
    releaseAllHeld()
  })

  it('6. delegate via ctx.spawnChild: child gets parentRunId, summary + status flow back, unknown agentType → default', async () => {
    holdPrompt = true
    const { service, store, ctxs } = makeService()
    const { sessionId } = service.createSession(provider)
    const parent = service.submitPrompt(sessionId, 'parent').runId
    await vi.waitFor(() => expect(ctxs.length).toBeGreaterThan(0))
    const parentCtx = ctxs[0]

    holdPrompt = false // let the child auto-complete
    const child = await parentCtx.spawnChild('child goal', { agentType: 'nonexistent-type' })
    expect(child.summary.length).toBeGreaterThan(0)
    expect(child.status).toBe('completed')

    const childRows = store.getRunEvents(sessionId).filter((r) => r.runId === child.runId)
    expect(childRows.length).toBeGreaterThan(0)
    expect(childRows.every((r) => r.parentRunId === parent)).toBe(true)
    const created = childRows.find((r) => (r.event as { kind: string }).kind === 'run.created')
    expect((created!.event as { agentDefId?: string }).agentDefId).toBe(DEFAULT_AGENT_DEF.id)
    releaseAllHeld()
  })

  it('7. uniform wiring: ctx.createTask is available inside a CHILD run and runs a work task', async () => {
    holdPrompt = true
    const { service, ctxs } = makeService()
    const { sessionId } = service.createSession(provider)
    service.submitPrompt(sessionId, 'parent')
    await vi.waitFor(() => expect(ctxs.length).toBeGreaterThan(0))
    const parentCtx = ctxs[0]

    holdPrompt = false
    await parentCtx.spawnChild('child goal')
    const childCtx = ctxs[1]
    expect(childCtx.createTask).toBeDefined()
    const res = await childCtx.createTask!('nested work')
    expect(res.runId).toBeTruthy()
    expect(res.summary.length).toBeGreaterThan(0)
    releaseAllHeld()
  })

  it('8. markInterruptedRunsTerminal closes orphans across BOTH run.* and legacy task.* rows', async () => {
    const { service, store } = makeService()
    // Seed two interrupted sessions with an un-terminated run each.
    store.createSession('s-run', provider)
    store.updateSessionStatus('s-run', 'interrupted')
    store.appendRunEvent('s-run', 'r-new', null, {
      kind: 'run.created',
      sessionId: 's-run',
      runId: 'r-new',
      goal: 'g',
      seq: 1,
      ts: 1,
    } as unknown as UIEvent)

    store.createSession('s-legacy', provider)
    store.updateSessionStatus('s-legacy', 'interrupted')
    store.appendRunEvent('s-legacy', 'r-old', null, {
      kind: 'task.created',
      sessionId: 's-legacy',
      taskId: 'r-old',
      goal: 'g',
      seq: 1,
      ts: 1,
    } as unknown as UIEvent)

    service.markInterruptedRunsTerminal()

    for (const [sid, rid] of [
      ['s-run', 'r-new'],
      ['s-legacy', 'r-old'],
    ] as const) {
      const closeout = store.getRunEvents(sid).find((r) => (r.event as { kind: string }).kind === 'run.error')
      expect(closeout).toBeDefined()
      expect((closeout!.event as { error: { code: string } }).error.code).toBe('cancelled')
      expect(service.terminalRegistry.getStatus(rid)).toBe('cancelled')
    }
  })

  it('9. permission: a risky tool in ask mode broadcasts + persists the request; resolvePermission unblocks', async () => {
    simulateTool = 'risky'
    const { registry } = stubRegistry('risky')
    const { service, store, calls } = makeService({ toolRegistry: registry })
    const { sessionId } = service.createSession(provider)
    const { runId } = service.submitPrompt(sessionId, 'use a tool')

    await vi.waitFor(() => expect(calls.some((c) => c.event === 'run.permission_request')).toBe(true))
    const req = calls.find((c) => c.event === 'run.permission_request')!.data as {
      actionId: string
      runId: string
      taskId?: string
    }
    expect(req.runId).toBe(runId)
    // The run.* vocabulary: no top-level taskId leaks onto the wire.
    expect(req.taskId).toBeUndefined()
    const persisted = store
      .getRunEvents(sessionId)
      .find((r) => (r.event as { kind: string }).kind === 'run.permission_request')
    expect(persisted?.runId).toBe(runId)

    service.resolvePermission(sessionId, req.actionId, 'grant')
    await vi.waitFor(() => expect(service.terminalRegistry.getStatus(runId)).toBe('completed'))
  })

  it('9a. a WORK run inherits the session full permission mode: risky tool bypasses the prompt', async () => {
    simulateTool = 'risky'
    const { registry } = stubRegistry('risky')
    const store = createFakeStore()
    const { broadcaster, calls } = stubBroadcaster()
    const service = createSessionService({
      store: store as never,
      broadcaster,
      maxConcurrent: 5,
      getProvider: () => undefined,
      toolRegistry: registry,
    })
    const { sessionId } = service.createSession(provider)
    store.setSessionSettings(sessionId, { permissionMode: 'full' })

    const r = await service.runWork(sessionId, 'do risky work')
    expect(r.status).toBe('completed')
    expect(calls.some((c) => c.event === 'run.permission_request')).toBe(false)
  })

  it('9b. a delegated CHILD run inherits the session full permission mode: no prompt', async () => {
    holdPrompt = true
    simulateTool = 'risky'
    const { registry } = stubRegistry('risky')
    const store = createFakeStore()
    const { broadcaster, calls } = stubBroadcaster()
    const ctxs: ToolRunContext[] = []
    // Capture each run's ctx off the registry so we can drive spawnChild.
    const capturing = {
      resolve: (allow: string[], ctx: ToolRunContext) => {
        ctxs.push(ctx)
        return registry.resolve(allow, ctx)
      },
    } as unknown as ToolRegistry
    const service = createSessionService({
      store: store as never,
      broadcaster,
      maxConcurrent: 5,
      getProvider: () => undefined,
      toolRegistry: capturing,
    })
    const { sessionId } = service.createSession(provider)
    store.setSessionSettings(sessionId, { permissionMode: 'full' })
    service.submitPrompt(sessionId, 'parent')
    await vi.waitFor(() => expect(ctxs.length).toBeGreaterThan(0))

    holdPrompt = false
    const child = await ctxs[0].spawnChild('risky child work')
    expect(child.status).toBe('completed')
    expect(calls.some((c) => c.event === 'run.permission_request')).toBe(false)
    releaseAllHeld()
  })

  it('10. deleteSession aborts running + queued runs (both cancelled) and drops the store rows', async () => {
    holdPrompt = true
    const { service, store, calls } = makeService()
    const { sessionId } = service.createSession(provider)
    const a = service.submitPrompt(sessionId, 'A').runId
    const b = service.submitPrompt(sessionId, 'B').runId
    await vi.waitFor(() => expect(runKinds(calls)).toContain('run.dispatched')) // A dispatched, B queued

    service.deleteSession(sessionId)
    await vi.waitFor(() => {
      expect(service.terminalRegistry.getStatus(a)).toBe('cancelled')
      expect(service.terminalRegistry.getStatus(b)).toBe('cancelled')
    })
    // Rows dropped with the session (the SERVICE guard prevents post-delete
    // appends now — the fake store itself inserts unconditionally, mirroring
    // the real no-FK DB).
    expect(store.getRunEvents(sessionId)).toEqual([])
    // The registry/broadcast path is unaffected by the persistence skip: both
    // cancelled terminals still went out over the wire.
    const errorRunIds = calls
      .filter((c) => c.event.startsWith('run.') && (c.data as { kind: string }).kind === 'run.error')
      .map((c) => (c.data as { runId: string }).runId)
    expect(errorRunIds).toEqual(expect.arrayContaining([a, b]))
    releaseAllHeld()
  })

  // ---- Coverage-home ports from the deleted manager.test.ts -----------------

  it('11. ensureSystemSession bootstraps the system session from the caller provider and refreshes it later', () => {
    const { service, store } = makeService()
    const { sessionId } = service.createSession(provider)

    // First call bootstraps the long-lived system session.
    expect(service.ensureSystemSession(sessionId)).toBe(SYSTEM_SESSION_ID)
    expect(store.getSession(SYSTEM_SESSION_ID)).toBeDefined()
    expect(store.getSession(SYSTEM_SESSION_ID)?.providerSnapshot).toEqual(provider)

    // A later create with a different provider refreshes the system provider.
    const provider2 = { ...provider, id: 'c2', model: 'other' } as ProviderInjection
    service.createSession(provider2)
    expect(store.getSession(SYSTEM_SESSION_ID)?.providerSnapshot).toEqual(provider2)
  })

  it('12. submitPrompt invokes onComplete with the terminal status when the run ends', async () => {
    const { service } = makeService()
    const { sessionId } = service.createSession(provider)
    const statuses: string[] = []
    service.submitPrompt(sessionId, 'hello', undefined, (status) => statuses.push(status))
    await vi.waitFor(() => expect(statuses).toEqual(['completed']))
  })

  it('13. runWork does NOT overwrite the conversation agent_snapshot (regression)', async () => {
    const { service, store } = makeService()
    const { sessionId } = service.createSession(provider)
    // A conversation turn saves a snapshot (user + assistant).
    service.submitPrompt(sessionId, 'hello')
    await vi.waitFor(() => expect(store.getAgentSnapshot(sessionId).length).toBeGreaterThan(0))
    const before = store.getAgentSnapshot(sessionId)

    // A work run has no saveSnapshot wiring, so it must not touch the buffer.
    await service.runWork(sessionId, 'do work')
    expect(store.getAgentSnapshot(sessionId)).toEqual(before)
    expect(store.getAgentSnapshot(sessionId).filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('14. maxConcurrent caps global dispatch: a second session waits for the slot pool', async () => {
    holdPrompt = true
    const { service, calls } = makeService({ maxConcurrent: 1 })
    // Two independent sessions: the per-session FIFO does not serialize them, so
    // only the global slot pool can hold the second back.
    const { sessionId: sA } = service.createSession(provider)
    const { sessionId: sB } = service.createSession(provider)
    service.submitPrompt(sA, 'A')
    service.submitPrompt(sB, 'B')
    await vi.waitFor(() => expect(runKinds(calls).filter((k) => k === 'run.dispatched')).toHaveLength(1))

    // Exactly one dispatched under the cap; the other is parked on the pool.
    expect(runKinds(calls).filter((k) => k === 'run.dispatched')).toHaveLength(1)
    releaseAllHeld()
    await vi.waitFor(() => expect(runKinds(calls).filter((k) => k === 'run.dispatched')).toHaveLength(2))
  })

  it('15. plan mode resolves EXACTLY the read-only allowlist; goal mode resolves the agent allowlist', async () => {
    // Deliberately mirrored from session-service.ts's PLAN_READONLY_ALLOWLIST
    // (not imported): the safety property is "plan mode grants THESE nine
    // read-only tools and nothing else" — adding a mutating tool to the source
    // constant must fail here until this pin is consciously updated.
    const PLAN_READONLY_ALLOWLIST = [
      'fs.read_file',
      'fs.list_dir',
      'fs.glob',
      'fs.grep',
      'web.fetch',
      'web.search',
      'peekaboo.see_screen',
      'peekaboo.list_apps',
      'agent.update_plan',
    ]
    const { service, allowlists } = makeService()
    const { sessionId } = service.createSession(provider)

    service.submitPrompt(sessionId, 'plan it', undefined, undefined, { executionMode: 'plan' })
    await vi.waitFor(() => expect(allowlists).toHaveLength(1))
    expect(allowlists[0]).toEqual(PLAN_READONLY_ALLOWLIST)

    // Contrast: a goal-mode turn resolves the agent's own allowlist instead.
    service.submitPrompt(sessionId, 'do it', undefined, undefined, { executionMode: 'goal' })
    await vi.waitFor(() => expect(allowlists).toHaveLength(2))
    expect(allowlists[1]).toEqual(allowlistForAgent(DEFAULT_AGENT_DEF))
    expect(allowlists[1]).not.toEqual(PLAN_READONLY_ALLOWLIST)
  })
})
