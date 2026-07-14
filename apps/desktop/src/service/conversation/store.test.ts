import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { terminalStatusForMessageEvent } from '@swarm/protocol'
import { SYSTEM_SESSION_ID } from '@swarm/shared'
import Database from 'better-sqlite3'
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
    // Post-4b the tasks table is gone; taskCount is derived from distinct
    // message_id in message_events. Seed one message for ses-b.
    store.appendMessageEvent('ses-b', 'r-b', null, {
      kind: 'message.created',
      sessionId: 'ses-b',
      messageId: 'r-b',
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
      messageId: string,
      used: { tokens: number; calls: number; wallMs: number; usdCents: number; cacheRead: number; cacheWrite: number },
      model: string,
      ts: number
    ) => ({
      kind: 'message.usage' as const,
      sessionId,
      messageId,
      used,
      model,
      ts,
      seq: 1,
    })

    // Two top-level runs in the session.
    store.appendMessageEvent(
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
    store.appendMessageEvent(
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
    // A sub-agent child run emits its own run.usage — post-4a each runner
    // tracks its own cost (the parent's snapshot does NOT include the child),
    // so the child's usage is now COUNTED (pre-4b children were zeroed).
    store.appendMessageEvent(
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
    // A run may emit run.usage multiple times (per-turn snapshots); only the
    // LATEST per run_id contributes — earlier emissions are superseded.
    store.appendMessageEvent(
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

  describe('run events', () => {
    it('appendMessageEvent persists UIEvents and re-reads them with messageId/parentMessageId', () => {
      const store = createConversationStore(dbPath)
      const ev = {
        kind: 'message.progress' as const,
        sessionId: 's1',
        messageId: 'r1',
        event: { kind: 'llm.message' as const, role: 'user' as const, content: 'hi', ts: 1 },
        ts: 1,
        seq: 1,
      }
      store.appendMessageEvent('s1', 'r1', null, ev)
      store.appendMessageEvent('s1', 'r1', null, {
        kind: 'message.complete',
        sessionId: 's1',
        messageId: 'r1',
        summary: 'done',
        ts: 2,
        seq: 2,
      })
      store.appendMessageEvent('s1', 'r2', 'r1', {
        kind: 'message.created',
        sessionId: 's1',
        messageId: 'r2',
        parentMessageId: 'r1',
        ts: 3,
        seq: 3,
      })
      const rows = store.getMessageEvents('s1')
      expect(rows).toHaveLength(3)
      expect(rows.map((r) => r.messageId)).toEqual(['r1', 'r1', 'r2'])
      expect(rows[2].parentMessageId).toBe('r1')
      expect(rows[0].event.kind).toBe('message.progress')
      store.close()
    })

    // Spec §4: the store's boot-scan SQL (getTerminalMessageStatuses) and the
    // renderer's TS reducer (terminalStatusForMessageEvent) are two independent
    // encodings of the SAME event→terminal-status rule; bug ledger #9 is three
    // hand-synced copies drifting apart. Feed the identical event set through
    // both and assert they agree.
    it('classifies terminals identically via terminalStatusForMessageEvent (TS) and a store round-trip (SQL)', () => {
      const store = createConversationStore(dbPath)
      store.createSession('ses-eq', provider)

      const terminalEvents = [
        {
          messageId: 'r-ok',
          event: { kind: 'message.complete', sessionId: 'ses-eq', messageId: 'r-ok', summary: 'done', seq: 1, ts: 1 },
        },
        {
          messageId: 'r-fail',
          event: {
            kind: 'message.error',
            sessionId: 'ses-eq',
            messageId: 'r-fail',
            error: { code: 'boom', message: 'bad', tier: 'fatal' as const },
            seq: 1,
            ts: 1,
          },
        },
        {
          messageId: 'r-cancel',
          event: {
            kind: 'message.error',
            sessionId: 'ses-eq',
            messageId: 'r-cancel',
            error: { code: 'cancelled', message: 'cancelled', tier: 'fatal' as const },
            seq: 1,
            ts: 1,
          },
        },
        {
          // A run.error with NO code field must classify 'failed' on both sides:
          // SQL's json_extract('$.error.code') is NULL (→ ELSE failed) and the
          // TS reducer's code === undefined (→ failed). Guards the code-less path.
          messageId: 'r-nocode',
          event: {
            kind: 'message.error',
            sessionId: 'ses-eq',
            messageId: 'r-nocode',
            error: { message: 'no code here', tier: 'fatal' as const },
            seq: 1,
            ts: 1,
          },
        },
      ] as const

      for (const { messageId, event } of terminalEvents) {
        // The code-less run.error (r-nocode) is intentionally not a valid
        // MessageErrorInfo (no `code`); cast to exercise the malformed/legacy path.
        store.appendMessageEvent('ses-eq', messageId, null, event as never)
      }

      const fromStore = new Map(store.getTerminalMessageStatuses().map((r) => [r.messageId, r.status]))
      for (const { messageId, event } of terminalEvents) {
        const fromTs = terminalStatusForMessageEvent(event)
        expect(fromTs).toBeDefined()
        expect(fromStore.get(messageId)).toBe(fromTs)
      }
      store.close()
    })
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

  it('hard-deletes a session and its run events', () => {
    const store = createConversationStore(dbPath)
    store.createSession('ses-d', provider)
    store.appendMessageEvent('ses-d', 'r-d', null, {
      kind: 'message.created',
      sessionId: 'ses-d',
      messageId: 'r-d',
      ts: 1,
      seq: 1,
    })
    store.deleteSession('ses-d')
    expect(store.getSession('ses-d')).toBeUndefined()
    expect(store.getMessageEvents('ses-d')).toEqual([])
    expect(store.listSessions().some((s) => s.id === 'ses-d')).toBe(false)
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
      prompt: 'summarize inbox',
      createdAt: 1000,
      lastRunAt: null,
    })

    expect(store.listCronJobs().length).toBe(1)
    expect(store.listCronJobsForSession('ses-1')[0].prompt).toBe('summarize inbox')

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
      prompt: 'g',
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
      prompt: 'g',
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
      prompt: 'g',
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
      prompt: 'g',
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
      messageId: string,
      model: string,
      usedVal: ReturnType<typeof used>,
      ts: number
    ) => ({
      kind: 'message.usage' as const,
      sessionId,
      messageId,
      used: usedVal,
      model,
      ts,
      seq: 1,
    })
    const progressEvent = (
      sessionId: string,
      messageId: string,
      inner: import('@swarm/protocol').TaskEvent,
      ts: number
    ) => ({
      kind: 'message.progress' as const,
      sessionId,
      messageId,
      event: inner,
      ts,
      seq: 1,
    })

    store.appendMessageEvent(
      'ses-a',
      't-recent-a',
      null,
      usageEvent('ses-a', 't-recent-a', 'claude-sonnet-4-5', used(1000, 12), now)
    )
    store.appendMessageEvent(
      'ses-b',
      't-recent-b',
      null,
      usageEvent('ses-b', 't-recent-b', 'GLM-5.2', used(500, 0), now - day)
    )
    store.appendMessageEvent(
      'ses-a',
      't-old',
      null,
      usageEvent('ses-a', 't-old', 'claude-sonnet-4-5', used(9999, 99), now - 40 * day)
    )

    // Two assistant/user messages + one non-message (reasoning) on t-recent-a.
    store.appendMessageEvent(
      'ses-a',
      't-recent-a',
      null,
      progressEvent('ses-a', 't-recent-a', { kind: 'llm.message', role: 'assistant', content: 'hi', ts: now }, now)
    )
    store.appendMessageEvent(
      'ses-a',
      't-recent-a',
      null,
      progressEvent('ses-a', 't-recent-a', { kind: 'llm.message', role: 'user', content: 'yo', ts: now }, now)
    )
    store.appendMessageEvent(
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
      prompt: 'g',
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
        prompt: 'g',
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

  it('drops legacy 4a tasks/task_events/conversation_events tables on reopen so deleteSession succeeds', () => {
    // Simulate a pre-4b DB carrying the legacy schema with FK constraints:
    // tasks.session_id REFERENCES sessions(id), task_events.task_id REFERENCES tasks(id).
    // Without the bootstrap DROP, an orphan tasks row would block session deletion.
    const legacy = new Database(dbPath)
    legacy.pragma('foreign_keys = ON')
    legacy.exec(`
      CREATE TABLE sessions (
        id              TEXT PRIMARY KEY,
        created_at      INTEGER NOT NULL,
        last_active_at  INTEGER NOT NULL,
        status          TEXT NOT NULL,
        provider_snapshot TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        goal        TEXT NOT NULL,
        status      TEXT NOT NULL
      );
      CREATE TABLE task_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id  TEXT NOT NULL REFERENCES tasks(id),
        event    TEXT NOT NULL,
        ts       INTEGER NOT NULL
      );
      CREATE TABLE conversation_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event      TEXT NOT NULL,
        ts         INTEGER NOT NULL
      );
    `)
    legacy
      .prepare(
        `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot)
         VALUES (?, ?, ?, 'active', ?)`
      )
      .run('ses-legacy', Date.now(), Date.now(), JSON.stringify(provider))
    legacy
      .prepare(`INSERT INTO tasks (id, session_id, goal, status) VALUES (?, ?, 'g', 'completed')`)
      .run('task-legacy', 'ses-legacy')
    legacy.prepare('INSERT INTO task_events (task_id, event, ts) VALUES (?, ?, ?)').run('task-legacy', '{}', Date.now())
    legacy.close()

    // Reopen via the store — the bootstrap must DROP the legacy tables.
    const store = createConversationStore(dbPath)
    // deleteSession must not throw (orphan tasks rows are gone with the table).
    expect(() => store.deleteSession('ses-legacy')).not.toThrow()
    expect(store.getSession('ses-legacy')).toBeUndefined()
    store.close()

    // Legacy tables must be gone from the schema.
    const inspect = new Database(dbPath)
    const names = inspect
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name IN ('tasks','task_events','conversation_events')`
      )
      .all() as { name: string }[]
    inspect.close()
    expect(names.map((r) => r.name).sort()).toEqual([])
  })
})
