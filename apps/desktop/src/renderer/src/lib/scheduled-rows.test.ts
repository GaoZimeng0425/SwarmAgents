import type { MessageRecord } from '@shared/lib/apply-event'
import type { CronRun } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildScheduledRows, collectSubtree, formatDuration } from './scheduled-rows'

const task = (over: Partial<MessageRecord> & { id: string }): MessageRecord => ({
  sessionId: '__system__',
  prompt: 'goal',
  status: 'completed',
  summary: null,
  createdAt: 0,
  attachments: [],
  order: 0,
  events: [],
  ...over,
})

const run = (over: Partial<CronRun> & { id: string; jobId: string; taskId: string | null }): CronRun => ({
  sessionId: '__system__',
  status: 'completed',
  triggeredAt: 0,
  endedAt: null,
  error: null,
  ...over,
})

describe('buildScheduledRows', () => {
  it('uses the cron job name when a run links the task to a named job', () => {
    const tasks = [task({ id: 't1', prompt: 'raw goal', createdAt: 100, summary: 'done' })]
    const runs = [run({ id: 'r1', jobId: 'j1', taskId: 't1' })]
    const jobs = [{ id: 'j1', name: 'Daily report' }]
    const rows = buildScheduledRows(tasks, runs, jobs)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ messageId: 't1', name: 'Daily report', status: 'completed', summary: 'done' })
  })

  it('falls back to task.prompt when there is no run, no job, or a null job name', () => {
    const tasks = [task({ id: 't1', prompt: 'fallback goal' })]
    expect(buildScheduledRows(tasks, [], []).at(0)?.name).toBe('fallback goal')
    const runs = [run({ id: 'r1', jobId: 'j1', taskId: 't1' })]
    expect(buildScheduledRows(tasks, runs, [{ id: 'j1', name: null }]).at(0)?.name).toBe('fallback goal')
  })

  it('surfaces the run error and the wallMs duration', () => {
    const tasks = [
      task({
        id: 't1',
        status: 'failed',
        used: { tokens: 0, calls: 0, wallMs: 3200, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ]
    const runs = [run({ id: 'r1', jobId: 'j1', taskId: 't1', status: 'failed', error: 'boom' })]
    const rows = buildScheduledRows(tasks, runs, [{ id: 'j1', name: 'Job' }])
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'boom', durationMs: 3200 })
  })

  it('excludes sub-agent tasks and sorts newest first', () => {
    const tasks = [
      task({ id: 'old', createdAt: 100 }),
      task({ id: 'new', createdAt: 200 }),
      task({ id: 'child', createdAt: 250, parentMessageId: 'new' }),
    ]
    const rows = buildScheduledRows(tasks, [], [])
    expect(rows.map((r) => r.messageId)).toEqual(['new', 'old'])
  })
})

describe('collectSubtree', () => {
  it('returns the root plus its transitive descendants', () => {
    const tasks = [
      task({ id: 'root' }),
      task({ id: 'a', parentMessageId: 'root' }),
      task({ id: 'b', parentMessageId: 'a' }),
      task({ id: 'other' }),
    ]
    const ids = collectSubtree(tasks, 'root')
      .map((t) => t.id)
      .sort()
    expect(ids).toEqual(['a', 'b', 'root'])
  })

  it('returns [] for an unknown root', () => {
    expect(collectSubtree([task({ id: 'x' })], 'missing')).toEqual([])
  })
})

describe('formatDuration', () => {
  it('formats ms / s / m+s', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(120)).toBe('120ms')
    expect(formatDuration(3200)).toBe('3.2s')
    expect(formatDuration(59_999)).toBe('1m 0s')
    expect(formatDuration(125_000)).toBe('2m 5s')
  })
})
