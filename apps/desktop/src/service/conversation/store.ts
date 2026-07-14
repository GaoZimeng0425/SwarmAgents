import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type { ProviderInjection, UsageStats } from '@swarm/protocol'
import { HEATMAP_DAYS } from '@swarm/protocol'
import { SYSTEM_SESSION_ID } from '@swarm/shared'
import Database from 'better-sqlite3'

import { currentStreak, dayKey, dayKeysEndingAt, rangeCutoffMs, zeroFillDaily } from './usage-stats'

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
  /** The conversation that created this job (where schedule_task ran); null when unknown/legacy. */
  originSessionId: string | null
  name: string | null
  cron: string
  prompt: string
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
  /** Overwrite a session's persisted provider snapshot (e.g. to keep the system session's provider current). */
  updateSessionProvider(id: string, provider: ProviderInjection): void
  updateSessionLastActive(id: string): void
  getInterruptedSessions(): StoredSession[]
  listSessions(): import('@swarm/protocol').SessionSummary[]
  setSessionTitle(id: string, title: string): void
  setSessionPinned(id: string, pinned: boolean): void
  setSessionSettings(id: string, settings: import('@swarm/protocol').SessionSettings): void
  /** Read the persisted composer settings (cwd / permission / execution / agent) for a session. */
  getSessionSettings(id: string): import('@swarm/protocol').SessionSettings | undefined
  reorderSessions(orderedIds: string[]): void
  deleteSession(id: string): void
  saveAgentSnapshot(sessionId: string, messages: AgentMessage[]): void
  getAgentSnapshot(sessionId: string): AgentMessage[]
  /** Persist a message-lifecycle UIEvent on the session message stream. */
  appendMessageEvent(
    sessionId: string,
    messageId: string,
    parentMessageId: string | null,
    event: import('@swarm/protocol').UIEvent
  ): void
  /** Read a session's message events in insertion order. */
  getMessageEvents(sessionId: string): {
    messageId: string
    parentMessageId: string | null
    seq: number
    ts: number
    event: import('@swarm/protocol').UIEvent
  }[]
  /** The last terminal status per messageId across ALL sessions (for registry boot). */
  getTerminalMessageStatuses(): Array<{ messageId: string; status: 'completed' | 'failed' | 'cancelled' }>
  getUsageStats(rangeDays: number): UsageStats
  saveToolState(sessionId: string, key: string, value: unknown): void
  getToolState(sessionId: string, key: string): unknown
  saveCronJob(job: StoredCronJob): void
  listCronJobs(): StoredCronJob[]
  listCronJobsForSession(sessionId: string): StoredCronJob[]
  deleteCronJob(id: string): void
  /** Repoint a job to another session (used to migrate legacy jobs to the system session). */
  reassignCronJob(id: string, sessionId: string, originSessionId?: string | null): void
  touchCronJob(id: string, lastRunAt: number): void
  saveCronRun(run: StoredCronRun): void
  attachCronRunTask(runId: string, taskId: string): void
  finishCronRun(runId: string, outcome: { status: string; error: string | null; endedAt: number }): void
  listCronRunsForJob(jobId: string): StoredCronRun[]
  /** Every persisted run across all jobs, newest first (for the schedule calendar). */
  listAllCronRuns(): StoredCronRun[]
  listRunningCronRuns(): StoredCronRun[]
  close(): void
}

