import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import { SYSTEM_SESSION_ID } from '@shared/system-session'
import type { Actor, ActorMessage } from '@swarm/protocol'
import type { ProviderInjection } from '@swarm/protocol'
import type { Task, TaskEvent } from '@swarm/protocol'
import type { UsageStats } from '@swarm/protocol'
import { HEATMAP_DAYS } from '@swarm/protocol'
import Database from 'better-sqlite3'

import { currentStreak, dayKeysEndingAt, rangeCutoffMs, zeroFillDaily } from './usage-stats'

const log = createLogger({ process: 'service' }).child({ component: 'conversation-store' })

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'interrupted', 'cancelled'])

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

export type StoredTaskWaiter = {
  id: string
  sessionId: string
  waiterAddress: string
  taskId: string
  goal: string | null
  createdAt: number
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
  appendTaskEvent(taskId: string, event: import('@swarm/protocol').TaskEvent): void
  saveTaskPlan(taskId: string, plan: Task['plan']): void
  saveTaskCriteria(taskId: string, criteria: Task['acceptanceCriteria']): void
  saveTaskVerifications(taskId: string, rounds: Task['verifications']): void
  saveTaskDelegationPlan(taskId: string, plan: Task['delegationPlan']): void
  saveTask(task: Task, sessionId: string): void
  updateTaskStatus(taskId: string, status: Task['status'], result?: Task['result']): void
  /** Mark a task as actively running and stamp started_at (kept if already set). */
  markTaskRunning(taskId: string): void
  saveTaskUsage(taskId: string, used: Task['used'], contextWindow?: number): void
  getSessionTasks(sessionId: string): Task[]
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
  saveTaskWaiter(w: StoredTaskWaiter): void
  listTaskWaitersForTask(taskId: string): StoredTaskWaiter[]
  listAllTaskWaiters(): StoredTaskWaiter[]
  deleteTaskWaiter(id: string): void
  setTaskTerminalListener(fn: (taskId: string, status: string) => void): void
  getTask(taskId: string): Task | undefined
  upsertActor(actor: Actor): void
  getActor(address: string): Actor | undefined
  getActorByName(sessionId: string, name: string): Actor | undefined
  listActorsForSession(sessionId: string): Actor[]
  enqueueMessage(msg: ActorMessage): void
  nextUnconsumedFor(address: string): ActorMessage | undefined
  allUnconsumedFor(address: string): ActorMessage[]
  listUnconsumedAddresses(): string[]
  markConsumed(id: string): void
  // Atomically mark a message consumed AND persist the actor's conversation
  // state, so consumption and memory never diverge across a crash. Targeted
  // UPDATE on state/updated_at only — does not touch last_task_id/name.
  consumeAndPersist(msgId: string, address: string, state: string, updatedAt: number): void
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
      sort_order        INTEGER NOT NULL DEFAULT 0,
      cwd               TEXT,
      permission_mode   TEXT,
      execution_mode    TEXT
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
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      verifications       TEXT NOT NULL DEFAULT '[]',
      delegation_plan     TEXT NOT NULL DEFAULT '[]',
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
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id),
      origin_session_id TEXT,
      name              TEXT,
      cron              TEXT NOT NULL,
      goal              TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS task_waiters (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      waiter_address TEXT NOT NULL,
      task_id        TEXT NOT NULL,
      goal           TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_waiters_task_idx ON task_waiters (task_id);
  `)

  for (const stmt of [
    'ALTER TABLE sessions ADD COLUMN title TEXT',
    `ALTER TABLE sessions ADD COLUMN agent_snapshot TEXT NOT NULL DEFAULT '[]'`,
    'ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN cwd TEXT',
    'ALTER TABLE sessions ADD COLUMN permission_mode TEXT',
    'ALTER TABLE sessions ADD COLUMN execution_mode TEXT',
    'ALTER TABLE sessions ADD COLUMN agent_type TEXT',
    `ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN plan TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN verifications TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN delegation_plan TEXT NOT NULL DEFAULT '[]'`,
    'ALTER TABLE tasks ADD COLUMN context_window INTEGER',
    'ALTER TABLE cron_jobs ADD COLUMN origin_session_id TEXT',
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
    acceptanceCriteria: JSON.parse((row.acceptance_criteria as string) ?? '[]') as Task['acceptanceCriteria'],
    verifications: JSON.parse((row.verifications as string) ?? '[]') as Task['verifications'],
    delegationPlan: JSON.parse((row.delegation_plan as string) ?? '[]') as Task['delegationPlan'],
    result: row.result ? (JSON.parse(row.result as string) as Task['result']) : null,
    createdAt: row.created_at as number,
    startedAt: (row.started_at as number | null) ?? null,
    endedAt: (row.ended_at as number | null) ?? null,
    ...(row.context_window != null ? { contextWindow: row.context_window as number } : {}),
  })

  const rowToCronJob = (row: Record<string, unknown>): StoredCronJob => ({
    id: row.id as string,
    sessionId: row.session_id as string,
    originSessionId: (row.origin_session_id as string | null) ?? null,
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
    `INSERT OR REPLACE INTO cron_jobs (id, session_id, origin_session_id, name, cron, goal, created_at, last_run_at)
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
  const stmtListActorsForSession = db.prepare('SELECT * FROM actors WHERE session_id = ? ORDER BY created_at')
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
  const stmtPersistActorState = db.prepare('UPDATE actors SET state = ?, updated_at = ? WHERE address = ?')
  const consumeAndPersistTx = db.transaction((msgId: string, address: string, state: string, updatedAt: number) => {
    stmtMarkConsumed.run(msgId)
    stmtPersistActorState.run(state, updatedAt, address)
  })
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
  const stmtUpdateProvider = db.prepare('UPDATE sessions SET provider_snapshot = ? WHERE id = ?')
  const stmtUpdateLastActive = db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?')

  const markAndGetInterrupted = db.transaction((): StoredSession[] => {
    const active = db.prepare(`SELECT * FROM sessions WHERE status = 'active'`).all() as Record<string, unknown>[]
    db.prepare(`UPDATE sessions SET status = 'interrupted' WHERE status = 'active'`).run()
    // The process restarted, so every non-terminal task is a zombie — no worker
    // will ever resume it. Flip ALL of them to 'interrupted', not just those
    // under sessions flipped active→interrupted this run: a session already left
    // 'interrupted' by a *previous* restart still drags pending tasks that would
    // otherwise replay forever as phantom queued cards, since the active-only
    // `WHERE status='active'` filter never matches them again.
    const now = Date.now()
    const zombieTaskIds = (
      db
        .prepare(`SELECT id FROM tasks WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`)
        .all() as { id: string }[]
    ).map((r) => r.id)
    db.prepare(
      `UPDATE tasks SET status = 'interrupted', ended_at = COALESCE(ended_at, ?)
       WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`
    ).run(now)
    // A zombie interrupted mid-tool-call (e.g. spawn_sub_agent, whose execute()
    // blocks on the child) leaves a tool.call with no matching tool.result, so
    // its card would spin "running" forever. Close each orphan now that the task
    // is terminal.
    let closedOrphans = 0
    for (const id of zombieTaskIds) closedOrphans += closeOrphanToolCalls(id, now)
    if (closedOrphans > 0) log.info({ msg: 'closed orphan tool calls on interrupted tasks', count: closedOrphans })
    return active.map(rowToSession).map((s) => ({ ...s, status: 'interrupted' as const }))
  })

  const stmtInsertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks
     (id, session_id, parent_id, goal, status, result, budget, used,
      agent_def_id, assigned_worker_id, tool_allowlist, history, attachments, plan,
      acceptance_criteria, verifications, delegation_plan,
      created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const stmtUpdateTask = db.prepare('UPDATE tasks SET status = ?, result = ?, ended_at = ? WHERE id = ?')
  // COALESCE keeps the first dispatch's started_at across continuation turns on
  // the same task, so resuming doesn't reset the task's start time.
  const stmtMarkTaskRunning = db.prepare(
    `UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`
  )
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

  // Append a synthetic ok=false tool.result for every tool.call left without a
  // matching tool.result (e.g. spawn_sub_agent interrupted mid-run, whose
  // blocking execute() never returned to emit one). Without it the tool card
  // stays ok=null ("running") forever on reload. Returns the count appended.
  //
  // Pairing mirrors src/renderer/src/lib/task-segments.ts so the synthetic
  // result lands on the exact call it closes: callId-keyed for parallel results
  // (which arrive in completion order, not call order), FIFO for legacy no-callId
  // rows. update_plan's call AND result are both dropped by the renderer, so it
  // is kept out of pending — skipNextResult absorbs its result the same way.
  const closeOrphanToolCalls = (taskId: string, now: number): number => {
    const rows = stmtGetTaskEvents.all(taskId) as { event: string }[]
    const pendingByCallId = new Map<string, true>()
    let fifoPending = 0
    let skipNextResult = false
    for (const r of rows) {
      let e: TaskEvent
      try {
        e = JSON.parse(r.event) as TaskEvent
      } catch {
        continue
      }
      if (e.kind === 'tool.call') {
        if (e.tool === 'update_plan') {
          skipNextResult = true
          continue
        }
        skipNextResult = false
        if (e.callId) pendingByCallId.set(e.callId, true)
        else fifoPending += 1
      } else if (e.kind === 'tool.result') {
        if (skipNextResult) {
          skipNextResult = false
          continue
        }
        if (e.callId) pendingByCallId.delete(e.callId)
        else if (fifoPending > 0) fifoPending -= 1
      }
    }
    let inserted = 0
    const payload = { kind: 'text', text: 'Interrupted before completion' }
    for (const callId of pendingByCallId.keys()) {
      stmtInsertTaskEvent.run(
        taskId,
        JSON.stringify({ kind: 'tool.result', ok: false, payload, callId, ts: now } satisfies TaskEvent),
        now
      )
      inserted += 1
    }
    for (let i = 0; i < fifoPending; i++) {
      stmtInsertTaskEvent.run(
        taskId,
        JSON.stringify({ kind: 'tool.result', ok: false, payload, ts: now } satisfies TaskEvent),
        now
      )
      inserted += 1
    }
    return inserted
  }

  const stmtSetTaskPlan = db.prepare('UPDATE tasks SET plan = ? WHERE id = ?')
  const stmtSetTaskCriteria = db.prepare('UPDATE tasks SET acceptance_criteria = ? WHERE id = ?')
  const stmtSetTaskVerifications = db.prepare('UPDATE tasks SET verifications = ? WHERE id = ?')
  const stmtSetTaskDelegationPlan = db.prepare('UPDATE tasks SET delegation_plan = ? WHERE id = ?')

  const stmtInsertTaskWaiter = db.prepare(
    `INSERT INTO task_waiters (id, session_id, waiter_address, task_id, goal, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const stmtListWaitersForTask = db.prepare('SELECT * FROM task_waiters WHERE task_id = ? ORDER BY created_at ASC')
  const stmtListAllWaiters = db.prepare('SELECT * FROM task_waiters ORDER BY created_at ASC')
  const stmtDeleteWaiter = db.prepare('DELETE FROM task_waiters WHERE id = ?')

  const rowToTaskWaiter = (row: Record<string, unknown>): StoredTaskWaiter => ({
    id: row.id as string,
    sessionId: row.session_id as string,
    waiterAddress: row.waiter_address as string,
    taskId: row.task_id as string,
    goal: (row.goal as string | null) ?? null,
    createdAt: row.created_at as number,
  })

  let taskTerminalListener: ((taskId: string, status: string) => void) | null = null

  const stmtListSessions = db.prepare(
    // tokensUsed / usdCents sum the per-task `used` snapshots (same method as
    // getUsageStats), so the list shows each session's cumulative cost without
    // hydrating its tasks into the renderer. Sub-agent children persist zeroed
    // usage, so summing all tasks equals summing the top-level turns.
    `SELECT s.id, s.title, s.status, s.pinned, s.sort_order AS sortOrder, s.last_active_at AS lastActiveAt,
            s.cwd, s.permission_mode AS permissionMode, s.execution_mode AS executionMode,
            s.agent_type AS agentType,
            (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id) AS taskCount,
            (SELECT COALESCE(SUM(json_extract(t.used, '$.tokens')), 0) FROM tasks t WHERE t.session_id = s.id) AS tokensUsed,
            (SELECT COALESCE(SUM(json_extract(t.used, '$.usdCents')), 0) FROM tasks t WHERE t.session_id = s.id) AS usdCents
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
        executionMode: (r.executionMode as 'goal' | 'plan' | null) ?? undefined,
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
        executionMode: (r.executionMode as 'goal' | 'plan' | null) ?? undefined,
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
    appendTaskEvent(taskId, event) {
      stmtInsertTaskEvent.run(taskId, JSON.stringify(event), event.ts)
    },
    saveTaskPlan(taskId, plan) {
      stmtSetTaskPlan.run(JSON.stringify(plan), taskId)
    },
    saveTaskCriteria(taskId, criteria) {
      stmtSetTaskCriteria.run(JSON.stringify(criteria), taskId)
    },
    saveTaskVerifications(taskId, rounds) {
      stmtSetTaskVerifications.run(JSON.stringify(rounds), taskId)
    },
    saveTaskDelegationPlan(taskId, plan) {
      stmtSetTaskDelegationPlan.run(JSON.stringify(plan), taskId)
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
        JSON.stringify(task.acceptanceCriteria ?? []),
        JSON.stringify(task.verifications ?? []),
        JSON.stringify(task.delegationPlan ?? []),
        task.createdAt,
        task.startedAt ?? null,
        task.endedAt ?? null
      )
    },
    updateTaskStatus(taskId, status, result) {
      const endedAt = TERMINAL_TASK_STATUSES.has(status) ? Date.now() : null
      stmtUpdateTask.run(status, result ? JSON.stringify(result) : null, endedAt, taskId)
      if (TERMINAL_TASK_STATUSES.has(status)) taskTerminalListener?.(taskId, status)
    },
    markTaskRunning(taskId) {
      stmtMarkTaskRunning.run(Date.now(), taskId)
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
                    COALESCE(SUM(json_extract(t.used, '$.tokens')), 0) AS tokens,
                    COALESCE(SUM(json_extract(t.used, '$.usdCents')), 0) AS usdCents
             FROM tasks t JOIN sessions s ON s.id = t.session_id
             WHERE t.created_at >= ?
             GROUP BY model
             HAVING tokens > 0
             ORDER BY tokens DESC`
          )
          .all(cutoff) as { model: string; tokens: number; usdCents: number }[]

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
          usdCents: r.usdCents,
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
        job.originSessionId ?? null,
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
    saveTaskWaiter(w) {
      stmtInsertTaskWaiter.run(w.id, w.sessionId, w.waiterAddress, w.taskId, w.goal ?? null, w.createdAt)
    },
    listTaskWaitersForTask(taskId) {
      return (stmtListWaitersForTask.all(taskId) as Record<string, unknown>[]).map(rowToTaskWaiter)
    },
    listAllTaskWaiters() {
      return (stmtListAllWaiters.all() as Record<string, unknown>[]).map(rowToTaskWaiter)
    },
    deleteTaskWaiter(id) {
      stmtDeleteWaiter.run(id)
    },
    setTaskTerminalListener(fn) {
      taskTerminalListener = fn
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
    listActorsForSession(sessionId) {
      return (stmtListActorsForSession.all(sessionId) as ActorRow[]).map(rowToActor)
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
    consumeAndPersist: (msgId, address, state, updatedAt) => consumeAndPersistTx(msgId, address, state, updatedAt),
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
