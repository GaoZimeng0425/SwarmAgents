import {
  type CommitResult,
  type Context,
  type Entry,
  type EntryScan,
  type EntryStructure,
  prepareStorageCommit,
  type ListElement,
  type ListReadOptions,
  resolveListReadOptions,
  type SessionStats,
  type Storage,
  type StorageBranchScan,
  type StoredValue,
  type UsageRow,
  type UsageScan,
  type Value,
  type ValueList,
  validateCommittedWrites,
  type Write,
} from '@earendil-works/pi-agent-core'
import type { Usage } from '@earendil-works/pi-ai'
import { type EntryRow, type SessionEntry, SessionEntrySchema } from '@swarm/protocol'
import type { Database } from 'better-sqlite3'

/** Single source of truth (spec §3.2): finalized entries only; AUTOINCREMENT id is order + cursor. */
export function ensureEntriesSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_entries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id        TEXT NOT NULL UNIQUE,
      session_id      TEXT NOT NULL,
      parent_entry_id TEXT,
      type            TEXT NOT NULL,
      entry           TEXT NOT NULL,
      ts              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_session ON session_entries(session_id, id);
  `)
}

export type EntryStore = {
  append(sessionId: string, entry: SessionEntry): number
  list(sessionId: string, afterRowId?: number): EntryRow[]
  forSession(sessionId: string): SqliteStorage
  deleteSession(sessionId: string): void
  copyUpTo(sourceSessionId: string, targetSessionId: string, upToRowId: number): void
}

export function createEntryStore(db: Database): EntryStore {
  const insert = db.prepare(
    `INSERT INTO session_entries (entry_id, session_id, parent_entry_id, type, entry, ts)
     VALUES (@entryId, @sessionId, @parentId, @type, @entry, @ts)`
  )
  const selectAfter = db.prepare('SELECT id, entry FROM session_entries WHERE session_id = ? AND id > ? ORDER BY id')
  const del = db.prepare('DELETE FROM session_entries WHERE session_id = ?')
  const copy = db.prepare(
    `INSERT INTO session_entries (entry_id, session_id, parent_entry_id, type, entry, ts)
     SELECT entry_id || '-' || @target, @target, parent_entry_id, type, entry, ts
     FROM session_entries WHERE session_id = @source AND id <= @upTo ORDER BY id`
  )

  const append = (sessionId: string, entry: SessionEntry): number => {
    const parsed = SessionEntrySchema.parse(entry)
    const info = insert.run({
      entryId: parsed.id,
      sessionId,
      parentId: parsed.parentId,
      type: parsed.type,
      entry: JSON.stringify(parsed),
      ts: Date.now(),
    })
    return Number(info.lastInsertRowid)
  }
  const list = (sessionId: string, afterRowId = 0): EntryRow[] =>
    (selectAfter.all(sessionId, afterRowId) as Array<{ id: number; entry: string }>).map((r) => ({
      rowId: r.id,
      entry: SessionEntrySchema.parse(JSON.parse(r.entry)),
    }))

  return {
    append,
    list,
    forSession: (sessionId) => new SqliteStorage(db, sessionId),
    deleteSession: (sessionId) => void del.run(sessionId),
    copyUpTo: (source, target, upTo) => void copy.run({ source, target, upTo }),
  }
}

// ─── pi Storage contract (pi-agent-core 0.85) ────────────────────────────────

/**
 * pi's Storage contract over sqlite, bound to one session — the 0.85 successor
 * of the old SqliteSessionStorage adapter. Deliberately separate from the
 * session_entries table above (whose rowId cursor the conversation UI streams
 * through): pi's model needs one global write sequence shared by entries,
 * values, lists and usage rows, which the UI cursor must not be entangled with.
 *
 * Semantics mirror pi's MemoryStorage reference implementation: single branch
 * is a parentId chain walk; value delete removes the whole key; list delete
 * removes the whole list; stats.total usage sums every usage row (adjustment
 * rows arrive with negative usage). Adopting the real AgentHarness later means
 * pointing StorageBackedSession at this class — no storage change needed.
 */
export function ensurePiSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pi_seqs (
      session_id TEXT PRIMARY KEY,
      next_seq   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pi_entries (
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      id          TEXT NOT NULL,
      parent_id   TEXT,
      type        TEXT NOT NULL,
      custom_type TEXT,
      timestamp   INTEGER NOT NULL,
      entry       TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_entries_id ON pi_entries(session_id, id);
    CREATE TABLE IF NOT EXISTS pi_values (
      session_id TEXT NOT NULL,
      namespace  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      PRIMARY KEY (session_id, namespace, key)
    );
    CREATE TABLE IF NOT EXISTS pi_lists (
      session_id TEXT NOT NULL,
      namespace  TEXT NOT NULL,
      key        TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      value      TEXT NOT NULL,
      PRIMARY KEY (session_id, namespace, key, seq)
    );
    CREATE TABLE IF NOT EXISTS pi_usage (
      session_id TEXT NOT NULL,
      id         TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      usage      TEXT NOT NULL,
      entry_id   TEXT,
      adjustment INTEGER NOT NULL,
      details    TEXT,
      PRIMARY KEY (session_id, id)
    );
  `)
}

