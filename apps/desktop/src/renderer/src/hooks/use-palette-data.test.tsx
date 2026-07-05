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
vi.mock('./use-runs', () => ({
  useRuns: () => [
    { id: 'r1', sessionId: 's1', goal: 'g', status: 'running', summary: null, events: [] },
    { id: 'r2', sessionId: 's2', goal: 'g', status: 'completed', summary: null, events: [] },
    { id: 'r3', sessionId: 's3', goal: 'g', status: 'pending', summary: null, events: [] },
  ],
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
        goal: '',
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

  it('keeps only running/pending runs', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePaletteData(), { wrapper: makeWrapper(qc) })
    expect(result.current.runningRuns.map((r) => r.id)).toEqual(['r1', 'r3'])
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
