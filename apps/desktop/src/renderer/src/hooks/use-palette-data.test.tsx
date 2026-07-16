// apps/desktop/src/renderer/src/hooks/use-palette-data.test.tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Each leaf hook is mocked so the test exercises only the aggregation logic in
// usePaletteData. Note: usePaletteData itself calls useQuery (for artifacts),
// so a real QueryClient + provider wrapper is still required.
vi.mock('../stores/sessions', () => ({
  useSessionsStore: (sel: (s: any) => any) =>
    sel({
      sessions: [
        {
          id: 'sys',
          title: '系统',
          isSystem: true,
          lastActiveAt: 0,
          sortOrder: 0,
          pinned: false,
          status: 'active',
          taskCount: 0,
        },
        {
          id: 's1',
          title: 'Chat',
          isSystem: false,
          lastActiveAt: 1,
          sortOrder: 1,
          pinned: false,
          status: 'active',
          taskCount: 0,
          agentType: 'ceo',
        },
      ],
      selectedSessionId: 's1',
    }),
}))
vi.mock('./use-session-view', () => ({
  // s1 is running (and non-system); sys is running but the system session is
  // excluded from 继续未完成.
  useRunningSessions: () => new Set(['s1', 'sys']),
}))
vi.mock('./use-cron', () => ({
  useAllCronJobs: () => ({
    data: [
      {
        id: 'c1',
        sessionId: 'sys',
        name: '日报',
        cron: '0 9 * * *',
        nextRun: 1,
        lastRunAt: 0,
        lastStatus: null,
        originSessionId: null,
        sessionTitle: null,
        originSessionTitle: null,
        createdAt: 0,
        prompt: '',
      },
    ],
  }),
}))
vi.mock('./use-agents', () => ({ useTeamOptions: () => [{ id: 'ceo', label: '公司 (CEO)' }] }))
vi.mock('./use-memory', () => ({ useMemory: () => ({ entries: [], isError: false, refetch: () => {} }) }))
vi.mock('./use-skills', () => ({ useSkills: () => ({ skills: [], setSkills: () => {}, reload: () => {} }) }))
vi.mock('../lib/api', () => ({ swarmApi: { listArtifacts: vi.fn().mockResolvedValue([]) } }))

import { usePaletteData } from './use-palette-data'

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

describe('usePaletteData', () => {
  it('excludes the system session from sessions', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePaletteData(), { wrapper: makeWrapper(qc) })
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s1'])
    expect(result.current.currentSessionId).toBe('s1')
  })

  it('surfaces running non-system sessions (excludes the system session)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePaletteData(), { wrapper: makeWrapper(qc) })
    expect(result.current.runningMessages.map((r) => r.id)).toEqual(['s1'])
    expect(result.current.runningMessages[0]).toMatchObject({ sessionId: 's1', prompt: 'Chat', status: 'running' })
  })

  it('maps cron lastRunAt → lastRun and passes through formations/services', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePaletteData(), { wrapper: makeWrapper(qc) })
    expect(result.current.cronJobs).toEqual([
      { id: 'c1', sessionId: 'sys', name: '日报', cron: '0 9 * * *', nextRun: 1, lastRun: 0, lastStatus: null },
    ])
    expect(result.current.formations).toEqual([{ id: 'ceo', label: '公司 (CEO)' }])
    expect(result.current.services.map((s) => s.id)).toEqual(['bilibili', 'gmail', 'scheduled', 'trending'])
  })
})
