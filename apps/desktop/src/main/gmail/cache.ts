// src/main/gmail/cache.ts
//
// Local sqlite cache of synced Gmail threads/messages. Main process is the
// sole writer (the daemon) and sole reader (the query methods); WAL is enabled
// for hygiene. Opened with better-sqlite3; ':memory:' is used in tests.
import type { GmailMessage, GmailThread } from '@swarm/protocol'
import type { Database as DB } from 'better-sqlite3'
import Database from 'better-sqlite3'

export type ThreadStats = { messageCount: number; lastSyncAt: number }

export type Cache = {
  upsertThreads(rows: GmailThread[]): void
  upsertMessages(rows: GmailMessage[]): void
  search(query: string, limit: number): GmailThread[]
  getThread(id: string): { thread: GmailThread; messages: GmailMessage[] } | null
  // Cheap existence check used by the daemon to skip already-cached threads
  // during incremental polls.
  hasThread(id: string): boolean
  // True when a cached thread has at least one message whose htmlBody is empty
  // (e.g. cached before the htmlBody column existed) — signals the daemon to
  // re-fetch and backfill. False for threads with full htmlBody or no messages.
  threadMissingHtml(id: string): boolean
  // True total cached message count, regardless of the last poll's fetch volume.
  countMessages(): number
  getThreadAnalysis(threadId: string): import('@swarm/protocol').GmailThreadAnalysis | null
  saveThreadAnalysis(threadId: string, analysis: import('@swarm/protocol').ThreadAnalysisPayload): void
  // Thread ids that already have a cached thread-level analysis — drives the
  // inbox list's "AI" badge.
  analyzedThreadIds(): string[]
  // Flip a thread's cached unread flag (optimistic update after marking read on
  // the server). No-op if the thread isn't cached.
  setThreadUnread(threadId: string, unread: boolean): void
  // Remove a thread and everything hanging off it (messages, thread analysis) — used
  // when a thread leaves INBOX (archived/trashed/deleted) elsewhere.
  deleteThread(threadId: string): void
  listRecent(input: { limit: number; label?: string }): GmailThread[]
  stats(): ThreadStats
  setStats(stats: ThreadStats): void
  // Incremental-sync cursor (Gmail mailbox historyId). null before the first sync.
  getHistoryId(): string | null
  setHistoryId(historyId: string): void
  // Read specific threads by id, preserving the given order and skipping any not
  // cached — used to materialize a fetched page in list order.
  getThreadsByIds(ids: string[]): GmailThread[]
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, snippet TEXT, fromAddr TEXT, subject TEXT,
  lastDateMs INTEGER, labelIds TEXT, unread INTEGER, updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_threads_date ON threads(lastDateMs);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, threadId TEXT, fromAddr TEXT, toAddrs TEXT,
  subject TEXT, snippet TEXT, bodyText TEXT, htmlBody TEXT, dateMs INTEGER, labelIds TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(threadId);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(dateMs);
CREATE TABLE IF NOT EXISTS thread_analyses (
  threadId TEXT PRIMARY KEY, summary TEXT, todos TEXT, suggest TEXT, updatedAt INTEGER
);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
`

function rowToThread(r: Record<string, unknown>): GmailThread {
  return {
    id: String(r.id),
    snippet: String(r.snippet ?? ''),
    fromAddr: String(r.fromAddr ?? ''),
    subject: String(r.subject ?? ''),
    lastDateMs: Number(r.lastDateMs ?? 0),
    labelIds: JSON.parse(String(r.labelIds ?? '[]')) as string[],
    unread: Number(r.unread ?? 0) === 1,
  }
}

function rowToMessage(r: Record<string, unknown>): GmailMessage {
  return {
    id: String(r.id),
    threadId: String(r.threadId ?? ''),
    fromAddr: String(r.fromAddr ?? ''),
    toAddrs: JSON.parse(String(r.toAddrs ?? '[]')) as string[],
    subject: String(r.subject ?? ''),
    snippet: String(r.snippet ?? ''),
    bodyText: String(r.bodyText ?? ''),
    htmlBody: String(r.htmlBody ?? ''),
    dateMs: Number(r.dateMs ?? 0),
    labelIds: JSON.parse(String(r.labelIds ?? '[]')) as string[],
  }
}

export function createCache(opts: { filePath: string }): Cache {
  const db: DB = new Database(opts.filePath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  // Idempotent migration: caches created before htmlBody landed lack the column.
  const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'htmlBody')) {
    db.exec('ALTER TABLE messages ADD COLUMN htmlBody TEXT')
  }

  const upsertThread = db.prepare(
    `INSERT INTO threads (id, snippet, fromAddr, subject, lastDateMs, labelIds, unread, updatedAt)
     VALUES (@id, @snippet, @fromAddr, @subject, @lastDateMs, @labelIds, @unread, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       snippet=@snippet, fromAddr=@fromAddr, subject=@subject, lastDateMs=@lastDateMs,
       labelIds=@labelIds, unread=@unread, updatedAt=@updatedAt`
  )
  const upsertMessage = db.prepare(
    `INSERT INTO messages (id, threadId, fromAddr, toAddrs, subject, snippet, bodyText, htmlBody, dateMs, labelIds)
     VALUES (@id, @threadId, @fromAddr, @toAddrs, @subject, @snippet, @bodyText, @htmlBody, @dateMs, @labelIds)
     ON CONFLICT(id) DO UPDATE SET
       threadId=@threadId, fromAddr=@fromAddr, toAddrs=@toAddrs, subject=@subject,
       snippet=@snippet, bodyText=@bodyText, htmlBody=@htmlBody, dateMs=@dateMs, labelIds=@labelIds`
  )

  const upsertThreads: Cache['upsertThreads'] = (rows) => {
    const now = Date.now()
    const tx = db.transaction((items: GmailThread[]) => {
      for (const t of items) {
        upsertThread.run({
          id: t.id,
          snippet: t.snippet,
          fromAddr: t.fromAddr,
          subject: t.subject,
          lastDateMs: t.lastDateMs,
          labelIds: JSON.stringify(t.labelIds),
          unread: t.unread ? 1 : 0,
          updatedAt: now,
        })
      }
    })
    tx(rows)
  }

  const upsertMessages: Cache['upsertMessages'] = (rows) => {
    const tx = db.transaction((items: GmailMessage[]) => {
      for (const m of items) {
        upsertMessage.run({
          id: m.id,
          threadId: m.threadId,
          fromAddr: m.fromAddr,
          toAddrs: JSON.stringify(m.toAddrs),
          subject: m.subject,
          snippet: m.snippet,
          bodyText: m.bodyText,
          htmlBody: m.htmlBody,
          dateMs: m.dateMs,
          labelIds: JSON.stringify(m.labelIds),
        })
      }
    })
    tx(rows)
  }

  const search: Cache['search'] = (query, limit) => {
    const like = `%${query}%`
    const rows = db
      .prepare(
        `SELECT * FROM threads
         WHERE subject LIKE @like OR snippet LIKE @like OR fromAddr LIKE @like
         OR id IN (SELECT threadId FROM messages WHERE bodyText LIKE @like OR subject LIKE @like)
         ORDER BY lastDateMs DESC LIMIT @limit`
      )
      .all({ like, limit }) as Record<string, unknown>[]
    return rows.map(rowToThread)
  }

  const getThread: Cache['getThread'] = (id) => {
    const tr = db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!tr) return null
    const msgs = db.prepare('SELECT * FROM messages WHERE threadId = ? ORDER BY dateMs ASC').all(id) as Record<
      string,
      unknown
    >[]
    return { thread: rowToThread(tr), messages: msgs.map(rowToMessage) }
  }

  const hasThread: Cache['hasThread'] = (id) =>
    db.prepare('SELECT 1 FROM threads WHERE id = ? LIMIT 1').get(id) !== undefined
  const threadMissingHtml: Cache['threadMissingHtml'] = (id) =>
    db.prepare(`SELECT 1 FROM messages WHERE threadId = ? AND (htmlBody IS NULL OR htmlBody = '') LIMIT 1`).get(id) !==
    undefined
  const countMessages: Cache['countMessages'] = () => {
    const r = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n?: number } | undefined
    return r?.n ?? 0
  }

  const listRecent: Cache['listRecent'] = ({ limit, label }) => {
    const rows = label
      ? (db
          .prepare('SELECT * FROM threads WHERE labelIds LIKE @label ORDER BY lastDateMs DESC LIMIT @limit')
          .all({ label: `%"${label}"%`, limit }) as Record<string, unknown>[])
      : (db.prepare('SELECT * FROM threads ORDER BY lastDateMs DESC LIMIT @limit').all({ limit }) as Record<
          string,
          unknown
        >[])
    return rows.map(rowToThread)
  }

  const stats: Cache['stats'] = () => {
    const get = (k: string): number => {
      const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(k) as { value?: string } | undefined
      return r?.value ? Number(r.value) : 0
    }
    return { messageCount: get('messageCount'), lastSyncAt: get('lastSyncAt') }
  }
  const setStats: Cache['setStats'] = (s) => {
    const set = db.prepare(
      'INSERT INTO sync_state (key, value) VALUES (@k, @v) ON CONFLICT(key) DO UPDATE SET value=@v'
    )
    set.run({ k: 'messageCount', v: String(s.messageCount) })
    set.run({ k: 'lastSyncAt', v: String(s.lastSyncAt) })
  }

  const setSyncStateStmt = db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (@k, @v) ON CONFLICT(key) DO UPDATE SET value=@v'
  )
  const getSyncState = (key: string): string | undefined =>
    (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value?: string } | undefined)?.value

  const getHistoryId: Cache['getHistoryId'] = () => getSyncState('historyId') ?? null
  const setHistoryId: Cache['setHistoryId'] = (historyId) => setSyncStateStmt.run({ k: 'historyId', v: historyId })

  const getThreadsByIds: Cache['getThreadsByIds'] = (ids) => {
    const byId = new Map<string, GmailThread>()
    for (const id of ids) {
      const r = db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (r) byId.set(id, rowToThread(r))
    }
    return ids.map((id) => byId.get(id)).filter((t): t is GmailThread => t !== undefined)
  }

  // Thread-level analysis cache: todos stored as a JSON string (sqlite needs a
  // string for the array); getThreadAnalysis parses it back. Upsert keyed by
  // threadId so re-analysis replaces the prior row.
  const upsertThreadAnalysis = db.prepare(
    `INSERT INTO thread_analyses (threadId, summary, todos, suggest, updatedAt)
     VALUES (@threadId, @summary, @todos, @suggest, @updatedAt)
     ON CONFLICT(threadId) DO UPDATE SET
       summary=@summary, todos=@todos, suggest=@suggest, updatedAt=@updatedAt`
  )
  const getThreadAnalysis: Cache['getThreadAnalysis'] = (threadId) => {
    const r = db.prepare('SELECT * FROM thread_analyses WHERE threadId = ?').get(threadId) as
      | { threadId: string; summary: string; todos: string; suggest: string; updatedAt: number }
      | undefined
    if (!r) return null
    return {
      summary: r.summary,
      todos: JSON.parse(r.todos) as import('@swarm/protocol').Todo[],
      suggest: r.suggest,
      updatedAt: r.updatedAt,
    }
  }
  const saveThreadAnalysis: Cache['saveThreadAnalysis'] = (threadId, analysis) => {
    upsertThreadAnalysis.run({
      threadId,
      summary: analysis.summary,
      todos: JSON.stringify(analysis.todos),
      suggest: analysis.suggest,
      updatedAt: Date.now(),
    })
  }

  const analyzedThreadIds: Cache['analyzedThreadIds'] = () =>
    (db.prepare('SELECT threadId FROM thread_analyses').all() as { threadId: string }[]).map((r) => r.threadId)

  const setThreadUnreadStmt = db.prepare('UPDATE threads SET unread = @unread WHERE id = @id')
  const setThreadUnread: Cache['setThreadUnread'] = (threadId, unread) => {
    setThreadUnreadStmt.run({ id: threadId, unread: unread ? 1 : 0 })
  }

  // Delete the thread's messages, thread-level analysis, and the thread row — atomically.
  const deleteThreadTxn = db.transaction((threadId: string) => {
    db.prepare('DELETE FROM messages WHERE threadId = ?').run(threadId)
    db.prepare('DELETE FROM thread_analyses WHERE threadId = ?').run(threadId)
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId)
  })
  const deleteThread: Cache['deleteThread'] = (threadId) => {
    deleteThreadTxn(threadId)
  }

  return {
    upsertThreads,
    upsertMessages,
    search,
    getThread,
    hasThread,
    threadMissingHtml,
    countMessages,
    getThreadAnalysis,
    saveThreadAnalysis,
    analyzedThreadIds,
    setThreadUnread,
    deleteThread,
    getHistoryId,
    setHistoryId,
    getThreadsByIds,
    listRecent,
    stats,
    setStats,
    close: () => db.close(),
  }
}
