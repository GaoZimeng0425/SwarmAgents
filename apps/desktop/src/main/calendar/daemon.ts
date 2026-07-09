// src/main/calendar/daemon.ts
//
// Resident Calendar sync daemon. Polls the primary calendar on a fixed
// interval and reconciles the events into the cache over a window spanning 30
// days back to 90 days forward. Each poll re-lists the window and makes the
// cache match it: events added/changed remotely are upserted, events
// deleted/moved out of the window are pruned — so the cache tracks the remote.
// Events outside the window are neither fetched nor pruned. The `calendar.synced`
// event carries `pastDays`/`futureDays` so the window is visible. Mirrors
// gmail/daemon.ts.
import { createLogger } from '@shared/logger'

import type { CalendarApi } from './api'
import type { Cache } from './cache'

const log = createLogger({ process: 'main' }).child({ component: 'calendar-daemon' })

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// Look back far enough to surface recent past events (Google's timeMin is
// forward-only otherwise), and forward for upcoming ones.
const PAST_WINDOW_MS = 30 * DAY_MS
const FUTURE_WINDOW_MS = 90 * DAY_MS

export type SyncedPayload = {
  count: number
  ts: number
  pastDays: number
  futureDays: number
  error?: string
}

export type Daemon = {
  start(): void
  stop(): void
  pollOnce(): Promise<void>
  // Register a sync listener; fired after every pollOnce (background or manual),
  // on both success and error payloads. Returns an unsubscribe.
  onSynced(cb: (payload: SyncedPayload) => void): () => void
}

export type DaemonDeps = {
  api: CalendarApi
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
        log.error({
          msg: 'calendar onSynced listener threw',
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  const pollOnce: Daemon['pollOnce'] = async () => {
    const ts = Date.now()
    const fromMs = ts - PAST_WINDOW_MS
    const toMs = ts + FUTURE_WINDOW_MS
    try {
      const rows = await deps.api.listUpcoming({ calendarId: 'primary', fromMs, toMs })
      const { deleted } = deps.cache.reconcileGoogleWindow({ calendarId: 'primary', fromMs, toMs, rows })
      deps.cache.setStats({ lastSyncAt: ts })
      log.info({ msg: 'calendar synced', count: rows.length, pruned: deleted })
      fireSynced({ count: rows.length, ts, pastDays: 30, futureDays: 90 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'calendar sync failed', err: msg })
      fireSynced({ count: 0, ts, pastDays: 30, futureDays: 90, error: msg })
    }
  }

  return {
    start() {
      if (timer) return
      void pollOnce()
      timer = setInterval(() => void pollOnce(), intervalMs)
      log.info({ msg: 'calendar daemon started', intervalMs })
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      log.info({ msg: 'calendar daemon stopped' })
    },
    pollOnce,
    onSynced(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
