// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DashboardRun } from '@/lib/dashboard-runs'

// Mutable permission queue, shared with the store mock via vi.hoisted so the
// factory (hoisted above imports) can read it lazily on each render.
const h = vi.hoisted(() => ({ queue: [] as Array<Record<string, unknown>> }))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/use-runs', () => ({ useDecidePermission: () => ({ mutate: vi.fn(), isPending: false }) }))
vi.mock('@/stores/permission', () => ({
  usePermissionStore: (sel: (s: { queue: unknown[] }) => unknown) => sel({ queue: h.queue }),
}))

const { RunningCard } = await import('./running-card')

const base: DashboardRun = {
  id: '1',
  sessionId: 's1',
  prompt: '修复登录 token 刷新竞态',
  status: 'running',
  wallMs: 60_000,
  cwd: '~/repo/desktop',
  agentLabel: undefined,
  steps: '3/8',
  activity: null,
}

afterEach(() => {
  h.queue = []
  cleanup()
})

describe('RunningCard', () => {
  it('running: renders the latest tool activity as a ▸ mono line', () => {
    render(<RunningCard run={{ ...base, activity: 'Bash pnpm vitest auth.test.ts' }} />)
    expect(screen.getByText(/▸ Bash pnpm vitest auth\.test\.ts/)).toBeInTheDocument()
  })

  it('running: omits the activity line when there is no activity yet', () => {
    render(<RunningCard run={{ ...base, activity: null }} />)
    expect(screen.queryByText(/▸/)).toBeNull()
  })

  it('awaiting: shows the pending permission summary + 允许/拒绝', () => {
    h.queue = [
      {
        actionId: 'a1',
        sessionId: 's1',
        runId: '1',
        risk: 'medium',
        summary: '执行 rm -rf out/ && pnpm build',
        payload: {},
      },
    ]
    render(<RunningCard run={{ ...base, status: 'awaiting_user' }} />)
    expect(screen.getByText('执行 rm -rf out/ && pnpm build')).toBeInTheDocument()
    expect(screen.getByText('允许')).toBeInTheDocument()
    expect(screen.getByText('拒绝')).toBeInTheDocument()
  })
})
