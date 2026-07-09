// src/main/calendar/service.ts
//
// Config state machine over the encrypted store + query/CRUD facade over the
// cache. Mirrors gmail/service.ts. Link/unlink drive daemon lifecycle. The
// async store is mirrored into `cachedConfig` on every mutation so getView()
// stays a synchronous snapshot for ipcMain.handle. A failed persist does NOT
// advance the in-memory state.
import { createLogger } from '@shared/logger'
import type { CalendarClientCreds, CalendarConfigOnDisk, CalendarConfigView, CalendarEvent } from '@swarm/protocol'

import type { Auth } from './auth'
import type { Cache, LocalEventInput } from './cache'
import type { Daemon } from './daemon'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'calendar-service' })

export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed' | 'not_linked'; message: string }

export type Service = {
  setClientCreds(creds: CalendarClientCreds): Promise<SetResult>
  clearClientCreds(): Promise<SetResult>
  linkAccount(): Promise<SetResult>
  unlinkAccount(): Promise<SetResult>
  getView(): CalendarConfigView
  syncNow(): Promise<void>
  listInRange(fromMs: number, toMs: number): CalendarEvent[]
  getEvent(id: string): CalendarEvent | null
  createLocal(input: LocalEventInput): CalendarEvent
  updateLocal(id: string, patch: Partial<LocalEventInput>): CalendarEvent | null
  deleteLocal(id: string): boolean
  onStateChanged(cb: (view: CalendarConfigView) => void): () => void
}

export type ServiceDeps = {
  store: Store
  cache: Cache
  auth: Auth
  daemon: Daemon
}

export async function createService(deps: ServiceDeps): Promise<Service> {
  const listeners = new Set<(v: CalendarConfigView) => void>()
  let cachedConfig: CalendarConfigOnDisk = await deps.store.load()
  let syncError: string | null = null
  let reauthRequired = false

  const snapshot = (): CalendarConfigView => {
    const stats = deps.cache.stats()
    return {
      hasClientCreds: !!cachedConfig.clientCreds,
      loggedIn: !!cachedConfig.tokens,
      accountEmail: cachedConfig.accountEmail,
      lastSyncAt: stats.lastSyncAt || null,
      googleEventCount: stats.googleCount || null,
      localEventCount: stats.localCount || null,
      syncError,
      reauthRequired,
    }
  }
  const emit = (): void => {
    const v = snapshot()
    for (const cb of listeners) cb(v)
  }

  // If already linked at boot (tokens present), keep the daemon running.
  // Otherwise stay idle and say so — otherwise the daemon is silent in the log
  // and "why aren't Google events syncing" is undiagnosable from logs alone.
  if (cachedConfig.tokens) {
    deps.daemon.start()
  } else {
    log.warn({
      msg: 'calendar daemon not started at boot: account not linked',
      hasClientCreds: !!cachedConfig.clientCreds,
    })
  }
  // Background daemon polls (and manual Sync now) update the view here — the
  // single place syncError/reauthRequired are derived, so nothing else clobbers
  // them. On reauth the auth layer already cleared the dead tokens; reload the
  // config so loggedIn flips to false and the UI prompts to re-link.
  deps.daemon.onSynced((payload) => {
    if (payload.reauthRequired) {
      reauthRequired = true
      syncError = payload.error ?? null
      void deps.store.load().then((cfg) => {
        cachedConfig = cfg
        emit()
      })
      return
    }
    reauthRequired = false
    syncError = payload.error ?? null
    emit()
  })

  return {
    async setClientCreds(creds) {
      const next: CalendarConfigOnDisk = { ...cachedConfig, clientCreds: creds }
      try {
        await deps.store.save(next)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'failed to persist calendar client creds', err: msg })
        return { ok: false, code: 'persist_failed', message: msg }
      }
      cachedConfig = next
      emit()
      return { ok: true }
    },
    async clearClientCreds() {
      const next: CalendarConfigOnDisk = { ...cachedConfig, clientCreds: null }
      try {
        await deps.store.save(next)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'failed to clear calendar client creds', err: msg })
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
        log.error({ msg: 'calendar link account failed', err: msg })
        syncError = msg
        emit()
        return { ok: false, code: 'persist_failed', message: msg }
      }
      // auth.login persisted fresh tokens into the store; mirror them in.
      cachedConfig = await deps.store.load()
      syncError = null
      reauthRequired = false
      deps.daemon.start()
      log.info({ msg: 'calendar account linked', email: cachedConfig.accountEmail })
      emit()
      return { ok: true }
    },
    async unlinkAccount() {
      deps.daemon.stop()
      reauthRequired = false
      syncError = null
      try {
        await deps.auth.logout()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'calendar logout failed', err: msg })
        syncError = msg
        emit()
        return { ok: false, code: 'persist_failed', message: msg }
      }
      cachedConfig = await deps.store.load()
      log.info({ msg: 'calendar account unlinked' })
      emit()
      return { ok: true }
    },
    async syncNow() {
      // pollOnce doesn't throw; it fires onSynced, which owns syncError/
      // reauthRequired and emits. The guard is for the unexpected only — do not
      // set syncError=null on success here or it would clobber onSynced.
      try {
        await deps.daemon.pollOnce()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'calendar syncNow failed', err: msg })
        syncError = msg
        emit()
      }
    },
    getView: () => snapshot(),
    listInRange: (fromMs, toMs) => deps.cache.listInRange(fromMs, toMs),
    getEvent: (id) => deps.cache.getEvent(id),
    createLocal: (input) => {
      const e = deps.cache.createLocal(input)
      log.info({ msg: 'calendar local event created', eventId: e.id })
      emit()
      return e
    },
    updateLocal: (id, patch) => {
      const e = deps.cache.updateLocal(id, patch)
      if (e) log.info({ msg: 'calendar local event updated', eventId: id })
      emit()
      return e
    },
    deleteLocal: (id) => {
      const ok = deps.cache.deleteLocal(id)
      if (ok) log.info({ msg: 'calendar local event deleted', eventId: id })
      emit()
      return ok
    },
    onStateChanged(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