// Local mirror of pi's internal harness/utils/usage addUsage (not publicly
// exported): adjustment rows arrive with negative usage and cancel out here
// exactly as they do in MemoryStorage's running totals.
function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
    ...(left.reasoning === undefined && right.reasoning === undefined
      ? {}
      : { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  }
}

export class SqliteStorage implements Storage {
  constructor(private readonly db: Database, private readonly sessionId: string) {
    ensurePiSchema(db)
  }

  private nextSeq(): number {
    const row = this.db.prepare('SELECT next_seq FROM pi_seqs WHERE session_id = ?').get(this.sessionId) as
      | { next_seq: number }
      | undefined
    return row?.next_seq ?? 1
  }

  private statsNow(): SessionStats {
    const messageCount = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM pi_entries WHERE session_id = ? AND type = 'message'`)
        .get(this.sessionId) as { n: number }
    ).n
    let usage = emptyUsageShape()
    const rows = this.db.prepare('SELECT usage FROM pi_usage WHERE session_id = ? ORDER BY seq').all(
      this.sessionId
    ) as Array<{ usage: string }>
    for (const row of rows) usage = addUsage(usage, JSON.parse(row.usage) as Usage)
    return { messageCount, usage }
  }

  private entryById(id: string): Entry | undefined {
    const row = this.db.prepare('SELECT entry FROM pi_entries WHERE session_id = ? AND id = ?').get(
      this.sessionId,
      id
    ) as { entry: string } | undefined
    return row ? (JSON.parse(row.entry) as Entry) : undefined
  }

  async commit(writes: Write[], _context: Context): Promise<CommitResult> {
    const firstSeq = this.nextSeq()
    const timestamp = Date.now()
    const prepared = prepareStorageCommit(writes, firstSeq, timestamp)
    validateCommittedWrites(prepared.writes, firstSeq, {
      hasEntryOrUsageId: (id) =>
        !!this.db.prepare('SELECT 1 FROM pi_entries WHERE session_id = ? AND id = ?').get(this.sessionId, id) ||
        !!this.db.prepare('SELECT 1 FROM pi_usage WHERE session_id = ? AND id = ?').get(this.sessionId, id),
      hasEntryId: (id) => !!this.db.prepare('SELECT 1 FROM pi_entries WHERE session_id = ? AND id = ?').get(this.sessionId, id),
    })
    const insertEntryRow = this.db.prepare(
      `INSERT INTO pi_entries (session_id, seq, id, parent_id, type, custom_type, timestamp, entry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertUsageRow = this.db.prepare(
      `INSERT INTO pi_usage (session_id, id, seq, usage, entry_id, adjustment, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const upsertValue = this.db.prepare(
      `INSERT INTO pi_values (session_id, namespace, key, value, seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, namespace, key) DO UPDATE SET value = excluded.value, seq = excluded.seq`
    )
    const deleteValue = this.db.prepare('DELETE FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?')
    const appendList = this.db.prepare(
      'INSERT INTO pi_lists (session_id, namespace, key, seq, value) VALUES (?, ?, ?, ?, ?)'
    )
    const deleteList = this.db.prepare('DELETE FROM pi_lists WHERE session_id = ? AND namespace = ? AND key = ?')
    const setSeq = this.db.prepare(
      `INSERT INTO pi_seqs (session_id, next_seq) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET next_seq = excluded.next_seq`
    )
    this.db.transaction(() => {
      for (const write of prepared.writes) {
        switch (write.kind) {
          case 'entry': {
            const { kind: _kind, ...entry } = write
            insertEntryRow.run(
              this.sessionId,
              write.seq,
              entry.id,
              entry.parentId,
              entry.type,
              entry.customType ?? null,
              entry.timestamp,
              JSON.stringify(entry)
            )
            break
          }
          case 'usage': {
            insertUsageRow.run(
              this.sessionId,
              write.id,
              write.seq,
              JSON.stringify(write.usage),
              write.entryId ?? null,
              write.adjustment ? 1 : 0,
              write.details === undefined ? null : JSON.stringify(write.details)
            )
            break
          }
          case 'value': {
            if (write.op === 'delete') deleteValue.run(this.sessionId, write.namespace, write.key)
            else upsertValue.run(this.sessionId, write.namespace, write.key, JSON.stringify(write.value), write.seq)
            break
          }
          case 'list': {
            if (write.op === 'delete') deleteList.run(this.sessionId, write.namespace, write.key)
            else appendList.run(this.sessionId, write.namespace, write.key, write.seq, JSON.stringify(write.value))
            break
          }
        }
      }
      const lastSeq = prepared.writes.length ? prepared.writes[prepared.writes.length - 1].seq : firstSeq - 1
      setSeq.run(this.sessionId, lastSeq + 1)
    })()
    return { ...prepared.result, stats: this.statsNow() }
  }

  async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    const map = new Map<string, Entry>()
    if (ids.length === 0) return map
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT id, entry FROM pi_entries WHERE session_id = ? AND id IN (${placeholders})`)
      .all(this.sessionId, ...ids) as Array<{ id: string; entry: string }>
    for (const row of rows) map.set(row.id, JSON.parse(row.entry) as Entry)
    return map
  }

  async getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
    const row = this.db
      .prepare('SELECT value, seq FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?')
      .get(this.sessionId, address.namespace, address.key) as { value: string; seq: number } | undefined
    if (!row) return undefined
    return { address, value: JSON.parse(row.value) as T, seq: row.seq }
  }

