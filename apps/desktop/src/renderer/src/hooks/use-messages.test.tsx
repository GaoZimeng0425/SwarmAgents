// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '../lib/api'
import { useSessionsStore } from '../stores/sessions'
import { useCancelRun, useDecidePermission, useSubmitPrompt } from './use-messages'

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  useSessionsStore.setState({ sessions: [], selectedSessionId: null, unread: {} })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSubmitPrompt', () => {
  it('creates a session first when none is selected, then submits prompt with that sessionId', async () => {
    vi.spyOn(api.swarmApi, 'createSession').mockResolvedValue({ sessionId: 'ses-test' })
    vi.spyOn(api.swarmApi, 'submitPrompt').mockResolvedValue({ runId: '1' })

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useSubmitPrompt(), { wrapper: makeWrapper(qc) })

    await act(async () => {
      await result.current.mutateAsync({ prompt: 'my prompt' })
    })

    expect(api.swarmApi.createSession).toHaveBeenCalledOnce()
    expect(api.swarmApi.submitPrompt).toHaveBeenCalledWith('ses-test', 'my prompt', undefined, undefined)
    expect(useSessionsStore.getState().selectedSessionId).toBe('ses-test')
  })

  it('uses the pre-selected session without creating a new one', async () => {
    useSessionsStore.getState().select('ses-existing')
    vi.spyOn(api.swarmApi, 'submitPrompt').mockResolvedValue({ runId: '2' })
    const mockCreate = vi.spyOn(api.swarmApi, 'createSession')

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useSubmitPrompt(), { wrapper: makeWrapper(qc) })

    await act(async () => {
      await result.current.mutateAsync({ prompt: 'another prompt' })
    })

    expect(mockCreate).not.toHaveBeenCalled()
    expect(api.swarmApi.submitPrompt).toHaveBeenCalledWith('ses-existing', 'another prompt', undefined, undefined)
  })
})

describe('useDecidePermission', () => {
  it('calls decidePermission with sessionId, actionId, and decision', async () => {
    vi.spyOn(api.swarmApi, 'decidePermission').mockResolvedValue(undefined)

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useDecidePermission(), { wrapper: makeWrapper(qc) })

    await act(async () => {
      await result.current.mutateAsync({ sessionId: 'ses-1', actionId: 'act-1', decision: 'grant' })
    })

    expect(api.swarmApi.decidePermission).toHaveBeenCalledWith('ses-1', 'act-1', 'grant')
  })
})

describe('useCancelRun', () => {
  it('cancels the run for a session', async () => {
    vi.spyOn(api.swarmApi, 'cancelRun').mockResolvedValue(undefined)

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useCancelRun(), { wrapper: makeWrapper(qc) })

    await act(async () => {
      await result.current.mutateAsync('ses-9')
    })

    expect(api.swarmApi.cancelRun).toHaveBeenCalledWith('ses-9')
  })
})
