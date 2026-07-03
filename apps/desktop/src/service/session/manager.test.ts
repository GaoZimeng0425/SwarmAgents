import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { type AgentDefinition, emptyUsed, type ProviderInjection } from '@swarm/protocol'
import { SYSTEM_SESSION_ID } from '@swarm/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createBroadcaster } from '../ipc/broadcaster'
import type { AgentRunner } from './agent-runner'
import { createSessionManager } from './manager'

vi.mock('./agent-runner', () => ({
  createAgentRunner: vi.fn(),
}))

import { createAgentRunner } from './agent-runner'

const mockCreate = vi.mocked(createAgentRunner)

// Awaited return type of AgentRunner.run(). Stubs use `runnerReturn(...)` to
// satisfy the full contract (status + summary + messages + 6-field `used`).
type RunReturn = Awaited<ReturnType<AgentRunner['run']>>
const runnerReturn = (
  status: 'completed' | 'failed' | 'cancelled',
  summary = '',
  messages: RunReturn['messages'] = []
): RunReturn => ({ status, summary, messages, used: emptyUsed() })

// Build an AgentRunner stub from a run() body. Lets mockImplementation
// callbacks stay loosely-typed while satisfying the AgentRunner contract.
const runner = (run: AgentRunner['run']): AgentRunner => ({ run })

const tmpDb = () => join(tmpdir(), `swarm-ses-test-${Date.now()}.db`)

