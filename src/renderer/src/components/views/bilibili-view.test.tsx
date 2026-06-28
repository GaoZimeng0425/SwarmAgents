// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { swarmApi } from '@/lib/api'
import { BilibiliView } from './bilibili-view'

function wrap(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BilibiliView', () => {
  it('shows a login prompt when logged out', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: false, uname: null, mid: null })
    render(wrap(<BilibiliView />))
    expect(await screen.findByRole('button', { name: /登录/ })).toBeInTheDocument()
  })

  it('renders folders and watch-later when logged in', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue({
      folders: [
        {
          folder: { id: 1, title: 'CS', count: 1 },
          videos: [{ bvid: 'BV1', title: '视频甲', cover: '', author: 'up', durationSec: 1, intro: '', source: 'CS' }],
        },
      ],
      watchLater: [
        { bvid: 'BV2', title: '视频乙', cover: '', author: 'up', durationSec: 1, intro: '', source: '稍后再看' },
      ],
    })
    render(wrap(<BilibiliView />))
    expect(await screen.findByText('视频甲')).toBeInTheDocument()
    expect(screen.getByText('视频乙')).toBeInTheDocument()
    expect(screen.getByText('CS')).toBeInTheDocument()
  })
})
