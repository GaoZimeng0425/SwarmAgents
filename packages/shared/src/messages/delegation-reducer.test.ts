import type { DelegationItem } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import {
  applyDelegationPlan,
  applyDelegationUpdate,
  type PlanItemState,
  replayDelegationEvents,
} from './delegation-reducer'

const item = (id: string, deps: string[] = []): DelegationItem => ({
  id,
  prompt: `do ${id}`,
  dependsOn: deps,
})

describe('applyDelegationPlan', () => {
  it('resets state to plan items with pending status', () => {
    const state = applyDelegationPlan(undefined, [item('d1'), item('d2', ['d1'])])
    expect(state.size).toBe(2)
    expect(state.get('d1')).toEqual({
      id: 'd1',
      prompt: 'do d1',
      dependsOn: [],
      status: 'pending',
      result: [],
    })
    expect(state.get('d2')?.status).toBe('pending')
  })

  it('overwrites previous state entirely', () => {
    const prev = applyDelegationPlan(undefined, [item('d1')])
    const next = applyDelegationPlan(prev, [item('d2')])
    expect(next.has('d1')).toBe(false)
    expect(next.has('d2')).toBe(true)
  })
})

describe('applyDelegationUpdate', () => {
  it('updates status and overwrites result', () => {
    const state = applyDelegationPlan(undefined, [item('d1')])
    const s1 = applyDelegationUpdate(state, { itemId: 'd1', status: 'running', result: [] })
    expect(s1.get('d1')?.status).toBe('running')
    const s2 = applyDelegationUpdate(s1, {
      itemId: 'd1',
      status: 'completed',
      result: [{ kind: 'note', text: 'done' }],
    })
    expect(s2.get('d1')?.status).toBe('completed')
    expect(s2.get('d1')?.result).toEqual([{ kind: 'note', text: 'done' }])
  })

  it('second update overwrites first result (not append)', () => {
    const state = applyDelegationPlan(undefined, [item('d1')])
    const s1 = applyDelegationUpdate(state, { itemId: 'd1', status: 'running', result: [] })
    const s2 = applyDelegationUpdate(s1, { itemId: 'd1', status: 'completed', result: [{ kind: 'note', text: 'A' }] })
    const s3 = applyDelegationUpdate(s2, { itemId: 'd1', status: 'completed', result: [{ kind: 'note', text: 'B' }] })
    expect(s3.get('d1')?.result).toEqual([{ kind: 'note', text: 'B' }])
  })

  it('no-op for unknown itemId (temporary delegation)', () => {
    const state = applyDelegationPlan(undefined, [item('d1')])
    const next = applyDelegationUpdate(state, { itemId: 'unknown', status: 'completed', result: [] })
    expect(next).toBe(state)
  })
})

describe('replayDelegationEvents', () => {
  it('replays plan + update events in order', () => {
    const events = [
      { kind: 'message.delegation_plan' as const, plan: [item('d1'), item('d2')] },
      { kind: 'message.delegation_update' as const, itemId: 'd1', status: 'running' as const, result: [] },
      {
        kind: 'message.delegation_update' as const,
        itemId: 'd1',
        status: 'completed' as const,
        result: [{ kind: 'note' as const, text: 'done' }],
      },
    ]
    const state = replayDelegationEvents(events)
    expect(state.get('d1')?.status).toBe('completed')
    expect(state.get('d1')?.result).toEqual([{ kind: 'note', text: 'done' }])
    expect(state.get('d2')?.status).toBe('pending')
  })

  it('returns empty map for no delegation events', () => {
    const state = replayDelegationEvents([{ kind: 'message.created' as const, prompt: 'hi' }] as never)
    expect(state.size).toBe(0)
  })

  it('includes running state (in-flight replay)', () => {
    const events = [
      { kind: 'message.delegation_plan' as const, plan: [item('d1')] },
      { kind: 'message.delegation_update' as const, itemId: 'd1', status: 'running' as const, result: [] },
    ]
    const state = replayDelegationEvents(events)
    expect(state.get('d1')?.status).toBe('running')
  })
})
