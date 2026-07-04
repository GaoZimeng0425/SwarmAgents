import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Task, TaskEvent, UIEvent } from '@swarm/protocol'
import { emptyUsed } from '@swarm/protocol'
import { SYSTEM_SESSION_ID } from '@swarm/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConversationStore } from './store'

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
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    const session = store.createSession('ses-1', provider)
    expect(session.id).toBe('ses-1')
    expect(session.status).toBe('active')

    const fetched = store.getSession('ses-1')
    expect(fetched?.id).toBe('ses-1')
    expect(fetched?.providerSnapshot.id).toBe('anthropic')
    store.close()
  })

  it('returns interrupted sessions on restart', () => {
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
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

  it('interrupts non-terminal tasks of interrupted sessions on restart, preserving terminal ones', () => {
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    const mkTask = (id: string, status: import('@swarm/protocol').Task['status']) => ({
      id,
      parentId: null,
      agentDefId: 'default',
      goal: 'g',
      status,
      assignedWorkerId: null,
      toolAllowlist: [],
      budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
      used: emptyUsed(),
      history: [],
      attachments: [],
      plan: [],
      result: null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
    })
    const store1 = createConversationStore(dbPath)
    store1.createSession('ses-x', provider) // left 'active' → interrupted on restart
    store1.saveTask(mkTask('task-run', 'running'), 'ses-x')
    store1.saveTask(mkTask('task-pend', 'pending'), 'ses-x')
    store1.saveTask(mkTask('task-done', 'completed'), 'ses-x')
    store1.close()

    const store2 = createConversationStore(dbPath)
    store2.getInterruptedSessions()
    const byId = new Map(store2.getSessionTasks('ses-x').map((t) => [t.id, t.status]))
    expect(byId.get('task-run')).toBe('interrupted')
    expect(byId.get('task-pend')).toBe('interrupted')
    expect(byId.get('task-done')).toBe('completed') // terminal preserved
    store2.close()
  })

  it('interrupts zombie tasks under already-interrupted sessions on restart', () => {
    // A previous restart already flipped the session to 'interrupted' but its
    // tasks slipped through the old active-only cleanup. A second restart must
    // still clean those zombies — the cleanup is global, not keyed to sessions
    // flipped active→interrupted this run.
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    const mkTask = (id: string, status: import('@swarm/protocol').Task['status']) => ({
      id,
      parentId: null,
      agentDefId: 'default',
      goal: 'g',
      status,
      assignedWorkerId: null,
      toolAllowlist: [],
      budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
      used: emptyUsed(),
      history: [],
      attachments: [],
      plan: [],
      result: null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
    })
    const store1 = createConversationStore(dbPath)
    store1.createSession('ses-prev', provider)
    store1.updateSessionStatus('ses-prev', 'interrupted') // simulate a prior restart
    store1.saveTask(mkTask('task-zombie', 'pending'), 'ses-prev')
    store1.close()

    const store2 = createConversationStore(dbPath)
    store2.getInterruptedSessions()
    expect(store2.getSessionTasks('ses-prev').find((t) => t.id === 'task-zombie')?.status).toBe('interrupted')
    store2.close()
  })

  it('closes orphan tool calls when interrupting zombie tasks on restart', () => {
    // A spawn_sub_agent interrupted mid-run leaves a tool.call whose blocking
    // execute() never returned, so no tool.result is ever recorded. Its card
    // would spin "running" forever on reload. The restart cleanup must synthesize
    // a tool.result (ok=false) for each unresolved call, while leaving already
    // resolved calls untouched.
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    const mkTask = (id: string, status: import('@swarm/protocol').Task['status']) => ({
      id,
      parentId: null,
      agentDefId: 'default',
      goal: 'g',
      status,
      assignedWorkerId: null,
      toolAllowlist: [],
      budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
      used: emptyUsed(),
      history: [],
      attachments: [],
      plan: [],
      result: null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
    })
    const store1 = createConversationStore(dbPath)
    store1.createSession('ses-x', provider) // left 'active' → interrupted on restart
    store1.saveTask(mkTask('task-zombie', 'pending'), 'ses-x')
    // A resolved tool call (call + result) plus an orphan spawn_sub_agent (call only).
    store1.appendTaskEvent('task-zombie', {
      kind: 'tool.call',
      server: 'builtin',
      tool: 'read_file',
      args: {},
      ts: 1,
      callId: 'call-resolved',
    })
    store1.appendTaskEvent('task-zombie', {
      kind: 'tool.result',
      ok: true,
      payload: { kind: 'text', text: 'ok' },
      ts: 2,
      callId: 'call-resolved',
    })
    store1.appendTaskEvent('task-zombie', {
      kind: 'tool.call',
      server: 'builtin',
      tool: 'spawn_sub_agent',
      args: { goal: 'g' },
      ts: 3,
      callId: 'call-orphan',
    })
    store1.close()

    const store2 = createConversationStore(dbPath)
    store2.getInterruptedSessions()
    const task = store2.getSessionTasks('ses-x').find((t) => t.id === 'task-zombie')!
    expect(task.status).toBe('interrupted')
    const results = task.history.filter(
      (e): e is Extract<TaskEvent, { kind: 'tool.result' }> => e.kind === 'tool.result'
    )
    const orphan = results.find((r) => r.callId === 'call-orphan')
    expect(orphan).toBeDefined()
    expect(orphan?.ok).toBe(false)
    // The already-resolved call is not duplicated.
    expect(results.filter((r) => r.callId === 'call-resolved')).toHaveLength(1)
    expect(results).toHaveLength(2)
    store2.close()
  })

  it('markTaskRunning sets running status and stamps started_at once', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-r', provider)
    store.saveTask(
      {
        id: 'task-r',
        parentId: null,
        agentDefId: 'default',
        goal: 'g',
        status: 'pending',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
        used: emptyUsed(),
        history: [],
        attachments: [],
        plan: [],
        result: null,
        createdAt: Date.now(),
        startedAt: null,
        endedAt: null,
      },
      'ses-r'
    )
    store.markTaskRunning('task-r')
    const after = store.getSessionTasks('ses-r')[0]
    expect(after.status).toBe('running')
    expect(after.startedAt).toBeGreaterThan(0)
    const firstStart = after.startedAt
    // A second dispatch (continuation) keeps the original start time.
    store.markTaskRunning('task-r')
    expect(store.getSessionTasks('ses-r')[0].startedAt).toBe(firstStart)
    store.close()
  })

  it('saves and retrieves tasks', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
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
        used: emptyUsed(),
        history: [],
        attachments: [],
        plan: [],
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
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-1', provider)
    store.saveToolState('ses-1', 'cookies', [{ name: 'sid', value: '123' }])
    const cookies = store.getToolState('ses-1', 'cookies')
    expect(cookies).toEqual([{ name: 'sid', value: '123' }])
    expect(store.getToolState('ses-1', 'nonexistent')).toBeUndefined()
    store.close()
  })

  it('stores and updates a session title', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-t', provider)
    expect(store.getSession('ses-t')?.title).toBeNull()
    store.setSessionTitle('ses-t', 'Tidy the desktop')
    expect(store.getSession('ses-t')?.title).toBe('Tidy the desktop')
    store.close()
  })

  it('round-trips an agent message snapshot', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-s', provider)
    expect(store.getAgentSnapshot('ses-s')).toEqual([])
    const messages = [{ role: 'user', content: 'hi' }] as unknown as Parameters<typeof store.saveAgentSnapshot>[1]
    store.saveAgentSnapshot('ses-s', messages)
    expect(store.getAgentSnapshot('ses-s')).toEqual(messages)
    store.close()
  })

  it('lists non-ended sessions newest-first with task counts', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
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
        used: emptyUsed(),
        history: [],
        attachments: [],
        plan: [],
        result: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
      },
      'ses-b'
    )
    // taskCount is now derived from distinct run_id in run_events (post-4b the
    // tasks table is no longer read for usage/listing). Seed one run for ses-b.
    store.appendRunEvent('ses-b', 'r-b', null, {
      kind: 'task.created',
      sessionId: 'ses-b',
      taskId: 'r-b',
      goal: 'g',
      ts: now,
      seq: 1,
    })

    const list = store.listSessions()
    const ids = list.map((s) => s.id)
    expect(ids).not.toContain('ses-gone')
    expect(ids).toContain('ses-a')
    expect(ids).toContain('ses-b')
    expect(list.find((s) => s.id === 'ses-b')?.taskCount).toBe(1)
    expect(list.find((s) => s.id === 'ses-a')?.taskCount).toBe(0)
    store.close()
  })

  it('aggregates per-session token + cost usage in listSessions', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-u', provider)
    const usageEvent = (
      sessionId: string,
      runId: string,
      used: { tokens: number; calls: number; wallMs: number; usdCents: number; cacheRead: number; cacheWrite: number },
      model: string,
      ts: number
    ) => ({
      kind: 'task.usage' as const,
      sessionId,
      taskId: runId,
      used,
      model,
      ts,
      seq: 1,
    })

    // Two top-level runs in the session.
    store.appendRunEvent(
      'ses-u',
      'r1',
      null,
      usageEvent(
        'ses-u',
        'r1',
        { tokens: 5000, calls: 1, wallMs: 0, usdCents: 6, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-5',
        1
      )
    )
    store.appendRunEvent(
      'ses-u',
      'r2',
      null,
      usageEvent(
        'ses-u',
        'r2',
        { tokens: 3000, calls: 1, wallMs: 0, usdCents: 4, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-5',
        1
      )
    )
    // A sub-agent child run emits its own task.usage — post-4a each runner
    // tracks its own cost (the parent's snapshot does NOT include the child),
    // so the child's usage is now COUNTED (pre-4b children were zeroed).
    store.appendRunEvent(
      'ses-u',
      'r3',
      'r1',
      usageEvent(
        'ses-u',
        'r3',
        { tokens: 1000, calls: 1, wallMs: 0, usdCents: 2, cacheRead: 0, cacheWrite: 0 },
        'claude-haiku-4-5-20251001',
        1
      )
    )
    // A run may emit task.usage multiple times (per-turn snapshots); only the
    // LATEST per run_id contributes — earlier emissions are superseded.
    store.appendRunEvent(
      'ses-u',
      'r1',
      null,
      usageEvent(
        'ses-u',
        'r1',
        { tokens: 7000, calls: 2, wallMs: 0, usdCents: 9, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-5',
        2
      )
    )

    const s = store.listSessions().find((x) => x.id === 'ses-u')
    // Latest per run: r1=7000/9, r2=3000/4, r3=1000/2 → 11000 tokens, 15 cents.
    expect(s?.tokensUsed).toBe(11000)
    expect(s?.usdCents).toBe(15)
    // Three distinct run_ids — top-level + sub-agent all count.
    expect(s?.taskCount).toBe(3)
    store.close()
  })

  const taskLiteral = (id: string, history: import('@swarm/protocol').TaskEvent[] = []) => ({
    id,
    parentId: null,
    agentDefId: 'default',
    goal: 'g',
    status: 'running' as const,
    assignedWorkerId: null,
    toolAllowlist: [] as string[],
    budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    used: emptyUsed(),
    history,
    attachments: [],
    plan: [],
    result: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
  })

  it('appends events and reconstructs history in insertion order', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-e', provider)
    store.saveTask(taskLiteral('01HRX0000000000000000000E1'), 'ses-e')
    store.appendTaskEvent('01HRX0000000000000000000E1', { kind: 'reasoning', content: 'a', ts: 1 })
    store.appendTaskEvent('01HRX0000000000000000000E1', { kind: 'llm.message', role: 'assistant', content: 'b', ts: 2 })
    expect(store.getSessionTasks('ses-e')[0].history).toEqual([
      { kind: 'reasoning', content: 'a', ts: 1 },
      { kind: 'llm.message', role: 'assistant', content: 'b', ts: 2 },
    ])
    store.close()
  })

  it('backfills legacy tasks.history into task_events on open, without duplicating', () => {
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    const legacy: import('@swarm/protocol').TaskEvent[] = [
      { kind: 'reasoning', content: 'x', ts: 1 },
      { kind: 'error', error: { code: 'boom', message: 'nope', tier: 'fatal' }, ts: 2 },
    ]
    const store1 = createConversationStore(dbPath)
    store1.createSession('ses-b', provider)
    store1.saveTask(taskLiteral('01HRX0000000000000000000B1', legacy), 'ses-b')
    store1.close()

    const store2 = createConversationStore(dbPath)
    expect(store2.getSessionTasks('ses-b')[0].history).toEqual(legacy)
    store2.close()

    const store3 = createConversationStore(dbPath)
    expect(store3.getSessionTasks('ses-b')[0].history).toHaveLength(2)
    store3.close()
  })

  it('deletes task_events when its session is deleted', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-d', provider)
    store.saveTask(taskLiteral('01HRX0000000000000000000D1'), 'ses-d')
    store.appendTaskEvent('01HRX0000000000000000000D1', { kind: 'reasoning', content: 'a', ts: 1 })
    store.deleteSession('ses-d')
    expect(store.getSessionTasks('ses-d')).toEqual([])
    store.close()
  })

  describe('conversation events', () => {
    it('appendConversationEvent persists and re-reads session conversation events', () => {
      const store = createConversationStore(dbPath)
      store.appendConversationEvent('s1', 'turn-1', {
        kind: 'llm.message',
        role: 'user',
        content: 'hi',
        ts: 1,
        seq: 1,
      } as never)
      store.appendConversationEvent('s1', 'turn-1', {
        kind: 'llm.message',
        role: 'assistant',
        content: 'yo',
        ts: 2,
        seq: 2,
      } as never)
      store.appendConversationEvent('s1', 'turn-2', {
        kind: 'llm.message',
        role: 'user',
        content: 'again',
        ts: 3,
        seq: 3,
      } as never)
      const rows = store.getConversationEvents('s1')
      expect(rows).toHaveLength(3)
      // Ordered by insertion id; grouped by turn.
      expect(rows.map((r) => r.turnId)).toEqual(['turn-1', 'turn-1', 'turn-2'])
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
      expect(rows.map((r) => (r.event as { content?: string }).content)).toEqual(['hi', 'yo', 'again'])
      store.close()
    })

    it('survives a reopen (events persisted to disk)', () => {
      const store1 = createConversationStore(dbPath)
      store1.appendConversationEvent('s1', 'turn-1', {
        kind: 'llm.message',
        role: 'user',
        content: 'hi',
        ts: 1,
        seq: 1,
      } as never)
      store1.close()
      const store2 = createConversationStore(dbPath)
      expect(store2.getConversationEvents('s1')).toHaveLength(1)
      store2.close()
    })

    it('deletes conversation_events when its session is deleted', () => {
      const store = createConversationStore(dbPath)
      const provider = { id: 'anthropic' as const, apiStyle: 'anthropic' as const, model: 'm', apiKey: 'k' }
      store.createSession('ses-c', provider)
      store.appendConversationEvent('ses-c', 'turn-1', {
        kind: 'llm.message',
        role: 'user',
        content: 'hi',
        ts: 1,
        seq: 1,
      } as never)
      store.deleteSession('ses-c')
      expect(store.getConversationEvents('ses-c')).toEqual([])
      store.close()
    })
  })

  describe('run events', () => {
    it('appendRunEvent persists UIEvents and re-reads them with runId/parentRunId', () => {
      const store = createConversationStore(dbPath)
      const ev: UIEvent = {
        kind: 'task.progress',
        sessionId: 's1',
        taskId: 'r1',
        event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 },
        ts: 1,
        seq: 1,
      }
      store.appendRunEvent('s1', 'r1', null, ev)
      store.appendRunEvent('s1', 'r1', null, {
        kind: 'task.complete',
        sessionId: 's1',
        taskId: 'r1',
        summary: 'done',
        ts: 2,
        seq: 2,
      })
      store.appendRunEvent('s1', 'r2', 'r1', {
        kind: 'task.created',
        sessionId: 's1',
        taskId: 'r2',
        goal: 'child',
        parentTaskId: 'r1',
        ts: 3,
        seq: 3,
      })
      const rows = store.getRunEvents('s1')
      expect(rows).toHaveLength(3)
      expect(rows.map((r) => r.runId)).toEqual(['r1', 'r1', 'r2'])
      expect(rows[2].parentRunId).toBe('r1')
      expect((rows[0].event as UIEvent).kind).toBe('task.progress')
      store.close()
    })
  })

  it('saveSessionUsage round-trips conversation usage on the session row', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, apiStyle: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-su', provider)
    expect(store.getSessionUsage('ses-su')).toBeUndefined()
    store.saveSessionUsage(
      'ses-su',
      { tokens: 900, calls: 3, wallMs: 1000, usdCents: 5, cacheRead: 200, cacheWrite: 0 },
      200_000
    )
    const got = store.getSessionUsage('ses-su')
    expect(got?.used.tokens).toBe(900)
    expect(got?.used.cacheRead).toBe(200)
    expect(got?.contextWindow).toBe(200_000)
    // Post-4b listSessions no longer folds session_used into its totals —
    // conversation usage comes from run_events.task.usage instead. The
    // session_used column is now write-only dead data on the read side
    // (still persisted here, cleaned up in a later task).
    const s = store.listSessions().find((x) => x.id === 'ses-su')
    expect(s?.tokensUsed).toBe(0)
    expect(s?.usdCents).toBe(0)
    store.close()
  })

  it('persists and reloads a task plan', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-p', provider)
    const now = Date.now()
    store.saveTask(
      {
        id: '01HRX0000000000000000000P1',
        parentId: null,
        agentDefId: 'default',
        goal: 'g',
        status: 'running',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: emptyUsed(),
        history: [],
        attachments: [],
        plan: [],
        result: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
      },
      'ses-p'
    )
    expect(store.getSessionTasks('ses-p')[0].plan).toEqual([])

    store.saveTaskPlan('01HRX0000000000000000000P1', [
      { content: 'step one', status: 'in_progress' },
      { content: 'step two', status: 'pending' },
    ])
    const tasks = store.getSessionTasks('ses-p')
    expect(tasks[0].plan).toEqual([
      { content: 'step one', status: 'in_progress' },
      { content: 'step two', status: 'pending' },
    ])
    store.close()
  })

  it('saveTaskUsage writes used back to the task row', () => {
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
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
        used: emptyUsed(),
        history: [],
        attachments: [],
        plan: [],
        result: null,
        createdAt: 1,
        startedAt: null,
        endedAt: null,
      },
      'ses-u'
    )
    store.saveTaskUsage(
      '01HRX0000000000000000000U1',
      { tokens: 1500, calls: 3, wallMs: 4200, usdCents: 7, cacheRead: 0, cacheWrite: 0 },
      200_000
    )
    const task = store.getSessionTasks('ses-u').find((t) => t.id === '01HRX0000000000000000000U1')
    expect(task?.used).toEqual({ tokens: 1500, calls: 3, wallMs: 4200, usdCents: 7, cacheRead: 0, cacheWrite: 0 })
    expect(task?.contextWindow).toBe(200_000)

    // A later call without a window must not wipe the stored one (COALESCE).
    store.saveTaskUsage('01HRX0000000000000000000U1', {
      tokens: 1600,
      calls: 4,
      wallMs: 4300,
      usdCents: 8,
      cacheRead: 0,
      cacheWrite: 0,
    })
    const after = store.getSessionTasks('ses-u').find((t) => t.id === '01HRX0000000000000000000U1')
    expect(after?.contextWindow).toBe(200_000)
    store.close()
  })

  const provider = { id: 'anthropic' as const, apiStyle: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }

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
        used: emptyUsed(),
        history: [],
        attachments: [],
        plan: [],
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
        used: emptyUsed(),
        history: [],
        attachments: [{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }],
        plan: [],
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

  it('saves, lists, touches, and deletes cron jobs', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, apiStyle: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-1', provider)

    store.saveCronJob({
      id: 'job-1',
      sessionId: 'ses-1',
      originSessionId: 'ses-1',
      name: 'morning',
      cron: '0 9 * * *',
      goal: 'summarize inbox',
      createdAt: 1000,
      lastRunAt: null,
    })

    expect(store.listCronJobs().length).toBe(1)
    expect(store.listCronJobsForSession('ses-1')[0].goal).toBe('summarize inbox')

    store.touchCronJob('job-1', 2000)
    expect(store.listCronJobs()[0].lastRunAt).toBe(2000)

    store.deleteCronJob('job-1')
    expect(store.listCronJobs().length).toBe(0)
    store.close()
  })

  it('reassigns a cron job to another session', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, apiStyle: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-old', provider)
    store.createSession(SYSTEM_SESSION_ID, provider)
    store.saveCronJob({
      id: 'job-1',
      sessionId: 'ses-old',
      originSessionId: null,
      name: null,
      cron: '0 9 * * *',
      goal: 'g',
      createdAt: 1000,
      lastRunAt: null,
    })

    store.reassignCronJob('job-1', SYSTEM_SESSION_ID)

    expect(store.listCronJobs()[0].sessionId).toBe(SYSTEM_SESSION_ID)
    expect(store.listCronJobsForSession('ses-old')).toHaveLength(0)
    expect(store.listCronJobsForSession(SYSTEM_SESSION_ID)).toHaveLength(1)
    store.close()
  })

  it('persists and round-trips originSessionId', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, apiStyle: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-origin', provider)
    store.saveCronJob({
      id: 'job-1',
      sessionId: 'ses-origin',
      originSessionId: 'ses-origin',
      name: null,
      cron: '0 9 * * *',
      goal: 'g',
      createdAt: 1000,
      lastRunAt: null,
    })
    expect(store.listCronJobs()[0].originSessionId).toBe('ses-origin')
    store.close()
  })

  it('reassign captures origin only when not already set (COALESCE)', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, apiStyle: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-old', provider)
    store.createSession(SYSTEM_SESSION_ID, provider)
    store.saveCronJob({
      id: 'job-1',
      sessionId: 'ses-old',
      originSessionId: null,
      name: null,
      cron: '0 9 * * *',
      goal: 'g',
      createdAt: 1000,
      lastRunAt: null,
    })

    // First repoint records the origin it came from.
    store.reassignCronJob('job-1', SYSTEM_SESSION_ID, 'ses-old')
    expect(store.listCronJobs()[0].sessionId).toBe(SYSTEM_SESSION_ID)
    expect(store.listCronJobs()[0].originSessionId).toBe('ses-old')

    // A later repoint must not clobber the recorded origin.
    store.reassignCronJob('job-1', SYSTEM_SESSION_ID, 'ses-other')
    expect(store.listCronJobs()[0].originSessionId).toBe('ses-old')
    store.close()
  })

  it('cascades cron job deletion when its session is deleted', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, apiStyle: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-1', provider)
    store.saveCronJob({
      id: 'job-1',
      sessionId: 'ses-1',
      originSessionId: null,
      name: null,
      cron: '* * * * *',
      goal: 'g',
      createdAt: 1000,
      lastRunAt: null,
    })
    store.deleteSession('ses-1')
    expect(store.listCronJobs().length).toBe(0)
    store.close()
  })

  it('new sessions get descending sort_order so newest is first', () => {
    const store = createConversationStore(':memory:')
    store.createSession('ses-a', provider)
    store.createSession('ses-b', provider)
    const ids = store.listSessions().map((s) => s.id)
    expect(ids).toEqual(['ses-b', 'ses-a']) // newest first by sort_order
    store.close()
  })

  it('reorderSessions persists an explicit order', () => {
    const store = createConversationStore(':memory:')
    store.createSession('ses-a', provider)
    store.createSession('ses-b', provider)
    store.createSession('ses-c', provider)
    store.reorderSessions(['ses-a', 'ses-c', 'ses-b'])
    expect(store.listSessions().map((s) => s.id)).toEqual(['ses-a', 'ses-c', 'ses-b'])
    store.close()
  })

  it('pinned sessions float above unpinned regardless of sort_order', () => {
    const store = createConversationStore(':memory:')
    store.createSession('ses-a', provider)
    store.createSession('ses-b', provider)
    store.reorderSessions(['ses-a', 'ses-b'])
    store.setSessionPinned('ses-b', true)
    expect(store.listSessions().map((s) => s.id)).toEqual(['ses-b', 'ses-a'])
    store.close()
  })

  it('aggregates usage stats over the range', () => {
    const store = createConversationStore(dbPath)
    const anthropic = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    const glm = { id: 'custom' as const, apiStyle: 'openai' as const, model: 'GLM-5.2', apiKey: 'k' }
    store.createSession('ses-a', anthropic)
    store.createSession('ses-b', glm)

    const now = Date.now()
    const day = 86_400_000
    const used = (tokens: number, usdCents: number) => ({
      tokens,
      calls: 1,
      wallMs: 1,
      usdCents,
      cacheRead: 0,
      cacheWrite: 0,
    })
    const usageEvent = (
      sessionId: string,
      runId: string,
      model: string,
      usedVal: ReturnType<typeof used>,
      ts: number
    ) => ({
      kind: 'task.usage' as const,
      sessionId,
      taskId: runId,
      used: usedVal,
      model,
      ts,
      seq: 1,
    })
    const progressEvent = (
      sessionId: string,
      runId: string,
      inner: import('@swarm/protocol').TaskEvent,
      ts: number
    ) => ({
      kind: 'task.progress' as const,
      sessionId,
      taskId: runId,
      event: inner,
      ts,
      seq: 1,
    })

    store.appendRunEvent(
      'ses-a',
      't-recent-a',
      null,
      usageEvent('ses-a', 't-recent-a', 'claude-sonnet-4-5', used(1000, 12), now)
    )
    store.appendRunEvent(
      'ses-b',
      't-recent-b',
      null,
      usageEvent('ses-b', 't-recent-b', 'GLM-5.2', used(500, 0), now - day)
    )
    store.appendRunEvent(
      'ses-a',
      't-old',
      null,
      usageEvent('ses-a', 't-old', 'claude-sonnet-4-5', used(9999, 99), now - 40 * day)
    )

    // Two assistant/user messages + one non-message (reasoning) on t-recent-a.
    store.appendRunEvent(
      'ses-a',
      't-recent-a',
      null,
      progressEvent('ses-a', 't-recent-a', { kind: 'llm.message', role: 'assistant', content: 'hi', ts: now }, now)
    )
    store.appendRunEvent(
      'ses-a',
      't-recent-a',
      null,
      progressEvent('ses-a', 't-recent-a', { kind: 'llm.message', role: 'user', content: 'yo', ts: now }, now)
    )
    store.appendRunEvent(
      'ses-a',
      't-recent-a',
      null,
      progressEvent('ses-a', 't-recent-a', { kind: 'reasoning', content: 'think', ts: now }, now)
    )

    const stats = store.getUsageStats(30)
    expect(stats.rangeDays).toBe(30)
    expect(stats.totals.tokens).toBe(1500) // old run excluded
    expect(stats.totals.usdCents).toBe(12)
    expect(stats.totals.sessions).toBe(2)
    expect(stats.totals.messages).toBe(2)
    expect(stats.totals.activeDays).toBe(2)
    expect(stats.byModel.map((m) => m.model).sort()).toEqual(['GLM-5.2', 'claude-sonnet-4-5'])
    expect(stats.byModel.find((m) => m.model === 'claude-sonnet-4-5')?.tokens).toBe(1000)
    // Per-model cost: claude's run spent 12 cents, GLM's spent 0.
    expect(stats.byModel.find((m) => m.model === 'claude-sonnet-4-5')?.usdCents).toBe(12)
    expect(stats.byModel.find((m) => m.model === 'GLM-5.2')?.usdCents).toBe(0)
    expect(stats.totals.topModel?.model).toBe('claude-sonnet-4-5')
    expect(stats.totals.topModel?.usdCents).toBe(12)
    expect(stats.totals.currentStreak).toBe(2) // today + yesterday both have usage
    expect(stats.daily.length).toBe(30)
    expect(stats.heatmap.length).toBe(364)
    // Per-day, per-model rows: claude today (1000), GLM yesterday (500); old run excluded.
    expect(stats.dailyByModel.length).toBe(2)
    expect(stats.dailyByModel.find((r) => r.model === 'claude-sonnet-4-5')?.tokens).toBe(1000)
    expect(stats.dailyByModel.find((r) => r.model === 'GLM-5.2')?.tokens).toBe(500)
    store.close()
  })

  it('returns an empty-but-shaped result with no data', () => {
    const store = createConversationStore(dbPath)
    const stats = store.getUsageStats(7)
    expect(stats.totals.tokens).toBe(0)
    expect(stats.totals.topModel).toBeNull()
    expect(stats.totals.currentStreak).toBe(0)
    expect(stats.byModel).toEqual([])
    expect(stats.dailyByModel).toEqual([])
    expect(stats.daily.length).toBe(7)
    expect(stats.heatmap.length).toBe(364)
    store.close()
  })

  it('records, attaches, and finishes a cron run', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-1', provider)

    store.saveCronRun({
      id: 'run-1',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: null,
      status: 'running',
      triggeredAt: 100,
      endedAt: null,
      error: null,
    })
    store.attachCronRunTask('run-1', 'task-1')
    store.finishCronRun('run-1', { status: 'completed', error: null, endedAt: 200 })

    const runs = store.listCronRunsForJob('job-1')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: 'run-1',
      taskId: 'task-1',
      status: 'completed',
      endedAt: 200,
    })
    store.close()
  })

  it('lists running cron runs only', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-1', provider)
    store.saveCronRun({
      id: 'r-run',
      jobId: 'j',
      sessionId: 'ses-1',
      taskId: 't',
      status: 'running',
      triggeredAt: 1,
      endedAt: null,
      error: null,
    })
    store.saveCronRun({
      id: 'r-done',
      jobId: 'j',
      sessionId: 'ses-1',
      taskId: 't2',
      status: 'completed',
      triggeredAt: 2,
      endedAt: 3,
      error: null,
    })

    const running = store.listRunningCronRuns()
    expect(running.map((r) => r.id)).toEqual(['r-run'])
    store.close()
  })

  it('keeps only the latest 100 runs per job', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-1', provider)
    for (let i = 0; i < 105; i++) {
      store.saveCronRun({
        id: `run-${i}`,
        jobId: 'job-1',
        sessionId: 'ses-1',
        taskId: null,
        status: 'running',
        triggeredAt: i,
        endedAt: null,
        error: null,
      })
    }
    const runs = store.listCronRunsForJob('job-1')
    expect(runs).toHaveLength(100)
    // newest first; oldest five (triggeredAt 0..4) pruned
    expect(runs[0].triggeredAt).toBe(104)
    expect(runs.at(-1)?.triggeredAt).toBe(5)
    store.close()
  })

  it('cascades cron_runs on session delete but keeps them after job removal', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-1', provider)
    store.saveCronJob({
      id: 'job-1',
      sessionId: 'ses-1',
      originSessionId: null,
      name: null,
      cron: '0 0 * * *',
      goal: 'g',
      createdAt: 1,
      lastRunAt: null,
    })
    store.saveCronRun({
      id: 'run-1',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: null,
      status: 'running',
      triggeredAt: 1,
      endedAt: null,
      error: null,
    })

    store.deleteCronJob('job-1')
    expect(store.listCronRunsForJob('job-1')).toHaveLength(1) // job removal keeps history

    store.deleteSession('ses-1')
    expect(store.listCronRunsForJob('job-1')).toHaveLength(0) // session delete cascades
    store.close()
  })

  it('getTask returns a saved task or undefined', () => {
    const store = createConversationStore(dbPath)
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }
    store.createSession('ses-1', provider)
    const now = Date.now()
    store.saveTask(
      {
        id: 'task-1',
        parentId: null,
        agentDefId: 'a',
        goal: 'g',
        status: 'pending',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: emptyUsed(),
        history: [],
        attachments: [],
        plan: [],
        result: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
      },
      'ses-1'
    )
    expect(store.getTask('task-1')?.goal).toBe('g')
    expect(store.getTask('missing')).toBeUndefined()
    store.close()
  })

  describe('system session', () => {
    const provider = {
      id: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    }

    it('includes the system session in listSessions and marks it isSystem', () => {
      const store = createConversationStore(':memory:')
      store.createSession('ses-1', provider)
      store.createSession(SYSTEM_SESSION_ID, provider)
      const list = store.listSessions()
      expect(list.find((s) => s.id === 'ses-1')?.isSystem).toBe(false)
      expect(list.find((s) => s.id === SYSTEM_SESSION_ID)?.isSystem).toBe(true)
      store.close()
    })

    it('lists all cron runs across jobs, newest first', () => {
      const store = createConversationStore(':memory:')
      store.createSession(SYSTEM_SESSION_ID, provider)
      store.saveCronJob({
        id: 'job-1',
        sessionId: SYSTEM_SESSION_ID,
        originSessionId: null,
        name: null,
        cron: '0 0 * * *',
        goal: 'g',
        createdAt: 1,
        lastRunAt: null,
      })
      store.saveCronRun({
        id: 'run-a',
        jobId: 'job-1',
        sessionId: SYSTEM_SESSION_ID,
        taskId: 'task-a',
        status: 'completed',
        triggeredAt: 100,
        endedAt: 200,
        error: null,
      })
      store.saveCronRun({
        id: 'run-b',
        jobId: 'job-1',
        sessionId: SYSTEM_SESSION_ID,
        taskId: 'task-b',
        status: 'failed',
        triggeredAt: 300,
        endedAt: 400,
        error: 'boom',
      })
      const runs = store.listAllCronRuns()
      expect(runs.map((r) => r.id)).toEqual(['run-b', 'run-a'])
      store.close()
    })

    it('protects the system session from deletion so its cron jobs survive', () => {
      const store = createConversationStore(':memory:')
      store.createSession(SYSTEM_SESSION_ID, provider)
      store.deleteSession(SYSTEM_SESSION_ID)
      expect(store.getSession(SYSTEM_SESSION_ID)).toBeDefined()
      store.close()
    })

    it('updates a session provider snapshot in place', () => {
      const store = createConversationStore(':memory:')
      store.createSession('ses-1', provider)
      const next = { id: 'anthropic' as const, apiStyle: 'anthropic' as const, model: 'claude-opus-4-8', apiKey: 'k2' }
      store.updateSessionProvider('ses-1', next)
      expect(store.getSession('ses-1')?.providerSnapshot).toEqual(next)
      store.close()
    })
  })

  describe('listActorsForSession', () => {
    it('returns a session actors in creation order and excludes other sessions', () => {
      const store = createConversationStore(':memory:')
      const mk = (address: string, sessionId: string, createdAt: number) => ({
        address,
        agentDefId: 'default',
        sessionId,
        name: address,
        state: null,
        lastTaskId: null,
        createdAt,
        updatedAt: createdAt,
      })
      store.upsertActor(mk('a2', 'S1', 200))
      store.upsertActor(mk('a1', 'S1', 100))
      store.upsertActor(mk('b1', 'S2', 150))
      expect(store.listActorsForSession('S1').map((a) => a.address)).toEqual(['a1', 'a2'])
      expect(store.listActorsForSession('S2').map((a) => a.address)).toEqual(['b1'])
      store.close()
    })
  })

  const mkTask = (id: string, status: Task['status']): Task => ({
    id,
    parentId: null,
    agentDefId: 'default',
    goal: 'g',
    status,
    assignedWorkerId: null,
    toolAllowlist: [],
    budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    used: emptyUsed(),
    history: [],
    attachments: [],
    plan: [],
    result: null,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
  })

  describe('task waiters', () => {
    it('saves, lists by task, and deletes a waiter', () => {
      const store = createConversationStore(tmpDb())
      store.saveTaskWaiter({
        id: 'w1',
        sessionId: 'ses-1',
        waiterAddress: 'addr-A',
        taskId: 'task-X',
        goal: 'continue',
        createdAt: 1,
      })
      expect(store.listTaskWaitersForTask('task-X').map((w) => w.id)).toEqual(['w1'])
      expect(store.listAllTaskWaiters()).toHaveLength(1)
      store.deleteTaskWaiter('w1')
      expect(store.listTaskWaitersForTask('task-X')).toEqual([])
      store.close()
    })

    it('fires the terminal listener only on terminal status', () => {
      const store = createConversationStore(tmpDb())
      store.createSession('ses-1', {
        id: 'anthropic' as const,
        apiStyle: 'anthropic' as const,
        model: 'm',
        apiKey: 'k',
      })
      store.saveTask(mkTask('task-X', 'running'), 'ses-1')
      const fired: Array<[string, string]> = []
      store.setTaskTerminalListener((taskId, status) => fired.push([taskId, status]))

      store.updateTaskStatus('task-X', 'running')
      expect(fired).toEqual([])

      store.updateTaskStatus('task-X', 'completed')
      expect(fired).toEqual([['task-X', 'completed']])
      store.close()
    })

    it('persists waiters across reopen', () => {
      const path = tmpDb()
      const s1 = createConversationStore(path)
      s1.saveTaskWaiter({ id: 'w1', sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: null, createdAt: 1 })
      s1.close()
      const s2 = createConversationStore(path)
      expect(s2.listAllTaskWaiters().map((w) => w.id)).toEqual(['w1'])
      s2.close()
    })
  })

  describe('delegation plan persistence', () => {
    it('round-trips a delegation plan on a task', () => {
      const store = createConversationStore(dbPath)
      const provider = {
        id: 'anthropic' as const,
        apiStyle: 'anthropic' as const,
        model: 'claude-sonnet-4-5',
        apiKey: 'k',
      }
      store.createSession('ses-dlp', provider)
      const task = {
        id: 'task-dlp',
        parentId: null,
        agentDefId: 'default',
        goal: 'g',
        status: 'pending',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 1, calls: 1, wallMs: 1, usdCents: 1 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
        history: [],
        attachments: [],
        plan: [],
        result: null,
        createdAt: 1,
        startedAt: null,
        endedAt: null,
      } as Task
      store.saveTask(task, 'ses-dlp')

      const plan = [
        {
          id: 'd1',
          goal: 'build',
          ownerAgentType: 'engineer',
          dependsOn: [],
        },
        { id: 'd2', goal: 'review', dependsOn: ['d1'] },
      ]
      store.saveTaskDelegationPlan('task-dlp', plan)

      const got = store.getTask('task-dlp')
      expect(got?.delegationPlan).toEqual(plan)
      store.close()
    })
  })
})
