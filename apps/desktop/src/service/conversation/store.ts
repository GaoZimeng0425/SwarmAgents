import { createLogger } from '@shared/logger'
import type { ProviderInjection, UsageStats } from '@swarm/protocol'
import { HEATMAP_DAYS } from '@swarm/protocol'
import { SYSTEM_SESSION_ID } from '@swarm/shared'
import Database from 'better-sqlite3'

import { createEntryStore, type EntryStore, ensureEntriesSchema } from '../session-agent/sqlite-storage'
import { currentStreak, dayKey, dayKeysEndingAt, rangeCutoffMs, zeroFillDaily } from './usage-stats'

const log = createLogger({ process: 'service' }).child({ component: 'conversation-store' })

export type StoredSession = {
  id: string
  createdAt: number
  lastActiveAt: number
  status: 'active' | 'interrupted' | 'ended'
  providerSnapshot: ProviderInjection
  title: string | null
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
  /** `kind` defaults to 'user'; pass 'child' for a hidden delegate sub-session. */
  createSession(id: string, provider: ProviderInjection, kind?: 'user' | 'child'): StoredSession
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
  getUsageStats(rangeDays: number): UsageStats
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
  entries: EntryStore
  close(): void
}

export function createConversationStore(dbPath: string): ConversationStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  ensureEntriesSchema(db)

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
    -- v3 (spec §3.6): the message-event log is retired — the entry log
    -- (session_entries) is the single source of truth, and usage stats moved
    -- onto 'usage' custom entries. Drop the old event tables (and the pre-v5
    -- run_events name); history is disposable per spec, so no migration.
    DROP TABLE IF EXISTS message_events;
    DROP TABLE IF EXISTS run_events;

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      created_at      INTEGER NOT NULL,
      last_active_at  INTEGER NOT NULL,
      status          TEXT NOT NULL,
      provider_snapshot TEXT NOT NULL,
      title             TEXT,
      pinned            INTEGER NOT NULL DEFAULT 0,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      cwd               TEXT,
      permission_mode   TEXT,
      execution_mode    TEXT,
      agent_type        TEXT,
      -- 'user' = a normal conversation shown in the session list; 'child' = a
      -- hidden delegate sub-session (filtered out of listSessions).
      kind              TEXT NOT NULL DEFAULT 'user'
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

  for (const stmt of [
    'ALTER TABLE sessions ADD COLUMN title TEXT',
    'ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN cwd TEXT',
    'ALTER TABLE sessions ADD COLUMN permission_mode TEXT',
    'ALTER TABLE sessions ADD COLUMN execution_mode TEXT',
    'ALTER TABLE sessions ADD COLUMN agent_type TEXT',
    `ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'`,
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
    `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot, title, sort_order, kind)
     VALUES (?, ?, ?, 'active', ?, NULL,
       COALESCE((SELECT MIN(sort_order) FROM sessions), 0) - 1, ?)`
  )
  const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const stmtUpdateStatus = db.prepare('UPDATE sessions SET status = ? WHERE id = ?')
  const stmtUpdateProvider = db.prepare('UPDATE sessions SET provider_snapshot = ? WHERE id = ?')
  const stmtUpdateLastActive = db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?')

  // On reopen, mark every session left 'active' by a crashed process as
  // 'interrupted' (matches the pre-4b session-status side of markAndGetInterrupted;
  // the tasks-side cleanup is gone now that the tasks table is dropped — orphaned
  // runs are settled by the manager on reopen, not here).
  const markAndGetInterrupted = db.transaction((): StoredSession[] => {
    const active = db.prepare(`SELECT * FROM sessions WHERE status = 'active'`).all() as Record<string, unknown>[]
    db.prepare(`UPDATE sessions SET status = 'interrupted' WHERE status = 'active'`).run()
    return active.map(rowToSession).map((s) => ({ ...s, status: 'interrupted' as const }))
  })

  const stmtSetTitle = db.prepare('UPDATE sessions SET title = ? WHERE id = ?')
  const stmtSetPinned = db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?')
  const stmtSetSortOrder = db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?')

  // tokensUsed / usdCents sum the LATEST 'usage' custom entry per run in the
  // session (each run emits one usage entry per turn; the last is the final
  // snapshot). taskCount is the number of distinct runs that produced usage.
  // v3: usage lives on 'usage' custom entries in session_entries (spec §3.6),
  // keyed by data.runId — the direct heir of the retired per-message message.usage
  // rows, so the aggregation shape (latest-per-key snapshot) is unchanged.
  // contextTokens / contextWindow come from the session's single newest usage
  // entry (by id) — the current context-occupancy snapshot the composer's fill
  // ring reads at session load. User sessions have only top-level usage entries
  // (sub-agent runs live in hidden child sessions), so no parent filtering.
  const stmtListSessions = db.prepare(
    `WITH latest_usage AS (
        SELECT session_id,
               json_extract(entry, '$.data.runId')         AS runId,
               json_extract(entry, '$.data.used.tokens')   AS tokens,
               json_extract(entry, '$.data.used.usdCents') AS usdCents
          FROM session_entries
         WHERE type = 'custom' AND json_extract(entry, '$.customType') = 'usage'
           AND id IN (SELECT MAX(id) FROM session_entries
                       WHERE type = 'custom' AND json_extract(entry, '$.customType') = 'usage'
                       GROUP BY json_extract(entry, '$.data.runId'))
     )
     SELECT s.id, s.title, s.status, s.pinned, s.sort_order AS sortOrder, s.last_active_at AS lastActiveAt,
            s.cwd, s.permission_mode AS permissionMode, s.execution_mode AS executionMode,
            s.agent_type AS agentType,
            (SELECT COUNT(DISTINCT lu.runId) FROM latest_usage lu WHERE lu.session_id = s.id) AS taskCount,
            COALESCE((SELECT SUM(lu.tokens)   FROM latest_usage lu WHERE lu.session_id = s.id), 0) AS tokensUsed,
            COALESCE((SELECT SUM(lu.usdCents) FROM latest_usage lu WHERE lu.session_id = s.id), 0) AS usdCents,
            (SELECT json_extract(entry, '$.data.contextTokens') FROM session_entries e
              WHERE e.session_id = s.id AND e.type = 'custom' AND json_extract(e.entry, '$.customType') = 'usage'
              ORDER BY e.id DESC LIMIT 1) AS contextTokens,
            (SELECT json_extract(entry, '$.data.contextWindow') FROM session_entries e
              WHERE e.session_id = s.id AND e.type = 'custom' AND json_extract(e.entry, '$.customType') = 'usage'
              ORDER BY e.id DESC LIMIT 1) AS contextWindow
       FROM sessions s
      WHERE s.status != 'ended' AND s.kind = 'user'
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
  // forbid orphaning child rows).
  const deleteSessionTx = db.transaction((id: string) => {
    db.prepare('DELETE FROM cron_runs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM cron_jobs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM session_entries WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  })

  const entries = createEntryStore(db)

  return {
    createSession(id, provider, kind = 'user') {
      const now = Date.now()
      stmtInsertSession.run(id, now, now, JSON.stringify(provider), kind)
      return {
        id,
        createdAt: now,
        lastActiveAt: now,
        status: 'active',
        providerSnapshot: provider,
        title: null,
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
        contextTokens: (r.contextTokens as number | null) ?? undefined,
        contextWindow: (r.contextWindow as number | null) ?? undefined,
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
    getUsageStats(rangeDays) {
      const t0 = Date.now()
      const range: 7 | 30 = rangeDays === 7 ? 7 : 30
      log.info({ msg: 'getUsageStats', rangeDays: range })
      try {
        const now = new Date()
        const cutoff = rangeCutoffMs(now, range)
        const heatmapCutoff = rangeCutoffMs(now, HEATMAP_DAYS)

        // Latest 'usage' custom entry per run across all time (no range filter —
        // we slice by ts in JS). v3: usage lives on 'usage' custom entries in
        // session_entries (spec §3.6), keyed by data.runId — the direct heir of
        // the retired per-message message.usage rows. Sub-agent runs live in
        // hidden child sessions with their OWN usage entries (the parent's
        // snapshot does NOT include child cost), so every run — top-level,
        // conversation, and sub-agent — contributes, one row per run.
        const usageRows = db
          .prepare(
            `SELECT json_extract(entry, '$.data.used.tokens')    AS tokens,
                    json_extract(entry, '$.data.used.cacheRead') AS cacheRead,
                    json_extract(entry, '$.data.used.usdCents')  AS usdCents,
                    json_extract(entry, '$.data.model')          AS model,
                    session_id                                    AS sessionId,
                    ts                                            AS ts
               FROM session_entries
              WHERE type = 'custom' AND json_extract(entry, '$.customType') = 'usage'
                AND id IN (SELECT MAX(id) FROM session_entries
                            WHERE type = 'custom' AND json_extract(entry, '$.customType') = 'usage'
                            GROUP BY json_extract(entry, '$.data.runId'))`
          )
          .all() as Array<{
          tokens: number
          cacheRead: number
          usdCents: number
          model: string | null
          sessionId: string
          ts: number
        }>

        // Messages: one unified count of persisted 'message' entries (user,
        // assistant, and tool turns) in range.
        const messagesRow = db
          .prepare(`SELECT COUNT(*) AS n FROM session_entries WHERE ts >= ? AND type = 'message'`)
          .get(cutoff) as { n: number }

        // Active days (any 'usage' custom entry, all time) for currentStreak.
        const activeDateRows = db
          .prepare(
            `SELECT DISTINCT date(ts/1000, 'unixepoch', 'localtime') AS date
               FROM session_entries
              WHERE type = 'custom' AND json_extract(entry, '$.customType') = 'usage'`
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
    entries,
    close() {
      db.close()
    },
  }
}
