import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConversationStore } from './conversation-store'

const tmpDb = () => join(tmpdir(), `swarm-test-${Date.now()}-${Math.random()}.db`)

describe('ConversationStore', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDb()
  })
  afterEach(() => {
    try {
      rmSync(dbPath)
    } catch {}
  })

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
        id: 'task-1',
        parentId: null,
        agentDefId: 'default',
        goal: 'hello',
        status: 'pending',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
      },
      'ses-1'
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

  it('stores and updates a session title', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-t', provider)
    expect(store.getSession('ses-t')?.title).toBeNull()
    store.setSessionTitle('ses-t', 'Tidy the desktop')
    expect(store.getSession('ses-t')?.title).toBe('Tidy the desktop')
    store.close()
  })

  it('round-trips an agent message snapshot', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-s', provider)
    expect(store.getAgentSnapshot('ses-s')).toEqual([])
    const messages = [{ role: 'user', content: 'hi' }] as unknown as Parameters<typeof store.saveAgentSnapshot>[1]
    store.saveAgentSnapshot('ses-s', messages)
    expect(store.getAgentSnapshot('ses-s')).toEqual(messages)
    store.close()
  })

  it('lists non-ended sessions newest-first with task counts', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-a', provider)
    store.updateSessionLastActive('ses-a')
    store.createSession('ses-b', provider)
    store.updateSessionLastActive('ses-b')
    store.createSession('ses-gone', provider)
    store.updateSessionStatus('ses-gone', 'ended')

    const now = Date.now()
    store.saveTask(
      {
        id: '01HRX0000000000000000000A1',
        parentId: null,
        agentDefId: 'default',
        goal: 'g',
        status: 'completed',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
      },
      'ses-b'
    )

    const list = store.listSessions()
    const ids = list.map((s) => s.id)
    expect(ids).not.toContain('ses-gone')
    expect(ids).toContain('ses-a')
    expect(ids).toContain('ses-b')
    expect(list.find((s) => s.id === 'ses-b')?.taskCount).toBe(1)
    expect(list.find((s) => s.id === 'ses-a')?.taskCount).toBe(0)
    store.close()
  })

  it('persists and reloads task history', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-h', provider)
    const now = Date.now()
    store.saveTask(
      {
        id: '01HRX0000000000000000000H1',
        parentId: null,
        agentDefId: 'default',
        goal: 'g',
        status: 'running',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
      },
      'ses-h'
    )
    store.saveTaskHistory('01HRX0000000000000000000H1', [
      { kind: 'llm.message', role: 'assistant', content: 'done', ts: now },
    ])
    const tasks = store.getSessionTasks('ses-h')
    expect(tasks[0].history).toEqual([{ kind: 'llm.message', role: 'assistant', content: 'done', ts: now }])
    store.close()
  })

  it('saveTaskUsage writes used back to the task row', () => {
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    const store = createConversationStore(dbPath)
    store.createSession('ses-u', provider)
    store.saveTask(
      {
        id: '01HRX0000000000000000000U1',
        parentId: null,
        agentDefId: 'default',
        goal: 'g',
        status: 'running',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 100, calls: 5, wallMs: 1000, usdCents: 10 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: 1,
        startedAt: null,
        endedAt: null,
      },
      'ses-u'
    )
    store.saveTaskUsage('01HRX0000000000000000000U1', { tokens: 1500, calls: 3, wallMs: 4200, usdCents: 7 })
    const task = store.getSessionTasks('ses-u').find((t) => t.id === '01HRX0000000000000000000U1')
    expect(task?.used).toEqual({ tokens: 1500, calls: 3, wallMs: 4200, usdCents: 7 })
    store.close()
  })

  const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }

  it('renames a session via setSessionTitle', () => {
    const store = createConversationStore(dbPath)
    store.createSession('ses-r', provider)
    store.setSessionTitle('ses-r', 'My chat')
    expect(store.listSessions().find((s) => s.id === 'ses-r')?.title).toBe('My chat')
    store.close()
  })

  it('floats pinned sessions to the top of listSessions', () => {
    const store = createConversationStore(dbPath)
    store.createSession('ses-a', provider)
    store.createSession('ses-b', provider)
    // Pin the second one — it must lead regardless of recency tiebreaks.
    store.setSessionPinned('ses-b', true)
    expect(store.listSessions()[0].id).toBe('ses-b')
    expect(store.listSessions().find((s) => s.id === 'ses-b')?.pinned).toBe(true)
    // Unpinning clears the flag.
    store.setSessionPinned('ses-b', false)
    expect(store.listSessions().every((s) => !s.pinned)).toBe(true)
    store.close()
  })

  it('hard-deletes a session and its tasks', () => {
    const store = createConversationStore(dbPath)
    store.createSession('ses-d', provider)
    store.saveTask(
      {
        id: '01HRX0000000000000000000D1',
        parentId: null,
        agentDefId: 'default',
        goal: 'g',
        status: 'running',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 100, calls: 5, wallMs: 1000, usdCents: 10 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: 1,
        startedAt: null,
        endedAt: null,
      },
      'ses-d'
    )
    store.deleteSession('ses-d')
    expect(store.getSession('ses-d')).toBeUndefined()
    expect(store.getSessionTasks('ses-d')).toEqual([])
    expect(store.listSessions().some((s) => s.id === 'ses-d')).toBe(false)
    store.close()
  })

  it('round-trips task attachments', () => {
    const store = createConversationStore(dbPath)
    store.createSession('ses-att', provider)
    store.saveTask(
      {
        id: '01HRX0000000000000000000T1',
        parentId: null,
        agentDefId: 'default',
        goal: 'look at this',
        status: 'pending',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        attachments: [{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }],
        result: null,
        createdAt: 1,
        startedAt: null,
        endedAt: null,
      },
      'ses-att'
    )
    const loaded = store.getSessionTasks('ses-att')
    expect(loaded[0].attachments).toEqual([{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }])
    store.close()
  })
})
