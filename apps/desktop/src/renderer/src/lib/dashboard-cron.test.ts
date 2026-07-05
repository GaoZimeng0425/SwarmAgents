import type { CronRun, ScheduledTask } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { selectDashboardCron } from '@/lib/dashboard-cron'

const NOW = Date.UTC(2026, 5, 5, 9, 0, 0)
const DAY = 86_400_000

const job = (over: Partial<ScheduledTask> & Pick<ScheduledTask, 'id'>): ScheduledTask => ({
  sessionId: 's1',
  originSessionId: 's1',
  name: 'n',
  cron: '0 9 * * *',
  goal: 'g',
  createdAt: NOW - 10 * DAY,
  lastRunAt: null,
  nextRun: null,
  sessionTitle: null,
  originSessionTitle: null,
  ...over,
})
const cronRun = (over: Partial<CronRun> & Pick<CronRun, 'id' | 'jobId'>): CronRun => ({
  sessionId: 's1',
  taskId: null,
  status: 'completed',
  triggeredAt: NOW - DAY,
  endedAt: NOW - DAY + 60_000,
  error: null,
  ...over,
})

describe('selectDashboardCron', () => {
  it('sorts by nextRun ascending (nulls last) and limits to 5', () => {
    const jobs = [
      job({ id: 'j-null', nextRun: null }),
      job({ id: 'j-late', nextRun: NOW + 3 * DAY }),
      job({ id: 'j-soon', nextRun: NOW + DAY }),
      job({ id: 'j-now', nextRun: NOW + 60_000 }),
    ]
    const out = selectDashboardCron(jobs, [], NOW)
    expect(out.rows.map((r) => r.id)).toEqual(['j-now', 'j-soon', 'j-late', 'j-null'])
  })

  it('limits to 5 rows', () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job({ id: `j${i}`, nextRun: NOW + i * 60_000 }))
    expect(selectDashboardCron(jobs, [], NOW).rows).toHaveLength(5)
  })

  it('shows "上次成功" (green) when the job has a completed last run', () => {
    const jobs = [job({ id: 'j1', lastRunAt: NOW - DAY, nextRun: NOW + DAY })]
    const runs = [cronRun({ id: 'r1', jobId: 'j1', status: 'completed', triggeredAt: NOW - DAY })]
    const out = selectDashboardCron(jobs, runs, NOW)
    expect(out.rows[0].statusKind).toBe('success')
    expect(out.rows[0].statusLabel).toBe('上次成功')
  })

  it('shows "上次失败" (failed) when the job has a non-completed last run', () => {
    const jobs = [job({ id: 'j1', lastRunAt: NOW - DAY, nextRun: NOW + DAY })]
    const runs = [cronRun({ id: 'r1', jobId: 'j1', status: 'error', triggeredAt: NOW - DAY })]
    const out = selectDashboardCron(jobs, runs, NOW)
    expect(out.rows[0].statusKind).toBe('failed')
    expect(out.rows[0].statusLabel).toBe('上次失败')
  })

  it('shows "X 天后" (pending) when there is no past run', () => {
    const jobs = [job({ id: 'j1', lastRunAt: null, nextRun: NOW + 3 * DAY })]
    const out = selectDashboardCron(jobs, [], NOW)
    expect(out.rows[0].statusKind).toBe('pending')
    expect(out.rows[0].statusLabel).toBe('3 天后')
  })

  it('shows "明天" for a next-run 1 day out with no past run', () => {
    const jobs = [job({ id: 'j1', lastRunAt: null, nextRun: NOW + DAY })]
    expect(selectDashboardCron(jobs, [], NOW).rows[0].statusLabel).toBe('明天')
  })

  it('picks the most recent run per job for the status (newest triggeredAt)', () => {
    const jobs = [job({ id: 'j1', lastRunAt: NOW - 60_000, nextRun: NOW + DAY })]
    const runs = [
      cronRun({ id: 'old', jobId: 'j1', status: 'completed', triggeredAt: NOW - 2 * DAY }),
      cronRun({ id: 'new', jobId: 'j1', status: 'error', triggeredAt: NOW - 60_000 }),
    ]
    expect(selectDashboardCron(jobs, runs, NOW).rows[0].statusKind).toBe('failed')
  })
})
