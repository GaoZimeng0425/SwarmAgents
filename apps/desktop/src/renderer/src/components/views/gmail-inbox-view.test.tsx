// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import type { UIEvent } from '@swarm/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ThreadAnalysisState } from '@/hooks/use-thread-analysis'
import { swarmApi } from '@/lib/api'
import { useAnalysisStreamStore } from '@/stores/analysis-stream'
import { GmailAssistantCard } from './gmail-assistant-card'
import { GmailInboxView } from './gmail-inbox-view'

function msg(overrides: Partial<{ id: string; subject: string; fromAddr: string; bodyText: string }> = {}) {
  return {
    id: 'm1',
    threadId: 't1',
    fromAddr: 'a@b',
    toAddrs: [],
    subject: 'S',
    snippet: '',
    bodyText: 'body',
    htmlBody: '',
    dateMs: 1,
    labelIds: [],
    ...overrides,
  } as import('@swarm/protocol').GmailMessage
}

describe('GmailAssistantCard', () => {
  beforeEach(() => {
    // jsdom lacks a clipboard implementation; stub it for the copy button.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })
  afterEach(() => {
    cleanup()
  })

  it('shows the AI 分析 button in the idle phase and fires onAnalyze', () => {
    const onAnalyze = vi.fn()
    const idle: ThreadAnalysisState = { phase: 'idle' }
    render(<GmailAssistantCard analysis={idle} messageCount={3} onAnalyze={onAnalyze} />)
    fireEvent.click(screen.getByRole('button', { name: /AI 分析/ }))
    expect(onAnalyze).toHaveBeenCalledTimes(1)
  })

  it('streams the summary and shows the 分析中… indicator', () => {
    const streaming: ThreadAnalysisState = { phase: 'streaming', summaryText: '## 摘要\n流式中' }
    render(<GmailAssistantCard analysis={streaming} messageCount={3} onAnalyze={() => undefined} />)
    expect(screen.getByText(/分析中/)).toBeInTheDocument()
    expect(screen.getByText(/流式中/)).toBeInTheDocument()
  })

  it('renders todos (with due chip) and the suggested reply in the done phase', () => {
    const done: ThreadAnalysisState = {
      phase: 'done',
      summary: '一句话总结',
      todos: [{ t: '回复 Bob', due: true, dueLabel: '今天' }, { t: '审阅文档' }],
      suggest: '好的，明天发你',
    }
    render(<GmailAssistantCard analysis={done} messageCount={3} onAnalyze={() => undefined} />)
    expect(screen.getByText('一句话总结')).toBeInTheDocument()
    expect(screen.getByText('回复 Bob')).toBeInTheDocument()
    expect(screen.getByText('今天')).toBeInTheDocument() // due chip
    expect(screen.getByText('审阅文档')).toBeInTheDocument()
    expect(screen.getByText(/好的，明天发你/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /采用并回复/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新生成/ })).toBeInTheDocument()
  })

  it('opens the draft area prefilled with the suggestion and copies it', () => {
    const done: ThreadAnalysisState = {
      phase: 'done',
      summary: 's',
      todos: [],
      suggest: '草稿建议',
    }
    render(<GmailAssistantCard analysis={done} messageCount={1} onAnalyze={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /采用并回复/ }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('草稿建议')

    fireEvent.click(screen.getByRole('button', { name: /复制到剪贴板/ }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('草稿建议')
  })

  it('calls onAnalyze when 重新生成 is clicked', () => {
    const onAnalyze = vi.fn()
    const done: ThreadAnalysisState = { phase: 'done', summary: 's', todos: [], suggest: '建议' }
    render(<GmailAssistantCard analysis={done} messageCount={1} onAnalyze={onAnalyze} />)
    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }))
    expect(onAnalyze).toHaveBeenCalledTimes(1)
  })

  it('renders the error message and a retry button in the error phase', () => {
    const onAnalyze = vi.fn()
    const errored: ThreadAnalysisState = { phase: 'error', error: '模型超时' }
    render(<GmailAssistantCard analysis={errored} messageCount={1} onAnalyze={onAnalyze} />)
    expect(screen.getByText('模型超时')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(onAnalyze).toHaveBeenCalledTimes(1)
  })
})

// Analysis is manual: opening a thread never auto-fires analyzeThread. A cache
// miss stays idle behind an "AI 分析" button; a cache hit shows the cached
// summary with a "重新生成" re-run. Both the initial 分析 and the re-run call
// analyzeThread exactly once and drive the card into `streaming`.
describe('GmailInboxView manual analysis', () => {
  // The hook keeps one subscription per selected thread; track all active
  // callbacks so an emit reaches the live handler (faithful to the preload
  // bridge, which fans events to every subscriber).
  let emits: ((e: UIEvent) => void)[] = []

  function wrap(node: React.ReactElement, qc: QueryClient): React.ReactElement {
    return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
  }

  // getThreadAnalysis is reassigned per-test (cached vs miss) before render.
  let getThreadAnalysis = vi.fn()

  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    const getStatus = vi.fn().mockResolvedValue({
      hasClientCreds: true,
      loggedIn: true,
      accountEmail: 'me@x',
      lastSyncAt: null,
      messageCount: 1,
      syncError: null,
    })
    const thread = {
      id: 't1',
      snippet: '',
      fromAddr: 'a@b',
      subject: '下周评审',
      lastDateMs: 1,
      labelIds: [],
      unread: false,
    }
    const listRecent = vi.fn().mockResolvedValue([thread])
    const listInboxPage = vi.fn().mockResolvedValue({ threads: [thread], total: 1 })
    const getThread = vi.fn().mockResolvedValue({
      thread: { id: 't1', subject: '下周评审' },
      messages: [msg({ id: 'm1', subject: '下周评审', fromAddr: 'a@b', bodyText: '正文内容' })],
    })
    getThreadAnalysis = vi.fn().mockResolvedValue({ summary: '旧缓存摘要', todos: [], suggest: '旧建议', updatedAt: 1 })
    const saveThreadAnalysis = vi.fn().mockResolvedValue(undefined)
    const onStateChanged = vi.fn().mockReturnValue(() => {})
    emits = []
    ;(window as unknown as { swarm: unknown }).swarm = {
      gmail: {
        getStatus,
        listRecent,
        getThread,
        search: vi.fn().mockResolvedValue([]),
        getThreadAnalysis: (id: string) => getThreadAnalysis(id),
        saveThreadAnalysis,
        analyzedThreadIds: vi.fn().mockResolvedValue([]),
        markThreadRead: vi.fn().mockResolvedValue(undefined),
        listInboxPage,
        onStateChanged,
      },
      analyzeThread: vi.fn().mockResolvedValue({ ok: true }),
      syncNow: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: (cb: (e: UIEvent) => void) => {
        const wrapped = (e: UIEvent) => cb(e)
        emits.push(wrapped)
        return () => {
          emits = emits.filter((c) => c !== wrapped)
        }
      },
    } as unknown as typeof window.swarm
  })

  afterEach(() => {
    cleanup()
    emits = []
    // Clear the global analysis-stream store so tests don't leak state.
    useAnalysisStreamStore.setState({ entries: new Map() })
  })

  it('does not auto-analyze a cache-miss thread; the AI 分析 button triggers it', async () => {
    getThreadAnalysis = vi.fn().mockResolvedValue(null)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const analyzeSpy = vi.spyOn(swarmApi, 'analyzeThread').mockResolvedValue({ ok: true })

    render(wrap(<GmailInboxView />, qc))

    // Open the thread → idle, an AI 分析 button, and NO automatic analysis.
    fireEvent.click(await screen.findByText('下周评审'))
    const analyzeBtn = await screen.findByRole('button', { name: /AI 分析/ })
    expect(analyzeSpy).not.toHaveBeenCalled()

    // Click it → analyzeThread fires once with the loaded thread.
    fireEvent.click(analyzeBtn)
    await waitFor(() => expect(analyzeSpy).toHaveBeenCalledTimes(1))
    expect(analyzeSpy).toHaveBeenCalledWith({
      threadId: 't1',
      subject: '下周评审',
      messages: [{ from: 'a@b', dateMs: 1, bodyText: '正文内容' }],
    })
    await waitFor(() => expect(screen.getByText(/分析中/)).toBeInTheDocument())
  })

  it('re-runs analysis when 重新生成 is clicked on a cached thread', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const analyzeSpy = vi.spyOn(swarmApi, 'analyzeThread').mockResolvedValue({ ok: true })

    render(wrap(<GmailInboxView />, qc))

    // Open the cached thread → assistant shows the cached summary in `done`,
    // and analyzeThread is NOT called (cache hit, manual only).
    fireEvent.click(await screen.findByText('下周评审'))
    expect(await screen.findByText('旧缓存摘要')).toBeInTheDocument()
    expect(analyzeSpy).not.toHaveBeenCalled()

    // Click 重新生成 → analyzeThread fires once and the card goes to `streaming`
    // (分析中 up, done-only action buttons gone).
    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }))
    await waitFor(() => expect(analyzeSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText(/分析中/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /采用并回复/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重新生成/ })).not.toBeInTheDocument()

    // The live subscription accepts a streamed delta.
    await act(async () => {
      for (const e of emits) e({ kind: 'gmail.threadAnalysisDelta', threadId: 't1', text: '新摘要开头', ts: 10 })
    })
    expect(emits.length).toBeGreaterThan(0)
    expect(screen.getByText(/分析中/)).toBeInTheDocument()
  })
})
