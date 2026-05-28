import Database from 'better-sqlite3'
import type { ProviderInjection } from '@shared/types/provider'
import type { Task } from '@shared/types/task'

export type StoredSession = {
  id: string
  createdAt: number
  lastActiveAt: number
  status: 'active' | 'interrupted' | 'ended'
  providerSnapshot: ProviderInjection
}

export type ConversationStore = {
  createSession(id: string, provider: ProviderInjection): StoredSession
  getSession(id: string): StoredSession | undefined
  updateSessionStatus(id: string, status: StoredSession['status']): void
  updateSessionLastActive(id: string): void
  getInterruptedSessions(): StoredSession[]
  saveTask(task: Task, sessionId: string): void
  updateTaskStatus(taskId: string, status: Task['status'], result?: Task['result']): void
  getSessionTasks(sessionId: string): Task[]
  saveToolState(sessionId: string, key: string, value: unknown): void
  getToolState(sessionId: string, key: string): unknown
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
      provider_snapshot TEXT NOT NULL
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
      created_at          INTEGER NOT NULL,
      started_at          INTEGER,
      ended_at            INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE TABLE IF NOT EXISTS tool_state_snapshots (
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (session_id, key)
    );
  `)

  const rowToSession = (row: Record<string, unknown>): StoredSession => ({
    id: row.id as string,
    createdAt: row.created_at as number,
    lastActiveAt: row.last_active_at as number,
    status: row.status as StoredSession['status'],
    providerSnapshot: JSON.parse(row.provider_snapshot as string) as ProviderInjection,
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
    history: JSON.parse((row.history as string) ?? '[]') as Task['history'],
    result: row.result ? (JSON.parse(row.result as string) as Task['result']) : null,
    createdAt: row.created_at as number,
    startedAt: (row.started_at as number | null) ?? null,
    endedAt: (row.ended_at as number | null) ?? null,
  })

  const stmtInsertSession = db.prepare(
    `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot)
     VALUES (?, ?, ?, 'active', ?)`,
  )
  const stmtGetSession = db.prepare(`SELECT * FROM sessions WHERE id = ?`)
  const stmtUpdateStatus = db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`)
  const stmtUpdateLastActive = db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`)

  const markAndGetInterrupted = db.transaction((): StoredSession[] => {
    const active = db.prepare(`SELECT * FROM sessions WHERE status = 'active'`).all() as Record<string, unknown>[]
    db.prepare(`UPDATE sessions SET status = 'interrupted' WHERE status = 'active'`).run()
    return active.map(rowToSession).map(s => ({ ...s, status: 'interrupted' as const }))
  })

  const stmtInsertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks
     (id, session_id, parent_id, goal, status, result, budget, used,
      agent_def_id, assigned_worker_id, tool_allowlist, history,
      created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const stmtUpdateTask = db.prepare(
    `UPDATE tasks SET status = ?, result = ?, ended_at = ? WHERE id = ?`,
  )
  const stmtGetTasks = db.prepare(`SELECT * FROM tasks WHERE session_id = ?`)
  const stmtUpsertToolState = db.prepare(
    `INSERT OR REPLACE INTO tool_state_snapshots (session_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)`,
  )
  const stmtGetToolState = db.prepare(
    `SELECT value FROM tool_state_snapshots WHERE session_id = ? AND key = ?`,
  )

  return {
    createSession(id, provider) {
      const now = Date.now()
      stmtInsertSession.run(id, now, now, JSON.stringify(provider))
      return { id, createdAt: now, lastActiveAt: now, status: 'active', providerSnapshot: provider }
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
    saveTask(task, sessionId) {
      stmtInsertTask.run(
        task.id, sessionId, task.parentId ?? null, task.goal, task.status,
        task.result ? JSON.stringify(task.result) : null,
        JSON.stringify(task.budget), JSON.stringify(task.used),
        task.agentDefId, task.assignedWorkerId ?? null,
        JSON.stringify(task.toolAllowlist), JSON.stringify(task.history),
        task.createdAt, task.startedAt ?? null, task.endedAt ?? null,
      )
    },
    updateTaskStatus(taskId, status, result) {
      const terminalStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled'])
      const endedAt = terminalStatuses.has(status) ? Date.now() : null
      stmtUpdateTask.run(status, result ? JSON.stringify(result) : null, endedAt, taskId)
    },
    getSessionTasks(sessionId) {
      return (stmtGetTasks.all(sessionId) as Record<string, unknown>[]).map(rowToTask)
    },
    saveToolState(sessionId, key, value) {
      stmtUpsertToolState.run(sessionId, key, JSON.stringify(value), Date.now())
    },
    getToolState(sessionId, key) {
      const row = stmtGetToolState.get(sessionId, key) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined
    },
    close() {
      db.close()
    },
  }
}
