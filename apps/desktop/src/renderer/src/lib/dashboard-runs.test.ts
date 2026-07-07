import type { RunRecord } from '@shared/lib/apply-event'
import type { SessionSummary } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { latestActivity, selectDashboardRuns } from '@/lib/dashboard-runs'

const NOW = 1_000_000
const run = (over: Partial<RunRecord> & Pick<RunRecord, 'id' | 'sessionId' | 'status'>): RunRecord => ({
  goal: 'g',
  summary: null,
  startedAt: NOW - 60_000,
  attachments: [],
  events: [],
  ...over,
})
const session = (over: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary => ({
  title: 't',
  status: 'active',
  lastActiveAt: NOW,
  taskCount: 0,
  pinned: false,
  sortOrder: 0,
  isSystem: false,
  ...over,
})

describe('selectDashboardRuns', () => {
  it('partitions running/pending into `running` and awaiting_user into `awaiting`', () => {
    const runs = [
      run({ id: '1', sessionId: 's1', status: 'running' }),
      run({ id: '2', sessionId: 's2', status: 'pending' }),
      run({ id: '3', sessionId: 's3', status: 'awaiting_user' }),
      run({ id: '4', sessionId: 's4', status: 'completed' }),
      run({ id: '5', sessionId: 's5', status: 'failed' }),
    ]
    const out = selectDashboardRuns(runs, [], [], NOW)
    expect(out.running.map((r) => r.id)).toEqual(['1', '2'])
    expect(out.awaiting.map((r) => r.id)).toEqual(['3'])
  })

  it('drops sub-agent runs (parentRunId set) — only top-level runs show on the dashboard', () => {
    const runs = [
      run({ id: '1', sessionId: 's1', status: 'running' }),
      run({ id: '2', sessionId: 's1', status: 'running', parentRunId: '1' }),
    ]
    const out = selectDashboardRuns(runs, [], [], NOW)
    expect(out.running.map((r) => r.id)).toEqual(['1'])
  })

  it('sorts running newest-first by startedAt', () => {
    const runs = [
      run({ id: 'old', sessionId: 's1', status: 'running', startedAt: NOW - 10_000 }),
      run({ id: 'new', sessionId: 's2', status: 'running', startedAt: NOW - 1_000 }),
    ]
    const out = selectDashboardRuns(runs, [], [], NOW)
    expect(out.running.map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('joins session cwd + agentType and maps agentType via teamOptions', () => {
    const runs = [run({ id: '1', sessionId: 's1', status: 'running' })]
    const sessions = [session({ id: 's1', cwd: '/repo/x', agentType: 'team-a' })]
    const teamOptions = [
      { id: 'ceo', label: '默认 Agent' },
      { id: 'team-a', label: '团队 A' },
    ]
    const out = selectDashboardRuns(runs, sessions, teamOptions, NOW)
    expect(out.running[0]).toMatchObject({ cwd: '/repo/x', agentLabel: '团队 A' })
  })

  it('falls back to the raw agentType id when no teamOption matches', () => {
    const runs = [run({ id: '1', sessionId: 's1', status: 'running' })]
    const sessions = [session({ id: 's1', agentType: 'unknown' })]
    const out = selectDashboardRuns(runs, sessions, [], NOW)
    expect(out.running[0].agentLabel).toBe('unknown')
  })

  it('computes wallMs from now - startedAt', () => {
    const runs = [run({ id: '1', sessionId: 's1', status: 'running', startedAt: NOW - 60_000 })]
    const out = selectDashboardRuns(runs, [], [], NOW)
    expect(out.running[0].wallMs).toBe(60_000)
  })

  it('derives step progress `${completed}/${total}` from plan, null when no plan', () => {
    const withPlan = run({
      id: '1',
      sessionId: 's1',
      status: 'running',
      plan: [
        { status: 'completed', content: 'a' },
        { status: 'in_progress', content: 'b' },
        { status: 'pending', content: 'c' },
      ] as RunRecord['plan'],
    })
    const noPlan = run({ id: '2', sessionId: 's2', status: 'running' })
    const out = selectDashboardRuns([withPlan, noPlan], [], [], NOW)
    expect(out.running[0].steps).toBe('1/3')
    expect(out.running[1].steps).toBeNull()
  })
})

const toolCall = (tool: string, args: unknown, seq: number): RunRecord['events'][number] =>
  ({ kind: 'run.tool_call', sessionId: 's1', runId: '1', seq, ts: seq, tool, args }) as RunRecord['events'][number]

describe('latestActivity', () => {
  it('returns null when there are no tool calls', () => {
    expect(latestActivity([])).toBeNull()
  })

  it('formats the most recent tool call as `${tool} ${argHint}`, newest wins', () => {
    const events = [
      toolCall('Read', { file_path: '/a.ts' }, 1),
      toolCall('Bash', { command: 'pnpm vitest auth.test.ts' }, 2),
    ]
    expect(latestActivity(events)).toBe('Bash pnpm vitest auth.test.ts')
  })

  it('falls back to the bare tool name when args carries no display string', () => {
    expect(latestActivity([toolCall('WebSearch', { limit: 5 }, 1)])).toBe('WebSearch')
  })

  it('picks file_path / pattern / url for non-command tools', () => {
    expect(latestActivity([toolCall('Grep', { pattern: 'TODO' }, 1)])).toBe('Grep TODO')
    expect(latestActivity([toolCall('WebFetch', { url: 'https://x.dev' }, 1)])).toBe('WebFetch https://x.dev')
  })

  it('is surfaced on DashboardRun.activity', () => {
    const r = run({ id: '1', sessionId: 's1', status: 'running', events: [toolCall('Bash', { command: 'ls' }, 1)] })
    expect(selectDashboardRuns([r], [], [], NOW).running[0].activity).toBe('Bash ls')
  })
})
