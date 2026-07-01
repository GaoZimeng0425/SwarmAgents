import { describe, expect, it, vi } from 'vitest'

import type { CronScheduler } from '../cron/scheduler'
import { cronSpecs } from './cron'
import type { ToolRunContext } from './registry'

const ctx: ToolRunContext = {
  sessionId: 'ses-1',
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
}

function fakeScheduler(): CronScheduler {
  return {
    add: vi.fn(() => ({ id: 'job-1', nextRun: 1_000_000 })),
    remove: vi.fn(() => true),
    listForSession: vi.fn(() => [
      {
        id: 'job-1',
        sessionId: 'ses-1',
        name: 'nightly',
        cron: '0 0 * * *',
        goal: 'g',
        createdAt: 1,
        lastRunAt: null,
        nextRun: 1_000_000,
      },
    ]),
    listAll: vi.fn(() => [
      {
        id: 'job-1',
        sessionId: 'other-session',
        name: 'nightly',
        cron: '0 0 * * *',
        goal: 'g',
        createdAt: 1,
        lastRunAt: null,
        nextRun: 1_000_000,
      },
    ]),
    start: vi.fn(),
    runJobNow: vi.fn(),
    dispose: vi.fn(),
    latestRunForJob: vi.fn(() => ({
      id: 'run-1',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: 'task-1',
      status: 'completed',
      triggeredAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_500,
      error: null,
    })),
    runsForJob: vi.fn(() => [
      {
        id: 'run-2',
        jobId: 'job-1',
        sessionId: 'ses-1',
        taskId: 'task-2',
        status: 'failed',
        triggeredAt: 1_700_000_100_000,
        endedAt: 1_700_000_101_000,
        error: 'provider 503',
      },
      {
        id: 'run-1',
        jobId: 'job-1',
        sessionId: 'ses-1',
        taskId: 'task-1',
        status: 'completed',
        triggeredAt: 1_700_000_000_000,
        endedAt: 1_700_000_000_500,
        error: null,
      },
    ]),
  }
}

const text = (r: { content: { type: string; text: string }[] }) => r.content.map((c) => c.text).join('')

describe('cronSpecs', () => {
  it('exposes schedule/list/cancel under the cron group with expected risk', () => {
    const specs = cronSpecs(fakeScheduler())
    expect(specs.map((s) => `${s.group}.${s.name}`).sort()).toEqual([
      'cron.cancel_scheduled_task',
      'cron.list_scheduled_tasks',
      'cron.list_task_runs',
      'cron.schedule_task',
    ])
    const risk = (n: string) => specs.find((s) => s.name === n)!.risk
    expect(risk('schedule_task')).toBe('medium')
    expect(risk('list_scheduled_tasks')).toBe('low')
    expect(risk('cancel_scheduled_task')).toBe('low')
    expect(risk('list_task_runs')).toBe('low')
  })

  it('schedule_task binds to ctx.sessionId and returns the job id', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'schedule_task')!
      .build(ctx)
    const res = await tool.execute('id', { cron: '0 9 * * *', goal: 'summarize inbox', name: 'am' })
    expect(sched.add).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      cron: '0 9 * * *',
      goal: 'summarize inbox',
      name: 'am',
    })
    expect(text(res as never)).toContain('job-1')
  })

  it('schedule_task returns an error result on an invalid expression', async () => {
    const sched = fakeScheduler()
    ;(sched.add as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('bad cron')
    })
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'schedule_task')!
      .build(ctx)
    const res = await tool.execute('id', { cron: 'nope', goal: 'g' })
    expect(text(res as never)).toContain('error')
  })

  it('list_scheduled_tasks lists all jobs globally, not just the caller session', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'list_scheduled_tasks')!
      .build(ctx)
    const res = await tool.execute('id', {})
    expect(sched.listAll).toHaveBeenCalled()
    expect(sched.listForSession).not.toHaveBeenCalled()
    expect(text(res as never)).toContain('nightly')
    // execution status surfaced from the latest run
    expect(sched.latestRunForJob).toHaveBeenCalledWith('job-1')
    expect(text(res as never)).toContain('last completed')
  })

  it('list_scheduled_tasks shows "never" when a job has not run yet', async () => {
    const sched = fakeScheduler()
    ;(sched.latestRunForJob as ReturnType<typeof vi.fn>).mockReturnValue(null)
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'list_scheduled_tasks')!
      .build(ctx)
    const res = await tool.execute('id', {})
    expect(text(res as never)).toContain('last never')
  })

  it('list_task_runs returns the run history for a job', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'list_task_runs')!
      .build(ctx)
    const res = await tool.execute('id', { id: 'job-1' })
    expect(sched.runsForJob).toHaveBeenCalledWith('job-1')
    const out = text(res as never)
    expect(out).toContain('failed')
    expect(out).toContain('completed')
    expect(out).toContain('provider 503')
    expect(out).toContain('task-2')
  })

  it('list_task_runs requires an id', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'list_task_runs')!
      .build(ctx)
    const res = await tool.execute('id', {})
    expect(text(res as never)).toContain('error')
  })

  it('list_task_runs reports when a job has no runs', async () => {
    const sched = fakeScheduler()
    ;(sched.runsForJob as ReturnType<typeof vi.fn>).mockReturnValue([])
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'list_task_runs')!
      .build(ctx)
    const res = await tool.execute('id', { id: 'job-9' })
    expect(text(res as never)).toContain('no runs')
  })

  it('list_task_runs respects the limit', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'list_task_runs')!
      .build(ctx)
    const res = await tool.execute('id', { id: 'job-1', limit: 1 })
    const lines = text(res as never)
      .split('\n')
      .filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(1)
    // newest first: the failed run is kept, the older completed run dropped
    expect(lines[0]).toContain('failed')
  })

  it('cancel_scheduled_task removes by id', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'cancel_scheduled_task')!
      .build(ctx)
    const res = await tool.execute('id', { id: 'job-1' })
    expect(sched.remove).toHaveBeenCalledWith('job-1')
    expect(text(res as never)).toContain('cancelled')
  })
})
