import { describe, expect, it, vi } from 'vitest'

import type { ConversationStore, StoredCronJob } from './conversation-store'
import { createCronScheduler } from './cron-scheduler'

function fakeStore(initial: StoredCronJob[] = []) {
  const jobs = new Map(initial.map((j) => [j.id, j]))
  const sessions = new Set(initial.map((j) => j.sessionId))
  return {
    sessions,
    store: {
      saveCronJob: (j: StoredCronJob) => {
        jobs.set(j.id, j)
      },
      listCronJobs: () => [...jobs.values()],
      listCronJobsForSession: (sid: string) => [...jobs.values()].filter((j) => j.sessionId === sid),
      deleteCronJob: (id: string) => {
        jobs.delete(id)
      },
      touchCronJob: (id: string, ts: number) => {
        const j = jobs.get(id)
        if (j) j.lastRunAt = ts
      },
      getSession: (id: string) => (sessions.has(id) ? { id } : undefined),
    } as unknown as ConversationStore,
    jobs,
  }
}

describe('createCronScheduler', () => {
  it('add persists a job and returns its next run', () => {
    const { store, jobs, sessions } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn()
    const sched = createCronScheduler({ store, fire })

    const { id, nextRun } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'g', name: 'nightly' })
    expect(jobs.get(id)?.goal).toBe('g')
    expect(nextRun).toBeGreaterThan(0)
    sched.dispose()
  })

  it('rejects an invalid cron expression', () => {
    const { store, sessions } = fakeStore()
    sessions.add('ses-1')
    const sched = createCronScheduler({ store, fire: vi.fn() })
    expect(() => sched.add({ sessionId: 'ses-1', cron: 'not-a-cron', goal: 'g' })).toThrow()
    sched.dispose()
  })

  it('fires the goal when the session still exists', () => {
    const { store, sessions } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn()
    const sched = createCronScheduler({ store, fire })
    const { id } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'do it' })
    sched.runJobNow(id)
    expect(fire).toHaveBeenCalledWith('ses-1', 'do it')
    sched.dispose()
  })

  it('cleans up instead of firing when the session is gone', () => {
    const { store, sessions, jobs } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn()
    const sched = createCronScheduler({ store, fire })
    const { id } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'g' })
    sessions.delete('ses-1')
    sched.runJobNow(id)
    expect(fire).not.toHaveBeenCalled()
    expect(jobs.has(id)).toBe(false)
    sched.dispose()
  })

  it('start re-schedules persisted jobs', () => {
    const persisted: StoredCronJob = {
      id: 'job-1',
      sessionId: 'ses-1',
      name: null,
      cron: '0 0 * * *',
      goal: 'reload me',
      createdAt: 1,
      lastRunAt: null,
    }
    const { store, sessions } = fakeStore([persisted])
    sessions.add('ses-1')
    const fire = vi.fn()
    const sched = createCronScheduler({ store, fire })
    sched.start()
    expect(sched.listForSession('ses-1').map((j) => j.id)).toContain('job-1')
    sched.runJobNow('job-1')
    expect(fire).toHaveBeenCalledWith('ses-1', 'reload me')
    sched.dispose()
  })

  it('listAll returns every job with a nextRun', () => {
    // arrange: add two jobs in different sessions via scheduler.add (existing helper)
    const { store, sessions } = fakeStore()
    sessions.add('ses-1')
    sessions.add('ses-2')
    const fire = vi.fn()
    const sched = createCronScheduler({ store, fire })
    sched.add({ sessionId: 'ses-1', cron: '0 9 * * *', goal: 'a' })
    sched.add({ sessionId: 'ses-2', cron: '0 10 * * *', goal: 'b' })
    const all = sched.listAll()
    expect(all).toHaveLength(2)
    expect(all.every((j) => typeof j.nextRun === 'number')).toBe(true)
    sched.dispose()
  })
})
