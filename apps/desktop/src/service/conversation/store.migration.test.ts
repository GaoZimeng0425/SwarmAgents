import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConversationStore } from './store'

const tmpDb = () => join(tmpdir(), `swarm-migration-test-${Date.now()}-${Math.random()}.db`)

// Builds a pre-W4 DB on disk: the post-4b schema (sessions + run_events, no
// schema_meta table) carrying every legacy task.* kind, an orphan row (session
// deleted while its run was in flight), and a workerId payload. This is what
// createConversationStore sees on first open after the W4 upgrade.
const seedLegacyDb = (path: string): void => {
  const raw = new Database(path)
  raw.exec(`
    CREATE TABLE sessions (
      id              TEXT PRIMARY KEY,
      created_at      INTEGER NOT NULL,
      last_active_at  INTEGER NOT NULL,
      status          TEXT NOT NULL,
      provider_snapshot TEXT NOT NULL
    );
    CREATE TABLE run_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      run_id        TEXT NOT NULL,
      parent_run_id TEXT,
      seq           INTEGER NOT NULL,
      ts            INTEGER NOT NULL,
      event         TEXT NOT NULL
    );
  `)
  const provider = JSON.stringify({ id: 'anthropic', apiStyle: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'k' })
  raw
    .prepare(
      `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot) VALUES (?, ?, ?, 'active', ?)`
    )
    .run('ses-1', 1, 1, provider)

  const insert = raw.prepare(
    'INSERT INTO run_events (session_id, run_id, parent_run_id, seq, ts, event) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const row = (
    sessionId: string,
    runId: string,
    parentRunId: string | null,
    seq: number,
    ts: number,
    event: Record<string, unknown>
  ) => insert.run(sessionId, runId, parentRunId, seq, ts, JSON.stringify(event))

  // Every legacy kind, all on run r1 (the ordering below is just fixture
  // convenience — the migration keys off json, not row order).
  row('ses-1', 'r1', null, 1, 1, { kind: 'task.created', sessionId: 'ses-1', taskId: 'r1', goal: 'g', ts: 1, seq: 1 })
  row('ses-1', 'r1', null, 2, 2, {
    kind: 'task.dispatched',
    sessionId: 'ses-1',
    taskId: 'r1',
    workerId: 'w1',
    ts: 2,
    seq: 2,
  })
  row('ses-1', 'r1', null, 3, 3, {
    kind: 'task.progress',
    sessionId: 'ses-1',
    taskId: 'r1',
    event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 3 },
    ts: 3,
    seq: 3,
  })
  row('ses-1', 'r1', null, 4, 4, {
    kind: 'task.complete',
    sessionId: 'ses-1',
    taskId: 'r1',
    summary: 'done',
    ts: 4,
    seq: 4,
  })
  row('ses-1', 'r1', null, 5, 5, {
    kind: 'task.usage',
    sessionId: 'ses-1',
    taskId: 'r1',
    used: { tokens: 10, calls: 1, wallMs: 1, usdCents: 1, cacheRead: 0, cacheWrite: 0 },
    model: 'claude-sonnet-4-5',
    ts: 5,
    seq: 5,
  })
  row('ses-1', 'r1', null, 6, 6, { kind: 'task.plan', sessionId: 'ses-1', taskId: 'r1', todos: [], ts: 6, seq: 6 })
  row('ses-1', 'r1', null, 7, 7, {
    kind: 'task.delegation_plan',
    sessionId: 'ses-1',
    taskId: 'r1',
    plan: [],
    ts: 7,
    seq: 7,
  })
  // handoff.spawned: no taskId at all — only parentTaskId/childTaskId. The
  // storage row's own run_id column is independent of the payload shape.
  row('ses-1', 'r1', null, 8, 8, {
    kind: 'task.handoff.spawned',
    sessionId: 'ses-1',
    parentTaskId: 'r1',
    childTaskId: 'r2',
    ts: 8,
    seq: 8,
  })
  // handoff.completed: must be dropped entirely by the migration.
  row('ses-1', 'r1', null, 9, 9, {
    kind: 'task.handoff.completed',
    sessionId: 'ses-1',
    parentTaskId: 'r1',
    childTaskId: 'r2',
    childSummary: 'ok',
    ts: 9,
    seq: 9,
  })
  // Two more runs to exercise every getTerminalRunStatuses branch post-migration.
  row('ses-1', 'r3', null, 1, 10, {
    kind: 'task.error',
    sessionId: 'ses-1',
    taskId: 'r3',
    error: { code: 'cancelled', message: 'cancelled', tier: 'fatal' },
    ts: 10,
    seq: 1,
  })
  row('ses-1', 'r4', null, 1, 11, {
    kind: 'task.error',
    sessionId: 'ses-1',
    taskId: 'r4',
    error: { code: 'boom', message: 'bad', tier: 'fatal' },
    ts: 11,
    seq: 1,
  })
  // Orphan: session_id references a session row that no longer exists.
  row('ses-gone', 'r-orphan', null, 1, 1, {
    kind: 'task.created',
    sessionId: 'ses-gone',
    taskId: 'r-orphan',
    goal: 'g',
    ts: 1,
    seq: 1,
  })

  raw.close()
}

