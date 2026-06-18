import { createLogger } from '@shared/logger'
import { CronJob } from 'cron'
import { ulid } from 'ulid'

import type { ConversationStore, StoredCronJob } from './conversation-store'

const log = createLogger({ process: 'service' }).child({ component: 'cron-scheduler' })

export type CronScheduler = {
  /** Create + persist + start a job. Throws on an invalid cron expression. */
  add(input: { sessionId: string; cron: string; goal: string; name?: string }): { id: string; nextRun: number }
  remove(id: string): boolean
  listForSession(sessionId: string): Array<StoredCronJob & { nextRun: number | null }>
  listAll(): Array<StoredCronJob & { nextRun: number | null }>
  /** Re-schedule every persisted job. Call once on startup. */
  start(): void
  /** Test seam: run a scheduled job's tick body immediately. */
  runJobNow(id: string): void
  dispose(): void
}

export function createCronScheduler(deps: {
  store: ConversationStore
  fire: (sessionId: string, goal: string) => void
}): CronScheduler {
  const { store, fire } = deps
  const live = new Map<string, CronJob>()

  // The body that runs each time a job ticks. Lazy-cleans jobs whose session
  // was deleted; otherwise records the run and fires the goal.
  const tick = (job: StoredCronJob): void => {
    try {
      if (!store.getSession(job.sessionId)) {
        remove(job.id)
        return
      }
      store.touchCronJob(job.id, Date.now())
      fire(job.sessionId, job.goal)
    } catch (err) {
      log.error({ msg: 'cron tick failed', id: job.id, err: err instanceof Error ? err.message : String(err) })
    }
  }

  // Construct + start a CronJob for an already-persisted record. Throws on a
  // bad expression (CronJob validates the cronTime in its constructor).
  const schedule = (job: StoredCronJob): CronJob => {
    const cj = CronJob.from({
      cronTime: job.cron,
      onTick: () => tick(job),
      start: true,
      waitForCompletion: true,
    })
    live.set(job.id, cj)
    return cj
  }

  function remove(id: string): boolean {
    const cj = live.get(id)
    if (cj) {
      void cj.stop()
      live.delete(id)
    }
    store.deleteCronJob(id)
    return !!cj
  }

  return {
    add({ sessionId, cron, goal, name }) {
      const job: StoredCronJob = {
        id: ulid(),
        sessionId,
        name: name ?? null,
        cron,
        goal,
        createdAt: Date.now(),
        lastRunAt: null,
      }
      // Validate + start BEFORE persisting so a bad expression never lands a row.
      const cj = schedule(job)
      store.saveCronJob(job)
      return { id: job.id, nextRun: cj.nextDate().toMillis() }
    },
    remove,
    listForSession(sessionId) {
      return store.listCronJobsForSession(sessionId).map((j) => ({
        ...j,
        nextRun: live.get(j.id)?.nextDate().toMillis() ?? null,
      }))
    },
    listAll() {
      return store.listCronJobs().map((j) => ({
        ...j,
        nextRun: live.get(j.id)?.nextDate().toMillis() ?? null,
      }))
    },
    start() {
      for (const job of store.listCronJobs()) {
        try {
          schedule(job)
        } catch (err) {
          log.error({ msg: 'failed to reschedule cron job', id: job.id, err: String(err) })
        }
      }
    },
    runJobNow(id) {
      const stored = store.listCronJobs().find((j) => j.id === id)
      if (stored) tick(stored)
    },
    dispose() {
      for (const cj of live.values()) void cj.stop()
      live.clear()
    },
  }
}