  async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    const rows = this.db
      .prepare('SELECT namespace, key, value, seq FROM pi_values WHERE session_id = ? AND namespace = ?')
      .all(this.sessionId, prefix.namespace) as Array<{ namespace: string; key: string; value: string; seq: number }>
    return rows
      .filter((row) => row.key.startsWith(prefix.key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((row) => ({
        address: { kind: 'value', namespace: row.namespace, key: row.key } as Value<T>,
        value: JSON.parse(row.value) as T,
        seq: row.seq,
      }))
  }

  async readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    _context: Context
  ): Promise<ListElement<T>[]> {
    const resolved = resolveListReadOptions(options)
    const rows = this.db
      .prepare('SELECT seq, value FROM pi_lists WHERE session_id = ? AND namespace = ? AND key = ? ORDER BY seq ASC')
      .all(this.sessionId, address.namespace, address.key) as Array<{ seq: number; value: string }>
    const filtered = rows.filter((row) =>
      resolved.cursor === undefined ? true : resolved.order === 'asc' ? row.seq > resolved.cursor.seq : row.seq < resolved.cursor.seq
    )
    const ordered = resolved.order === 'asc' ? filtered : [...filtered].reverse()
    return ordered.slice(0, resolved.limit).map((row) => ({ seq: row.seq, value: JSON.parse(row.value) as T }))
  }

