// @vitest-environment jsdom

import type { UIEvent } from '@swarm/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '../lib/api'
import { usePermissionStore } from '../stores/permission'
import { useSessionsStore } from '../stores/sessions'
import { useEventsSubscription } from './use-events-subscription'
import { hydrateSession, RUNS_KEY, useDecidePermission, useSubmitGoal, useTasks } from './use-tasks'

// useEventsSubscription now navigates (toast jump) + toasts on background
// activity; stub both so rendering it here needs no router/Toaster.
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}))

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  useSessionsStore.setState({ sessions: [], selectedSessionId: null, unread: {} })
  usePermissionStore.setState({ queue: [] })
  // useEventsSubscription pulls deep links + subscribes to navigation on mount;
  // stub both so tests that render it don't touch an undefined window.swarm.
  vi.spyOn(api.swarmApi, 'consumePendingDeepLink').mockResolvedValue(null)
  vi.spyOn(api.swarmApi, 'onNavigateToSession').mockReturnValue(() => {})
  vi.spyOn(api.swarmApi, 'onNavigateToSettings').mockReturnValue(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('use-tasks + use-events-subscription', () => {
  it('a task.created event populates useTasks()', async () => {
    let emit: (e: UIEvent) => void = () => {}
    vi.spyOn(api.swarmApi, 'subscribeEvents').mockImplementation((cb) => {
      emit = cb
      return () => {}
    })

    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } })

    const view = renderHook(
      () => {
        useEventsSubscription()
        return useTasks()
      },
      { wrapper: makeWrapper(qc) }
    )

    // Wait for initial query to settle (queryFn resolves async even though sync)
    await waitFor(() => expect(view.result.current).toEqual([]))

    await act(async () => {
      emit({ kind: 'task.created', sessionId: 'ses-1', taskId: 't1', goal: 'do x', ts: 1 })
    })

    await waitFor(() => expect(view.result.current).toHaveLength(1))
    expect(view.result.current[0].id).toBe('t1')
    expect(view.result.current[0].sessionId).toBe('ses-1')
  })

  it('a high-risk permission_request goes into the permission store (no native dialog)', async () => {
    let emit: (e: UIEvent) => void = () => {}
    vi.spyOn(api.swarmApi, 'subscribeEvents').mockImplementation((cb) => {
      emit = cb
      return () => {}
    })

    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } })
    renderHook(() => useEventsSubscription(), { wrapper: makeWrapper(qc) })

    act(() => {
      emit({
        kind: 'task.permission_request',
        ts: 1,
        sessionId: 'sess-1',
        taskId: 'task-1',
        workerId: 'w-1',
        actionId: 'act-9',
        risk: 'high',
        summary: 'rm -rf /tmp/x',
        payload: { cmd: 'rm -rf /tmp/x' },
      })
    })

    await waitFor(() => {
      expect(usePermissionStore.getState().queue.some((p) => p.actionId === 'act-9')).toBe(true)
    })
  })
})

describe('useSubmitGoal', () => {
  it('creates a session first when none is selected, then submits goal with that sessionId', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ sessionId: 'ses-test' })
    const mockSubmitGoal = vi.fn().mockResolvedValue({ taskId: 'task-1' })

    // Stub window.swarm
    Object.defineProperty(window, 'swarm', {
      value: {
        sessions: { create: mockCreate, list: vi.fn(), getTasks: vi.fn() },
        submitGoal: mockSubmitGoal,
        cancelTask: vi.fn(),
        decidePermission: vi.fn(),
        subscribeEvents: vi.fn(() => () => {}),
      },
      writable: true,
      configurable: true,
    })

    vi.spyOn(api.swarmApi, 'createSession').mockImplementation(() => mockCreate())
    vi.spyOn(api.swarmApi, 'submitGoal').mockImplementation((sessionId, goal) => mockSubmitGoal(sessionId, goal))

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useSubmitGoal(), { wrapper: makeWrapper(qc) })

    await act(async () => {
      await result.current.mutateAsync({ goal: 'my goal' })
    })

    expect(api.swarmApi.createSession).toHaveBeenCalledOnce()
    expect(api.swarmApi.submitGoal).toHaveBeenCalledWith('ses-test', 'my goal', undefined, undefined)
    // Session should now be selected
    expect(useSessionsStore.getState().selectedSessionId).toBe('ses-test')
  })

  it('uses the pre-selected session without creating a new one', async () => {
    useSessionsStore.getState().select('ses-existing')

    const mockSubmitGoal = vi.fn().mockResolvedValue({ taskId: 'task-2' })
    vi.spyOn(api.swarmApi, 'submitGoal').mockImplementation((sessionId, goal) => mockSubmitGoal(sessionId, goal))
    const mockCreate = vi.fn()
    vi.spyOn(api.swarmApi, 'createSession').mockImplementation(mockCreate)

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useSubmitGoal(), { wrapper: makeWrapper(qc) })

    await act(async () => {
      await result.current.mutateAsync({ goal: 'another goal' })
    })

    expect(api.swarmApi.createSession).not.toHaveBeenCalled()
    expect(api.swarmApi.submitGoal).toHaveBeenCalledWith('ses-existing', 'another goal', undefined, undefined)
  })
})

describe('useDecidePermission', () => {
  it('calls decidePermission with sessionId, actionId, and decision', async () => {
    const mockDecide = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(api.swarmApi, 'decidePermission').mockImplementation(mockDecide)

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useDecidePermission(), { wrapper: makeWrapper(qc) })

    await act(async () => {
      await result.current.mutateAsync({ sessionId: 'ses-1', actionId: 'act-1', decision: 'grant' })
    })

    expect(api.swarmApi.decidePermission).toHaveBeenCalledWith('ses-1', 'act-1', 'grant')
  })
})

describe('hydrateSession', () => {
  it('replays run_events into RunRecords via applyEvent', async () => {
    const rows: import('@swarm/protocol').RunEvent[] = [
      {
        runId: 'r1',
        parentRunId: null,
        seq: 1,
        ts: 1,
        event: { kind: 'task.created', sessionId: 's', taskId: 'r1', goal: 'hi', ts: 1, seq: 1 },
      },
      {
        runId: 'r1',
        parentRunId: null,
        seq: 2,
        ts: 2,
        event: { kind: 'task.complete', sessionId: 's', taskId: 'r1', summary: 'done', ts: 2, seq: 2 },
      },
    ]
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    // The old adapter sources return nothing so the test fails on the assertion
    // (status !== 'completed') until hydrateSession reads getRunEvents.
    vi.spyOn(api.swarmApi, 'getRunEvents').mockResolvedValue(rows)

    await hydrateSession(qc, 's')

    const records = qc.getQueryData<import('@shared/lib/apply-event').RunRecord[]>(RUNS_KEY) ?? []
    expect(records.find((r) => r.id === 'r1')?.status).toBe('completed')
    expect(records.find((r) => r.id === 'r1')?.goal).toBe('hi')
  })
})
