import { describe, expect, it, vi } from 'vitest'

import type { ConversationStore, StoredCronJob, StoredCronRun } from '../conversation/store'
import { createCronScheduler } from './scheduler'

function fakeStore(initial: StoredCronJob[] = []) {
  const jobs = new Map(initial.map((j) => [j.id, j]))
  const sessions = new Set(initial.map((j) => j.sessionId))
  const runs = new Map<string, StoredCronRun>()
  return {
    sessions,
    runs,
    store: {
      saveCronJob: (j: StoredCronJob) => {
        jobs.set(j.id, j)
      },
      listCronJobs: () => [...jobs.values()],
      listCronJobsForSession: (sid: string) => [...jobs.values()].filter((j) => j.sessionId === sid),
      deleteCronJob: (id: string) => {
        jobs.delete(id)
      },
      reassignCronJob: (id: string, sid: string) => {
        const j = jobs.get(id)
        if (j) j.sessionId = sid
      },
      touchCronJob: (id: string, ts: number) => {
        const j = jobs.get(id)
        if (j) j.lastRunAt = ts
      },
      getSession: (id: string) => (sessions.has(id) ? { id } : undefined),
      saveCronRun: (r: StoredCronRun) => {
        runs.set(r.id, r)
      },
      attachCronRunTask: (runId: string, taskId: string) => {
        const r = runs.get(runId)
        if (r) r.taskId = taskId
      },
      finishCronRun: (runId: string, o: { status: string; error: string | null; endedAt: number }) => {
        const r = runs.get(runId)
        if (r) Object.assign(r, o)
      },
      listCronRunsForJob: (jobId: string) =>
        [...runs.values()].filter((r) => r.jobId === jobId).sort((a, b) => b.triggeredAt - a.triggeredAt),
      listRunningCronRuns: () => [...runs.values()].filter((r) => r.status === 'running'),
    } as unknown as ConversationStore,
    jobs,
  }
}

// Default terminal-registry predicates for tests that don't exercise reconcile.
// Reconcile only matters when isRunTerminal is wired; everything else just
// needs the deps shape satisfied.
const noTerminal = {
  isRunTerminal: () => false,
  runTerminalStatus: () => undefined as string | undefined,
}

