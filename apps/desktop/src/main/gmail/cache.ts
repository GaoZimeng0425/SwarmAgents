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
  // True total cached message count, regardless of the last poll's fetch volume.
  countMessages(): number
  listRecent(input: { limit: number; label?: string }): GmailThread[]
  stats(): ThreadStats
  setStats(stats: ThreadStats): void
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
  subject TEXT, snippet TEXT, bodyText TEXT, dateMs INTEGER, labelIds TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(threadId);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(dateMs);
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
    dateMs: Number(r.dateMs ?? 0),
    labelIds: JSON.parse(String(r.labelIds ?? '[]')) as string[],
  }
}

export function createCache(opts: { filePath: string }): Cache {
  const db: DB = new Database(opts.filePath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  const upsertThread = db.prepare(
    `INSERT INTO threads (id, snippet, fromAddr, subject, lastDateMs, labelIds, unread, updatedAt)
     VALUES (@id, @snippet, @fromAddr, @subject, @lastDateMs, @labelIds, @unread, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       snippet=@snippet, fromAddr=@fromAddr, subject=@subject, lastDateMs=@lastDateMs,
       labelIds=@labelIds, unread=@unread, updatedAt=@updatedAt`
  )
  const upsertMessage = db.prepare(
    `INSERT INTO messages (id, threadId, fromAddr, toAddrs, subject, snippet, bodyText, dateMs, labelIds)
     VALUES (@id, @threadId, @fromAddr, @toAddrs, @subject, @snippet, @bodyText, @dateMs, @labelIds)
     ON CONFLICT(id) DO UPDATE SET
       threadId=@threadId, fromAddr=@fromAddr, toAddrs=@toAddrs, subject=@subject,
       snippet=@snippet, bodyText=@bodyText, dateMs=@dateMs, labelIds=@labelIds`
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

  return {
    upsertThreads,
    upsertMessages,
    search,
    getThread,
    hasThread,
    countMessages,
    listRecent,
    stats,
    setStats,
    close: () => db.close(),
  }
}
