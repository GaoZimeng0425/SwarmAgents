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

  const taskLiteral = (id: string, history: import('@shared/types/task').TaskEvent[] = []) => ({
    id,
    parentId: null,
    agentDefId: 'default',
    goal: 'g',
    status: 'running' as const,
    assignedWorkerId: null,
    toolAllowlist: [] as string[],
    budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    history,
    plan: [],
    result: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
  })

  it('appends events and reconstructs history in insertion order', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
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
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    const legacy: import('@shared/types/task').TaskEvent[] = [
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
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-d', provider)
    store.saveTask(taskLiteral('01HRX0000000000000000000D1'), 'ses-d')
    store.appendTaskEvent('01HRX0000000000000000000D1', { kind: 'reasoning', content: 'a', ts: 1 })
    store.deleteSession('ses-d')
    expect(store.getSessionTasks('ses-d')).toEqual([])
    store.close()
  })

  it('persists and reloads a task plan', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
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
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
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
    store.saveTaskUsage('01HRX0000000000000000000U1', { tokens: 1500, calls: 3, wallMs: 4200, usdCents: 7 }, 200_000)
    const task = store.getSessionTasks('ses-u').find((t) => t.id === '01HRX0000000000000000000U1')
    expect(task?.used).toEqual({ tokens: 1500, calls: 3, wallMs: 4200, usdCents: 7 })
    expect(task?.contextWindow).toBe(200_000)

    // A later call without a window must not wipe the stored one (COALESCE).
    store.saveTaskUsage('01HRX0000000000000000000U1', { tokens: 1600, calls: 4, wallMs: 4300, usdCents: 8 })
    const after = store.getSessionTasks('ses-u').find((t) => t.id === '01HRX0000000000000000000U1')
    expect(after?.contextWindow).toBe(200_000)
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

  it('saves, lists, touches, and deletes cron jobs', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-1', provider)

    store.saveCronJob({
      id: 'job-1',
      sessionId: 'ses-1',
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

  it('cascades cron job deletion when its session is deleted', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-1', provider)
    store.saveCronJob({
      id: 'job-1',
      sessionId: 'ses-1',
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
    const anthropic = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    const glm = { id: 'custom' as const, model: 'GLM-5.2', apiKey: 'k' }
    store.createSession('ses-a', anthropic)
    store.createSession('ses-b', glm)

    const now = Date.now()
    const day = 86_400_000
    const mkTask = (id: string, sessionId: string, tokens: number, usdCents: number, createdAt: number) => {
      store.saveTask(
        {
          id,
          parentId: null,
          agentDefId: 'default',
          goal: 'g',
          status: 'completed',
          assignedWorkerId: null,
          toolAllowlist: [],
          budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
          used: { tokens, calls: 1, wallMs: 1, usdCents },
          history: [],
          attachments: [],
          plan: [],
          result: null,
          createdAt,
          startedAt: createdAt,
          endedAt: createdAt,
        },
        sessionId
      )
    }
    mkTask('t-recent-a', 'ses-a', 1000, 12, now)
    mkTask('t-recent-b', 'ses-b', 500, 0, now - day)
    mkTask('t-old', 'ses-a', 9999, 99, now - 40 * day) // outside 30d

    store.appendTaskEvent('t-recent-a', { kind: 'llm.message', role: 'assistant', content: 'hi', ts: now })
    store.appendTaskEvent('t-recent-a', { kind: 'llm.message', role: 'user', content: 'yo', ts: now })
    store.appendTaskEvent('t-recent-a', { kind: 'reasoning', content: 'think', ts: now }) // not a message

    const stats = store.getUsageStats(30)
    expect(stats.rangeDays).toBe(30)
    expect(stats.totals.tokens).toBe(1500) // old task excluded
    expect(stats.totals.usdCents).toBe(12)
    expect(stats.totals.sessions).toBe(2)
    expect(stats.totals.messages).toBe(2)
    expect(stats.totals.activeDays).toBe(2)
    expect(stats.byModel.map((m) => m.model).sort()).toEqual(['GLM-5.2', 'claude-sonnet-4-5'])
    expect(stats.byModel.find((m) => m.model === 'claude-sonnet-4-5')?.tokens).toBe(1000)
    expect(stats.totals.topModel?.model).toBe('claude-sonnet-4-5')
    expect(stats.totals.currentStreak).toBe(2) // today + yesterday both have tasks
    expect(stats.daily.length).toBe(30)
    expect(stats.heatmap.length).toBe(364)
    // Per-day, per-model rows: claude today (1000), GLM yesterday (500); old task excluded.
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
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
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
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)
    store.saveCronRun({ id: 'r-run', jobId: 'j', sessionId: 'ses-1', taskId: 't', status: 'running', triggeredAt: 1, endedAt: null, error: null })
    store.saveCronRun({ id: 'r-done', jobId: 'j', sessionId: 'ses-1', taskId: 't2', status: 'completed', triggeredAt: 2, endedAt: 3, error: null })

    const running = store.listRunningCronRuns()
    expect(running.map((r) => r.id)).toEqual(['r-run'])
    store.close()
  })

  it('keeps only the latest 100 runs per job', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)
    for (let i = 0; i < 105; i++) {
      store.saveCronRun({ id: `run-${i}`, jobId: 'job-1', sessionId: 'ses-1', taskId: null, status: 'running', triggeredAt: i, endedAt: null, error: null })
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
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)
    store.saveCronJob({ id: 'job-1', sessionId: 'ses-1', name: null, cron: '0 0 * * *', goal: 'g', createdAt: 1, lastRunAt: null })
    store.saveCronRun({ id: 'run-1', jobId: 'job-1', sessionId: 'ses-1', taskId: null, status: 'running', triggeredAt: 1, endedAt: null, error: null })

    store.deleteCronJob('job-1')
    expect(store.listCronRunsForJob('job-1')).toHaveLength(1) // job removal keeps history

    store.deleteSession('ses-1')
    expect(store.listCronRunsForJob('job-1')).toHaveLength(0) // session delete cascades
    store.close()
  })

  it('getTask returns a saved task or undefined', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)
    const now = Date.now()
    store.saveTask(
      {
        id: 'task-1', parentId: null, agentDefId: 'a', goal: 'g', status: 'pending',
        assignedWorkerId: null, toolAllowlist: [], budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 }, history: [], attachments: [],
        result: null, createdAt: now, startedAt: null, endedAt: null,
      },
      'ses-1'
    )
    expect(store.getTask('task-1')?.goal).toBe('g')
    expect(store.getTask('missing')).toBeUndefined()
    store.close()
  })
})
