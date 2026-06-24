import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_SESSION_ID } from '@shared/system-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createBroadcaster } from '../ipc/broadcaster'
import { createSessionManager } from './manager'

vi.mock('./agent-runner', () => ({
  createAgentRunner: vi.fn(),
}))

import { createAgentRunner } from './agent-runner'

const mockCreate = vi.mocked(createAgentRunner)

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
    const resolvers: Array<(v: { status: 'completed' | 'failed'; summary: string }) => void> = []
    mockCreate.mockImplementation(() => ({
      run: () =>
        new Promise<{ status: 'completed' | 'failed'; summary: string }>((resolve) => {
          resolvers.push(resolve)
        }),
    }))

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
    resolvers[0]({ status: 'completed', summary: '' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(resolvers).toHaveLength(3)

    resolvers[1]({ status: 'completed', summary: '' })
    resolvers[2]({ status: 'completed', summary: '' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    store.close()
  })

  it('semaphore never exceeds maxConcurrent under contended release+acquire', async () => {
    // Goals submitted to DIFFERENT sessions run concurrently (cross-session),
    // bounded by the semaphore. This exercises the waiter-transfer path.
    const resolvers: Array<(v: { status: 'completed' | 'failed'; summary: string }) => void> = []
    mockCreate.mockImplementation(() => ({
      run: () =>
        new Promise<{ status: 'completed' | 'failed'; summary: string }>((resolve) => {
          resolvers.push(resolve)
        }),
    }))

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
    resolvers[0]({ status: 'completed', summary: '' })
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
    resolvers[1]({ status: 'completed', summary: '' })
    resolvers[2]?.({ status: 'completed', summary: '' })
    resolvers[3]?.({ status: 'completed', summary: '' })
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
        return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: 'parent done' }) }
      }
      // Child runner: resolves with a non-empty summary
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: 'child result text' }) }
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
      seenBudgets.push(deps.task.budget)
      if (callCount === 1) {
        capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
        return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: 'parent done' }) }
      }
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: 'child done' }) }
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
    let childProvider: { id: string; model: string; apiKey: string } | null = null

    mockCreate.mockImplementationOnce((deps) => {
      capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }) }
    })
    mockCreate.mockImplementationOnce((deps) => {
      childProvider = deps.provider as typeof childProvider
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }) }
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
    let childProvider: { id: string; model: string; apiKey: string } | null = null

    mockCreate.mockImplementationOnce((deps) => {
      capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }) }
    })
    mockCreate.mockImplementationOnce((deps) => {
      childProvider = deps.provider as typeof childProvider
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }) }
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

  it('injects sessionId into broadcasts and persists task history on completion', async () => {
    const events: Array<{ name: string; data: Record<string, unknown> }> = []
    const broadcaster = {
      broadcast: (name: string, data: unknown) => events.push({ name, data: data as Record<string, unknown> }),
      addClient: () => undefined,
      removeClient: () => undefined,
    } as never

    mockCreate.mockImplementation((deps: { task: { id: string }; emit: (n: string, d: unknown) => void }) => ({
      run: async () => {
        deps.emit('task.progress', {
          taskId: deps.task.id,
          event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 },
          ts: 1,
        })
        deps.emit('task.complete', { taskId: deps.task.id, result: { summary: 'hi', artifacts: [] }, ts: 2 })
        return { status: 'completed' as const, summary: 'hi', messages: [] }
      },
    }))

    const store = createConversationStore(dbPath)
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({
      id: 'anthropic',
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    })
    const { taskId } = manager.submitGoal(sessionId, 'say hi')

    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(events.every((e) => typeof e.data.sessionId === 'string')).toBe(true)
    expect(events.find((e) => e.name === 'task.created')?.data.sessionId).toBe(sessionId)
    const history = store.getSessionTasks(sessionId).find((t) => t.id === taskId)?.history
    expect(history).toEqual([{ kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 }])
    store.close()
  })

  it('seeds each turn from the previous turn messages (continuity) and serializes per session', async () => {
    const seeds: unknown[] = []
    let resolveFirst: (() => void) | null = null
    let firstStarted = false
    mockCreate.mockImplementation(
      (deps: { initialMessages: unknown; saveSnapshot?: (m: unknown, u: unknown) => void }) => ({
        run: async () => {
          seeds.push(deps.initialMessages)
          if (!firstStarted) {
            firstStarted = true
            await new Promise<void>((r) => {
              resolveFirst = r
            })
            deps.saveSnapshot?.([{ role: 'assistant', content: 'a' }], {
              tokens: 0,
              calls: 0,
              wallMs: 0,
              usdCents: 0,
            })
            return { status: 'completed' as const, summary: 'a' }
          }
          deps.saveSnapshot?.([{ role: 'assistant', content: 'b' }], {
            tokens: 0,
            calls: 0,
            wallMs: 0,
            usdCents: 0,
          })
          return { status: 'completed' as const, summary: 'b' }
        },
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
    expect(seeds[1]).toEqual([{ role: 'assistant', content: 'a' }])
    expect(store.getAgentSnapshot(sessionId)).toEqual([{ role: 'assistant', content: 'b' }])
    store.close()
  })

  it('sets the session title from the first goal', async () => {
    mockCreate.mockImplementation(() => ({
      run: async () => ({ status: 'completed' as const, summary: '', messages: [] }),
    }))
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

  it('cancelTask aborts the running task signal', async () => {
    let capturedSignal: AbortSignal | undefined
    mockCreate.mockImplementation((deps: { signal?: AbortSignal }) => {
      capturedSignal = deps.signal
      return { run: () => new Promise<never>(() => {}) } // stays running
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

  it('persists the used returned by the runner to the task row', async () => {
    mockCreate.mockImplementation((deps: { saveSnapshot?: (m: unknown, u: unknown) => void }) => ({
      run: async () => {
        deps.saveSnapshot?.([], { tokens: 1200, calls: 4, wallMs: 3000, usdCents: 6 })
        return { status: 'completed' as const, summary: '' }
      },
    }))
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
    const { taskId } = manager.submitGoal(sessionId, 'g')

    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const task = store.getSessionTasks(sessionId).find((t) => t.id === taskId)
    expect(task?.used).toEqual({ tokens: 1200, calls: 4, wallMs: 3000, usdCents: 6 })
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
    mockCreate.mockImplementation((deps: { task: { goal: string }; saveSnapshot?: (m: unknown, u: unknown) => void }) => ({
      run: async () => {
        ran.push(deps.task.goal)
        if (deps.task.goal === 'A') {
          await new Promise<void>((r) => {
            resolveA = r
          })
        }
        deps.saveSnapshot?.([], { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 })
        return { status: 'completed' as const, summary: '' }
      },
    }))

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    manager.submitGoal(sessionId, 'A')
    const { taskId: bId } = manager.submitGoal(sessionId, 'B')
    await new Promise((r) => setTimeout(r, 0))

    manager.cancelTask(sessionId, bId)
    expect(store.getSessionTasks(sessionId).find((t) => t.id === bId)?.status).toBe('cancelled')

    resolveA!()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(ran).toEqual(['A']) // B was cancelled before it could run
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
    let capturedTask: {
      cwd?: string
      permissionMode?: string
      executionMode?: string
      toolAllowlist: string[]
    } | null = null
    mockCreate.mockImplementation((deps: { task: typeof capturedTask }) => {
      capturedTask = deps.task
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }) }
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

  it('lists sessions and returns a session tasks via the manager', () => {
    mockCreate.mockImplementation(() => ({
      run: async () => ({ status: 'completed' as const, summary: '', messages: [] }),
    }))
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
    expect(manager.getSessionTasks(sessionId).length).toBeGreaterThanOrEqual(1)
    store.close()
  })

  it('resolves options.agentType to the registered agent definition', () => {
    mockCreate.mockImplementation(() => ({
      run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }),
    }))

    const customDef = {
      id: 'researcher',
      name: 'Researcher',
      description: 'Use when you need to research things.',
      systemPrompt: 'You research things.',
      toolScope: 'fs' as const,
      maxIterations: 25,
      model: undefined,
    }
    const agentStore = { get: (id: string) => (id === 'researcher' ? customDef : undefined), list: () => [customDef] }

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

    const tasks = store.getSessionTasks(sessionId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].agentDefId).toBe('researcher')
    store.close()
  })

  it('interruptWith cancels the running task and runs the promoted one before the rest', async () => {
    const ran: string[] = []
    mockCreate.mockImplementation((deps: { task: { goal: string }; signal?: AbortSignal; saveSnapshot?: (m: unknown, u: unknown) => void }) => ({
      run: () =>
        new Promise<{ status: 'completed' | 'cancelled'; summary: string }>((resolve) => {
          ran.push(deps.task.goal)
          if (deps.task.goal === 'A') {
            // A stays running until interrupted (aborted).
            deps.signal?.addEventListener('abort', () => resolve({ status: 'cancelled', summary: '' }))
            return
          }
          deps.saveSnapshot?.([], { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 })
          resolve({ status: 'completed', summary: '' })
        }),
    }))

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
    store.close()
  })

  it('falls back to default agent when options.agentType is unknown', () => {
    mockCreate.mockImplementation(() => ({
      run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }),
    }))

    const agentStore = { get: (_id: string) => undefined, list: () => [] }

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

    const tasks = store.getSessionTasks(sessionId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].agentDefId).toBe('default')
    store.close()
  })
})
