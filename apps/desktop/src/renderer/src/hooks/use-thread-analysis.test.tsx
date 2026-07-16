// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import type { UIEvent } from '@swarm/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAnalysisEventBridge } from '@/hooks/use-analysis-event-bridge'
import { swarmApi } from '@/lib/api'
import { useAnalysisStreamStore } from '@/stores/analysis-stream'
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
  // Clear the global analysis-stream store so tests don't leak state.
  useAnalysisStreamStore.setState({ entries: new Map() })
})

function makeWrapper(qc: QueryClient) {
  // Mounts the global analysis-event bridge so streamed events dispatched via
  // `emit` reach the analysis-stream store (the single source of truth), mirroring
  // how the app root wires it. Without this, useThreadAnalysis would never see
  // delta/complete/error because the hook no longer subscribes per-panel.
  function Bridge(): null {
    useAnalysisEventBridge()
    return null
  }
  return function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
    return (
      <QueryClientProvider client={qc}>
        <Bridge />
        {children}
      </QueryClientProvider>
    )
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
    expect(result.current.state.phase).toBe('idle')
  })

  it('does not auto-analyze; analyze() triggers analyzeThread and streams deltas', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })
    // Cache miss stays idle — analysis is manual now.
    await waitFor(() => expect(result.current.state.phase).toBe('idle'))
    expect(swarmApi.analyzeThread).not.toHaveBeenCalled()

    await act(async () => {
      result.current.analyze()
    })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())
    expect(swarmApi.analyzeThread).toHaveBeenCalledWith({
      threadId: 't1',
      subject: '下周评审',
      messages: [{ from: 'a@b', dateMs: 1, bodyText: '正文内容' }],
    })

    await act(async () => {
      emit?.({ kind: 'gmail.threadAnalysisDelta', threadId: 't1', text: '流式摘要', ts: 1 })
    })
    expect(result.current.state.phase).toBe('streaming')
    expect((result.current.state as { summaryText?: string }).summaryText).toContain('流式摘要')
  })

  it('reaches done on Complete and persists via window.swarm.gmail.saveThreadAnalysis', async () => {
    const saveSpy = window.swarm.gmail.saveThreadAnalysis as unknown as ReturnType<typeof vi.fn>
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })
    await act(async () => {
      result.current.analyze()
    })
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
    expect(result.current.state.phase).toBe('done')
    if (result.current.state.phase === 'done') {
      expect(result.current.state.summary).toBe('一句话总结')
      expect(result.current.state.todos).toEqual([{ t: '回复' }])
      expect(result.current.state.suggest).toBe('草稿建议')
    }
    expect(saveSpy).toHaveBeenCalledWith('t1', {
      summary: '一句话总结',
      todos: [{ t: '回复' }],
      suggest: '草稿建议',
    })
  })

  it('shows an error phase when analyzeThread acks failure (no provider)', async () => {
    vi.mocked(swarmApi.analyzeThread).mockResolvedValue({
      ok: false,
      code: 'no_provider',
      message: '请先在 设置 → 模型 配置提供商。',
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })

    await act(async () => {
      result.current.analyze()
    })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())
    await waitFor(() => expect(result.current.state.phase).toBe('error'))
    if (result.current.state.phase === 'error') {
      expect(result.current.state.error).toBe('请先在 设置 → 模型 配置提供商。')
    }
  })

  it('accumulates streamed deltas verbatim as the summary text', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })
    await act(async () => {
      result.current.analyze()
    })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())

    // Structured fields ride a separate render_ui tool call, so the streamed
    // markdown is shown as-is (no sentinel stripping).
    await act(async () => {
      emit?.({ kind: 'gmail.threadAnalysisDelta', threadId: 't1', text: '## 摘要\n', ts: 1 })
      emit?.({ kind: 'gmail.threadAnalysisDelta', threadId: 't1', text: '要点一', ts: 2 })
    })
    expect(result.current.state.phase).toBe('streaming')
    expect((result.current.state as { summaryText?: string }).summaryText).toBe('## 摘要\n要点一')
  })

  it('reaches error on threadAnalysisError', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis(thread), { wrapper: makeWrapper(qc) })
    await act(async () => {
      result.current.analyze()
    })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())

    await act(async () => {
      emit?.({ kind: 'gmail.threadAnalysisError', threadId: 't1', error: '模型超时', ts: 3 })
    })
    expect(result.current.state.phase).toBe('error')
    if (result.current.state.phase === 'error') {
      expect(result.current.state.error).toBe('模型超时')
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
    await waitFor(() => expect(result.current.state.phase).toBe('done'))
    if (result.current.state.phase === 'done') {
      expect(result.current.state.summary).toBe('缓存结果')
    }
  })

  it('keeps a single global subscription when the thread id changes', async () => {
    // After the 切走丢失 fix, streaming events are dispatched by a single global
    // bridge (mounted in the wrapper), not per-thread by the hook. So switching
    // threads must NOT add or tear down subscriptions — the store is keyed by id.
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    ;(window.swarm as unknown as { subscribeEvents: unknown }).subscribeEvents = subscribe
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = renderHook(({ t }: { t: ThreadAnalysisInput }) => useThreadAnalysis(t), {
      wrapper: makeWrapper(qc),
      initialProps: { t: thread },
    })
    // The wrapper's bridge subscribes exactly once; the hook itself never subscribes.
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))

    rerender({ t: { ...thread, id: 't2' } })
    // Switching threads does not re-subscribe.
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()
  })
})
