import { createLogger } from '@shared/logger'
import { CronJob } from 'cron'
import { ulid } from 'ulid'

import type { ConversationStore, StoredCronJob, StoredCronRun } from '../conversation/store'

const log = createLogger({ process: 'service' }).child({ component: 'cron-scheduler' })

export type CronScheduler = {
  /** Create + persist + start a job. Throws on an invalid cron expression. */
  add(input: { sessionId: string; cron: string; goal: string; name?: string }): { id: string; nextRun: number }
  remove(id: string): boolean
  listForSession(sessionId: string): Array<StoredCronJob & { nextRun: number | null }>
  listAll(): Array<StoredCronJob & { nextRun: number | null }>
  /** The most recent run record for a job, or null if it has never fired. */
  latestRunForJob(id: string): StoredCronRun | null
  /** Every persisted run record for a job, newest first. */
  runsForJob(id: string): StoredCronRun[]
  /** Re-schedule every persisted job. Call once on startup. */
  start(): void
  /** Test seam: run a scheduled job's tick body immediately. */
  runJobNow(id: string): void
  dispose(): void
}

export function createCronScheduler(deps: {
  store: ConversationStore
  fire: (sessionId: string, goal: string, onComplete: (status: string, error?: string) => void) => { taskId: string }
  /**
   * Maps the calling session to the session a new job should be owned by and
   * fired into. Production wires this to the system session so jobs are global
   * and survive deletion of the conversation that created them. Omitted in
   * tests → jobs stay bound to the caller session.
   */
  resolveJobSession?: (fromSessionId: string) => string
}): CronScheduler {
  const { store, fire, resolveJobSession } = deps
  const live = new Map<string, CronJob>()

  // The body that runs each time a job ticks. Lazy-cleans jobs whose session
  // was deleted; otherwise records the run and fires the goal.
  const tick = (job: StoredCronJob): void => {
    if (!store.getSession(job.sessionId)) {
      remove(job.id)
      return
    }
    const runId = ulid()
    const triggeredAt = Date.now()
    const runLog = log.child({ jobId: job.id, runId })
    store.touchCronJob(job.id, triggeredAt)
    store.saveCronRun({
      id: runId,
      jobId: job.id,
      sessionId: job.sessionId,
      taskId: null,
      status: 'running',
      triggeredAt,
      endedAt: null,
      error: null,
    })
    runLog.info({ msg: 'cron run started', sessionId: job.sessionId })
    try {
      const { taskId } = fire(job.sessionId, job.goal, (status, error) => {
        store.finishCronRun(runId, { status, error: error ?? null, endedAt: Date.now() })
        runLog.info({
          msg: 'cron run finished',
          taskId,
          status,
          durationMs: Date.now() - triggeredAt,
          ...(error ? { error } : {}),
        })
      })
      store.attachCronRunTask(runId, taskId)
      runLog.info({ msg: 'cron run dispatched', taskId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.finishCronRun(runId, { status: 'error', error: message, endedAt: Date.now() })
      runLog.error({ msg: 'cron run dispatch failed', err: message })
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

  // Finalize runs left 'running' by a crash/restart: their in-memory onComplete
  // is gone, so derive the outcome from the task's persisted status, or mark
  // 'interrupted' when the task can't be confirmed.
  const reconcile = (): void => {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
    for (const run of store.listRunningCronRuns()) {
      const task = run.taskId ? store.getTask(run.taskId) : undefined
      if (task && terminal.has(task.status)) {
        // error stays null here: a reconciled failure's message lives on the
        // task (reachable via taskId), unlike the live onComplete path.
        store.finishCronRun(run.id, { status: task.status, error: null, endedAt: task.endedAt ?? Date.now() })
        log.warn({ msg: 'cron run reconciled', runId: run.id, jobId: run.jobId, status: task.status })
      } else {
        store.finishCronRun(run.id, { status: 'interrupted', error: null, endedAt: Date.now() })
        log.warn({ msg: 'cron run reconciled', runId: run.id, jobId: run.jobId, status: 'interrupted' })
      }
    }
  }

  return {
    add({ sessionId, cron, goal, name }) {
      // Route ownership to the resolved (system) session so the job is global,
      // not tied to the conversation that issued schedule_task.
      const ownerSessionId = resolveJobSession ? resolveJobSession(sessionId) : sessionId
      const job: StoredCronJob = {
        id: ulid(),
        sessionId: ownerSessionId,
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
    latestRunForJob(id) {
      // listCronRunsForJob is ordered newest-first, so the head is the latest.
      return store.listCronRunsForJob(id)[0] ?? null
    },
    runsForJob(id) {
      return store.listCronRunsForJob(id)
    },
    start() {
      for (const job of store.listCronJobs()) {
        try {
          schedule(job)
        } catch (err) {
          log.error({ msg: 'failed to reschedule cron job', id: job.id, err: String(err) })
        }
      }
      reconcile()
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
