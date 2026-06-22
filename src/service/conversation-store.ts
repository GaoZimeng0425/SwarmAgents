import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type { Actor, ActorMessage } from '@shared/types/actor'
import type { ProviderInjection } from '@shared/types/provider'
import type { Task } from '@shared/types/task'
import type { UsageStats } from '@shared/types/usage'
import { HEATMAP_DAYS } from '@shared/types/usage'
import Database from 'better-sqlite3'

import { currentStreak, dayKeysEndingAt, rangeCutoffMs, zeroFillDaily } from './usage-stats'

const log = createLogger({ process: 'service' }).child({ component: 'conversation-store' })

export type StoredSession = {
  id: string
  createdAt: number
  lastActiveAt: number
  status: 'active' | 'interrupted' | 'ended'
  providerSnapshot: ProviderInjection
  title: string | null
  agentSnapshot: AgentMessage[]
}

export type StoredCronJob = {
  id: string
  sessionId: string
  name: string | null
  cron: string
  goal: string
  createdAt: number
  lastRunAt: number | null
}

export type StoredCronRun = {
  id: string
  jobId: string
  sessionId: string
  taskId: string | null
  status: string
  triggeredAt: number
  endedAt: number | null
  error: string | null
}

export type ConversationStore = {
  createSession(id: string, provider: ProviderInjection): StoredSession
  getSession(id: string): StoredSession | undefined
  updateSessionStatus(id: string, status: StoredSession['status']): void
  updateSessionLastActive(id: string): void
  getInterruptedSessions(): StoredSession[]
  listSessions(): import('@shared/types/ui').SessionSummary[]
  setSessionTitle(id: string, title: string): void
  setSessionPinned(id: string, pinned: boolean): void
  reorderSessions(orderedIds: string[]): void
  deleteSession(id: string): void
  saveAgentSnapshot(sessionId: string, messages: AgentMessage[]): void
  getAgentSnapshot(sessionId: string): AgentMessage[]
  appendTaskEvent(taskId: string, event: import('@shared/types/task').TaskEvent): void
  saveTaskPlan(taskId: string, plan: Task['plan']): void
  saveTask(task: Task, sessionId: string): void
  updateTaskStatus(taskId: string, status: Task['status'], result?: Task['result']): void
  saveTaskUsage(taskId: string, used: Task['used'], contextWindow?: number): void
  getSessionTasks(sessionId: string): Task[]
  getUsageStats(rangeDays: number): UsageStats
  saveToolState(sessionId: string, key: string, value: unknown): void
  getToolState(sessionId: string, key: string): unknown
  saveCronJob(job: StoredCronJob): void
  listCronJobs(): StoredCronJob[]
  listCronJobsForSession(sessionId: string): StoredCronJob[]
  deleteCronJob(id: string): void
  touchCronJob(id: string, lastRunAt: number): void
  saveCronRun(run: StoredCronRun): void
  attachCronRunTask(runId: string, taskId: string): void
  finishCronRun(runId: string, outcome: { status: string; error: string | null; endedAt: number }): void
  listCronRunsForJob(jobId: string): StoredCronRun[]
  listRunningCronRuns(): StoredCronRun[]
  getTask(taskId: string): Task | undefined
  upsertActor(actor: Actor): void
  getActor(address: string): Actor | undefined
  getActorByName(sessionId: string, name: string): Actor | undefined
  enqueueMessage(msg: ActorMessage): void
  nextUnconsumedFor(address: string): ActorMessage | undefined
  allUnconsumedFor(address: string): ActorMessage[]
  listUnconsumedAddresses(): string[]
  markConsumed(id: string): void
  markDead(id: string): void
  bumpRetries(id: string): number
  close(): void
}

