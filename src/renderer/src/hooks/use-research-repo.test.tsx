// @vitest-environment jsdom
import type { TrendingRepo } from '@shared/types/trending'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as api from '../lib/api'
import { useSessionsStore } from '../stores/sessions'
import { buildResearchPrompt, useResearchRepo } from './use-research-repo'

// Stub the router so useNavigate() works outside a real router tree.
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigateSpy,
}))

const navigateSpy = vi.fn()

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  navigateSpy.mockReset()
})

const repo: TrendingRepo = {
  repoName: 'oven-sh/bun',
  description: 'Incredibly fast JavaScript runtime',
  language: 'Zig',
  stars: 1234,
  forks: 56,
  pullRequests: 7,
  totalScore: 88,
  contributorLogins: 'a,b',
}

describe('buildResearchPrompt', () => {
  it('includes the owner/repo, GitHub URL and metrics for the period', () => {
    const prompt = buildResearchPrompt(repo, 'past_week')
    expect(prompt).toContain('oven-sh/bun')
    expect(prompt).toContain('https://github.com/oven-sh/bun')
    expect(prompt).toContain('过去一周')
    expect(prompt).toContain('1234')
    expect(prompt).toContain('56')
    expect(prompt).toContain('7')
  })
})

describe('useResearchRepo', () => {
  it('always creates a fresh session and wires the full flow correctly', async () => {
    // Arrange: stub api methods
    const createSessionMock = vi.spyOn(api.swarmApi, 'createSession').mockResolvedValue({ sessionId: 'new-123' })
    const submitGoalMock = vi.spyOn(api.swarmApi, 'submitGoal').mockResolvedValue({ taskId: 'task-xyz' })
    const updateSessionSettingsMock = vi
      .spyOn(api.swarmApi, 'updateSessionSettings')
      .mockResolvedValue(undefined as never)

    // Spy on the sessions store select method
    const selectSpy = vi.spyOn(useSessionsStore.getState(), 'select')

    // Act: render the hook wrapped in QueryClientProvider (useSubmitGoal uses useMutation)
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } })
    const { result } = renderHook(() => useResearchRepo(), { wrapper: makeWrapper(qc) })
    await act(async () => {
      await result.current(repo, 'past_week')
    })

    // Assert: createSession called unconditionally (no pre-selected session required)
    expect(createSessionMock).toHaveBeenCalledOnce()

    // Assert: sessions store select was called with the new session id
    expect(selectSpy).toHaveBeenCalledWith('new-123')

    // Assert: submitGoal called with correct args
    expect(submitGoalMock).toHaveBeenCalledWith('new-123', expect.stringContaining('oven-sh/bun'), undefined, {
      permissionMode: 'ask',
      executionMode: 'goal',
      agentType: 'ceo',
    })

    // Assert: settings persisted — regression from original useResearchRepo that
    // bypassed useSubmitGoal and omitted the updateSessionSettings call.
    expect(updateSessionSettingsMock).toHaveBeenCalledWith('new-123', {
      cwd: undefined,
      permissionMode: 'ask',
      executionMode: 'goal',
    })

    // Assert: navigate called to the new session route
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/session/$sessionId',
      params: { sessionId: 'new-123' },
    })
  })
})