describe('ConversationStore migration v2 (task.* → run.*)', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDb()
  })
  afterEach(() => {
    try {
      rmSync(dbPath)
    } catch {}
  })

  it('bumps schema_meta to the latest version on first open', () => {
    seedLegacyDb(dbPath)
    const store = createConversationStore(dbPath)
    store.close()

    const inspect = new Database(dbPath)
    const row = inspect.prepare('SELECT version FROM schema_meta').get() as { version: number }
    inspect.close()
    expect(row.version).toBe(3)
  })

  it('renames a legacy cron_jobs.goal column to prompt, keeping the data', () => {
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
        status TEXT NOT NULL, provider_snapshot TEXT NOT NULL
      );
      CREATE TABLE cron_jobs (
        id                TEXT PRIMARY KEY,
        session_id        TEXT NOT NULL REFERENCES sessions(id),
        origin_session_id TEXT,
        name              TEXT,
        cron              TEXT NOT NULL,
        goal              TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        last_run_at       INTEGER
      );
    `)
    raw
      .prepare(
        `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot) VALUES (?, ?, ?, 'active', '{}')`
      )
      .run('ses-1', 1, 1)
    raw
      .prepare(
        `INSERT INTO cron_jobs (id, session_id, name, cron, goal, created_at) VALUES ('job-1', 'ses-1', 'nightly', '0 0 * * *', 'summarize inbox', 1)`
      )
      .run()
    raw.close()

    const store = createConversationStore(dbPath)
    const jobs = store.listCronJobs()
    store.close()

    expect(jobs).toHaveLength(1)
    expect(jobs[0].prompt).toBe('summarize inbox')
  })

  it('migration v3 renames the run.created goal key to prompt', () => {
    seedLegacyDb(dbPath)
    const store = createConversationStore(dbPath)
    const rows = store.getRunEvents('ses-1')
    store.close()

    const created = rows.find((r) => r.event.kind === 'run.created') as { event: Record<string, unknown> } | undefined
    expect(created?.event.prompt).toBe('g')
    expect('goal' in (created?.event ?? {})).toBe(false)
  })

  it('sweeps orphan rows whose session no longer exists', () => {
    seedLegacyDb(dbPath)
    const store = createConversationStore(dbPath)
    expect(store.getRunEvents('ses-gone')).toEqual([])
    store.close()

    const inspect = new Database(dbPath)
    const n = (
      inspect.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE session_id = 'ses-gone'`).get() as { n: number }
    ).n
    inspect.close()
    expect(n).toBe(0)
  })

  it('drops task.handoff.completed rows entirely', () => {
    seedLegacyDb(dbPath)
    const store = createConversationStore(dbPath)
    const rows = store.getRunEvents('ses-1')
    store.close()

    expect(rows.some((r) => (r.event as { kind: string }).kind === 'task.handoff.completed')).toBe(false)
    expect(rows.some((r) => (r.event as { kind: string }).kind === 'run.handoff.completed')).toBe(false)
    // 11 legacy rows seeded for ses-1, minus the 1 dropped handoff.completed.
    expect(rows).toHaveLength(10)
  })

  it('renames every legacy kind to its run.* equivalent, with no task.* survivors', () => {
    seedLegacyDb(dbPath)
    const store = createConversationStore(dbPath)
    const rows = store.getRunEvents('ses-1')
    store.close()

    const kinds = rows.map((r) => r.event.kind).sort()
    expect(kinds).toEqual(
      [
        'run.complete',
        'run.created',
        'run.delegation_plan',
        'run.dispatched',
        'run.error',
        'run.error',
        'run.plan',
        'run.progress',
        'run.spawned',
        'run.usage',
      ].sort()
    )
    expect(kinds.every((k) => k.startsWith('run.'))).toBe(true)
    expect(kinds.some((k) => k.startsWith('task.'))).toBe(false)
  })

  it('renames taskId/parentTaskId/childTaskId keys and drops workerId, leaving no old keys', () => {
    seedLegacyDb(dbPath)
    const store = createConversationStore(dbPath)
    const rows = store.getRunEvents('ses-1')
    store.close()

    for (const r of rows) {
      const raw = r.event as Record<string, unknown>
      expect(raw.taskId).toBeUndefined()
      expect(raw.parentTaskId).toBeUndefined()
      expect(raw.childTaskId).toBeUndefined()
      expect(raw.workerId).toBeUndefined()
    }

    const created = rows.find((r) => r.event.kind === 'run.created') as { event: Record<string, unknown> } | undefined
    expect(created?.event.runId).toBe('r1')

    const spawned = rows.find((r) => r.event.kind === 'run.spawned') as { event: Record<string, unknown> } | undefined
    expect(spawned?.event.parentRunId).toBe('r1')
    expect(spawned?.event.childRunId).toBe('r2')

    const dispatched = rows.find((r) => r.event.kind === 'run.dispatched') as
      | { event: Record<string, unknown> }
      | undefined
    expect(dispatched?.event.runId).toBe('r1')
    expect('workerId' in (dispatched?.event ?? {})).toBe(false)
  })

  it('classifies migrated terminal events correctly via getTerminalRunStatuses', () => {
    seedLegacyDb(dbPath)
    const store = createConversationStore(dbPath)
    const statuses = new Map(store.getTerminalRunStatuses().map((r) => [r.runId, r.status]))
    store.close()

    expect(statuses.get('r1')).toBe('completed')
    expect(statuses.get('r3')).toBe('cancelled')
    expect(statuses.get('r4')).toBe('failed')
  })

  it('is idempotent: a second open leaves version, row count, and content unchanged', () => {
    seedLegacyDb(dbPath)
    const store1 = createConversationStore(dbPath)
    const rowsAfterFirstOpen = store1.getRunEvents('ses-1')
    store1.close()

    const store2 = createConversationStore(dbPath)
    const rowsAfterSecondOpen = store2.getRunEvents('ses-1')
    store2.close()

    const inspect = new Database(dbPath)
    const version = (inspect.prepare('SELECT version FROM schema_meta').get() as { version: number }).version
    const metaRowCount = (inspect.prepare('SELECT COUNT(*) AS n FROM schema_meta').get() as { n: number }).n
    inspect.close()

    expect(version).toBe(3)
    expect(metaRowCount).toBe(1) // no duplicate version row inserted on reopen
    expect(rowsAfterSecondOpen).toEqual(rowsAfterFirstOpen) // no double-rewrite (e.g. no 'run.run.*')
  })
})
