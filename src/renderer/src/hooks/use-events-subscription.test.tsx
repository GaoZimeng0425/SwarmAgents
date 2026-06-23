// @vitest-environment jsdom

import type { UIEvent } from '@shared/types/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '../lib/api'
import { useSessionsStore } from '../stores/sessions'
import { useEventsSubscription } from './use-events-subscription'

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

function mount(): (e: UIEvent) => void {
  let emit: (e: UIEvent) => void = () => {}
  vi.spyOn(api.swarmApi, 'subscribeEvents').mockImplementation((cb) => {
    emit = cb
    return () => {}
  })
  vi.spyOn(api.swarmApi, 'consumePendingDeepLink').mockResolvedValue(null)
  vi.spyOn(api.swarmApi, 'onNavigateToSession').mockReturnValue(() => {})
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } })
  renderHook(() => useEventsSubscription(), { wrapper: makeWrapper(qc) })
  return (e) => emit(e)
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionsStore.setState({
    sessions: [
      {
        id: 'bg',
        title: 'Background',
        status: 'active',
        lastActiveAt: 1,
        taskCount: 0,
        pinned: false,
        sortOrder: 0,
        isSystem: false,
      },
    ],
    selectedSessionId: 'current',
    unread: {},
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useEventsSubscription — background session activity', () => {
  it('toasts and marks unread for a milestone event in a non-active session', async () => {
    const emit = mount()
    act(() => {
      emit({ kind: 'task.created', sessionId: 'bg', taskId: 't1', goal: 'g', ts: 1 })
    })
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1))
    expect(toast).toHaveBeenCalledWith('「Background」开始了新任务', expect.objectContaining({ id: 'activity-bg' }))
    expect(useSessionsStore.getState().unread).toEqual({ bg: true })
  })

  it('does nothing for the currently active session', async () => {
    const emit = mount()
    act(() => {
      emit({ kind: 'task.created', sessionId: 'current', taskId: 't1', goal: 'g', ts: 1 })
    })
    await waitFor(() => expect(api.swarmApi.subscribeEvents).toHaveBeenCalled())
    expect(toast).not.toHaveBeenCalled()
    expect(useSessionsStore.getState().unread).toEqual({})
  })

  it('marks unread but does not toast for non-milestone events', async () => {
    const emit = mount()
    act(() => {
      emit({
        kind: 'task.progress',
        sessionId: 'bg',
        taskId: 't1',
        event: { kind: 'reasoning', content: 'thinking', ts: 1 },
        ts: 1,
      })
    })
    await waitFor(() => expect(useSessionsStore.getState().unread).toEqual({ bg: true }))
    expect(toast).not.toHaveBeenCalled()
  })
})
