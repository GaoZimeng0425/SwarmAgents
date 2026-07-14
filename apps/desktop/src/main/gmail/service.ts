// src/main/gmail/service.ts
//
// Config state machine over the encrypted store + query facade over the cache.
// Mirrors budgets/web-search service. Link/unlink drive daemon lifecycle. The
// async store is mirrored into `cachedConfig` on every mutation so getView()
// stays a synchronous snapshot for ipcMain.handle. A failed persist does NOT
// advance the in-memory state.
import { createLogger } from '@shared/logger'
import type { GmailClientCreds, GmailConfigOnDisk, GmailConfigView } from '@swarm/protocol'

import type { GmailApi } from './api'
import type { Auth } from './auth'
import type { Cache } from './cache'
import type { Daemon } from './daemon'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-service' })

export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed' | 'not_linked'; message: string }

export type Service = {
  setClientCreds(creds: GmailClientCreds): Promise<SetResult>
  clearClientCreds(): Promise<SetResult>
  linkAccount(): Promise<SetResult>
  unlinkAccount(): Promise<SetResult>
  getView(): GmailConfigView
  syncNow(): Promise<void>
  search(query: string, limit: number): ReturnType<Cache['search']>
  getThread(id: string): ReturnType<Cache['getThread']>
  listRecent(input: { limit: number; label?: string }): ReturnType<Cache['listRecent']>
  getThreadAnalysis(threadId: string): ReturnType<Cache['getThreadAnalysis']>
  saveThreadAnalysis(threadId: string, analysis: import('@swarm/protocol').ThreadAnalysisPayload): void
  analyzedThreadIds(): string[]
  // Mark a thread read on Gmail (remove UNREAD) and mirror it into the cache.
  markThreadRead(threadId: string): Promise<void>
  // Fetch one 50-thread page of the inbox from Gmail into the cache and return
  // it (in list order) plus the inbox total for the pager's real page count.
  listInboxPage(page: number): Promise<{ threads: ReturnType<Cache['getThreadsByIds']>; total: number }>
  onStateChanged(cb: (view: GmailConfigView) => void): () => void
}

export type ServiceDeps = {
  store: Store
  cache: Cache
  auth: Auth
  daemon: Daemon
  api: GmailApi
}

export async function createService(deps: ServiceDeps): Promise<Service> {
  const listeners = new Set<(v: GmailConfigView) => void>()
  let cachedConfig: GmailConfigOnDisk = await deps.store.load()
  let syncError: string | null = null

  const snapshot = (): GmailConfigView => {
    const stats = deps.cache.stats()
    return {
      hasClientCreds: !!cachedConfig.clientCreds,
      loggedIn: !!cachedConfig.tokens,
      accountEmail: cachedConfig.accountEmail,
      lastSyncAt: stats.lastSyncAt || null,
      messageCount: stats.messageCount || null,
      syncError,
    }
  }
  const emit = (): void => {
    const v = snapshot()
    for (const cb of listeners) cb(v)
  }

  // If already linked at boot (tokens present), keep the daemon running.
  if (cachedConfig.tokens) deps.daemon.start()
  // Background daemon polls (5-min interval) must refresh the view too —
  // otherwise only manual Sync now broadcasts gmail:stateChanged.
  deps.daemon.onSynced(() => emit())

  return {
    async setClientCreds(creds) {
      const next: GmailConfigOnDisk = { ...cachedConfig, clientCreds: creds }
      try {
        await deps.store.save(next)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'failed to persist gmail client creds', err: msg })
        return { ok: false, code: 'persist_failed', message: msg }
      }
      cachedConfig = next
      emit()
      return { ok: true }
    },
    async clearClientCreds() {
      const next: GmailConfigOnDisk = { ...cachedConfig, clientCreds: null }
      try {
        await deps.store.save(next)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'failed to clear gmail client creds', err: msg })
        return { ok: false, code: 'persist_failed', message: msg }
      }
      cachedConfig = next
      emit()
      return { ok: true }
    },
    async linkAccount() {
      if (!cachedConfig.clientCreds) {
        return { ok: false, code: 'not_linked', message: 'missing OAuth client credentials' }
      }
      try {
        await deps.auth.login()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'gmail link account failed', err: msg })
        syncError = msg
        emit()
        return { ok: false, code: 'persist_failed', message: msg }
      }
      // auth.login persisted fresh tokens into the store; mirror them in.
      cachedConfig = await deps.store.load()
      syncError = null
      deps.daemon.start()
      log.info({ msg: 'gmail account linked', email: cachedConfig.accountEmail })
      emit()
      return { ok: true }
    },
    async unlinkAccount() {
      deps.daemon.stop()
      try {
        await deps.auth.logout()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'gmail logout failed', err: msg })
        syncError = msg
        emit()
        return { ok: false, code: 'persist_failed', message: msg }
      }
      cachedConfig = await deps.store.load()
      log.info({ msg: 'gmail account unlinked' })
      emit()
      return { ok: true }
    },
    async syncNow() {
      try {
        // Incremental poll (History API): picks up new mail, read/unread flips,
        // and deletions since the cursor — cheap, a handful of fetches. No longer
        // forces a full re-fetch; the history cursor already catches replies on
        // cached threads, and an expired cursor auto-falls-back to full.
        await deps.daemon.pollOnce()
        syncError = null
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'gmail syncNow failed', err: msg })
        syncError = msg
      }
      emit()
    },
    getView: () => snapshot(),
    search: (q, limit) => deps.cache.search(q, limit),
    getThread: (id) => deps.cache.getThread(id),
    listRecent: (input) => deps.cache.listRecent(input),
    getThreadAnalysis: (threadId) => deps.cache.getThreadAnalysis(threadId),
    saveThreadAnalysis: (threadId, analysis) => deps.cache.saveThreadAnalysis(threadId, analysis),
    analyzedThreadIds: () => deps.cache.analyzedThreadIds(),
    async listInboxPage(page) {
      const { threadIds, total } = await deps.daemon.getPage(page)
      return { threads: deps.cache.getThreadsByIds(threadIds), total }
    },
    async markThreadRead(threadId) {
      // Optimistic: flip the cache + notify the UI right away, then write to
      // Gmail. A failed write is logged (not thrown) — the next forced sync
      // reconciles from the server.
      deps.cache.setThreadUnread(threadId, false)
      emit()
      try {
        await deps.api.markThreadRead(threadId)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'gmail markThreadRead failed', threadId, err: msg })
      }
    },
    onStateChanged(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
