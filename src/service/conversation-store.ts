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

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      created_at      INTEGER NOT NULL,
      last_active_at  INTEGER NOT NULL,
      status          TEXT NOT NULL,
      provider_snapshot TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      parent_id   TEXT,
      goal        TEXT NOT NULL,
      status      TEXT NOT NULL,
      result      TEXT,
      budget      TEXT NOT NULL,
      used        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      started_at  INTEGER,
      ended_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS tool_state_snapshots (
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (session_id, key)
    );
  `)

  const stmtInsertSession = db.prepare(
    `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot)
     VALUES (?, ?, ?, 'active', ?)`,
  )
  const stmtGetSession = db.prepare(`SELECT * FROM sessions WHERE id = ?`)
  const stmtUpdateStatus = db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`)
  const stmtUpdateLastActive = db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`)
  const stmtGetInterrupted = db.prepare(`SELECT * FROM sessions WHERE status = 'active'`)
  const stmtInsertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks
     (id, session_id, parent_id, goal, status, result, budget, used, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    agentDefId: 'default',
    goal: row.goal as string,
    status: row.status as Task['status'],
    assignedWorkerId: null,
    toolAllowlist: [],
    budget: JSON.parse(row.budget as string) as Task['budget'],
    used: JSON.parse(row.used as string) as Task['used'],
    history: [],
    result: row.result ? (JSON.parse(row.result as string) as Task['result']) : null,
    createdAt: row.created_at as number,
    startedAt: (row.started_at as number | null) ?? null,
    endedAt: (row.ended_at as number | null) ?? null,
  })

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
      return (stmtGetInterrupted.all() as Record<string, unknown>[]).map(rowToSession)
    },
    saveTask(task, sessionId) {
      stmtInsertTask.run(
        task.id, sessionId, task.parentId ?? null, task.goal, task.status,
        task.result ? JSON.stringify(task.result) : null,
        JSON.stringify(task.budget), JSON.stringify(task.used),
        task.createdAt, task.startedAt ?? null, task.endedAt ?? null,
      )
    },
    updateTaskStatus(taskId, status, result) {
      stmtUpdateTask.run(status, result ? JSON.stringify(result) : null, Date.now(), taskId)
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
