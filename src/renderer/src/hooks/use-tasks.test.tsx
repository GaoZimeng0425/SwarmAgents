// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UIEvent } from '@shared/types/ui'

import * as api from '../lib/api'
import { useEventsSubscription } from './use-events-subscription'
import { useTasks } from './use-tasks'

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

describe('use-tasks + use-events-subscription', () => {
  it('a task.created event populates useTasks()', async () => {
    let emit: (e: UIEvent) => void = () => {}
    vi.spyOn(api.swarmApi, 'subscribeEvents').mockImplementation((cb) => {
      emit = cb
      return () => {}
    })

    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })

    const view = renderHook(
      () => {
        useEventsSubscription()
        return useTasks()
      },
      { wrapper: makeWrapper(qc) },
    )

    // Wait for initial query to settle (queryFn resolves async even though sync)
    await waitFor(() => expect(view.result.current).toEqual([]))

    await act(async () => {
      emit({ kind: 'task.created', taskId: 't1', goal: 'do x', ts: 1 })
    })

    await waitFor(() => expect(view.result.current).toHaveLength(1))
    expect(view.result.current[0].id).toBe('t1')
  })
})
