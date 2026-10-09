// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArticleView } from './article-view'

function withClient(ui: React.ReactNode): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

describe('ArticleView', () => {
  beforeEach(() => {
    vi.stubGlobal('swarm', {
      article: {
        list: vi.fn().mockResolvedValue([]),
        analyze: vi.fn(),
        getAnalysis: vi.fn(),
        delete: vi.fn(),
      },
      // The always-mounted detail panel subscribes to analysis-stream events on
      // render (even with no selection); stub a no-op unsubscribe so the panel
      // doesn't touch the absent preload bridge.
      subscribeEvents: vi.fn().mockReturnValue(() => {}),
    })
  })

  it('renders empty state when no articles', async () => {
    render(withClient(<ArticleView />))
    await waitFor(() => expect(screen.getByText(/还没有收集的文章/)).toBeInTheDocument())
  })

  it('renders cards when articles exist', async () => {
    vi.mocked(window.swarm.article.list).mockResolvedValueOnce([
      {
        url: 'https://example.com/a',
        title: 'First Article',
        author: null,
        siteName: 'Ex',
        publishedTime: null,
        contentMarkdown: 'body',
        id: '1',
        collectedAt: '2026-07-07T00:00:00.000Z',
        excerpt: 'body',
        summary: null,
        analyzedAt: null,
      },
    ])
    render(withClient(<ArticleView />))
    await waitFor(() => expect(screen.getByText('First Article')).toBeInTheDocument())
  })
})
