// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import type { TrendingRepo } from '@shared/types/trending'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { swarmApi } from '@/lib/api'
import { TrendingView } from './trending-view'

vi.mock('@/hooks/use-research-repo', () => ({
  useResearchRepo: () => vi.fn(),
}))

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

function wrap(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TrendingView', () => {
  it('renders the trending repo rows on success', async () => {
    vi.spyOn(swarmApi, 'getTrendingRepos').mockResolvedValue([repo])
    render(wrap(<TrendingView />))
    expect(await screen.findByText('oven-sh/bun')).toBeInTheDocument()
    expect(screen.getByText('Incredibly fast JavaScript runtime')).toBeInTheDocument()
  })

  it('shows an error state with a retry control when the fetch fails', async () => {
    vi.spyOn(swarmApi, 'getTrendingRepos').mockRejectedValue(new Error('boom'))
    render(wrap(<TrendingView />))
    expect(await screen.findByRole('button', { name: /重试/ })).toBeInTheDocument()
  })

  it('shows an empty state when no repos are returned', async () => {
    vi.spyOn(swarmApi, 'getTrendingRepos').mockResolvedValue([])
    render(wrap(<TrendingView />))
    await waitFor(() => expect(screen.getByText(/暂无/)).toBeInTheDocument())
  })

  it('shows a loading indicator while fetching', () => {
    // Never-resolving promise keeps isPending=true for the lifetime of this test
    vi.spyOn(swarmApi, 'getTrendingRepos').mockReturnValue(new Promise(() => {}))
    render(wrap(<TrendingView />))
    expect(screen.getByText(/加载中/)).toBeInTheDocument()
  })
})
