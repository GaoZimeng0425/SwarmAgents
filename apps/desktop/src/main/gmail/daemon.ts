// src/main/gmail/daemon.ts
//
// Resident Gmail sync daemon. Polls the inbox on a fixed interval and upserts
// threads/messages into the cache. Steady-state polls are incremental via the
// Gmail History API (users.history.list since a stored historyId cursor): they
// pick up new mail, UNREAD flips, AND removals (archive/trash/delete) made on
// other devices — a changed thread is re-fetched and dropped from the cache if
// it no longer carries the INBOX label. The first poll (no cursor) and manual
// "Sync now" (force) do a full sync; an expired cursor falls back to full.
import { createLogger } from '@shared/logger'
import type { GmailMessage, GmailThread } from '@swarm/protocol'

import type { GmailApi } from './api'
import type { Cache } from './cache'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-daemon' })

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
// Inbox page size for the list pager.
const PAGE_SIZE = 50

export type SyncedPayload = {
  count: number
  ts: number
  error?: string
}

export type Daemon = {
  start(): void
  stop(): void
  // force: full sync that re-fetches every listed thread even if cached (manual
  // "Sync now" — recovery path for changed replies). The background timer polls
  // incrementally via the history cursor instead.
  pollOnce(opts?: { force?: boolean }): Promise<void>
  // Fetch one page (1-based, 50 per page) of the inbox from Gmail into the cache
  // and return that page's thread ids (in list order) plus the inbox total.
  // Pages via a token sequence, so only the requested page is fetched.
  getPage(page: number): Promise<{ threadIds: string[]; total: number }>
  // Register a sync listener; fired after every pollOnce (background or manual),
  // on both success and error payloads. Returns an unsubscribe.
  onSynced(cb: (payload: SyncedPayload) => void): () => void
}

export type DaemonDeps = {
  api: GmailApi
  cache: Cache
  onSynced?(payload: SyncedPayload): void
  intervalMs?: number
}