describe('SessionManager', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDb()
    mockCreate.mockReset()
  })
  afterEach(() => {
    try {
      rmSync(dbPath)
    } catch {}
  })

  const providerA = {
    id: 'anthropic' as const,
    registry: 'anthropic' as const,
    apiStyle: 'anthropic' as const,
    model: 'claude-haiku-4-5-20251001',
    apiKey: 'k',
  }

  it('ensureSystemSession bootstraps the system session from the caller provider', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    const systemId = manager.ensureSystemSession(sessionId)

    expect(systemId).toBe(SYSTEM_SESSION_ID)
    expect(store.getSession(SYSTEM_SESSION_ID)?.providerSnapshot).toEqual(providerA)
    store.close()
  })

  it('ensureSystemSession refreshes the system provider on later calls', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const a = manager.createSession(providerA).sessionId
    manager.ensureSystemSession(a)

    const providerB = { ...providerA, model: 'claude-opus-4-8', apiKey: 'k2' }
    const b = manager.createSession(providerB).sessionId
    manager.ensureSystemSession(b)

    expect(store.getSession(SYSTEM_SESSION_ID)?.providerSnapshot).toEqual(providerB)
    store.close()
  })

  it('creates a session and returns sessionId', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = {
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    }

    const { sessionId } = manager.createSession(provider)
    expect(sessionId).toBeTruthy()
    expect(store.getSession(sessionId)?.status).toBe('active')
    store.close()
  })

  it('createSession refreshes the system session provider when it exists', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    // System session bootstrapped from provider A.
    const a = manager.createSession(providerA).sessionId
    manager.ensureSystemSession(a)

    // A later session carries an updated provider (e.g. user rotated the key).
    const providerB = { ...providerA, model: 'claude-opus-4-8', apiKey: 'rotated' }
    manager.createSession(providerB)

    // System session's snapshot tracks the latest, without a new schedule_task.
    expect(store.getSession(SYSTEM_SESSION_ID)?.providerSnapshot).toEqual(providerB)
    store.close()
  })

  it('createSession does not create a system session when none exists', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    manager.createSession(providerA)
    expect(store.getSession(SYSTEM_SESSION_ID)).toBeUndefined()
    store.close()
  })

  it('marks active sessions interrupted on init', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    }
    store.createSession('old-ses', provider)
    store.close()

    const store2 = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    createSessionManager({ store: store2, broadcaster, maxConcurrent: 2, getProvider: () => undefined })

    expect(store2.getSession('old-ses')?.status).toBe('interrupted')
    store2.close()
  })

  it('resolves permission by forwarding to registry', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = {
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    }
    const { sessionId } = manager.createSession(provider)

    expect(() => manager.resolvePermission(sessionId, 'no-such-action', 'deny')).not.toThrow()
    store.close()
  })

  it('limits concurrent runners to maxConcurrent', async () => {
    // Goals submitted to DIFFERENT sessions run concurrently (cross-session),
    // bounded by the semaphore. Goals in the same session are serialized.
    const resolvers: Array<(v: RunReturn) => void> = []
    mockCreate.mockImplementation(() =>
      runner(
        () =>
          new Promise<RunReturn>((resolve) => {
            resolvers.push(resolve)
          })
      )
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = {
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    }
    const { sessionId: s1 } = manager.createSession(provider)
    const { sessionId: s2 } = manager.createSession(provider)
    const { sessionId: s3 } = manager.createSession(provider)

    manager.submitGoal(s1, 'goal 1')
    manager.submitGoal(s2, 'goal 2')
    manager.submitGoal(s3, 'goal 3')

    // Flush promise queue: two slots fill immediately (maxConcurrent = 2)
    await Promise.resolve()
    await Promise.resolve()
    expect(resolvers).toHaveLength(2)

    // Release one slot — the queued runner should start
    resolvers[0](runnerReturn('completed', ''))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(resolvers).toHaveLength(3)

    resolvers[1](runnerReturn('completed', ''))
    resolvers[2](runnerReturn('completed', ''))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    store.close()
  })

  it('semaphore never exceeds maxConcurrent under contended release+acquire', async () => {
    // Goals submitted to DIFFERENT sessions run concurrently (cross-session),
    // bounded by the semaphore. This exercises the waiter-transfer path.
    const resolvers: Array<(v: RunReturn) => void> = []
    mockCreate.mockImplementation(() =>
      runner(
        () =>
          new Promise<RunReturn>((resolve) => {
            resolvers.push(resolve)
          })
      )
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = {
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    }
    const { sessionId: s1 } = manager.createSession(provider)
    const { sessionId: s2 } = manager.createSession(provider)
    const { sessionId: s3 } = manager.createSession(provider)

    // Submit 3 goals across 3 sessions — two run, one queues as waiter w3.
    manager.submitGoal(s1, 'g1')
    manager.submitGoal(s2, 'g2')
    manager.submitGoal(s3, 'g3')
    await Promise.resolve()
    await Promise.resolve()
    expect(resolvers).toHaveLength(2)

    // Trigger release of runner1 — this queues:
    //   M1: runner1 await-completion -> releaseSlot (decrement to 1, resolve waiter w3, queue M3)
    // Then on the next tick our test continuation runs as M2; we synchronously
    // submit g4. Under the buggy semaphore, g4's acquireSlot fast-path sees
    // activeRunners=1, increments to 2. Then M3 (waiter w3) ALSO increments to 3.
    // Total resolvers pushed by g3 + g4 -> 2 new = 4 resolvers, exceeding cap 2.
    resolvers[0](runnerReturn('completed', ''))
    await Promise.resolve() // M1 fires here (release + queue M3)

    // Now we're in M2 (test continuation). Synchronously submit g4 on a new session
    // BEFORE M3 (waiter w3's continuation) drains. acquireSlot fast-path runs sync.
    const { sessionId: s4 } = manager.createSession(provider)
    manager.submitGoal(s4, 'g4')

    // Drain all microtasks.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Correct semaphore: only 3 runners total ever started (g1, g2, then
    // either g3 or g4 — the other waits). resolvers.length === 3.
    // Buggy semaphore: 4 runners running concurrently. resolvers.length === 4.
    expect(resolvers.length).toBeLessThanOrEqual(3)

    // Drain remaining runners.
    resolvers[1](runnerReturn('completed', ''))
    resolvers[2]?.(runnerReturn('completed', ''))
    resolvers[3]?.(runnerReturn('completed', ''))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    store.close()
  })

  it('propagates child runner summary through spawnChild', async () => {
    let callCount = 0
    let capturedSpawnChild:
      | ((...args: unknown[]) => Promise<{ childTaskId: string; result: { summary: string; artifacts: unknown[] } }>)
      | null = null

    mockCreate.mockImplementation((deps) => {
      callCount++
      if (callCount === 1) {
        // Parent runner: capture spawnChild dep, then resolve
        capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
        return runner(vi.fn().mockResolvedValue(runnerReturn('completed', 'parent done')))
      }
      // Child runner: resolves with a non-empty summary
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', 'child result text')))
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const provider = {
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    }
    const { sessionId } = manager.createSession(provider)

    const { taskId: parentTaskId } = manager.submitGoal(sessionId, 'parent goal')

    // Wait for the async startRunner to reach createAgentRunner
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(capturedSpawnChild).not.toBeNull()
    const childResult = await capturedSpawnChild!(parentTaskId, 'child goal')
    expect(childResult.result.summary).toBe('child result text')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    store.close()
  })

  it('applies the configured main/sub budgets to tasks', async () => {
    const customBudget = {
      main: { tokens: 11, calls: 1, wallMs: 1000, usdCents: 1 },
      sub: { tokens: 22, calls: 2, wallMs: 2000, usdCents: 2 },
    }
    const seenBudgets: Array<{ tokens: number; calls: number; wallMs: number; usdCents: number }> = []
    let callCount = 0
    let capturedSpawnChild: ((...args: unknown[]) => Promise<unknown>) | null = null
    mockCreate.mockImplementation((deps) => {
      callCount++
      seenBudgets.push(deps.budget!)
      if (callCount === 1) {
        capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
        return runner(vi.fn().mockResolvedValue(runnerReturn('completed', 'parent done')))
      }
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', 'child done')))
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({
      store,
      broadcaster,
      maxConcurrent: 4,
      getProvider: () => undefined,
      getBudgetConfig: () => customBudget,
    })
    const { sessionId } = manager.createSession({
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })

    const { taskId: parentTaskId } = manager.submitGoal(sessionId, 'parent goal')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seenBudgets[0]).toEqual(customBudget.main)

    await capturedSpawnChild!(parentTaskId, 'child goal')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seenBudgets[1]).toEqual(customBudget.sub)
    await Promise.resolve()
    store.close()
  })

  it('resolves the permission gate live so a mid-run toggle takes effect', async () => {
    // The composer permission toggle only persists to session settings; the
    // runner resolves permissionMode live via getPermissionMode on each tool
    // call. So flipping "full" after a chat has started — at any time — drops
    // the prompt on the next call without freezing the task's submit snapshot.
    let getPermissionMode: (() => 'ask' | 'full') | undefined
    mockCreate.mockImplementation((deps) => {
      getPermissionMode = deps.getPermissionMode
      // A never-resolving run keeps the turn in-flight while we toggle the gate.
      return runner(() => new Promise<RunReturn>(() => {}))
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    manager.submitGoal(sessionId, 'goal')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getPermissionMode).toBeTypeOf('function')
    expect(getPermissionMode!()).toBe('ask')

    manager.updateSessionSettings(sessionId, { permissionMode: 'full' })
    expect(getPermissionMode!()).toBe('full')

    store.close()
  })

  it('emits the user message as a real seq event on a conversation turn (no Task)', async () => {
    mockCreate.mockImplementationOnce(() => runner(vi.fn().mockResolvedValue(runnerReturn('completed', ''))))
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    manager.submitGoal(sessionId, 'hello world')
    await new Promise((resolve) => setTimeout(resolve, 0))

    // No Task row — the user message lives on the session-conversation stream.
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)
    const userEvent = store
      .getConversationEvents(sessionId)
      .find(
        (r) =>
          (r.event as { kind?: string; role?: string }).kind === 'llm.message' &&
          (r.event as { role?: string }).role === 'user'
      )
    // The user message is a first-class event with a real seq.
    expect(userEvent).toBeDefined()
    expect((userEvent!.event as { content?: string }).content).toBe('hello world')
    expect(userEvent!.seq).toBeTypeOf('number')
    expect(userEvent!.seq).toBeGreaterThan(0)

    store.close()
  })

  it('uses session provider when providerKey is not given', async () => {
    const sessionProvider = {
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'session-key',
    }
    let capturedSpawnChild:
      | ((
          parentTaskId: string,
          goal: string,
          suggestedTools?: string[],
          providerKey?: string
        ) => Promise<{ childTaskId: string; result: { summary: string; artifacts: unknown[] } }>)
      | null = null
    let childProvider = null as ProviderInjection | null

    mockCreate.mockImplementationOnce((deps) => {
      capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })
    mockCreate.mockImplementationOnce((deps) => {
      childProvider = deps.provider
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const altProvider = {
      id: 'openai' as const,
      registry: 'openai' as const,
      apiStyle: 'openai' as const,
      model: 'gpt-4o',
      apiKey: 'alt-key',
    }
    const manager = createSessionManager({
      store,
      broadcaster,
      maxConcurrent: 4,
      getProvider: (key) => (key === 'openai' ? altProvider : undefined),
    })

    const { sessionId } = manager.createSession(sessionProvider)
    manager.submitGoal(sessionId, 'parent goal')
    await new Promise((resolve) => setTimeout(resolve, 0))

    await capturedSpawnChild!('parent-task', 'child goal')
    expect(childProvider?.apiKey).toBe('session-key')

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    store.close()
  })

  it('uses the looked-up provider when providerKey matches', async () => {
    const sessionProvider = {
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'session-key',
    }
    const altProvider = {
      id: 'openai' as const,
      registry: 'openai' as const,
      apiStyle: 'openai' as const,
      model: 'gpt-4o',
      apiKey: 'alt-key',
    }
    let capturedSpawnChild:
      | ((
          parentTaskId: string,
          goal: string,
          suggestedTools?: string[],
          providerKey?: string
        ) => Promise<{ childTaskId: string; result: { summary: string; artifacts: unknown[] } }>)
      | null = null
    let childProvider = null as ProviderInjection | null

    mockCreate.mockImplementationOnce((deps) => {
      capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })
    mockCreate.mockImplementationOnce((deps) => {
      childProvider = deps.provider
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({
      store,
      broadcaster,
      maxConcurrent: 4,
      getProvider: (key) => (key === 'openai' ? altProvider : undefined),
    })

    const { sessionId } = manager.createSession(sessionProvider)
    manager.submitGoal(sessionId, 'parent goal')
    await new Promise((resolve) => setTimeout(resolve, 0))

    await capturedSpawnChild!('parent-task', 'child goal', undefined, 'openai')
    expect(childProvider?.apiKey).toBe('alt-key')

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    store.close()
  })

  it('injects sessionId into broadcasts and persists conversation events on completion', async () => {
    const events: Array<{ name: string; data: Record<string, unknown> }> = []
    const broadcaster = {
      broadcast: (name: string, data: unknown) => events.push({ name, data: data as Record<string, unknown> }),
      addClient: () => undefined,
      removeClient: () => undefined,
    } as never

    mockCreate.mockImplementation((deps) =>
      runner(async () => {
        deps.emit('task.progress', {
          event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 },
          ts: 1,
        })
        deps.emit('task.complete', { result: { summary: 'hi', artifacts: [] }, ts: 2 })
        return runnerReturn('completed', 'hi')
      })
    )

    const store = createConversationStore(dbPath)
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic',
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })
    const { taskId: turnId } = manager.submitGoal(sessionId, 'say hi')

    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(events.every((e) => typeof e.data.sessionId === 'string')).toBe(true)
    // A conversation turn emits no task.created.
    expect(events.some((e) => e.name === 'task.created')).toBe(false)
    // The user + assistant messages persisted to the conversation stream, in order.
    const conv = store.getConversationEvents(sessionId)
    expect(conv.map((r) => (r.event as { content?: string }).content)).toEqual(['say hi', 'hi'])
    // Each broadcast is tagged with the turnId as taskId.
    expect(events.some((e) => e.data.taskId === turnId)).toBe(true)
    store.close()
  })

  it('seeds each turn from the previous turn messages (continuity) and serializes per session', async () => {
    const seeds: unknown[] = []
    let resolveFirst: (() => void) | null = null
    let firstStarted = false
    mockCreate.mockImplementation((deps) =>
      runner(async () => {
        seeds.push(deps.initialMessages)
        if (!firstStarted) {
          firstStarted = true
          await new Promise<void>((r) => {
            resolveFirst = r
          })
          deps.saveSnapshot?.([{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }] as AgentMessage[], {
            tokens: 0,
            calls: 0,
            wallMs: 0,
            usdCents: 0,
            cacheRead: 0,
            cacheWrite: 0,
          })
          return runnerReturn('completed', 'a')
        }
        deps.saveSnapshot?.([{ role: 'assistant', content: [{ type: 'text', text: 'b' }] }] as AgentMessage[], {
          tokens: 0,
          calls: 0,
          wallMs: 0,
          usdCents: 0,
          cacheRead: 0,
          cacheWrite: 0,
        })
        return runnerReturn('completed', 'b')
      })
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic',
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })

    manager.submitGoal(sessionId, 'first')
    manager.submitGoal(sessionId, 'second')
    await new Promise((r) => setTimeout(r, 0))

    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toEqual([])

    resolveFirst!()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(seeds).toHaveLength(2)
    expect(seeds[1]).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }])
    expect(store.getAgentSnapshot(sessionId)).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'b' }] }])
    store.close()
  })

  it('sets the session title from the first goal', async () => {
    mockCreate.mockImplementation(() => runner(async () => runnerReturn('completed', '')))
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic',
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })
    manager.submitGoal(sessionId, 'Organize my downloads folder')
    expect(store.getSession(sessionId)?.title).toBe('Organize my downloads folder')
    store.close()
  })

  it('emits task.dispatched when a turn starts so the UI marks it running (not queued)', async () => {
    // The renderer reducer maps task.dispatched -> status 'running'; nothing else
    // does. Without this emit the active turn stays 'pending' and is misrendered
    // as a queued card. pump must emit it when it starts a turn.
    let resolveA: (() => void) | null = null
    const resolveANow = (): void => {
      const fn = resolveA as (() => void) | null
      if (fn) fn()
    }
    mockCreate.mockImplementation(() =>
      runner(
        () =>
          new Promise<RunReturn>((resolve) => {
            resolveA = () => resolve(runnerReturn('completed', ''))
          })
      )
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const broadcastSpy = vi.spyOn(broadcaster, 'broadcast')
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    const { taskId } = manager.submitGoal(sessionId, 'A')
    await new Promise((r) => setTimeout(r, 0))

    expect(broadcastSpy).toHaveBeenCalledWith('task.dispatched', expect.objectContaining({ sessionId, taskId }))

    resolveANow()
    await new Promise((r) => setTimeout(r, 0))
    store.close()
  })

  it('cancelTask aborts the running task signal', async () => {
    let capturedSignal: AbortSignal | undefined
    mockCreate.mockImplementation((deps) => {
      capturedSignal = deps.signal
      return runner(() => new Promise<RunReturn>(() => {})) // stays running
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic',
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })
    const { taskId } = manager.submitGoal(sessionId, 'long running goal')

    await new Promise((r) => setTimeout(r, 0))
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
    expect(capturedSignal?.aborted).toBe(false)

    manager.cancelTask(sessionId, taskId)
    expect(capturedSignal?.aborted).toBe(true)
    store.close()
  })

  it('does not persist a Task for a conversation turn (session-level usage lands in Task 5)', async () => {
    mockCreate.mockImplementation((deps) =>
      runner(async () => {
        deps.saveSnapshot?.([], { tokens: 1200, calls: 4, wallMs: 3000, usdCents: 6, cacheRead: 0, cacheWrite: 0 })
        return runnerReturn('completed', '')
      })
    )
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic',
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })
    manager.submitGoal(sessionId, 'g')

    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // A conversation turn creates no Task row.
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)
    store.close()
  })

  it('invokes onComplete with the final status when the task turn ends', async () => {
    mockCreate.mockImplementation(() => ({
      run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }),
    }))

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })

    const onComplete = vi.fn()
    manager.submitGoal(sessionId, 'do it', [], undefined, onComplete)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith('completed')
    store.close()
  })

  it('cancelTask drops a queued task so it never runs and marks it cancelled', async () => {
    const ran: string[] = []
    let resolveA: (() => void) | null = null
    mockCreate.mockImplementation((deps) =>
      runner(async () => {
        ran.push(deps.goal!)
        if (deps.goal === 'A') {
          await new Promise<void>((r) => {
            resolveA = r
          })
        }
        deps.saveSnapshot?.([], { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 })
        return runnerReturn('completed', '')
      })
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const broadcastSpy = vi.spyOn(broadcaster, 'broadcast')
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    manager.submitGoal(sessionId, 'A')
    const { taskId: bId } = manager.submitGoal(sessionId, 'B')
    await new Promise((r) => setTimeout(r, 0))

    manager.cancelTask(sessionId, bId)
    // B is a conversation turn (no Task row); only the cancel broadcast is surfaced.
    expect(store.getSessionTasks(sessionId).find((t) => t.id === bId)).toBeUndefined()
    expect(broadcastSpy).toHaveBeenCalledWith(
      'task.error',
      expect.objectContaining({ taskId: bId, error: expect.objectContaining({ code: 'cancelled' }) })
    )

    resolveA!()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(ran).toEqual(['A']) // B was cancelled before it could run
    store.close()
  })

  it('cancelTask marks a zombie task cancelled when its session is not in memory', () => {
    // An interrupted session reopened in the UI is never re-dispatched, so it is
    // absent from the in-memory sessions Map. Cancelling its phantom queued task
    // must still flip it to 'cancelled' and emit so the UI drops the card.
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const broadcastSpy = vi.spyOn(broadcaster, 'broadcast')
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })

    // Seed a session + pending task directly in the store, bypassing
    // manager.createSession so the session never enters the in-memory Map.
    store.createSession('ses-ghost', providerA)
    store.updateSessionStatus('ses-ghost', 'interrupted')
    store.saveTask(
      {
        id: 'task-ghost',
        parentId: null,
        agentDefId: 'default',
        goal: 'g',
        status: 'pending',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
        history: [],
        attachments: [],
        plan: [],
        result: null,
        createdAt: Date.now(),
        startedAt: null,
        endedAt: null,
      },
      'ses-ghost'
    )

    manager.cancelTask('ses-ghost', 'task-ghost')
    expect(store.getTask('task-ghost')?.status).toBe('cancelled')
    expect(broadcastSpy).toHaveBeenCalledWith(
      'task.error',
      expect.objectContaining({ taskId: 'task-ghost', error: expect.objectContaining({ code: 'cancelled' }) })
    )
    store.close()
  })

  it('invokes onComplete with failed + message when the run throws', async () => {
    mockCreate.mockImplementation(() => ({
      run: vi.fn().mockRejectedValue(new Error('boom')),
    }))

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })

    const onComplete = vi.fn()
    manager.submitGoal(sessionId, 'do it', [], undefined, onComplete)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith('failed', 'boom')
    store.close()
  })

  it('stamps composer options on the task and applies the plan read-only allowlist', async () => {
    // Capture the full Task; assert the composer-stamped fields below.
    let capturedTask = null as Record<string, unknown> | null
    mockCreate.mockImplementation((deps) => {
      capturedTask = deps
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })

    manager.submitGoal(sessionId, 'investigate', [], undefined, undefined, {
      cwd: '/work/dir',
      permissionMode: 'full',
      executionMode: 'plan',
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(capturedTask?.cwd).toBe('/work/dir')
    expect(capturedTask?.permissionMode).toBe('full')
    expect(capturedTask?.executionMode).toBe('plan')
    // Plan mode is read-only: no shell, no fs writes, no spawn.
    expect(capturedTask?.toolAllowlist).not.toContain('*')
    expect(capturedTask?.toolAllowlist).toContain('fs.read_file')
    expect(capturedTask?.toolAllowlist).not.toContain('shell.run_shell')
    expect(capturedTask?.toolAllowlist).not.toContain('fs.write_file')
    expect(capturedTask?.toolAllowlist).not.toContain('agent.spawn_sub_agent')
    store.close()
  })

  it('lists sessions and drives a conversation turn (no Task) via the manager', async () => {
    mockCreate.mockImplementation(() => runner(async () => runnerReturn('completed', '')))
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic',
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })
    manager.submitGoal(sessionId, 'g')
    expect(manager.listSessions().map((s) => s.id)).toContain(sessionId)
    // A conversation turn produces no Task but does produce a conversation event.
    expect(manager.getSessionTasks(sessionId)).toHaveLength(0)
    expect(manager.getConversationEvents(sessionId).length).toBeGreaterThan(0)
    store.close()
  })

  it('resolves options.agentType to the registered agent definition for the conversation turn', async () => {
    let captured: AgentDefinition | undefined
    mockCreate.mockImplementation((deps) => {
      captured = deps.agentDefinition
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })

    const customDef = {
      id: 'researcher',
      name: 'Researcher',
      description: 'Use when you need to research things.',
      systemPrompt: 'You research things.',
      toolScope: 'fs' as const,
      maxIterations: 25,
      model: undefined,
    }
    const agentStore = {
      get: (id: string) => (id === 'researcher' ? customDef : undefined),
      list: () => [customDef],
      reload: () => undefined,
      save: () => ({ ok: true as const, agents: [] as AgentDefinition[] }),
      remove: () => ({ ok: true as const, agents: [] as AgentDefinition[] }),
      watch: () => () => undefined,
    }

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({
      store,
      broadcaster,
      maxConcurrent: 2,
      getProvider: () => undefined,
      agentStore,
    })
    const { sessionId } = manager.createSession({
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })

    manager.submitGoal(sessionId, 'research something', [], undefined, undefined, { agentType: 'researcher' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(captured?.id).toBe('researcher')
    // No Task row for a conversation turn.
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)
    store.close()
  })

  it('interruptWith cancels the running task and runs the promoted one before the rest', async () => {
    const ran: string[] = []
    const seeds: Record<string, unknown> = {}
    mockCreate.mockImplementation((deps) =>
      runner(
        () =>
          new Promise<RunReturn>((resolve) => {
            ran.push(deps.goal!)
            seeds[deps.goal!] = deps.initialMessages
            if (deps.goal === 'A') {
              // A stays running until interrupted (aborted). On abort it persists a
              // partial transcript via saveSnapshot before resolving cancelled, so
              // the promoted turn must seed from that partial output.
              deps.signal?.addEventListener('abort', () => {
                deps.saveSnapshot?.(
                  [{ role: 'assistant', content: [{ type: 'text', text: 'partial-A' }] }] as AgentMessage[],
                  {
                    tokens: 0,
                    calls: 0,
                    wallMs: 0,
                    usdCents: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  }
                )
                resolve(runnerReturn('cancelled', ''))
              })
              return
            }
            deps.saveSnapshot?.([], { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 })
            resolve(runnerReturn('completed', ''))
          })
      )
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    manager.submitGoal(sessionId, 'A') // runs
    manager.submitGoal(sessionId, 'B') // queued
    const { taskId: cId } = manager.submitGoal(sessionId, 'C') // queued
    await new Promise((r) => setTimeout(r, 0))

    manager.interruptWith(sessionId, cId) // cancel A, jump C ahead of B
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(ran).toEqual(['A', 'C', 'B'])
    // The promoted turn C seeds from the partial output A saved on abort.
    expect(seeds.C).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'partial-A' }] }])
    store.close()
  })

  it('interruptWith pumps the promoted queued turn when the session is idle (else branch)', async () => {
    // Exercise interruptWith's `else { pump(session) }` branch: no running turn to
    // abort, so interruptWith must start the promoted turn itself. The public
    // submitGoal always pumps, so we reach an idle-with-pending state via the
    // test-only enqueue seam, then promote C ahead of B and assert C runs first.
    const ran: string[] = []
    mockCreate.mockImplementation((deps) =>
      runner(async () => {
        ran.push(deps.goal!)
        deps.saveSnapshot?.([], { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 })
        return runnerReturn('completed', '')
      })
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    // Enqueue B then C without auto-pumping: the session stays idle with two
    // pending turns — the only state from which the idle else branch is reachable.
    const mgr = manager as unknown as { __enqueueWithoutPumpForTest(s: string, g: string): string }
    mgr.__enqueueWithoutPumpForTest(sessionId, 'B')
    const cId = mgr.__enqueueWithoutPumpForTest(sessionId, 'C')
    expect(ran).toEqual([]) // nothing started — session is idle

    manager.interruptWith(sessionId, cId) // promote C; no running task -> pump
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(ran).toEqual(['C', 'B']) // C ran first via the idle pump branch
    store.close()
  })

  it('cancelTask while a turn waits for a slot aborts it before it does any work', async () => {
    // FIX 1 regression: pump() shifts a turn out of pending and sets
    // session.running synchronously, then runTurn() awaits a slot. The abort
    // handle must be registered BEFORE that await, or a cancel issued during the
    // slot wait finds the turn nowhere and silently no-ops.
    const sawAbortedAtEntry: Record<string, boolean> = {}
    mockCreate.mockImplementation((deps) =>
      runner(
        () =>
          new Promise<RunReturn>((resolve) => {
            // Record whether the signal was already aborted when run() started.
            sawAbortedAtEntry[deps.goal!] = deps.signal?.aborted ?? false
            if (deps.signal?.aborted) {
              resolve(runnerReturn('cancelled', ''))
              return
            }
            // A holds the single slot until it is itself aborted.
            deps.signal?.addEventListener('abort', () => resolve(runnerReturn('cancelled', '')))
          })
      )
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    // maxConcurrent: 1 — one global slot shared across sessions.
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 1, getProvider: () => undefined })
    const { sessionId: s1 } = manager.createSession(providerA)
    const { sessionId: s2 } = manager.createSession(providerA)

    // A grabs the only slot and runs.
    const { taskId: aId } = manager.submitGoal(s1, 'A')
    await new Promise((r) => setTimeout(r, 0))
    expect(sawAbortedAtEntry.A).toBe(false)

    // B is dequeued by pump (session2.running set, B shifted out of pending) and
    // now blocks on acquireSlot() — A holds the slot.
    const { taskId: bId } = manager.submitGoal(s2, 'B')
    await new Promise((r) => setTimeout(r, 0))
    // B has not entered run() yet — no slot.
    expect(sawAbortedAtEntry.B).toBeUndefined()

    // Cancel B while it waits for the slot. With FIX 1 its handle is registered,
    // so this aborts B's latched signal.
    manager.cancelTask(s2, bId)

    // Free the slot by cancelling A → A resolves cancelled → releaseSlot → B
    // acquires the slot and starts; its run() entry must observe an aborted signal.
    manager.cancelTask(s1, aId)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(sawAbortedAtEntry.B).toBe(true)
    // B is a conversation turn (no Task row); only the aborted signal matters here.
    expect(store.getSessionTasks(s2).find((t) => t.id === bId)).toBeUndefined()
    store.close()
  })

  it('falls back to default agent when options.agentType is unknown', async () => {
    let captured: AgentDefinition | undefined
    mockCreate.mockImplementation((deps) => {
      captured = deps.agentDefinition
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })

    const agentStore = {
      get: (_id: string) => undefined,
      list: () => [],
      reload: () => undefined,
      save: () => ({ ok: true as const, agents: [] as AgentDefinition[] }),
      remove: () => ({ ok: true as const, agents: [] as AgentDefinition[] }),
      watch: () => () => undefined,
    }

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({
      store,
      broadcaster,
      maxConcurrent: 2,
      getProvider: () => undefined,
      agentStore,
    })
    const { sessionId } = manager.createSession({
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })

    manager.submitGoal(sessionId, 'do something', [], undefined, undefined, { agentType: 'nonexistent-agent' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(captured?.id).toBe('default')
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)
    store.close()
  })

  it('persists task.criteria and task.verification emits via the work-task emit handler', async () => {
    // Work tasks (runWorkTask → runTaskTurn) use makeEmit, which persists
    // task.criteria / task.verification. Conversation turns use makeConversationEmit,
    // which does not — so drive a work task here.
    let capturedEmit: ((event: string, data: unknown) => void) | null = null
    mockCreate.mockImplementation((deps) => {
      capturedEmit = deps.emit
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })
    const { taskId } = await (
      manager as unknown as {
        __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string; result: unknown }>
      }
    ).__runWorkTaskForTest(sessionId, 'solve it')

    expect(capturedEmit).not.toBeNull()
    const emit = capturedEmit!

    const saveCriteriaSpy = vi.spyOn(store, 'saveTaskCriteria')
    const saveVerifSpy = vi.spyOn(store, 'saveTaskVerifications')

    // Exercise task.criteria branch.
    const criteria = [{ id: 'c1', description: 'Output must be correct' }]
    emit('task.criteria', { taskId, criteria, ts: Date.now() })
    expect(saveCriteriaSpy).toHaveBeenCalledWith(taskId, criteria)

    // Exercise task.verification branch (read-modify-write: second round appends).
    const round1 = { round: 1, verdict: 'pass' as const, results: [], gaps: [], ts: Date.now() }
    emit('task.verification', { taskId, round: round1, ts: Date.now() })
    expect(saveVerifSpy).toHaveBeenCalledWith(taskId, [round1])

    const round2 = { round: 2, verdict: 'fail' as const, results: [], gaps: ['missing output'], ts: Date.now() }
    emit('task.verification', { taskId, round: round2, ts: Date.now() })
    expect(saveVerifSpy).toHaveBeenCalledWith(taskId, [round1, round2])

    store.close()
  })

  it('persists task.delegation_plan emits via the work-task emit handler', async () => {
    let capturedEmit: ((event: string, data: unknown) => void) | null = null
    mockCreate.mockImplementation((deps) => {
      capturedEmit = deps.emit
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })
    const { taskId } = await (
      manager as unknown as {
        __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string; result: unknown }>
      }
    ).__runWorkTaskForTest(sessionId, 'solve it')

    const emit = capturedEmit!
    const spy = vi.spyOn(store, 'saveTaskDelegationPlan')
    const plan = [
      {
        id: 'd1',
        goal: 'build',
        ownerAgentType: 'engineer',
        dependsOn: [],
        acceptanceCriteria: [{ id: 'c1', description: 'ships' }],
      },
      { id: 'd2', goal: 'review', dependsOn: ['d1'] },
    ]
    emit('task.delegation_plan', { taskId, plan, ts: Date.now() })
    expect(spy).toHaveBeenCalledWith(taskId, plan)
    store.close()
  })

  it('starts a fresh conversation turn per goal (no Task continuation)', async () => {
    const goals: string[] = []
    mockCreate.mockImplementation((deps) =>
      runner(async () => {
        goals.push(deps.goal!)
        return runnerReturn('completed', 'ok')
      })
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    const first = manager.submitGoal(sessionId, 'do the thing')
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // The session is idle; a follow-up starts a NEW turn (no task continuation).
    const followUp = manager.submitGoal(sessionId, '继续')
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(followUp.taskId).not.toBe(first.taskId)
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)
    expect(goals).toEqual(['do the thing', '继续'])
    // Both user messages live on the conversation stream, in order.
    const userContents = store
      .getConversationEvents(sessionId)
      .filter((r) => (r.event as { role?: string }).role === 'user')
      .map((r) => (r.event as { content?: string }).content)
    expect(userContents).toEqual(['do the thing', '继续'])
    store.close()
  })

  it('queues a distinct task when a top-level turn is already running', async () => {
    let releaseFirst: (() => void) | null = null
    const releaseFirstNow = (): void => {
      const fn = releaseFirst as (() => void) | null
      if (fn) fn()
    }
    let firstStarted = false
    mockCreate.mockImplementation(() =>
      runner(async () => {
        if (!firstStarted) {
          firstStarted = true
          await new Promise<void>((r) => {
            releaseFirst = r
          })
        }
        return runnerReturn('completed', 'ok')
      })
    )

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    const first = manager.submitGoal(sessionId, 'first')
    await new Promise((r) => setTimeout(r, 0)) // let the first turn start and block
    // Submitted while the first turn is still running → a distinct queued task.
    const second = manager.submitGoal(sessionId, 'second')
    await new Promise((r) => setTimeout(r, 0))

    expect(second.taskId).not.toBe(first.taskId)
    // Both are conversation turns (no Task rows).
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)

    releaseFirstNow()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    store.close()
  })

  it('runWorkTask creates a top-level work task and runs it single-shot', async () => {
    const calls: number[] = []
    mockCreate.mockImplementation(() => {
      calls.push(1)
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', 'done')))
    })
    const store = createConversationStore(dbPath)
    const manager = createSessionManager({
      store,
      broadcaster: createBroadcaster(),
      maxConcurrent: 2,
      getProvider: () => undefined,
    })
    const { sessionId } = manager.createSession(providerA)
    const out = await (
      manager as unknown as {
        __runWorkTaskForTest: (sid: string, goal: string) => Promise<{ taskId: string; result: { summary: string } }>
      }
    ).__runWorkTaskForTest(sessionId, 'build feature X')
    expect(calls).toHaveLength(1)
    expect(out.result.summary).toBe('done')
    const task = store.getSessionTasks(sessionId).find((t) => t.id === out.taskId)
    expect(task?.parentId).toBeNull()
    store.close()
  })

  it('submitGoal constructs the runner and saves no Task', async () => {
    let constructed = false
    mockCreate.mockImplementation(() => {
      constructed = true
      return runner(vi.fn().mockResolvedValue(runnerReturn('completed', '')))
    })
    const store = createConversationStore(dbPath)
    const manager = createSessionManager({
      store,
      broadcaster: createBroadcaster(),
      maxConcurrent: 2,
      getProvider: () => undefined,
    })
    const { sessionId } = manager.createSession(providerA)
    manager.submitGoal(sessionId, 'hi')
    await new Promise((r) => setTimeout(r, 0))
    expect(constructed).toBe(true)
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)
    store.close()
  })

  it('cancelTask aborts an in-flight conversation turn by turnId', async () => {
    let capturedSignal: AbortSignal | undefined
    let release: () => void = () => {}
    mockCreate.mockImplementation((deps) => {
      capturedSignal = deps.signal
      return runner(
        () =>
          new Promise<RunReturn>((r) => {
            release = () => r(runnerReturn('cancelled', ''))
          })
      )
    })
    const store = createConversationStore(dbPath)
    const manager = createSessionManager({
      store,
      broadcaster: createBroadcaster(),
      maxConcurrent: 1,
      getProvider: () => undefined,
    })
    const { sessionId } = manager.createSession(providerA)
    const { taskId: turnId } = manager.submitGoal(sessionId, 'hi')
    await new Promise((r) => setTimeout(r, 0))

    expect(capturedSignal?.aborted).toBe(false)
    manager.cancelTask(sessionId, turnId) // turnId, not a Task id
    expect(capturedSignal?.aborted).toBe(true)

    release()
    await new Promise((r) => setTimeout(r, 0))
    // A conversation turn leaves no Task row.
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)
    store.close()
  })

  it('cancelTask drops a queued conversation turn without FK-violating', async () => {
    // A queued conversation turn has no Task row; cancelling it must broadcast a
    // task.error directly (not appendTaskEvent, which FK-violates on the missing
    // task_id) and leave no Task behind.
    let releaseFirst: () => void = () => {}
    mockCreate.mockImplementation(() =>
      runner(
        () =>
          new Promise<RunReturn>((r) => {
            releaseFirst = () => r(runnerReturn('completed', ''))
          })
      )
    )
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const broadcastSpy = vi.spyOn(broadcaster, 'broadcast')
    const manager = createSessionManager({
      store,
      broadcaster,
      maxConcurrent: 1,
      getProvider: () => undefined,
    })
    const { sessionId } = manager.createSession(providerA)
    manager.submitGoal(sessionId, 'first') // running, holds the only slot
    await new Promise((r) => setTimeout(r, 0))
    const { taskId: secondId } = manager.submitGoal(sessionId, 'second') // queued

    // Must not throw (no FK violation) and must surface the cancel.
    expect(() => manager.cancelTask(sessionId, secondId)).not.toThrow()
    expect(broadcastSpy).toHaveBeenCalledWith(
      'task.error',
      expect.objectContaining({ taskId: secondId, error: expect.objectContaining({ code: 'cancelled' }) })
    )
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)

    releaseFirst()
    await new Promise((r) => setTimeout(r, 0))
    store.close()
  })
})