export function createConversationStore(dbPath: string): ConversationStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    -- Drop legacy 4a-era tables if present. Order matters: task_events
    -- references tasks, so it must drop first. IF EXISTS makes this a no-op
    -- on fresh DBs and idempotent on subsequent opens. Old rows are NOT
    -- migrated (history disposable per spec).
    DROP TABLE IF EXISTS task_events;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS conversation_events;
    -- W3: the actor/resident subsystem is removed (spec D1) — the actors,
    -- messages, and task_waiters tables (and their data) are dropped.
    DROP TABLE IF EXISTS task_waiters;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS actors;

    -- Tracks which versioned migrations (below) have already run, so a
    -- crash-and-retry or a later reopen never re-applies one.
    CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      created_at      INTEGER NOT NULL,
      last_active_at  INTEGER NOT NULL,
      status          TEXT NOT NULL,
      provider_snapshot TEXT NOT NULL,
      title             TEXT,
      agent_snapshot    TEXT NOT NULL DEFAULT '[]',
      pinned            INTEGER NOT NULL DEFAULT 0,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      cwd               TEXT,
      permission_mode   TEXT,
      execution_mode    TEXT,
      agent_type        TEXT
    );
    CREATE TABLE IF NOT EXISTS message_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id         TEXT NOT NULL,
      message_id         TEXT NOT NULL,
      parent_message_id  TEXT,
      seq                INTEGER NOT NULL,
      ts                 INTEGER NOT NULL,
      event              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_events_session ON message_events(session_id, id);
    CREATE TABLE IF NOT EXISTS tool_state_snapshots (
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (session_id, key)
    );
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id),
      origin_session_id TEXT,
      name              TEXT,
      cron              TEXT NOT NULL,
      prompt            TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      last_run_at       INTEGER
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
  `)

  // cron_jobs.goal → cron_jobs.prompt. Guarded by column presence (not
  // schema_meta): fresh DBs already create the table with `prompt` above, so
  // the rename only fires on a pre-rename DB and is a no-op ever after.
  const cronCols = db.prepare('PRAGMA table_info(cron_jobs)').all() as Array<{ name: string }>
  if (cronCols.some((c) => c.name === 'goal')) {
    db.exec('ALTER TABLE cron_jobs RENAME COLUMN goal TO prompt')
  }

  // ---- Migration v2: task.* → run.* single-vocabulary switchover ----------
  // Guarded by schema_meta.version so it runs exactly once across the DB's
  // lifetime; runs inside ONE transaction so a crash mid-migration rolls back
  // to the pre-migration state instead of leaving run_events half-rewritten.
  // Fresh-DB guard: v2-v4 reference run_events (renamed to message_events in
  // v5). On a fresh DB only message_events exists, so these migrations would
  // crash on "no such table: run_events". If run_events is absent, skip
  // straight to the current version — there is nothing to migrate.
  const hasRunEvents =
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_events'").get() !== undefined
  const schemaMetaRow = db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined
  if ((schemaMetaRow?.version ?? 0) < 2) {
    if (!hasRunEvents) {
      // Fresh DB — no legacy data to migrate. Stamp the latest version so v2-v5
      // are all skipped on this and subsequent opens.
      const latestVersion = 6
      if (schemaMetaRow) db.prepare('UPDATE schema_meta SET version = ?').run(latestVersion)
      else db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(latestVersion)
    } else {
      const migrateToV2 = db.transaction(() => {
        // 1. Orphan sweep: sessions deleted while runs were in flight, pre-guard
        // (deleteSession's in-memory cutoff didn't exist yet on old builds).
        db.exec('DELETE FROM run_events WHERE session_id NOT IN (SELECT id FROM sessions)')
        // 2. task.handoff.completed rows are redundant linkage — the run's own
        // terminal event plus parentRunId already carry the same information.
        db.exec(`DELETE FROM run_events WHERE json_extract(event, '$.kind') = 'task.handoff.completed'`)
        // 3. Kind renames. handoff.spawned MUST be rewritten first: its payload
        // shape (parentTaskId/childTaskId, no taskId) differs from the generic
        // task.<rest> pattern, and once renamed to run.spawned it no longer
        // matches the LIKE below — renaming it after the generic sweep would
        // instead (wrongly) produce run.handoff.spawned.
        db.exec(
          `UPDATE run_events SET event = json_set(event, '$.kind', 'run.spawned') WHERE json_extract(event, '$.kind') = 'task.handoff.spawned'`
        )
        db.exec(
          `UPDATE run_events SET event = json_set(event, '$.kind', 'run.' || substr(json_extract(event, '$.kind'), 6)) WHERE json_extract(event, '$.kind') LIKE 'task.%'`
        )
        // 4. Key renames + workerId drop. json_set would otherwise write an
        // explicit null when the source key is absent, so each rewrite is
        // guarded by a WHERE on the old key's presence.
        db.exec(
          `UPDATE run_events SET event = json_remove(json_set(event, '$.runId', json_extract(event, '$.taskId')), '$.taskId') WHERE json_extract(event, '$.taskId') IS NOT NULL`
        )
        db.exec(
          `UPDATE run_events SET event = json_remove(json_set(event, '$.parentRunId', json_extract(event, '$.parentTaskId')), '$.parentTaskId') WHERE json_extract(event, '$.parentTaskId') IS NOT NULL`
        )
        db.exec(
          `UPDATE run_events SET event = json_remove(json_set(event, '$.childRunId', json_extract(event, '$.childTaskId')), '$.childTaskId') WHERE json_extract(event, '$.childTaskId') IS NOT NULL`
        )
        db.exec(
          `UPDATE run_events SET event = json_remove(event, '$.workerId') WHERE json_extract(event, '$.workerId') IS NOT NULL`
        )
        // Version write inside the SAME transaction: if anything above throws,
        // the whole migration (including this) rolls back, so a retry on next
        // open is safe and won't skip a half-applied rewrite.
        if (schemaMetaRow) db.prepare('UPDATE schema_meta SET version = 2').run()
        else db.prepare('INSERT INTO schema_meta (version) VALUES (2)').run()
      })
      migrateToV2()
    }
  }

  // ---- Migration v3: run.created `goal` key → `prompt` --------------------
  // Part of retiring the goal vocabulary; run.created is the only wire event
  // with a top-level goal key. Same guard/transaction shape as v2.
  const versionRowV3 = db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined
  if ((versionRowV3?.version ?? 0) < 3) {
    const migrateToV3 = db.transaction(() => {
      db.exec(
        `UPDATE run_events SET event = json_remove(json_set(event, '$.prompt', json_extract(event, '$.goal')), '$.goal') WHERE json_extract(event, '$.goal') IS NOT NULL`
      )
      if (versionRowV3) db.prepare('UPDATE schema_meta SET version = 3').run()
      else db.prepare('INSERT INTO schema_meta (version) VALUES (3)').run()
    })
    migrateToV3()
  }

  // ---- Migration v4: delegation-plan items `goal` → `prompt` --------------
  // run.delegation_plan payloads carry a nested plan array; SQLite json_set
  // can't rewrite a key inside every array element, so this one loops in JS.
  const versionRowV4 = db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined
  if ((versionRowV4?.version ?? 0) < 4) {
    const migrateToV4 = db.transaction(() => {
      const rows = db
        .prepare(`SELECT id, event FROM run_events WHERE json_extract(event, '$.kind') = 'run.delegation_plan'`)
        .all() as Array<{ id: number; event: string }>
      const update = db.prepare('UPDATE run_events SET event = ? WHERE id = ?')
      for (const r of rows) {
        const e = JSON.parse(r.event) as { plan?: Array<Record<string, unknown>> }
        if (!Array.isArray(e.plan)) continue
        let changed = false
        for (const item of e.plan) {
          if ('goal' in item) {
            item.prompt = item.goal
            delete item.goal
            changed = true
          }
        }
        if (changed) update.run(JSON.stringify(e), r.id)
      }
      if (versionRowV4) db.prepare('UPDATE schema_meta SET version = 4').run()
      else db.prepare('INSERT INTO schema_meta (version) VALUES (4)').run()
    })
    migrateToV4()
  }

  // ---- Migration v5: run.* → message.* single-vocabulary switchover ---------
  // Renames the table + columns and rewrites the JSON event kind and the
  // identity keys (runId/parentRunId/childRunId). On a fresh DB the table is
  // already message_events (CREATE TABLE above), so this migration is guarded
  // by schema_meta.version and only fires on a DB last opened at v4. The v2-v4
  // migrations above still reference run_events — on an old DB that table IS
  // run_events until v5 renames it; on a fresh DB they're skipped (version jumps
  // straight to 5), so they never touch the absent run_events. Same
  // guard/transaction shape as v2-v4: one tx, version written last.
  const versionRowV5 = db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined
  if ((versionRowV5?.version ?? 0) < 5) {
    const migrateToV5 = db.transaction(() => {
      // 1. Table + column renames. On a v4 DB, run_events holds the real data
      // and message_events is an empty placeholder created by CREATE TABLE IF
      // NOT EXISTS above — drop the placeholder before renaming, otherwise
      // RENAME fails with "there is already another table or index with this
      // name: message_events". Safe: the placeholder has zero rows (all writes
      // went to run_events while version < 5).
      const hasRunEvents = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_events'")
        .get() as { name: string } | undefined
      if (hasRunEvents) {
        db.exec('DROP TABLE IF EXISTS message_events')
        db.exec('ALTER TABLE run_events RENAME TO message_events')
      }
      db.exec('ALTER TABLE message_events RENAME COLUMN run_id TO message_id')
      db.exec('ALTER TABLE message_events RENAME COLUMN parent_run_id TO parent_message_id')
      // 2. Index swap (drop old, create new) — the old index follows the old
      // table name, so it must be dropped under its original name.
      db.exec('DROP INDEX IF EXISTS idx_run_events_session')
      db.exec('CREATE INDEX IF NOT EXISTS idx_message_events_session ON message_events(session_id, id)')
      // 3. Kind rewrite: run.<rest> → message.<rest> (substr skips the 'run.'
      //    prefix at offset 5 and replaces it with 'message.').
      db.exec(
        `UPDATE message_events SET event = json_set(event, '$.kind', 'message.' || substr(json_extract(event, '$.kind'), 5)) WHERE json_extract(event, '$.kind') LIKE 'run.%'`
      )
      // 4. Identity-key renames. json_set would otherwise write an explicit
      //    null when the source key is absent, so each rewrite is guarded by a
      //    WHERE on the old key's presence (same pattern as v2).
      db.exec(
        `UPDATE message_events SET event = json_remove(json_set(event, '$.messageId', json_extract(event, '$.runId')), '$.runId') WHERE json_extract(event, '$.runId') IS NOT NULL`
      )
      db.exec(
        `UPDATE message_events SET event = json_remove(json_set(event, '$.parentMessageId', json_extract(event, '$.parentRunId')), '$.parentRunId') WHERE json_extract(event, '$.parentRunId') IS NOT NULL`
      )
      db.exec(
        `UPDATE message_events SET event = json_remove(json_set(event, '$.childMessageId', json_extract(event, '$.childRunId')), '$.childRunId') WHERE json_extract(event, '$.childRunId') IS NOT NULL`
      )
      if (versionRowV5) db.prepare('UPDATE schema_meta SET version = 5').run()
      else db.prepare('INSERT INTO schema_meta (version) VALUES (5)').run()
    })
    migrateToV5()
  }

  // ---- Migration v6: message.created.prompt → message.progress (role:user) -
  // The user-facing prompt is no longer a field on message.created (which is
  // now identity-only); it lives as a role:'user' llm.message progress event,
  // the sole source of the message's input content. For each legacy created
  // row that still carries a `prompt` key, synthesize a matching progress row
  // at seq = max(seq)+1 for that session, then strip the key from created.
  const versionRowV6 = db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined
  if ((versionRowV6?.version ?? 0) < 6) {
    const migrateToV6 = db.transaction(() => {
      const legacy = db
        .prepare(
          `SELECT id, session_id, message_id, parent_message_id, seq, ts, event
           FROM message_events
           WHERE json_extract(event, '$.kind') = 'message.created'
             AND json_extract(event, '$.prompt') IS NOT NULL`
        )
        .all() as Array<{
        id: number
        session_id: string
        message_id: string
        parent_message_id: string | null
        seq: number
        ts: number
        event: string
      }>
      const insertProgress = db.prepare(
        'INSERT INTO message_events (session_id, message_id, parent_message_id, seq, ts, event) VALUES (?, ?, ?, ?, ?, ?)'
      )
      const stripPrompt = db.prepare(`UPDATE message_events SET event = json_remove(event, '$.prompt') WHERE id = ?`)
      for (const row of legacy) {
        const prompt = JSON.parse(row.event).prompt as string
        // Next seq for this session: one past the current max.
        const maxSeq = (
          db
            .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM message_events WHERE session_id = ?')
            .get(row.session_id) as { m: number }
        ).m
        const progressEvent = JSON.stringify({
          kind: 'message.progress',
          sessionId: row.session_id,
          messageId: row.message_id,
          ...(row.parent_message_id ? { parentMessageId: row.parent_message_id } : {}),
          seq: maxSeq + 1,
          ts: row.ts,
          event: { kind: 'llm.message', role: 'user', content: prompt, ts: row.ts, seq: maxSeq + 1 },
        })
        insertProgress.run(row.session_id, row.message_id, row.parent_message_id, maxSeq + 1, row.ts, progressEvent)
        stripPrompt.run(row.id)
      }
      if (versionRowV6) db.prepare('UPDATE schema_meta SET version = 6').run()
      else db.prepare('INSERT INTO schema_meta (version) VALUES (6)').run()
    })
    migrateToV6()
  }

  for (const stmt of [
    'ALTER TABLE sessions ADD COLUMN title TEXT',
    `ALTER TABLE sessions ADD COLUMN agent_snapshot TEXT NOT NULL DEFAULT '[]'`,
    'ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN cwd TEXT',
    'ALTER TABLE sessions ADD COLUMN permission_mode TEXT',
    'ALTER TABLE sessions ADD COLUMN execution_mode TEXT',
    'ALTER TABLE sessions ADD COLUMN agent_type TEXT',
    'ALTER TABLE cron_jobs ADD COLUMN origin_session_id TEXT',
  ]) {
    try {
      db.exec(stmt)
    } catch {
      // Column already exists — fresh DBs get it from CREATE TABLE above.
    }
  }

  // The execution mode VALUE 'goal' was renamed to 'direct'. Runs after the
  // ALTER loop so legacy DBs have the column; a plain UPDATE is idempotent,
  // so no version guard is needed.
  db.exec(`UPDATE sessions SET execution_mode = 'direct' WHERE execution_mode = 'goal'`)

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

  const rowToCronJob = (row: Record<string, unknown>): StoredCronJob => ({
    id: row.id as string,
    sessionId: row.session_id as string,
    originSessionId: (row.origin_session_id as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    cron: row.cron as string,
    prompt: row.prompt as string,
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
    `INSERT OR REPLACE INTO cron_jobs (id, session_id, origin_session_id, name, cron, prompt, created_at, last_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const stmtListCronJobs = db.prepare('SELECT * FROM cron_jobs')
  const stmtListCronJobsForSession = db.prepare('SELECT * FROM cron_jobs WHERE session_id = ?')
  const stmtDeleteCronJob = db.prepare('DELETE FROM cron_jobs WHERE id = ?')
  // Repoint to a new owning session; record where it was created only if not
  // already known (COALESCE keeps a previously-captured origin).
  const stmtReassignCronJob = db.prepare(
    'UPDATE cron_jobs SET session_id = ?, origin_session_id = COALESCE(origin_session_id, ?) WHERE id = ?'
  )
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
  const stmtListAllCronRuns = db.prepare('SELECT * FROM cron_runs ORDER BY triggered_at DESC')
  const stmtListRunningCronRuns = db.prepare("SELECT * FROM cron_runs WHERE status = 'running'")

  const stmtInsertSession = db.prepare(
    `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot, title, agent_snapshot, sort_order)
     VALUES (?, ?, ?, 'active', ?, NULL, '[]',
       COALESCE((SELECT MIN(sort_order) FROM sessions), 0) - 1)`
  )
  const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const stmtUpdateStatus = db.prepare('UPDATE sessions SET status = ? WHERE id = ?')
  const stmtUpdateProvider = db.prepare('UPDATE sessions SET provider_snapshot = ? WHERE id = ?')
  const stmtUpdateLastActive = db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?')

  // On reopen, mark every session left 'active' by a crashed process as
  // 'interrupted' (matches the pre-4b session-status side of markAndGetInterrupted;
  // the tasks-side cleanup is gone now that the tasks table is dropped — orphaned
  // runs are settled by markInterruptedRunsTerminal in the manager, not here).
  const markAndGetInterrupted = db.transaction((): StoredSession[] => {
    const active = db.prepare(`SELECT * FROM sessions WHERE status = 'active'`).all() as Record<string, unknown>[]
    db.prepare(`UPDATE sessions SET status = 'interrupted' WHERE status = 'active'`).run()
    return active.map(rowToSession).map((s) => ({ ...s, status: 'interrupted' as const }))
  })

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
  const stmtInsertMessageEvent = db.prepare(
    'INSERT INTO message_events (session_id, message_id, parent_message_id, seq, ts, event) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const stmtGetMessageEvents = db.prepare(
    'SELECT message_id AS messageId, parent_message_id AS parentMessageId, seq, ts, event FROM message_events WHERE session_id = ? ORDER BY id'
  )
  // Last terminal event per messageId across all sessions — boots the session
  // manager's terminal registry at construction (one scan of message_events).
  const stmtGetTerminalMessageStatuses = db.prepare(
    `SELECT message_id AS messageId,
       CASE
         WHEN json_extract(event, '$.kind') = 'message.complete' THEN 'completed'
         WHEN json_extract(event, '$.error.code') = 'cancelled' THEN 'cancelled'
         ELSE 'failed'
       END AS status
     FROM message_events
     WHERE id IN (SELECT MAX(id) FROM message_events
                   WHERE json_extract(event, '$.kind') IN ('message.complete', 'message.error')
                   GROUP BY message_id)`
  )

  const stmtListSessions = db.prepare(
    // tokensUsed / usdCents sum the LATEST message.usage per message_id in the session
    // (each message emits usage at every turn boundary; the last is the final
    // snapshot). contextTokens / contextWindow come from the latest TOP-LEVEL
    // message's usage event (sub-agent messages don't carry meaningful context
    // for the composer ring). Post-W5 the store holds ONLY message.* kinds.
    `WITH latest_usage AS (
        SELECT session_id, message_id,
               json_extract(event, '$.used.tokens')   AS tokens,
               json_extract(event, '$.used.usdCents') AS usdCents,
               json_extract(event, '$.contextTokens') AS contextTokens,
               json_extract(event, '$.contextWindow') AS contextWindow
          FROM message_events
         WHERE json_extract(event, '$.kind') = 'message.usage'
           AND id IN (SELECT MAX(id) FROM message_events
                       WHERE json_extract(event, '$.kind') = 'message.usage'
                       GROUP BY message_id)
     )
     SELECT s.id, s.title, s.status, s.pinned, s.sort_order AS sortOrder, s.last_active_at AS lastActiveAt,
            s.cwd, s.permission_mode AS permissionMode, s.execution_mode AS executionMode,
            s.agent_type AS agentType,
            (SELECT COUNT(DISTINCT message_id) FROM message_events re WHERE re.session_id = s.id) AS taskCount,
            COALESCE((SELECT SUM(lu.tokens)   FROM latest_usage lu WHERE lu.session_id = s.id), 0) AS tokensUsed,
            COALESCE((SELECT SUM(lu.usdCents) FROM latest_usage lu WHERE lu.session_id = s.id), 0) AS usdCents,
            (SELECT lu.contextTokens FROM latest_usage lu
              JOIN message_events me ON me.message_id = lu.message_id
             WHERE lu.session_id = s.id AND me.parent_message_id IS NULL
             ORDER BY me.id DESC LIMIT 1) AS contextTokens,
            (SELECT lu.contextWindow FROM latest_usage lu
              JOIN message_events me ON me.message_id = lu.message_id
             WHERE lu.session_id = s.id AND me.parent_message_id IS NULL
             ORDER BY me.id DESC LIMIT 1) AS contextWindow
       FROM sessions s
      WHERE s.status != 'ended'
      ORDER BY s.pinned DESC, s.sort_order ASC`
  )
  const stmtSetSessionSettings = db.prepare(
    'UPDATE sessions SET cwd = ?, permission_mode = ?, execution_mode = ?, agent_type = ? WHERE id = ?'
  )
  const stmtGetSessionSettings = db.prepare(
    `SELECT cwd, permission_mode AS permissionMode, execution_mode AS executionMode,
            agent_type AS agentType
     FROM sessions WHERE id = ?`
  )

  // Hard-delete a session and everything that references it (FK constraints
  // forbid orphaning tool-state rows).
  const deleteSessionTx = db.transaction((id: string) => {
    db.prepare('DELETE FROM cron_runs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM cron_jobs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM tool_state_snapshots WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM message_events WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  })

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
    updateSessionProvider(id, provider) {
      stmtUpdateProvider.run(JSON.stringify(provider), id)
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
        isSystem: (r.id as string) === SYSTEM_SESSION_ID,
        cwd: (r.cwd as string | null) ?? undefined,
        permissionMode: (r.permissionMode as 'ask' | 'full' | null) ?? undefined,
        executionMode: (r.executionMode as 'direct' | 'plan' | null) ?? undefined,
        agentType: (r.agentType as string | null) ?? undefined,
        tokensUsed: r.tokensUsed as number,
        usdCents: r.usdCents as number,
      }))
    },
    setSessionSettings(id, settings) {
      stmtSetSessionSettings.run(
        settings.cwd ?? null,
        settings.permissionMode ?? null,
        settings.executionMode ?? null,
        settings.agentType ?? null,
        id
      )
    },
    getSessionSettings(id) {
      const r = stmtGetSessionSettings.get(id) as Record<string, unknown> | undefined
      if (!r) return undefined
      return {
        cwd: (r.cwd as string | null) ?? undefined,
        permissionMode: (r.permissionMode as 'ask' | 'full' | null) ?? undefined,
        executionMode: (r.executionMode as 'direct' | 'plan' | null) ?? undefined,
        agentType: (r.agentType as string | null) ?? undefined,
      }
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
      // The system session owns all global cron jobs; never delete it (and so
      // never cascade-delete its jobs) even if something asks.
      if (id === SYSTEM_SESSION_ID) return
      deleteSessionTx(id)
    },
    saveAgentSnapshot(sessionId, messages) {
      stmtSetSnapshot.run(JSON.stringify(messages), sessionId)
    },
    getAgentSnapshot(sessionId) {
      const row = stmtGetSnapshot.get(sessionId) as { agent_snapshot: string } | undefined
      return row ? (JSON.parse(row.agent_snapshot) as AgentMessage[]) : []
    },
    appendMessageEvent(sessionId, messageId, parentMessageId, event) {
      // seq is stamped upstream by makeMessageEmit; fall back to 0 if absent.
      const seq = typeof (event as { seq?: number }).seq === 'number' ? (event as { seq: number }).seq : 0
      stmtInsertMessageEvent.run(
        sessionId,
        messageId,
        parentMessageId,
        seq,
        event.ts ?? Date.now(),
        JSON.stringify(event)
      )
    },
    getMessageEvents(sessionId) {
      return (
        stmtGetMessageEvents.all(sessionId) as {
          messageId: string
          parentMessageId: string | null
          seq: number
          ts: number
          event: string
        }[]
      ).map((r) => ({
        messageId: r.messageId,
        parentMessageId: r.parentMessageId,
        seq: r.seq,
        ts: r.ts,
        event: JSON.parse(r.event) as import('@swarm/protocol').UIEvent,
      }))
    },
    getTerminalMessageStatuses() {
      return stmtGetTerminalMessageStatuses.all() as Array<{
        messageId: string
        status: 'completed' | 'failed' | 'cancelled'
      }>
    },
    getUsageStats(rangeDays) {
      const t0 = Date.now()
      const range: 7 | 30 = rangeDays === 7 ? 7 : 30
      log.info({ msg: 'getUsageStats', rangeDays: range })
      try {
        const now = new Date()
        const cutoff = rangeCutoffMs(now, range)
        const heatmapCutoff = rangeCutoffMs(now, HEATMAP_DAYS)

        // Latest message.usage per message_id across all time (no range filter — we
        // slice by ts in JS). Post-W5 the store holds ONLY message.* kinds, so
        // this is the single source of truth for both work messages and
        // conversation turns (both emit message.usage via makeMessageEmit).
        // Sub-agent messages emit their own usage (the parent's snapshot does NOT
        // include child cost), so every message_id — top-level, conversation, and
        // sub-agent — contributes.
        const usageRows = db
          .prepare(
            `SELECT json_extract(re.event, '$.used.tokens')    AS tokens,
                    json_extract(re.event, '$.used.cacheRead') AS cacheRead,
                    json_extract(re.event, '$.used.usdCents')  AS usdCents,
                    json_extract(re.event, '$.model')          AS model,
                    re.session_id                               AS sessionId,
                    re.ts                                        AS ts
               FROM message_events re
              WHERE json_extract(re.event, '$.kind') = 'message.usage'
                AND re.id IN (SELECT MAX(id) FROM message_events
                               WHERE json_extract(event, '$.kind') = 'message.usage'
                               GROUP BY message_id)`
          )
          .all() as Array<{
          tokens: number
          cacheRead: number
          usdCents: number
          model: string | null
          sessionId: string
          ts: number
        }>

        // Messages: one unified count over message_events. Work + conversation
        // both surface as message.progress wrapping an llm.message inner event.
        const messagesRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM message_events
              WHERE ts >= ? AND json_extract(event, '$.kind') = 'message.progress'
                AND json_extract(event, '$.event.kind') = 'llm.message'`
          )
          .get(cutoff) as { n: number }

        // Active days (any message_events message.usage, all time) for currentStreak.
        const activeDateRows = db
          .prepare(
            `SELECT DISTINCT date(ts/1000, 'unixepoch', 'localtime') AS date
               FROM message_events
              WHERE json_extract(event, '$.kind') = 'message.usage'`
          )
          .all() as { date: string }[]
        const activeKeys = new Set(activeDateRows.map((r) => r.date))

        const inRange = usageRows.filter((r) => r.ts >= cutoff)
        const inHeatmap = usageRows.filter((r) => r.ts >= heatmapCutoff)

        const totalTokens = inRange.reduce((s, r) => s + (r.tokens ?? 0), 0)
        const totalCacheRead = inRange.reduce((s, r) => s + (r.cacheRead ?? 0), 0)
        const totalUsd = inRange.reduce((s, r) => s + (r.usdCents ?? 0), 0)

        // byModel: group inRange rows by message.usage.model (fallback 'unknown'); tokens > 0 only.
        const byModelMap = new Map<string, { tokens: number; usdCents: number }>()
        for (const r of inRange) {
          const key = r.model ?? 'unknown'
          const acc = byModelMap.get(key) ?? { tokens: 0, usdCents: 0 }
          acc.tokens += r.tokens ?? 0
          acc.usdCents += r.usdCents ?? 0
          byModelMap.set(key, acc)
        }
        const byModel = [...byModelMap.entries()]
          .map(([model, v]) => ({
            model,
            tokens: v.tokens,
            usdCents: v.usdCents,
            pct: totalTokens > 0 ? Math.round((v.tokens / totalTokens) * 1000) / 10 : 0,
          }))
          .filter((m) => m.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)

        // Per-day token totals across the heatmap range; pivoted into daily
        // (range slice) and heatmap (full 364d) below.
        const dailyMap = new Map<string, number>()
        for (const r of inHeatmap) {
          const key = dayKey(new Date(r.ts))
          dailyMap.set(key, (dailyMap.get(key) ?? 0) + (r.tokens ?? 0))
        }
        const dailyBuckets = [...dailyMap.entries()].map(([date, tokens]) => ({ date, tokens }))

        // Sparse per-day, per-model over the range; renderer pivots into a
        // multi-line "tokens by model" trend.
        const dailyModelMap = new Map<string, { date: string; model: string; tokens: number }>()
        for (const r of inRange) {
          const date = dayKey(new Date(r.ts))
          const model = r.model ?? 'unknown'
          const key = `${date}|${model}`
          const acc = dailyModelMap.get(key) ?? { date, model, tokens: 0 }
          acc.tokens += r.tokens ?? 0
          dailyModelMap.set(key, acc)
        }
        const dailyByModel = [...dailyModelMap.values()].filter((r) => r.tokens > 0)

        const rangeKeys = dayKeysEndingAt(now, range)
        const rangeKeySet = new Set(rangeKeys)
        const heatmapKeys = dayKeysEndingAt(now, HEATMAP_DAYS)

        const result: UsageStats = {
          rangeDays: range,
          totals: {
            tokens: totalTokens,
            cacheRead: totalCacheRead,
            usdCents: totalUsd,
            sessions: new Set(inRange.map((r) => r.sessionId)).size,
            messages: messagesRow.n,
            activeDays: new Set(inRange.map((r) => dayKey(new Date(r.ts)))).size,
            currentStreak: currentStreak(activeKeys, now),
            topModel: byModel[0] ?? null,
          },
          daily: zeroFillDaily(
            dailyBuckets.filter((r) => rangeKeySet.has(r.date)),
            rangeKeys
          ),
          dailyByModel,
          byModel,
          heatmap: zeroFillDaily(dailyBuckets, heatmapKeys),
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
        job.originSessionId ?? null,
        job.name ?? null,
        job.cron,
        job.prompt,
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
    reassignCronJob(id, sessionId, originSessionId) {
      stmtReassignCronJob.run(sessionId, originSessionId ?? null, id)
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
    listAllCronRuns() {
      return (stmtListAllCronRuns.all() as Record<string, unknown>[]).map(rowToCronRun)
    },
    listRunningCronRuns() {
      return (stmtListRunningCronRuns.all() as Record<string, unknown>[]).map(rowToCronRun)
    },
    close() {
      db.close()
    },
  }
}