  // Branch = the parentId chain from `start` toward the root. Throws on an
  // unknown start or a missing parent, matching MemoryStorage.
  async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    const path: Entry[] = []
    let entry = this.entryById(query.start)
    if (!entry) throw new Error(`Unknown branch start: ${query.start}`)
    for (;;) {
      path.push(entry)
      if (entry.parentId === null) break
      const parent = this.entryById(entry.parentId)
      if (!parent) throw new Error('Corrupt branch: missing parent')
      entry = parent
    }
    if (query.order === 'oldestFirst') path.reverse()
    const stopped: Entry[] = []
    for (const candidate of path) {
      stopped.push(candidate)
      if (candidate.id === query.stopAtId || candidate.type === query.stopAtType) break
    }
    const filtered = stopped
      .filter((candidate) => query.type === undefined || candidate.type === query.type)
      .filter((candidate) => query.customType === undefined || candidate.customType === query.customType)
      .filter((candidate) =>
        query.cursor === undefined
          ? true
          : query.order === 'oldestFirst'
            ? candidate.seq > query.cursor.seq
            : candidate.seq < query.cursor.seq
      )
    return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit))
  }

  async scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
    return (await this.scanBranch(query, _context)).map((entry) => ({
      id: entry.id,
      parentId: entry.parentId,
      seq: entry.seq,
      timestamp: entry.timestamp,
      type: entry.type,
      ...(entry.customType === undefined ? {} : { customType: entry.customType }),
    }))
  }

  async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    const conditions = ['session_id = ?']
    const params: unknown[] = [this.sessionId]
    if (query.type !== undefined) {
      conditions.push('type = ?')
      params.push(query.type)
    }
    if (query.customType !== undefined) {
      conditions.push('custom_type = ?')
      params.push(query.customType)
    }
    if (query.fromSeq !== undefined) {
      conditions.push('seq >= ?')
      params.push(query.fromSeq)
    }
    if (query.toSeq !== undefined) {
      conditions.push('seq <= ?')
      params.push(query.toSeq)
    }
    const limit = query.limit === undefined ? -1 : Math.max(0, Math.trunc(query.limit))
    const order = query.order === 'desc' ? 'DESC' : 'ASC'
    const rows = this.db
      .prepare(
        `SELECT entry FROM pi_entries WHERE ${conditions.join(' AND ')} ORDER BY seq ${order} LIMIT ?`
      )
      .all(...params, limit) as Array<{ entry: string }>
    return rows.map((row) => JSON.parse(row.entry) as Entry)
  }

  async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    const conditions = ['session_id = ?']
    const params: unknown[] = [this.sessionId]
    if (query.fromSeq !== undefined) {
      conditions.push('seq >= ?')
      params.push(query.fromSeq)
    }
    if (query.toSeq !== undefined) {
      conditions.push('seq <= ?')
      params.push(query.toSeq)
    }
    const limit = query.limit === undefined ? -1 : Math.max(0, Math.trunc(query.limit))
    const order = query.order === 'desc' ? 'DESC' : 'ASC'
    const rows = this.db
      .prepare(
        `SELECT id, seq, usage, entry_id, adjustment, details FROM pi_usage
         WHERE ${conditions.join(' AND ')} ORDER BY seq ${order} LIMIT ?`
      )
      .all(...params, limit) as Array<{
      id: string
      seq: number
      usage: string
      entry_id: string | null
      adjustment: number
      details: string | null
    }>
    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      usage: JSON.parse(row.usage) as Usage,
      ...(row.entry_id === null ? {} : { entryId: row.entry_id }),
      adjustment: row.adjustment !== 0,
      ...(row.details === null ? {} : { details: JSON.parse(row.details) }),
    }))
  }

  async getStats(_context: Context): Promise<SessionStats> {
    return this.statsNow()
  }

  async close(_context: Context): Promise<void> {
    /* sqlite lifecycle is owned by the app, not per-session storages */
  }
}

// Local zero Usage (mirror of pi-ai's emptyUsage; kept local for the same
// reason as addUsage above).
function emptyUsageShape(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}
