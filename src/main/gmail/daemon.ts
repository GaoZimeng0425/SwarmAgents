// src/main/gmail/daemon.ts
//
// Resident Gmail sync daemon. Polls the inbox on a fixed interval and upserts
// the threads/messages into the cache. v1 uses re-list + UPSERT (idempotent):
// it does NOT track deletions or older-thread updates — the `gmail.synced`
// event carries `deletionsNotTracked: true` so the limitation is visible.
import { createLogger } from '@shared/logger'

import type { GmailApi } from './api'
import type { Cache } from './cache'

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

  const pollOnce: Daemon['pollOnce'] = async () => {
    const ts = Date.now()
    try {
      const { threadIds } = await deps.api.listThreads({ max: 200 })
      const threads = []
      const messages = []
      for (const id of threadIds) {
        const full = await deps.api.fetchThread(id)
        threads.push(full.thread)
        messages.push(...full.messages)
      }
      deps.cache.upsertThreads(threads)
      deps.cache.upsertMessages(messages)
      deps.cache.setStats({ messageCount: messages.length, lastSyncAt: ts })
      log.info({ msg: 'gmail synced', count: threads.length })
      deps.onSynced?.({ count: threads.length, ts, deletionsNotTracked: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'gmail sync failed', err: msg })
      deps.onSynced?.({ count: 0, ts, deletionsNotTracked: true, error: msg })
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
  }
}