export function createConversationStore(dbPath: string): ConversationStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      created_at      INTEGER NOT NULL,
      last_active_at  INTEGER NOT NULL,
      status          TEXT NOT NULL,
      provider_snapshot TEXT NOT NULL,
      title             TEXT,
      agent_snapshot    TEXT NOT NULL DEFAULT '[]',
      pinned            INTEGER NOT NULL DEFAULT 0,
      sort_order        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id                  TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL REFERENCES sessions(id),
      parent_id           TEXT,
      goal                TEXT NOT NULL,
      status              TEXT NOT NULL,
      result              TEXT,
      budget              TEXT NOT NULL,
      used                TEXT NOT NULL,
      agent_def_id        TEXT NOT NULL DEFAULT 'default',
      assigned_worker_id  TEXT,
      tool_allowlist      TEXT NOT NULL DEFAULT '[]',
      history             TEXT NOT NULL DEFAULT '[]',
      attachments         TEXT NOT NULL DEFAULT '[]',
      plan                TEXT NOT NULL DEFAULT '[]',
      context_window      INTEGER,
      created_at          INTEGER NOT NULL,
      started_at          INTEGER,
      ended_at            INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE TABLE IF NOT EXISTS task_events (
      id       INTEGER PRIMARY KEY,
      task_id  TEXT NOT NULL REFERENCES tasks(id),
      event    TEXT NOT NULL,
      ts       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
    CREATE TABLE IF NOT EXISTS tool_state_snapshots (
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (session_id, key)
    );
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES sessions(id),
      name         TEXT,
      cron         TEXT NOT NULL,
      goal         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_run_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_session ON cron_jobs(session_id);
    -- No FK on job_id/session_id: runs survive job deletion (audit history);
    -- session-delete cascade is handled in deleteSessionTx.
    CREATE TABLE IF NOT EXISTS cron_runs (
      id           TEXT PRIMARY KEY,
      job_id       TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      task_id      TEXT,
      status       TEXT NOT NULL,
      triggered_at INTEGER NOT NULL,
      ended_at     INTEGER,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id);
    CREATE TABLE IF NOT EXISTS actors (
      address       TEXT PRIMARY KEY,
      agent_def_id  TEXT NOT NULL,
      session_id    TEXT,
      name          TEXT,
      state         TEXT,
      last_task_id  TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_actors_session_name ON actors(session_id, name);
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      to_addr         TEXT NOT NULL,
      from_addr       TEXT,
      kind            TEXT NOT NULL,
      correlation_id  TEXT,
      payload         TEXT NOT NULL,
      consumed        INTEGER NOT NULL DEFAULT 0,
      retries         INTEGER NOT NULL DEFAULT 0,
      dead            INTEGER NOT NULL DEFAULT 0,
      ts              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_addr, consumed, dead, ts);
  `)

  for (const stmt of [
    'ALTER TABLE sessions ADD COLUMN title TEXT',
    `ALTER TABLE sessions ADD COLUMN agent_snapshot TEXT NOT NULL DEFAULT '[]'`,
    'ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0',
    `ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN plan TEXT NOT NULL DEFAULT '[]'`,
    'ALTER TABLE tasks ADD COLUMN context_window INTEGER',
  ]) {
    try {
      db.exec(stmt)
    } catch {
      // Column already exists — fresh DBs get it from CREATE TABLE above.
    }
  }

  // One-time backfill: give pre-existing rows a sort_order matching the old
  // recency order (newest = smallest). Rows already migrated keep their value.
  try {
    const needsBackfill = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sort_order = 0').get() as { n: number }
    if (needsBackfill.n > 1) {
      const rows = db.prepare('SELECT id FROM sessions ORDER BY last_active_at DESC').all() as { id: string }[]
      const tx = db.transaction(() => {
        for (let i = 0; i < rows.length; i += 1) {
          db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?').run(i, rows[i].id)
        }
      })
      tx()
    }
  } catch (err) {
    log.error({ msg: 'sort_order backfill failed', err: err instanceof Error ? err.message : String(err) })
  }

  const rowToSession = (row: Record<string, unknown>): StoredSession => ({
    id: row.id as string,
    createdAt: row.created_at as number,
    lastActiveAt: row.last_active_at as number,
    status: row.status as StoredSession['status'],
    providerSnapshot: JSON.parse(row.provider_snapshot as string) as ProviderInjection,
    title: (row.title as string | null) ?? null,
    agentSnapshot: JSON.parse((row.agent_snapshot as string) ?? '[]') as AgentMessage[],
  })

  const rowToTask = (row: Record<string, unknown>): Task => ({
    id: row.id as string,
    parentId: (row.parent_id as string | null) ?? null,
    agentDefId: (row.agent_def_id as string) ?? 'default',
    goal: row.goal as string,
    status: row.status as Task['status'],
    assignedWorkerId: (row.assigned_worker_id as string | null) ?? null,
    toolAllowlist: JSON.parse((row.tool_allowlist as string) ?? '[]') as string[],
    budget: JSON.parse(row.budget as string) as Task['budget'],
    used: JSON.parse(row.used as string) as Task['used'],
    history: (stmtGetTaskEvents.all(row.id as string) as { event: string }[]).map((r) =>
      JSON.parse(r.event)
    ) as Task['history'],
    attachments: JSON.parse((row.attachments as string) ?? '[]') as Task['attachments'],
    plan: JSON.parse((row.plan as string) ?? '[]') as Task['plan'],
    result: row.result ? (JSON.parse(row.result as string) as Task['result']) : null,
    createdAt: row.created_at as number,
    startedAt: (row.started_at as number | null) ?? null,
    endedAt: (row.ended_at as number | null) ?? null,
    ...(row.context_window != null ? { contextWindow: row.context_window as number } : {}),
  })

  const rowToCronJob = (row: Record<string, unknown>): StoredCronJob => ({
    id: row.id as string,
    sessionId: row.session_id as string,
    name: (row.name as string | null) ?? null,
    cron: row.cron as string,
    goal: row.goal as string,
    createdAt: row.created_at as number,
    lastRunAt: (row.last_run_at as number | null) ?? null,
  })

  const rowToCronRun = (row: Record<string, unknown>): StoredCronRun => ({
    id: row.id as string,
    jobId: row.job_id as string,
    sessionId: row.session_id as string,
    taskId: (row.task_id as string | null) ?? null,
    status: row.status as string,
    triggeredAt: row.triggered_at as number,
    endedAt: (row.ended_at as number | null) ?? null,
    error: (row.error as string | null) ?? null,
  })

  const stmtInsertCronJob = db.prepare(
    `INSERT OR REPLACE INTO cron_jobs (id, session_id, name, cron, goal, created_at, last_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const stmtListCronJobs = db.prepare('SELECT * FROM cron_jobs')
  const stmtListCronJobsForSession = db.prepare('SELECT * FROM cron_jobs WHERE session_id = ?')
  const stmtDeleteCronJob = db.prepare('DELETE FROM cron_jobs WHERE id = ?')
  const stmtTouchCronJob = db.prepare('UPDATE cron_jobs SET last_run_at = ? WHERE id = ?')

  const stmtInsertCronRun = db.prepare(
    `INSERT INTO cron_runs (id, job_id, session_id, task_id, status, triggered_at, ended_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const stmtPruneCronRuns = db.prepare(
    `DELETE FROM cron_runs WHERE job_id = ? AND id NOT IN (
       SELECT id FROM cron_runs WHERE job_id = ? ORDER BY triggered_at DESC LIMIT 100
     )`
  )
  const stmtAttachCronRunTask = db.prepare('UPDATE cron_runs SET task_id = ? WHERE id = ?')
  const stmtFinishCronRun = db.prepare('UPDATE cron_runs SET status = ?, error = ?, ended_at = ? WHERE id = ?')
  const stmtListCronRunsForJob = db.prepare('SELECT * FROM cron_runs WHERE job_id = ? ORDER BY triggered_at DESC')
  const stmtListRunningCronRuns = db.prepare("SELECT * FROM cron_runs WHERE status = 'running'")
  const stmtGetTask = db.prepare('SELECT * FROM tasks WHERE id = ?')

  const stmtUpsertActor = db.prepare(`
    INSERT INTO actors (address, agent_def_id, session_id, name, state, last_task_id, created_at, updated_at)
    VALUES (@address, @agentDefId, @sessionId, @name, @state, @lastTaskId, @createdAt, @updatedAt)
    ON CONFLICT(address) DO UPDATE SET
      agent_def_id = excluded.agent_def_id, session_id = excluded.session_id, name = excluded.name,
      state = excluded.state, last_task_id = excluded.last_task_id, updated_at = excluded.updated_at
  `)
  const stmtGetActor = db.prepare('SELECT * FROM actors WHERE address = ?')
  const stmtGetActorByName = db.prepare('SELECT * FROM actors WHERE session_id = ? AND name = ?')
  const stmtEnqueueMessage = db.prepare(`
    INSERT INTO messages (id, to_addr, from_addr, kind, correlation_id, payload, consumed, retries, dead, ts)
    VALUES (@id, @toAddr, @fromAddr, @kind, @correlationId, @payload, @consumed, @retries, @dead, @ts)
  `)
  const stmtNextUnconsumed = db.prepare(
    'SELECT * FROM messages WHERE to_addr = ? AND consumed = 0 AND dead = 0 ORDER BY ts ASC LIMIT 1'
  )
  const stmtAllUnconsumedFor = db.prepare(
    'SELECT * FROM messages WHERE to_addr = ? AND consumed = 0 AND dead = 0 ORDER BY ts ASC'
  )
  // Distinct destinations with pending, non-dead messages whose actor still
  // exists — drives crash-recovery re-drain on session-manager init.
  const stmtUnconsumedAddrs = db.prepare(
    `SELECT DISTINCT m.to_addr AS addr FROM messages m
     JOIN actors a ON a.address = m.to_addr
     WHERE m.consumed = 0 AND m.dead = 0`
  )
  const stmtMarkConsumed = db.prepare('UPDATE messages SET consumed = 1 WHERE id = ?')
  const stmtMarkDead = db.prepare('UPDATE messages SET dead = 1 WHERE id = ?')
  const stmtBumpRetries = db.prepare('UPDATE messages SET retries = retries + 1 WHERE id = ?')
  const stmtGetRetries = db.prepare('SELECT retries FROM messages WHERE id = ?')

  type ActorRow = {
    address: string
    agent_def_id: string
    session_id: string | null
    name: string | null
    state: string | null
    last_task_id: string | null
    created_at: number
    updated_at: number
  }
  const rowToActor = (r: ActorRow): Actor => ({
    address: r.address,
    agentDefId: r.agent_def_id,
    sessionId: r.session_id,
    name: r.name,
    state: r.state,
    lastTaskId: r.last_task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })

  type MessageRow = {
    id: string
    to_addr: string
    from_addr: string | null
    kind: string
    correlation_id: string | null
    payload: string
    consumed: number
    retries: number
    dead: number
    ts: number
  }
  const rowToMessage = (r: MessageRow): ActorMessage => ({
    id: r.id,
    toAddr: r.to_addr,
    fromAddr: r.from_addr,
    kind: r.kind as 'send' | 'rpc',
    correlationId: r.correlation_id,
    payload: r.payload,
    consumed: !!r.consumed,
    retries: r.retries,
    dead: !!r.dead,
    ts: r.ts,
  })

  const stmtInsertSession = db.prepare(
    `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot, title, agent_snapshot, sort_order)
     VALUES (?, ?, ?, 'active', ?, NULL, '[]',
       COALESCE((SELECT MIN(sort_order) FROM sessions), 0) - 1)`
  )
  const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const stmtUpdateStatus = db.prepare('UPDATE sessions SET status = ? WHERE id = ?')
  const stmtUpdateLastActive = db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?')

  const markAndGetInterrupted = db.transaction((): StoredSession[] => {
    const active = db.prepare(`SELECT * FROM sessions WHERE status = 'active'`).all() as Record<string, unknown>[]
    db.prepare(`UPDATE sessions SET status = 'interrupted' WHERE status = 'active'`).run()
    return active.map(rowToSession).map((s) => ({ ...s, status: 'interrupted' as const }))
  })

  const stmtInsertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks
     (id, session_id, parent_id, goal, status, result, budget, used,
      agent_def_id, assigned_worker_id, tool_allowlist, history, attachments, plan,
      created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const stmtUpdateTask = db.prepare('UPDATE tasks SET status = ?, result = ?, ended_at = ? WHERE id = ?')
  // COALESCE keeps a previously-stored window when this call has none, so a
  // turn that resolved no window can't wipe a good value.
  const stmtUpdateTaskUsage = db.prepare(
    'UPDATE tasks SET used = ?, context_window = COALESCE(?, context_window) WHERE id = ?'
  )
  const stmtGetTasks = db.prepare('SELECT * FROM tasks WHERE session_id = ?')
  const stmtUpsertToolState = db.prepare(
    `INSERT OR REPLACE INTO tool_state_snapshots (session_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)`
  )
  const stmtGetToolState = db.prepare('SELECT value FROM tool_state_snapshots WHERE session_id = ? AND key = ?')

  const stmtSetTitle = db.prepare('UPDATE sessions SET title = ? WHERE id = ?')
  const stmtSetPinned = db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?')
  const stmtSetSortOrder = db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?')
  const stmtSetSnapshot = db.prepare('UPDATE sessions SET agent_snapshot = ? WHERE id = ?')
  const stmtGetSnapshot = db.prepare('SELECT agent_snapshot FROM sessions WHERE id = ?')
  const stmtInsertTaskEvent = db.prepare('INSERT INTO task_events (task_id, event, ts) VALUES (?, ?, ?)')
  const stmtGetTaskEvents = db.prepare('SELECT event FROM task_events WHERE task_id = ? ORDER BY id')
  const stmtCountTaskEvents = db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?')
  const stmtSetTaskPlan = db.prepare('UPDATE tasks SET plan = ? WHERE id = ?')
  const stmtListSessions = db.prepare(
    `SELECT s.id, s.title, s.status, s.pinned, s.sort_order AS sortOrder, s.last_active_at AS lastActiveAt,
            (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id) AS taskCount
     FROM sessions s
     WHERE s.status != 'ended'
     ORDER BY s.pinned DESC, s.sort_order ASC`
  )

  // Hard-delete a session and everything that references it (FK constraints
  // forbid orphaning tasks / tool-state rows).
  const deleteSessionTx = db.transaction((id: string) => {
    db.prepare('DELETE FROM cron_runs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM cron_jobs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM tool_state_snapshots WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE session_id = ?)').run(id)
    db.prepare('DELETE FROM tasks WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  })

  // One-time migration: carry forward transcripts persisted in the legacy
  // tasks.history column into task_events. Idempotent — skips any task that
  // already has events. New tasks never populate the column, so they're skipped.
  const backfillTaskEvents = db.transaction(() => {
    const rows = db.prepare("SELECT id, history FROM tasks WHERE history IS NOT NULL AND history != '[]'").all() as {
      id: string
      history: string
    }[]
    for (const r of rows) {
      if ((stmtCountTaskEvents.get(r.id) as { n: number }).n > 0) continue
      let events: unknown
      try {
        events = JSON.parse(r.history)
      } catch {
        continue
      }
      if (!Array.isArray(events)) continue
      for (const ev of events) {
        const ts = (ev as { ts?: number }).ts ?? 0
        stmtInsertTaskEvent.run(r.id, JSON.stringify(ev), ts)
      }
    }
  })
  backfillTaskEvents()

  return {
    createSession(id, provider) {
      const now = Date.now()
      stmtInsertSession.run(id, now, now, JSON.stringify(provider))
      return {
        id,
        createdAt: now,
        lastActiveAt: now,
        status: 'active',
        providerSnapshot: provider,
        title: null,
        agentSnapshot: [],
      }
    },
    getSession(id) {
      const row = stmtGetSession.get(id) as Record<string, unknown> | undefined
      return row ? rowToSession(row) : undefined
    },
    updateSessionStatus(id, status) {
      stmtUpdateStatus.run(status, id)
    },
    updateSessionLastActive(id) {
      stmtUpdateLastActive.run(Date.now(), id)
    },
    getInterruptedSessions() {
      return markAndGetInterrupted()
    },
    listSessions() {
      return (stmtListSessions.all() as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        title: (r.title as string | null) ?? null,
        status: r.status as 'active' | 'interrupted' | 'ended',
        lastActiveAt: r.lastActiveAt as number,
        taskCount: r.taskCount as number,
        pinned: Boolean(r.pinned),
        sortOrder: r.sortOrder as number,
      }))
    },
    setSessionTitle(id, title) {
      stmtSetTitle.run(title, id)
    },
    setSessionPinned(id, pinned) {
      stmtSetPinned.run(pinned ? 1 : 0, id)
    },
    reorderSessions(orderedIds) {
      const tx = db.transaction((ids: string[]) => {
        for (let i = 0; i < ids.length; i += 1) {
          stmtSetSortOrder.run(i, ids[i])
        }
      })
      tx(orderedIds)
    },
    deleteSession(id) {
      deleteSessionTx(id)
    },
    saveAgentSnapshot(sessionId, messages) {
      stmtSetSnapshot.run(JSON.stringify(messages), sessionId)
    },
    getAgentSnapshot(sessionId) {
      const row = stmtGetSnapshot.get(sessionId) as { agent_snapshot: string } | undefined
      return row ? (JSON.parse(row.agent_snapshot) as AgentMessage[]) : []
    },
    appendTaskEvent(taskId, event) {
      stmtInsertTaskEvent.run(taskId, JSON.stringify(event), event.ts)
    },
    saveTaskPlan(taskId, plan) {
      stmtSetTaskPlan.run(JSON.stringify(plan), taskId)
    },
    saveTask(task, sessionId) {
      stmtInsertTask.run(
        task.id,
        sessionId,
        task.parentId ?? null,
        task.goal,
        task.status,
        task.result ? JSON.stringify(task.result) : null,
        JSON.stringify(task.budget),
        JSON.stringify(task.used),
        task.agentDefId,
        task.assignedWorkerId ?? null,
        JSON.stringify(task.toolAllowlist),
        JSON.stringify(task.history),
        JSON.stringify(task.attachments ?? []),
        JSON.stringify(task.plan ?? []),
        task.createdAt,
        task.startedAt ?? null,
        task.endedAt ?? null
      )
    },
    updateTaskStatus(taskId, status, result) {
      const terminalStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled'])
      const endedAt = terminalStatuses.has(status) ? Date.now() : null
      stmtUpdateTask.run(status, result ? JSON.stringify(result) : null, endedAt, taskId)
    },
    saveTaskUsage(taskId, used, contextWindow) {
      stmtUpdateTaskUsage.run(JSON.stringify(used), contextWindow ?? null, taskId)
    },
    getSessionTasks(sessionId) {
      return (stmtGetTasks.all(sessionId) as Record<string, unknown>[]).map(rowToTask)
    },
    getUsageStats(rangeDays) {
      const t0 = Date.now()
      const range: 7 | 30 = rangeDays === 7 ? 7 : 30
      log.info({ msg: 'getUsageStats', rangeDays: range })
      try {
        const now = new Date()
        const cutoff = rangeCutoffMs(now, range)
        const heatmapCutoff = rangeCutoffMs(now, HEATMAP_DAYS)

        const totalsRow = db
          .prepare(
            `SELECT
               COALESCE(SUM(json_extract(used, '$.tokens')), 0)     AS tokens,
               COALESCE(SUM(json_extract(used, '$.cacheRead')), 0)  AS cacheRead,
               COALESCE(SUM(json_extract(used, '$.usdCents')), 0)   AS usdCents,
               COUNT(DISTINCT session_id)                           AS sessions,
               COUNT(DISTINCT date(created_at/1000,'unixepoch','localtime')) AS activeDays
             FROM tasks WHERE created_at >= ?`
          )
          .get(cutoff) as { tokens: number; cacheRead: number; usdCents: number; sessions: number; activeDays: number }

        const messagesRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM task_events
             WHERE ts >= ? AND json_extract(event, '$.kind') = 'llm.message'`
          )
          .get(cutoff) as { n: number }

        const modelRows = db
          .prepare(
            `SELECT json_extract(s.provider_snapshot, '$.model') AS model,
                    COALESCE(SUM(json_extract(t.used, '$.tokens')), 0) AS tokens
             FROM tasks t JOIN sessions s ON s.id = t.session_id
             WHERE t.created_at >= ?
             GROUP BY model
             HAVING tokens > 0
             ORDER BY tokens DESC`
          )
          .all(cutoff) as { model: string; tokens: number }[]

        const dailyRows = db
          .prepare(
            `SELECT date(created_at/1000,'unixepoch','localtime') AS date,
                    COALESCE(SUM(json_extract(used, '$.tokens')), 0) AS tokens
             FROM tasks WHERE created_at >= ? GROUP BY date`
          )
          .all(heatmapCutoff) as { date: string; tokens: number }[]

        // Sparse per-day, per-model totals over the range; the renderer pivots
        // these into a multi-line "tokens by model" trend.
        const dailyModelRows = db
          .prepare(
            `SELECT date(t.created_at/1000,'unixepoch','localtime') AS date,
                    json_extract(s.provider_snapshot, '$.model') AS model,
                    COALESCE(SUM(json_extract(t.used, '$.tokens')), 0) AS tokens
             FROM tasks t JOIN sessions s ON s.id = t.session_id
             WHERE t.created_at >= ?
             GROUP BY date, model
             HAVING tokens > 0`
          )
          .all(cutoff) as { date: string; model: string; tokens: number }[]

        const totalTokens = totalsRow.tokens
        const byModel = modelRows.map((r) => ({
          model: r.model ?? 'unknown',
          tokens: r.tokens,
          pct: totalTokens > 0 ? Math.round((r.tokens / totalTokens) * 1000) / 10 : 0,
        }))

        const rangeKeys = dayKeysEndingAt(now, range)
        const rangeKeySet = new Set(rangeKeys)
        const heatmapKeys = dayKeysEndingAt(now, HEATMAP_DAYS)
        const activeDateRows = db
          .prepare(`SELECT DISTINCT date(created_at/1000,'unixepoch','localtime') AS date FROM tasks`)
          .all() as { date: string }[]
        const activeKeys = new Set(activeDateRows.map((r) => r.date))

        const result: UsageStats = {
          rangeDays: range,
          totals: {
            tokens: totalTokens,
            cacheRead: totalsRow.cacheRead,
            usdCents: totalsRow.usdCents,
            sessions: totalsRow.sessions,
            messages: messagesRow.n,
            activeDays: totalsRow.activeDays,
            currentStreak: currentStreak(activeKeys, now),
            topModel: byModel[0] ?? null,
          },
          daily: zeroFillDaily(
            dailyRows.filter((r) => rangeKeySet.has(r.date)),
            rangeKeys
          ),
          dailyByModel: dailyModelRows.map((r) => ({
            date: r.date,
            model: r.model ?? 'unknown',
            tokens: r.tokens,
          })),
          byModel,
          heatmap: zeroFillDaily(dailyRows, heatmapKeys),
        }
        log.info({ msg: 'getUsageStats ok', rangeDays: range, tokens: totalTokens, durationMs: Date.now() - t0 })
        return result
      } catch (err) {
        log.error({
          msg: 'getUsageStats failed',
          rangeDays: range,
          err: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
    saveToolState(sessionId, key, value) {
      stmtUpsertToolState.run(sessionId, key, JSON.stringify(value), Date.now())
    },
    getToolState(sessionId, key) {
      const row = stmtGetToolState.get(sessionId, key) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined
    },
    saveCronJob(job) {
      stmtInsertCronJob.run(
        job.id,
        job.sessionId,
        job.name ?? null,
        job.cron,
        job.goal,
        job.createdAt,
        job.lastRunAt ?? null
      )
    },
    listCronJobs() {
      return (stmtListCronJobs.all() as Record<string, unknown>[]).map(rowToCronJob)
    },
    listCronJobsForSession(sessionId) {
      return (stmtListCronJobsForSession.all(sessionId) as Record<string, unknown>[]).map(rowToCronJob)
    },
    deleteCronJob(id) {
      stmtDeleteCronJob.run(id)
    },
    touchCronJob(id, lastRunAt) {
      stmtTouchCronJob.run(lastRunAt, id)
    },
    saveCronRun(run) {
      stmtInsertCronRun.run(
        run.id,
        run.jobId,
        run.sessionId,
        run.taskId ?? null,
        run.status,
        run.triggeredAt,
        run.endedAt ?? null,
        run.error ?? null
      )
      stmtPruneCronRuns.run(run.jobId, run.jobId)
    },
    attachCronRunTask(runId, taskId) {
      stmtAttachCronRunTask.run(taskId, runId)
    },
    finishCronRun(runId, outcome) {
      stmtFinishCronRun.run(outcome.status, outcome.error ?? null, outcome.endedAt, runId)
    },
    listCronRunsForJob(jobId) {
      return (stmtListCronRunsForJob.all(jobId) as Record<string, unknown>[]).map(rowToCronRun)
    },
    listRunningCronRuns() {
      return (stmtListRunningCronRuns.all() as Record<string, unknown>[]).map(rowToCronRun)
    },
    getTask(taskId) {
      const row = stmtGetTask.get(taskId) as Record<string, unknown> | undefined
      return row ? rowToTask(row) : undefined
    },
    upsertActor(actor) {
      stmtUpsertActor.run(actor)
    },
    getActor(address) {
      const row = stmtGetActor.get(address) as ActorRow | undefined
      return row ? rowToActor(row) : undefined
    },
    getActorByName(sessionId, name) {
      const row = stmtGetActorByName.get(sessionId, name) as ActorRow | undefined
      return row ? rowToActor(row) : undefined
    },
    enqueueMessage(msg) {
      stmtEnqueueMessage.run({ ...msg, consumed: msg.consumed ? 1 : 0, dead: msg.dead ? 1 : 0 })
    },
    nextUnconsumedFor(address) {
      const row = stmtNextUnconsumed.get(address) as MessageRow | undefined
      return row ? rowToMessage(row) : undefined
    },
    allUnconsumedFor(address) {
      return (stmtAllUnconsumedFor.all(address) as MessageRow[]).map(rowToMessage)
    },
    listUnconsumedAddresses() {
      return (stmtUnconsumedAddrs.all() as { addr: string }[]).map((r) => r.addr)
    },
    markConsumed(id) {
      stmtMarkConsumed.run(id)
    },
    markDead(id) {
      stmtMarkDead.run(id)
    },
    bumpRetries(id) {
      stmtBumpRetries.run(id)
      return (stmtGetRetries.get(id) as { retries: number } | undefined)?.retries ?? 0
    },
    close() {
      db.close()
    },
  }
}
