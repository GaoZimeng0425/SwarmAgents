import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createConversationStore } from './conversation-store'

const tmpDb = () => join(tmpdir(), `swarm-test-${Date.now()}-${Math.random()}.db`)

describe('ConversationStore', () => {
  let dbPath: string

  beforeEach(() => { dbPath = tmpDb() })
  afterEach(() => { try { rmSync(dbPath) } catch {} })

  it('creates and retrieves a session', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    const session = store.createSession('ses-1', provider)
    expect(session.id).toBe('ses-1')
    expect(session.status).toBe('active')

    const fetched = store.getSession('ses-1')
    expect(fetched?.id).toBe('ses-1')
    expect(fetched?.providerSnapshot.id).toBe('anthropic')
    store.close()
  })

  it('returns interrupted sessions on restart', () => {
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    const store1 = createConversationStore(dbPath)
    store1.createSession('ses-active', provider)
    const store1b = createConversationStore(dbPath)
    store1b.createSession('ses-ended', provider)
    store1b.updateSessionStatus('ses-ended', 'ended')
    store1b.close()
    store1.close()

    const store2 = createConversationStore(dbPath)
    const interrupted = store2.getInterruptedSessions()
    const ids = interrupted.map((s) => s.id)
    expect(ids).toContain('ses-active')
    expect(ids).not.toContain('ses-ended')
    // Verify they are now marked interrupted in the DB
    expect(store2.getSession('ses-active')?.status).toBe('interrupted')
    store2.close()
  })

  it('saves and retrieves tasks', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)

    const now = Date.now()
    store.saveTask(
      {
        id: 'task-1', parentId: null, agentDefId: 'default', goal: 'hello',
        status: 'pending', assignedWorkerId: null,
        toolAllowlist: [], budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
      },
      'ses-1',
    )
    const tasks = store.getSessionTasks('ses-1')
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('task-1')
    store.close()
  })

  it('saves and retrieves tool state', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)
    store.saveToolState('ses-1', 'cookies', [{ name: 'sid', value: '123' }])
    const cookies = store.getToolState('ses-1', 'cookies')
    expect(cookies).toEqual([{ name: 'sid', value: '123' }])
    expect(store.getToolState('ses-1', 'nonexistent')).toBeUndefined()
    store.close()
  })
})
