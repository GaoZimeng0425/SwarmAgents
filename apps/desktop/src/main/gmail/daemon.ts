// src/main/gmail/daemon.ts
//
// Resident Gmail sync daemon. Polls the inbox on a fixed interval and upserts
// the threads/messages into the cache. v1 uses re-list + UPSERT (idempotent):
// it does NOT track deletions or older-thread updates — the `gmail.synced`
// event carries `deletionsNotTracked: true` so the limitation is visible.
import { createLogger } from '@shared/logger'

import type { GmailApi } from './api'
import type { Cache } from './cache'

import type { GmailMessage, GmailThread } from '@swarm/protocol'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-daemon' })

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

export type SyncedPayload = {
  count: number
  ts: number
  deletionsNotTracked: true
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

  const pollOnce: Daemon['pollOnce'] = async () => {
    const ts = Date.now()
    try {
      const { threadIds } = await deps.api.listThreads({ max: 200 })
      const threads: GmailThread[] = []
      const messages: GmailMessage[] = []
      for (const id of threadIds) {
        const full = await deps.api.fetchThread(id)
        threads.push(full.thread)
        messages.push(...full.messages)
      }
      deps.cache.upsertThreads(threads)
      deps.cache.upsertMessages(messages)
      deps.cache.setStats({ messageCount: messages.length, lastSyncAt: ts })
      log.info({ msg: 'gmail synced', count: threads.length })
      fireSynced({ count: threads.length, ts, deletionsNotTracked: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'gmail sync failed', err: msg })
      fireSynced({ count: 0, ts, deletionsNotTracked: true, error: msg })
    }
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
    onSynced(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
