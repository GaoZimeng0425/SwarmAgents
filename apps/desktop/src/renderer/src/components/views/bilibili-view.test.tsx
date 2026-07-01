// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import type { BiliListResult } from '@swarm/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { swarmApi } from '@/lib/api'
import { BilibiliView, buildRows } from './bilibili-view'

// The always-mounted detail sheet subscribes to transcription progress on render and
// the list/panel query the analysis cache; stub these by default so tests that don't
// care don't hit the (absent) preload bridge.
beforeEach(() => {
  vi.spyOn(swarmApi, 'bilibiliOnTranscribeProgress').mockReturnValue(() => {})
  vi.spyOn(swarmApi, 'bilibiliAnalyzedBvids').mockResolvedValue([])
  vi.spyOn(swarmApi, 'bilibiliGetAnalysis').mockResolvedValue(null)
})

function wrap(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

const SAMPLE: BiliListResult = {
  folders: [
    {
      folder: { id: 1, title: 'CS', count: 1 },
      videos: [
        { bvid: 'BV1', title: '视频甲', cover: '', author: 'up甲', durationSec: 65, intro: '简介甲内容', source: 'CS' },
      ],
    },
    {
      folder: { id: 2, title: '音乐', count: 1 },
      videos: [{ bvid: 'BV3', title: '视频丙', cover: '', author: 'up丙', durationSec: 3, intro: '', source: '音乐' }],
    },
  ],
  watchLater: [
    { bvid: 'BV2', title: '视频乙', cover: '', author: 'up乙', durationSec: 1, intro: '', source: '稍后再看' },
  ],
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('buildRows', () => {
  it('favorites/all shows every folder with headers and excludes watch-later', () => {
    const rows = buildRows(SAMPLE, 'favorites', 'all', 3)
    const headers = rows.filter((r) => r.kind === 'header').map((r) => (r.kind === 'header' ? r.title : ''))
    expect(headers).toEqual(['CS', '音乐'])
    const bvids = rows.flatMap((r) => (r.kind === 'grid' ? r.videos.map((v) => v.bvid) : []))
    expect(bvids).toEqual(['BV1', 'BV3'])
    expect(bvids).not.toContain('BV2')
  })

  it('favorites with a specific folder shows only that folder', () => {
    const rows = buildRows(SAMPLE, 'favorites', 2, 3)
    const bvids = rows.flatMap((r) => (r.kind === 'grid' ? r.videos.map((v) => v.bvid) : []))
    expect(bvids).toEqual(['BV3'])
  })

  it('watch-later tab shows only watch-later videos and no folder headers', () => {
    const rows = buildRows(SAMPLE, 'watch-later', 'all', 3)
    expect(rows.some((r) => r.kind === 'header')).toBe(false)
    const bvids = rows.flatMap((r) => (r.kind === 'grid' ? r.videos.map((v) => v.bvid) : []))
    expect(bvids).toEqual(['BV2'])
  })
})

describe('BilibiliView', () => {
  it('shows a login prompt when logged out', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: false, uname: null, mid: null })
    render(wrap(<BilibiliView />))
    expect(await screen.findByRole('button', { name: /登录/ })).toBeInTheDocument()
  })

  it('defaults to the favorites tab and hides watch-later videos', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    render(wrap(<BilibiliView />))
    expect(await screen.findByText('视频甲')).toBeInTheDocument()
    expect(screen.queryByText('视频乙')).not.toBeInTheDocument()
  })

  it('switches to the watch-later tab on click', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    render(wrap(<BilibiliView />))
    fireEvent.click(await screen.findByRole('tab', { name: /稍后再看/ }))
    expect(await screen.findByText('视频乙')).toBeInTheDocument()
    expect(screen.queryByText('视频甲')).not.toBeInTheDocument()
  })

  it('opens a detail panel showing the video intro when a card is clicked', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    render(wrap(<BilibiliView />))
    fireEvent.click(await screen.findByText('视频甲'))
    expect(await screen.findByText('简介甲内容')).toBeInTheDocument()
  })

  it('runs AI analysis from the detail panel and shows the summary', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    vi.spyOn(swarmApi, 'bilibiliProcess').mockResolvedValue({
      ok: true,
      summary: { gist: 'AI主旨', points: ['要点一'], experience: [], pitfalls: [], steps: [] },
      text: '字幕全文',
      source: 'subtitle',
    })
    render(wrap(<BilibiliView />))
    fireEvent.click(await screen.findByText('视频甲'))
    fireEvent.click(await screen.findByRole('button', { name: /AI 分析/ }))
    expect(await screen.findByText('AI主旨')).toBeInTheDocument()
    expect(screen.getByText('要点一')).toBeInTheDocument()
  })

  it('shows the no-subtitle message when analysis fails that way', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    vi.spyOn(swarmApi, 'bilibiliProcess').mockResolvedValue({
      ok: false,
      code: 'no_subtitle',
      message: '该视频没有字幕，暂不支持（语音转写为后续里程碑）。',
    })
    render(wrap(<BilibiliView />))
    fireEvent.click(await screen.findByText('视频甲'))
    fireEvent.click(await screen.findByRole('button', { name: /AI 分析/ }))
    expect(await screen.findByText(/没有字幕/)).toBeInTheDocument()
  })

  it('offers local transcription when the video has no subtitle and shows the summary', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    vi.spyOn(swarmApi, 'bilibiliProcess').mockResolvedValue({
      ok: false,
      code: 'no_subtitle',
      message: '该视频没有字幕。',
    })
    vi.spyOn(swarmApi, 'bilibiliOnTranscribeProgress').mockReturnValue(() => {})
    const transcribe = vi.spyOn(swarmApi, 'bilibiliTranscribe').mockResolvedValue({
      ok: true,
      summary: { gist: '转写主旨', points: ['转写要点'], experience: [], pitfalls: [], steps: [] },
      text: '转写全文',
      source: 'transcript',
    })
    render(wrap(<BilibiliView />))
    fireEvent.click(await screen.findByText('视频甲'))
    fireEvent.click(await screen.findByRole('button', { name: /AI 分析/ }))
    fireEvent.click(await screen.findByRole('button', { name: /本地转写/ }))
    expect(await screen.findByText('转写主旨')).toBeInTheDocument()
    expect(screen.getByText('转写要点')).toBeInTheDocument()
    expect(transcribe).toHaveBeenCalledWith('BV1')
  })

  it('shows a cached analysis without calling bilibiliProcess', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    const process = vi.spyOn(swarmApi, 'bilibiliProcess')
    vi.spyOn(swarmApi, 'bilibiliGetAnalysis').mockResolvedValue({
      bvid: 'BV1',
      summary: { gist: '缓存主旨', points: [], experience: [], pitfalls: [], steps: [] },
      text: '字幕全文内容',
      source: 'subtitle',
      analyzedAt: '2026-06-28T00:00:00.000Z',
    })
    render(wrap(<BilibiliView />))
    fireEvent.click(await screen.findByText('视频甲'))
    expect(await screen.findByText('缓存主旨')).toBeInTheDocument()
    expect(process).not.toHaveBeenCalled()
  })

  it('reveals the full text when the section is expanded', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    vi.spyOn(swarmApi, 'bilibiliGetAnalysis').mockResolvedValue({
      bvid: 'BV1',
      summary: { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] },
      text: '字幕全文内容',
      source: 'subtitle',
      analyzedAt: '2026-06-28T00:00:00.000Z',
    })
    render(wrap(<BilibiliView />))
    fireEvent.click(await screen.findByText('视频甲'))
    fireEvent.click(await screen.findByRole('button', { name: /字幕原文/ }))
    expect(await screen.findByText('字幕全文内容')).toBeInTheDocument()
  })

  it('shows an AI badge on analyzed videos', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    vi.spyOn(swarmApi, 'bilibiliAnalyzedBvids').mockResolvedValue(['BV1'])
    render(wrap(<BilibiliView />))
    const card = (await screen.findByText('视频甲')).closest('button') as HTMLElement
    expect(within(card).getByText('AI')).toBeInTheDocument()
  })

  it('opens the video via the watch button with the clicked bvid', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    const open = vi.spyOn(swarmApi, 'bilibiliOpen').mockResolvedValue(undefined)
    render(wrap(<BilibiliView />))
    fireEvent.click(await screen.findByText('视频甲'))
    fireEvent.click(await screen.findByRole('button', { name: /观看/ }))
    expect(open).toHaveBeenCalledWith('BV1')
  })

  it('saves the summary to Obsidian from the detail panel', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    vi.spyOn(swarmApi, 'bilibiliProcess').mockResolvedValue({
      ok: true,
      summary: { gist: 'AI主旨', points: ['要点一'], experience: [], pitfalls: [], steps: [] },
      text: '字幕全文',
      source: 'subtitle',
    })
    const save = vi.spyOn(swarmApi, 'bilibiliSave').mockResolvedValue({ ok: true, path: '/vault/bili/x.md' })
    render(wrap(<BilibiliView />))
    fireEvent.click(await screen.findByText('视频甲'))
    fireEvent.click(await screen.findByRole('button', { name: /AI 分析/ }))
    await screen.findByText('AI主旨')
    fireEvent.click(screen.getByRole('button', { name: /保存到 Obsidian/ }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(await screen.findByText(/已保存/)).toBeInTheDocument()
  })
})