export function createDaemon(deps: DaemonDeps): Daemon {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | null = null

  // Listeners registered via onSynced(); fired alongside the constructor dep.
  const listeners = new Set<(p: SyncedPayload) => void>()
  const fireSynced = (payload: SyncedPayload): void => {
    deps.onSynced?.(payload)
    for (const cb of listeners) {
      try {
        cb(payload)
      } catch (err) {
        log.error({ msg: 'gmail onSynced listener threw', err: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  // Fetch a set of threads and upsert them. `skipCached` avoids re-fetching
  // threads already in the cache (background full syncs), except when their
  // messages predate the htmlBody column (backfill). Returns the fetched count.
  const fetchAndUpsert = async (threadIds: string[], skipCached: boolean): Promise<number> => {
    const threads: GmailThread[] = []
    const messages: GmailMessage[] = []
    for (const id of threadIds) {
      if (skipCached && deps.cache.hasThread(id) && !deps.cache.threadMissingHtml(id)) continue
      const full = await deps.api.fetchThread(id)
      threads.push(full.thread)
      messages.push(...full.messages)
    }
    if (threads.length) deps.cache.upsertThreads(threads)
    if (messages.length) deps.cache.upsertMessages(messages)
    return threads.length
  }

  // Full sync: baseline the historyId FIRST (so nothing between here and the
  // list is lost — at worst re-applied), then list + fetch the inbox. Used on
  // first link, on manual "Sync now", and as the cursor-expired fallback.
  // skipCached=false (manual "Sync now") re-fetches every listed thread — the
  // recovery path for changed replies; true (bootstrap / expiry) only fetches
  // uncached threads.
  const fullSync = async (ts: number, skipCached: boolean): Promise<number> => {
    const { historyId } = await deps.api.getProfile()
    const { threadIds } = await deps.api.listThreads({ max: PAGE_SIZE })
    const fetched = await fetchAndUpsert(threadIds, skipCached)
    deps.cache.setStats({ messageCount: deps.cache.countMessages(), lastSyncAt: ts })
    if (historyId) deps.cache.setHistoryId(historyId)
    log.info({ msg: 'gmail full sync', fetched, historyId })
    return fetched
  }

  // Entry pageToken per 1-based page. pageTokens[0] is always undefined (page 1
  // takes no token); pageTokens[i] is the token that lists page i+1. Rebuilt from
  // page 1 on each page-1 request so shifted boundaries (new mail) self-heal.
  let pageTokens: (string | undefined)[] = [undefined]

  const getPage: Daemon['getPage'] = async (page) => {
    const target = Math.max(1, Math.trunc(page))
    if (target === 1) pageTokens = [undefined]
    // Walk forward collecting entry tokens until the target page's is known (or
    // Gmail signals no more pages). Each hop lists ids only — no body fetch.
    while (pageTokens.length < target) {
      const { nextPageToken } = await deps.api.listThreads({
        max: PAGE_SIZE,
        pageToken: pageTokens[pageTokens.length - 1],
      })
      if (nextPageToken === null) break // no further pages
      pageTokens.push(nextPageToken)
    }
    const total = await deps.api.getInboxTotal()
    if (target > pageTokens.length) return { threadIds: [], total } // beyond the end
    const { threadIds } = await deps.api.listThreads({ max: PAGE_SIZE, pageToken: pageTokens[target - 1] })
    await fetchAndUpsert(threadIds, true)
    deps.cache.setStats({ messageCount: deps.cache.countMessages(), lastSyncAt: Date.now() })
    log.info({ msg: 'gmail get page', page: target, count: threadIds.length, total })
    return { threadIds, total }
  }

  // Reconcile a changed thread against INBOX membership: re-fetch it; if it's
  // gone (404) or no longer carries INBOX (archived/trashed elsewhere), drop it
  // from the cache; otherwise upsert the fresh state. A transient fetch error is
  // logged and skipped (never deletes on a flaky fetch). Returns 1 if upserted.
  const reconcileThread = async (id: string): Promise<number> => {
    try {
      const full = await deps.api.fetchThread(id)
      if (!full.thread.labelIds.includes('INBOX')) {
        deps.cache.deleteThread(id)
        return 0
      }
      deps.cache.upsertThreads([full.thread])
      deps.cache.upsertMessages(full.messages)
      return 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('404')) {
        deps.cache.deleteThread(id)
        return 0
      }
      log.warn({ msg: 'gmail reconcile fetch failed; leaving thread as-is', threadId: id, err: msg })
      return 0
    }
  }

  // Incremental sync: ask "what changed since the cursor" — new mail, UNREAD
  // flips, and removals (archive/trash/delete). Falls back to full sync when the
  // cursor has expired.
  const incrementalSync = async (ts: number, cursor: string): Promise<number> => {
    const changes = await deps.api.getHistory(cursor)
    if (changes.expired) return fullSync(ts, true)
    // Cheap label flips first (no fetch), then reconcile changed threads — the
    // reconcile fetch is authoritative and overwrites any stale flip.
    for (const id of changes.readThreadIds) deps.cache.setThreadUnread(id, false)
    for (const id of changes.unreadThreadIds) deps.cache.setThreadUnread(id, true)
    let fetched = 0
    for (const id of changes.changedThreadIds) fetched += await reconcileThread(id)
    deps.cache.setStats({ messageCount: deps.cache.countMessages(), lastSyncAt: ts })
    deps.cache.setHistoryId(changes.newHistoryId)
    log.info({
      msg: 'gmail incremental sync',
      changed: changes.changedThreadIds.length,
      read: changes.readThreadIds.length,
      unread: changes.unreadThreadIds.length,
    })
    return fetched
  }

  const runPoll = async (opts?: { force?: boolean }): Promise<void> => {
    const ts = Date.now()
    const force = opts?.force === true
    try {
      const cursor = deps.cache.getHistoryId()
      // Force (manual Sync now) re-fetches everything; first-ever poll (no cursor)
      // bootstraps a full sync; steady-state polls go incremental via the cursor.
      const count = force
        ? await fullSync(ts, false)
        : cursor
          ? await incrementalSync(ts, cursor)
          : await fullSync(ts, true)
      fireSynced({ count, ts })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'gmail sync failed', err: msg })
      fireSynced({ count: 0, ts, error: msg })
    }
  }

  // Serialize polls. The background timer can fire while a manual "Sync now" is
  // in flight (or vice versa); running both at once double-hits the History API
  // and races setHistoryId, leaving the cursor on the older value. Chain each
  // poll after the previous so at most one runs at a time. `.catch` neutralizes
  // a prior rejection so the chain never gets permanently stuck.
  let pollChain: Promise<void> = Promise.resolve()
  const pollOnce: Daemon['pollOnce'] = (opts) => {
    const next = pollChain.catch(() => {}).then(() => runPoll(opts))
    pollChain = next
    return next
  }

  return {
    start() {
      if (timer) return
      void pollOnce()
      timer = setInterval(() => void pollOnce(), intervalMs)
      log.info({ msg: 'gmail daemon started', intervalMs })
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      log.info({ msg: 'gmail daemon stopped' })
    },
    pollOnce,
    getPage,
    onSynced(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
