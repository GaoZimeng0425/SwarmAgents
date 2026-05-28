import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSessionManager } from './session-manager'
import { createConversationStore } from './conversation-store'
import { createSseBroadcaster } from './sse'

const tmpDb = () => join(tmpdir(), `swarm-ses-test-${Date.now()}.db`)

describe('SessionManager', () => {
  let dbPath: string

  beforeEach(() => { dbPath = tmpDb() })
  afterEach(() => { try { rmSync(dbPath) } catch {} })

  it('creates a session and returns sessionId', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2 })
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
    createSessionManager({ store: store2, broadcaster, maxConcurrent: 2 })

    expect(store2.getSession('old-ses')?.status).toBe('interrupted')
    store2.close()
  })

  it('resolves permission by forwarding to registry', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2 })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    const { sessionId } = manager.createSession(provider)

    // Should not throw for unknown actionId
    expect(() => manager.resolvePermission(sessionId, 'no-such-action', 'deny')).not.toThrow()
    store.close()
  })
})
