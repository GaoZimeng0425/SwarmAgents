import type { SessionMetadata, SessionStorage, SessionTreeEntry } from '@earendil-works/pi-agent-core'
import { uuidv7 } from '@earendil-works/pi-agent-core'
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
  forSession(sessionId: string): SqliteSessionStorage
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
    forSession: (sessionId) => new SqliteSessionStorage(sessionId, { append, list }),
    deleteSession: (sessionId) => void del.run(sessionId),
    copyUpTo: (source, target, upTo) => void copy.run({ source, target, upTo }),
  }
}

/**
 * pi SessionStorage contract over sqlite, bound to one session. Linear history
 * (spec D5): leaf = last entry; setLeafId is a no-op until branching lands.
 * Free insurance: adopting the real AgentHarness later needs no storage change.
 */
export class SqliteSessionStorage implements SessionStorage {
  constructor(
    private readonly sessionId: string,
    private readonly ops: Pick<EntryStore, 'append' | 'list'>
  ) {}

  async getMetadata(): Promise<SessionMetadata> {
    return { id: this.sessionId, createdAt: new Date(0).toISOString() }
  }
  async getLeafId(): Promise<string | null> {
    const rows = this.ops.list(this.sessionId)
    return rows.length ? rows[rows.length - 1].entry.id : null
  }
  async setLeafId(_leafId: string | null): Promise<void> {
    /* linear history: leaf is always the last entry (spec D5) */
  }
  async createEntryId(): Promise<string> {
    return uuidv7()
  }
  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    // Lossy cast: pi entry kinds outside our 6-member SessionEntry union
    // (label/leaf/session_info/branch_summary/active_tools_change) throw at
    // SessionEntrySchema.parse inside append(). Callers (SessionAgent) must
    // only ever append supported kinds.
    this.ops.append(this.sessionId, entry as SessionEntry)
  }
  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return (await this.getEntries()).find((e) => e.id === id)
  }
  async findEntries<TType extends SessionTreeEntry['type']>(type: TType) {
    return (await this.getEntries()).filter((e) => e.type === type) as Array<Extract<SessionTreeEntry, { type: TType }>>
  }
  async getLabel(_id: string): Promise<string | undefined> {
    return undefined
  }
  async getPathToRoot(_leafId: string | null): Promise<SessionTreeEntry[]> {
    return this.getEntries() // linear: path-to-root === full ordered log
  }
  async getEntries(): Promise<SessionTreeEntry[]> {
    return this.ops.list(this.sessionId).map((r) => r.entry as SessionTreeEntry)
  }
}
