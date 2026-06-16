import { describe, expect, it, vi } from 'vitest'

import type { CronScheduler } from '../cron-scheduler'
import { cronSpecs } from './cron'
import type { ToolRunContext } from './registry'

const ctx: ToolRunContext = {
  sessionId: 'ses-1',
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
  askUser: async () => '',
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
    start: vi.fn(),
    runJobNow: vi.fn(),
    dispose: vi.fn(),
  }
}

const text = (r: { content: { type: string; text: string }[] }) => r.content.map((c) => c.text).join('')

describe('cronSpecs', () => {
  it('exposes schedule/list/cancel under the cron group with expected risk', () => {
    const specs = cronSpecs(fakeScheduler())
    expect(specs.map((s) => `${s.group}.${s.name}`).sort()).toEqual([
      'cron.cancel_scheduled_task',
      'cron.list_scheduled_tasks',
      'cron.schedule_task',
    ])
    const risk = (n: string) => specs.find((s) => s.name === n)!.risk
    expect(risk('schedule_task')).toBe('medium')
    expect(risk('list_scheduled_tasks')).toBe('low')
    expect(risk('cancel_scheduled_task')).toBe('low')
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

  it('list_scheduled_tasks lists jobs for the session', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched)
      .find((s) => s.name === 'list_scheduled_tasks')!
      .build(ctx)
    const res = await tool.execute('id', {})
    expect(sched.listForSession).toHaveBeenCalledWith('ses-1')
    expect(text(res as never)).toContain('nightly')
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