describe('createCronScheduler', () => {
  it('add persists a job and returns its next run', () => {
    const { store, jobs, sessions } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn().mockReturnValue({ taskId: 'task-x' })
    const sched = createCronScheduler({ store, fire, ...noTerminal })

    const { id, nextRun } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'g', name: 'nightly' })
    expect(jobs.get(id)?.goal).toBe('g')
    expect(nextRun).toBeGreaterThan(0)
    sched.dispose()
  })

  it('routes new jobs to the session returned by resolveJobSession', () => {
    const { store, jobs, sessions } = fakeStore()
    sessions.add('caller')
    sessions.add('__system__')
    const fire = vi.fn().mockReturnValue({ taskId: 'task-x' })
    const resolveJobSession = vi.fn(() => '__system__')
    const sched = createCronScheduler({ store, fire, resolveJobSession, ...noTerminal })

    const { id } = sched.add({ sessionId: 'caller', cron: '0 0 * * *', goal: 'g' })
    expect(resolveJobSession).toHaveBeenCalledWith('caller')
    expect(jobs.get(id)?.sessionId).toBe('__system__')

    sched.runJobNow(id)
    expect(fire).toHaveBeenCalledWith('__system__', 'g', expect.any(Function))
    sched.dispose()
  })

  it('rejects an invalid cron expression', () => {
    const { store, sessions } = fakeStore()
    sessions.add('ses-1')
    const sched = createCronScheduler({ store, fire: vi.fn().mockReturnValue({ taskId: 'task-x' }), ...noTerminal })
    expect(() => sched.add({ sessionId: 'ses-1', cron: 'not-a-cron', goal: 'g' })).toThrow()
    sched.dispose()
  })

  it('fires the goal when the session still exists', () => {
    const { store, sessions } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn().mockReturnValue({ taskId: 'task-x' })
    const sched = createCronScheduler({ store, fire, ...noTerminal })
    const { id } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'do it' })
    sched.runJobNow(id)
    expect(fire).toHaveBeenCalledWith('ses-1', 'do it', expect.any(Function))
    sched.dispose()
  })

  it('cleans up instead of firing when the session is gone', () => {
    const { store, sessions, jobs } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn().mockReturnValue({ taskId: 'task-x' })
    const sched = createCronScheduler({ store, fire, ...noTerminal })
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
      originSessionId: 'ses-1',
    }
    const { store, sessions } = fakeStore([persisted])
    sessions.add('ses-1')
    const fire = vi.fn().mockReturnValue({ taskId: 'task-x' })
    const sched = createCronScheduler({ store, fire, ...noTerminal })
    sched.start()
    expect(sched.listForSession('ses-1').map((j) => j.id)).toContain('job-1')
    sched.runJobNow('job-1')
    expect(fire).toHaveBeenCalledWith('ses-1', 'reload me', expect.any(Function))
    sched.dispose()
  })

  it('start migrates legacy session-bound jobs to the resolved system session', () => {
    const legacy: StoredCronJob = {
      id: 'job-1',
      sessionId: 'old-ses',
      name: null,
      cron: '0 0 * * *',
      goal: 'remind me',
      createdAt: 1,
      lastRunAt: null,
      originSessionId: 'old-ses',
    }
    const { store, jobs, sessions } = fakeStore([legacy])
    sessions.add('old-ses')
    sessions.add('__system__')
    const resolveJobSession = vi.fn(() => '__system__')
    const sched = createCronScheduler({
      store,
      fire: vi.fn().mockReturnValue({ taskId: 't' }),
      resolveJobSession,
      ...noTerminal,
    })

    sched.start()

    expect(jobs.get('job-1')?.sessionId).toBe('__system__')
    // After migration the job fires into the system session.
    sched.runJobNow('job-1')
    sched.dispose()
  })

  it('start does not migrate when no resolveJobSession is wired', () => {
    const legacy: StoredCronJob = {
      id: 'job-1',
      sessionId: 'old-ses',
      name: null,
      cron: '0 0 * * *',
      goal: 'g',
      createdAt: 1,
      lastRunAt: null,
      originSessionId: 'old-ses',
    }
    const { store, jobs, sessions } = fakeStore([legacy])
    sessions.add('old-ses')
    const sched = createCronScheduler({ store, fire: vi.fn().mockReturnValue({ taskId: 't' }), ...noTerminal })

    sched.start()

    expect(jobs.get('job-1')?.sessionId).toBe('old-ses')
    sched.dispose()
  })

  it('listAll returns every job with a nextRun', () => {
    // arrange: add two jobs in different sessions via scheduler.add (existing helper)
    const { store, sessions } = fakeStore()
    sessions.add('ses-1')
    sessions.add('ses-2')
    const fire = vi.fn().mockReturnValue({ taskId: 'task-x' })
    const sched = createCronScheduler({ store, fire, ...noTerminal })
    sched.add({ sessionId: 'ses-1', cron: '0 9 * * *', goal: 'a' })
    sched.add({ sessionId: 'ses-2', cron: '0 10 * * *', goal: 'b' })
    const all = sched.listAll()
    expect(all).toHaveLength(2)
    expect(all.every((j) => typeof j.nextRun === 'number')).toBe(true)
    sched.dispose()
  })

  it('records a run and back-fills its outcome via onComplete', () => {
    const { store, sessions, runs } = fakeStore()
    sessions.add('ses-1')
    let captured: ((status: string, error?: string) => void) | undefined
    const fire = vi.fn((_sid: string, _goal: string, onComplete: (s: string, e?: string) => void) => {
      captured = onComplete
      return { taskId: 'task-1' }
    })
    const sched = createCronScheduler({ store, fire, ...noTerminal })
    const { id } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'g' })
    sched.runJobNow(id)

    const run = [...runs.values()][0]
    expect(run.status).toBe('running')
    expect(run.taskId).toBe('task-1')

    captured?.('completed')
    expect([...runs.values()][0].status).toBe('completed')
    sched.dispose()
  })

  it('marks the run as error when dispatch throws', () => {
    const { store, sessions, runs } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn(() => {
      throw new Error('dispatch boom')
    })
    const sched = createCronScheduler({ store, fire, ...noTerminal })
    const { id } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'g' })
    sched.runJobNow(id)

    const run = [...runs.values()][0]
    expect(run.status).toBe('error')
    expect(run.error).toBe('dispatch boom')
    expect(run.taskId).toBeNull()
    sched.dispose()
  })

  it('reconciles orphaned running runs on start', () => {
    const { store, sessions, runs } = fakeStore()
    sessions.add('ses-1')
    // a leftover running run whose target run is terminal in the registry
    runs.set('run-done', {
      id: 'run-done',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: 'r-done',
      status: 'running',
      triggeredAt: 1,
      endedAt: null,
      error: null,
    })
    // a leftover running run whose target run is not terminal (e.g. crashed mid-flight)
    runs.set('run-lost', {
      id: 'run-lost',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: 'r-gone',
      status: 'running',
      triggeredAt: 2,
      endedAt: null,
      error: null,
    })

    // Registry-backed predicates: only 'r-done' is terminal.
    const terminal = new Map([['r-done', 'completed']])
    const sched = createCronScheduler({
      store,
      fire: vi.fn().mockReturnValue({ taskId: 't' }),
      isRunTerminal: (runId) => terminal.has(runId),
      runTerminalStatus: (runId) => terminal.get(runId),
    })
    sched.start()

    expect(runs.get('run-done')?.status).toBe('completed')
    expect(runs.get('run-lost')?.status).toBe('interrupted')
    sched.dispose()
  })

  it('latestRunForJob returns the newest run, or null when none', () => {
    const { store, sessions, runs } = fakeStore()
    sessions.add('ses-1')
    const sched = createCronScheduler({ store, fire: vi.fn().mockReturnValue({ taskId: 't' }), ...noTerminal })

    expect(sched.latestRunForJob('job-1')).toBeNull()

    runs.set('r1', {
      id: 'r1',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: 't1',
      status: 'completed',
      triggeredAt: 1,
      endedAt: 2,
      error: null,
    })
    runs.set('r2', {
      id: 'r2',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: 't2',
      status: 'failed',
      triggeredAt: 5,
      endedAt: 6,
      error: 'boom',
    })

    expect(sched.latestRunForJob('job-1')?.id).toBe('r2')
    sched.dispose()
  })

  it('runsForJob returns all runs for a job, newest first', () => {
    const { store, sessions, runs } = fakeStore()
    sessions.add('ses-1')
    const sched = createCronScheduler({ store, fire: vi.fn().mockReturnValue({ taskId: 't' }), ...noTerminal })

    expect(sched.runsForJob('job-1')).toEqual([])

    runs.set('r1', {
      id: 'r1',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: 't1',
      status: 'completed',
      triggeredAt: 1,
      endedAt: 2,
      error: null,
    })
    runs.set('r2', {
      id: 'r2',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: 't2',
      status: 'failed',
      triggeredAt: 5,
      endedAt: 6,
      error: 'boom',
    })

    expect(sched.runsForJob('job-1').map((r) => r.id)).toEqual(['r2', 'r1'])
    sched.dispose()
  })
})
