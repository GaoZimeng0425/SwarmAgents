// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import type { UIEvent } from '@swarm/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { swarmApi } from '@/lib/api'
import { type ThreadAnalysisInput, useThreadAnalysis } from './use-thread-analysis'

let emit: ((e: UIEvent) => void) | null = null

beforeEach(() => {
  vi.spyOn(swarmApi, 'gmailGetThreadAnalysis').mockResolvedValue(null)
  vi.spyOn(swarmApi, 'analyzeThread').mockResolvedValue({ ok: true })
  emit = null
  const saveThreadAnalysis = vi.fn().mockResolvedValue(undefined)
  ;(window as unknown as { swarm: unknown }).swarm = {
    subscribeEvents: (cb: (e: UIEvent) => void) => {
      emit = cb
      return () => {
        emit = null
      }
    },
    gmail: { saveThreadAnalysis },
  } as unknown as typeof window.swarm
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

const thread: ThreadAnalysisInput = {
  id: 't1',
  subject: '下周评审',
  messages: [{ from: 'a@b', dateMs: 1, bodyText: '正文内容' }],
}

describe('useThreadAnalysis', () => {
  it('returns idle when thread is null', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(null), { wrapper: makeWrapper(qc) })
    expect(result.current.phase).toBe('idle')
  })

  it('triggers analyzeThread when no cache and streams deltas', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())
    // The hook forwards the thread's subject + messages to the backend.
    expect(swarmApi.analyzeThread).toHaveBeenCalledWith({
      threadId: 't1',
      subject: '下周评审',
      messages: [{ from: 'a@b', dateMs: 1, bodyText: '正文内容' }],
    })

    await act(async () => {
      emit?.({ kind: 'gmail.threadAnalysisDelta', threadId: 't1', text: '流式摘要', ts: 1 })
    })
    expect(result.current.phase).toBe('streaming')
    expect((result.current as { summaryText?: string }).summaryText).toContain('流式摘要')
  })

  it('reaches done on Complete and persists via window.swarm.gmail.saveThreadAnalysis', async () => {
    const saveSpy = window.swarm.gmail.saveThreadAnalysis as unknown as ReturnType<typeof vi.fn>
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())

    await act(async () => {
      emit?.({
        kind: 'gmail.threadAnalysisComplete',
        threadId: 't1',
        summary: '一句话总结',
        todos: [{ t: '回复' }],
        suggest: '草稿建议',
        ts: 2,
      })
    })
    expect(result.current.phase).toBe('done')
    if (result.current.phase === 'done') {
      expect(result.current.summary).toBe('一句话总结')
      expect(result.current.todos).toEqual([{ t: '回复' }])
      expect(result.current.suggest).toBe('草稿建议')
    }
    expect(saveSpy).toHaveBeenCalledWith('t1', {
      summary: '一句话总结',
      todos: [{ t: '回复' }],
      suggest: '草稿建议',
    })
  })

  it('shows an error phase and does NOT subscribe when analyzeThread acks failure (no provider)', async () => {
    vi.mocked(swarmApi.analyzeThread).mockResolvedValue({
      ok: false,
      code: 'no_provider',
      message: '请先在 设置 → 模型 配置提供商。',
    })
    const subscribeSpy = vi.spyOn(window.swarm, 'subscribeEvents')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })

    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())
    await waitFor(() => expect(result.current.phase).toBe('error'))
    if (result.current.phase === 'error') {
      expect(result.current.error).toBe('请先在 设置 → 模型 配置提供商。')
    }
    // No provider ⇒ no event stream ⇒ the subscription must never be created.
    expect(subscribeSpy).not.toHaveBeenCalled()
  })

  it('hides the trailing <!--ANALYSIS JSON block while streaming', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())

    // A delta whose tail begins the sentinel (closing `-->` not yet streamed).
    await act(async () => {
      emit?.({ kind: 'gmail.threadAnalysisDelta', threadId: 't1', text: '一些摘要<!--ANALYSIS:{', ts: 1 })
    })
    expect(result.current.phase).toBe('streaming')
    expect((result.current as { summaryText?: string }).summaryText).not.toContain('<!--ANALYSIS')
    expect((result.current as { summaryText?: string }).summaryText).toContain('一些摘要')
  })

  it('reaches error on threadAnalysisError', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())

    await act(async () => {
      emit?.({ kind: 'gmail.threadAnalysisError', threadId: 't1', error: '模型超时', ts: 3 })
    })
    expect(result.current.phase).toBe('error')
    if (result.current.phase === 'error') {
      expect(result.current.error).toBe('模型超时')
    }
  })

  it('uses cache when available and does not call analyzeThread', async () => {
    vi.mocked(swarmApi.gmailGetThreadAnalysis).mockResolvedValue({
      summary: '缓存结果',
      todos: [],
      suggest: '',
      updatedAt: 1,
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(swarmApi.gmailGetThreadAnalysis).toHaveBeenCalled())
    expect(swarmApi.analyzeThread).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.phase).toBe('done'))
    if (result.current.phase === 'done') {
      expect(result.current.summary).toBe('缓存结果')
    }
  })

  it('unsubscribes the previous subscription when the thread id changes', async () => {
    const unsubscribe = vi.fn()
    ;(window.swarm as unknown as { subscribeEvents: unknown }).subscribeEvents = vi.fn(() => unsubscribe)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = renderHook(({ t }: { t: ThreadAnalysisInput }) => useThreadAnalysis(t), {
      wrapper: makeWrapper(qc),
      initialProps: { t: thread },
    })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalledTimes(1))

    rerender({ t: { ...thread, id: 't2' } })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalledTimes(2))
    // Switching to a new thread id must tear down the prior event subscription.
    expect(unsubscribe).toHaveBeenCalled()
  })
})
