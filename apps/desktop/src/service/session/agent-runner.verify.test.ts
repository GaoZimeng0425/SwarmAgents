import { describe, expect, it, vi } from 'vitest'

import { runGoalVerifyLoop } from './agent-runner'
import type { Verdict } from './verify'

const fakeSession = (statuses: Array<'completed' | 'failed' | 'cancelled'>) => {
  let i = 0
  const messages = [{ role: 'assistant', content: 'work' }]
  return {
    promptOnce: vi.fn(async (goal: string) => {
      const status = statuses[Math.min(i, statuses.length - 1)]
      i += 1
      return { status, summary: `summary for: ${goal}` }
    }),
    getUsed: () => ({ tokens: 10, calls: 1, wallMs: 5, usdCents: 1, cacheRead: 0, cacheWrite: 0 }),
    agent: { state: { messages } },
  } as unknown as Parameters<typeof runGoalVerifyLoop>[0]['session']
}

const verdict = (verdict: 'pass' | 'fail', gaps: string[] = []): Verdict & { judgeUsed?: undefined } => ({
  verdict,
  results: [],
  gaps,
})

describe('runGoalVerifyLoop', () => {
  it('completes on a passing first verdict', async () => {
    const verify = vi.fn().mockResolvedValue(verdict('pass'))
    const emit = vi.fn()
    const r = await runGoalVerifyLoop({
      session: fakeSession(['completed']),
      goal: 'do it',
      images: undefined,
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 3,
      cwd: undefined,
      emit,
      taskId: 't1',
    })
    expect(r.status).toBe('completed')
    expect(verify).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('task.verification', expect.objectContaining({ taskId: 't1' }))
  })

  it('loops back on fail then completes', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce(verdict('fail', ['add tests']))
      .mockResolvedValueOnce(verdict('pass'))
    const session = fakeSession(['completed', 'completed'])
    const r = await runGoalVerifyLoop({
      session,
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 3,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('completed')
    expect(verify).toHaveBeenCalledTimes(2)
    // round 0 goal + round 1 rework = 2 prompts
    expect(session.promptOnce as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2)
  })

  it('fails after exhausting maxRounds, with gaps in the summary', async () => {
    const verify = vi.fn().mockResolvedValue(verdict('fail', ['still broken']))
    const r = await runGoalVerifyLoop({
      session: fakeSession(['completed']),
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 1,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('failed')
    expect(r.summary).toContain('still broken')
    // round 0 + round 1 = 2 verifies at maxRounds=1
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('short-circuits when a turn does not complete (e.g. budget)', async () => {
    const verify = vi.fn()
    const r = await runGoalVerifyLoop({
      session: fakeSession(['failed']),
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 3,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('failed')
    expect(verify).not.toHaveBeenCalled()
  })

  it('folds judge usage into the returned used', async () => {
    const verify = vi.fn().mockResolvedValue({
      verdict: 'pass',
      results: [],
      gaps: [],
      judgeUsed: { tokens: 100, calls: 1, wallMs: 1, usdCents: 2, cacheRead: 0, cacheWrite: 0 },
    })
    const r = await runGoalVerifyLoop({
      session: fakeSession(['completed']),
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 3,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.used.tokens).toBe(110) // 10 session + 100 judge
  })

  it('fails fast when two consecutive rounds report identical gaps', async () => {
    const sameGaps = ['fix tests']
    const verify = vi.fn().mockResolvedValue(verdict('fail', sameGaps))
    const session = fakeSession(['completed', 'completed', 'completed'])
    const r = await runGoalVerifyLoop({
      session,
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 5,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('failed')
    expect(r.summary).toContain('not progressing')
    // round 0 fails (gaps set) → round 1 fails with the SAME gaps → stall → stop.
    // So verify is called exactly twice, not maxRounds+1 (6).
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('keeps looping when gaps change between rounds', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce(verdict('fail', ['a']))
      .mockResolvedValueOnce(verdict('fail', ['b']))
      .mockResolvedValueOnce(verdict('pass'))
    const r = await runGoalVerifyLoop({
      session: fakeSession(['completed', 'completed', 'completed']),
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 5,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('completed')
    expect(verify).toHaveBeenCalledTimes(3)
  })
})
