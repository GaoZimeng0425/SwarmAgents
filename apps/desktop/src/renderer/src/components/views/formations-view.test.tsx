// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import type { AgentDefinition } from '@swarm/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { swarmApi } from '@/lib/api'
import type { AgentActivity } from '@/lib/formations/build-agent-activity'
import { FormationsView } from './formations-view'

// useAgentMutations talks to the IPC-backed agent store; we only need the
// returned handlers to exist for read-only renders, so stub them.
vi.mock('@/hooks/use-agent-mutations', () => ({
  useAgentMutations: () => ({
    save: vi.fn(),
    remove: vi.fn(),
    restoreDefaults: vi.fn(),
  }),
}))

// useAgentActivity normally derives a Map from all runs + sessions. The smoke
// tests drive it with a fixed activity map so they don't have to construct
// MessageRecord/Session fixtures. `current` is reassigned per test before render.
let current: Map<string, AgentActivity> = new Map()
vi.mock('@/hooks/use-agent-activity', () => ({
  useAgentActivity: () => current,
}))

// sonner's toast is imported by FormationsView (error paths only); silence it
// so a stray call never throws under jsdom.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

/** Minimal valid AgentListItem fixture. */
const a = (over: Partial<AgentDefinition> & { id: string }): AgentDefinition => ({
  name: over.id,
  description: 'd',
  systemPrompt: `prompt-${over.id}`,
  toolScope: 'all',
  maxIterations: 25,
  ...over,
})

// Engineer delegates to a reviewer via a find_agents({ role: 'reviewer' })
// call in its prompt — buildDelegationEdges turns that into an edge
// { from: 'engineer', to: 'reviewer' }, so selecting Engineer highlights
// Reviewer as a delegation target.
const AGENTS: AgentDefinition[] = [
  a({ id: 'ceo', name: 'CEO', role: 'ceo' }),
  a({
    id: 'engineer',
    name: 'Engineer',
    role: 'engineer',
    systemPrompt: 'You build features. find_agents({ role: "reviewer" }) for review.',
  }),
  a({ id: 'reviewer', name: 'Reviewer', role: 'reviewer' }),
]

function wrap(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

beforeEach(() => {
  vi.spyOn(swarmApi, 'listAgents').mockResolvedValue(AGENTS)
  vi.spyOn(swarmApi, 'subscribeEvents').mockReturnValue(() => {})
  current = new Map()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FormationsView (smoke)', () => {
  it('renders the agent count and the "正在工作" pill', async () => {
    current = new Map([['engineer', { status: 'running', currentTask: '修复登录', stepProgress: '1/3 步' }]])
    render(wrap(<FormationsView />))
    expect(await screen.findByText('3 个 Agent')).toBeInTheDocument()
    expect(screen.getByText('1 正在工作')).toBeInTheDocument()
  })

  it('shows the running task line on the Engineer node', async () => {
    current = new Map([['engineer', { status: 'running', currentTask: '修复登录', stepProgress: '1/3 步' }]])
    render(wrap(<FormationsView />))
    expect(await screen.findByText('运行中 · 修复登录 · 1/3 步')).toBeInTheDocument()
  })

  it('lights the Reviewer as a delegation target when Engineer is selected', async () => {
    render(wrap(<FormationsView />))
    // Selecting a node is done by clicking its card's toggle button.
    fireEvent.click(await screen.findByText('Engineer'))
    // "Reviewer" also appears as a Delegates-to chip in the detail column once
    // Engineer is selected, so scope the lookup to the org-tree column. The card
    // name span is the one carrying data-delegation-target on its ancestor.
    const treeReviewer = screen
      .getAllByText('Reviewer')
      .find((el) => el.closest('[data-delegation-target]')) as HTMLElement
    const reviewerCard = treeReviewer.closest('[data-delegation-target]') as HTMLElement
    expect(reviewerCard).toHaveAttribute('data-delegation-target', 'true')
  })
})
