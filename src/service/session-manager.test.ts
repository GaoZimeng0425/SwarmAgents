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

    store.close()
  })
})
