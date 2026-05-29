import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSessionManager } from './session-manager'
import { createConversationStore } from './conversation-store'
import { createSseBroadcaster } from './sse'

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
  afterEach(() => { try { rmSync(dbPath) } catch {} })

  it('creates a session and returns sessionId', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }

    const { sessionId } = manager.createSession(provider)
    expect(sessionId).toBeTruthy()
    expect(store.getSession(sessionId)?.status).toBe('active')
    store.close()
  })

  it('marks active sessions interrupted on init', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    store.createSession('old-ses', provider)
    store.close()

    const store2 = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    createSessionManager({ store: store2, broadcaster, maxConcurrent: 2, getProvider: () => undefined })

    expect(store2.getSession('old-ses')?.status).toBe('interrupted')
    store2.close()
  })

  it('resolves permission by forwarding to registry', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    const { sessionId } = manager.createSession(provider)

    expect(() => manager.resolvePermission(sessionId, 'no-such-action', 'deny')).not.toThrow()
    store.close()
  })

  it('limits concurrent runners to maxConcurrent', async () => {
    const resolvers: Array<(v: { status: 'completed' | 'failed'; summary: string }) => void> = []
    mockCreate.mockImplementation(() => ({
      run: () => new Promise<{ status: 'completed' | 'failed'; summary: string }>(
        (resolve) => { resolvers.push(resolve) }
      ),
    }))

    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    const { sessionId } = manager.createSession(provider)

    manager.submitGoal(sessionId, 'goal 1')
    manager.submitGoal(sessionId, 'goal 2')
    manager.submitGoal(sessionId, 'goal 3')

    // Flush promise queue: two slots fill immediately
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
    const resolvers: Array<(v: { status: 'completed' | 'failed'; summary: string }) => void> = []
    mockCreate.mockImplementation(() => ({
      run: () => new Promise<{ status: 'completed' | 'failed'; summary: string }>(
        (resolve) => { resolvers.push(resolve) }
      ),
    }))

    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    const { sessionId } = manager.createSession(provider)

    // Submit 3 — two run, one queues as waiter w3.
    manager.submitGoal(sessionId, 'g1')
    manager.submitGoal(sessionId, 'g2')
    manager.submitGoal(sessionId, 'g3')
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

    // Now we're in M2 (test continuation). Synchronously submit g4 BEFORE M3
    // (waiter w3's continuation) drains. acquireSlot fast-path runs sync.
    manager.submitGoal(sessionId, 'g4')

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
    let capturedSpawnChild: ((...args: unknown[]) => Promise<{ childTaskId: string; result: { summary: string; artifacts: unknown[] } }>) | null = null

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
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    const { sessionId } = manager.createSession(provider)

    const { taskId: parentTaskId } = manager.submitGoal(sessionId, 'parent goal')

    // Wait for the async startRunner to reach createAgentRunner
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(capturedSpawnChild).not.toBeNull()
    const childResult = await capturedSpawnChild!(parentTaskId, 'child goal')
    expect(childResult.result.summary).toBe('child result text')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    store.close()
  })
})
