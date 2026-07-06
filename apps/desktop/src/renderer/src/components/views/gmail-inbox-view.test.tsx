// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import type { UIEvent } from '@swarm/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ThreadAnalysisState } from '@/hooks/use-thread-analysis'
import { swarmApi } from '@/lib/api'
import { GmailAssistantCard } from './gmail-assistant-card'
import { GmailInboxView, MessageAnalysis } from './gmail-inbox-view'

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

type AnalysisCb = (e: { kind: string; messageId?: string; text?: string; markdown?: string }) => void

function mockSwarm(): { subscriber: { current: AnalysisCb | null }; analyzeEmail: ReturnType<typeof vi.fn> } {
  const subscriber = { current: null as AnalysisCb | null }
  const analyzeEmail = vi.fn().mockResolvedValue({ ok: true } as import('@swarm/protocol').AnalyzeEmailResult)
  ;(window as unknown as { swarm: unknown }).swarm = {
    analyzeEmail,
    subscribeEvents: (cb: AnalysisCb) => {
      subscriber.current = cb
      return () => {
        subscriber.current = null
      }
    },
    gmail: { saveAnalysis: vi.fn().mockResolvedValue(undefined) },
  } as unknown as typeof window.swarm
  return { subscriber, analyzeEmail }
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

  it('renders nothing in the idle phase', () => {
    const idle: ThreadAnalysisState = { phase: 'idle' }
    const { container } = render(<GmailAssistantCard analysis={idle} messageCount={3} onRegenerate={() => undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('streams the summary and shows the 分析中… indicator', () => {
    const streaming: ThreadAnalysisState = { phase: 'streaming', summaryText: '## 摘要\n流式中' }
    render(<GmailAssistantCard analysis={streaming} messageCount={3} onRegenerate={() => undefined} />)
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
    render(<GmailAssistantCard analysis={done} messageCount={3} onRegenerate={() => undefined} />)
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
    render(<GmailAssistantCard analysis={done} messageCount={1} onRegenerate={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /采用并回复/ }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('草稿建议')

    fireEvent.click(screen.getByRole('button', { name: /复制到剪贴板/ }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('草稿建议')
  })

  it('calls onRegenerate when 重新生成 is clicked', () => {
    const onRegenerate = vi.fn()
    const done: ThreadAnalysisState = { phase: 'done', summary: 's', todos: [], suggest: '建议' }
    render(<GmailAssistantCard analysis={done} messageCount={1} onRegenerate={onRegenerate} />)
    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })

  it('renders the error message and a retry button in the error phase', () => {
    const onRegenerate = vi.fn()
    const errored: ThreadAnalysisState = { phase: 'error', error: '模型超时' }
    render(<GmailAssistantCard analysis={errored} messageCount={1} onRegenerate={onRegenerate} />)
    expect(screen.getByText('模型超时')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })
})

// MessageAnalysis is no longer mounted in the inbox (replaced by the thread
// assistant), but the component is kept for backward compatibility. These
// tests guard that it still behaves correctly so any lingering import sites
// keep working.
describe('MessageAnalysis (backward-compat, unmounted)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders the cached analysis without calling analyzeEmail', async () => {
    const { analyzeEmail } = mockSwarm()
    render(<MessageAnalysis cached={{ analysis: '## 摘要\n缓存结果', updatedAt: 1 }} message={msg()} />)
    await screen.findByText(/缓存结果/)
    expect(analyzeEmail).not.toHaveBeenCalled()
  })
})

// Regression: the "重新生成"/"重试" button used to be dead on a cached thread.
// useThreadAnalysis's effect takes an early return on a cache hit (sets `done`
// without subscribing to events), so the regenerate() call's analyzeThread had
// no event listener and the UI stayed stuck on the stale summary. The fix:
// regenerate() nulls the threadAnalysis query cache entry, forcing the effect
// to re-run into its cache-miss branch (re-subscribe + reset its closure-local
// accumulator + re-fire analyzeThread). We use setQueryData(key, null) rather
// than invalidateQueries: invalidate retains stale data during refetch
// (stale-while-revalidate) and the refetch re-resolves to the same cached
// analysis, so cache.data never becomes falsy and the cache-hit early-return
// would keep suppressing the subscription.
describe('GmailInboxView regenerate-on-cache-hit', () => {
  // Track ALL active subscription callbacks (not just the last-registered one):
  // the effect re-subscribes on regenerate, and a single `emit` slot can hold a
  // stale reference during that churn. Emitting to every active callback is the
  // faithful model of the real preload bridge, which fans events to all
  // subscribers.
  let emits: ((e: UIEvent) => void)[] = []

  function wrap(node: React.ReactElement, qc: QueryClient): React.ReactElement {
    return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    // Account is linked, one thread cached.
    const getStatus = vi.fn().mockResolvedValue({
      hasClientCreds: true,
      loggedIn: true,
      accountEmail: 'me@x',
      lastSyncAt: null,
      messageCount: 1,
      syncError: null,
    })
    const listRecent = vi.fn().mockResolvedValue([
      {
        id: 't1',
        snippet: '',
        fromAddr: 'a@b',
        subject: '下周评审',
        lastDateMs: 1,
        labelIds: [],
        unread: false,
      },
    ])
    const getThread = vi.fn().mockResolvedValue({
      thread: { id: 't1', subject: '下周评审' },
      messages: [msg({ id: 'm1', subject: '下周评审', fromAddr: 'a@b', bodyText: '正文内容' })],
    })
    // Cached analysis → the hook takes the cache-hit branch (no subscription).
    const getThreadAnalysis = vi
      .fn()
      .mockResolvedValue({ summary: '旧缓存摘要', todos: [], suggest: '旧建议', updatedAt: 1 })
    const saveThreadAnalysis = vi.fn().mockResolvedValue(undefined)
    const onStateChanged = vi.fn().mockReturnValue(() => {})
    emits = []
    ;(window as unknown as { swarm: unknown }).swarm = {
      gmail: {
        getStatus,
        listRecent,
        getThread,
        search: vi.fn().mockResolvedValue([]),
        getThreadAnalysis,
        saveThreadAnalysis,
        getAnalyses: vi.fn().mockResolvedValue({}),
        onStateChanged,
      },
      analyzeThread: vi.fn().mockResolvedValue({ ok: true }),
      syncNow: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: (cb: (e: UIEvent) => void) => {
        // Wrap so the stored reference is distinct from the raw `cb` the hook
        // passes in. The effect tears down + re-subscribes during the
        // regenerate cache-miss re-run; storing the raw inline handler meant a
        // stale (cleaned-up) closure could linger in `emits`. The wrapper is a
        // stable identity we control and always forwards to the live handler.
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
  })

  it('nulls the cache and re-triggers analysis when 重新生成 is clicked on a cached thread', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const setQueryDataSpy = vi.spyOn(qc, 'setQueryData')
    // swarmApi forwards to window.swarm.analyzeThread; spy on the wrapper so we
    // assert the user-facing call site (not the raw bridge).
    const analyzeSpy = vi.spyOn(swarmApi, 'analyzeThread').mockResolvedValue({ ok: true })

    render(wrap(<GmailInboxView />, qc))

    // Open the cached thread → assistant shows the cached summary in `done`.
    fireEvent.click(await screen.findByText('下周评审'))
    expect(await screen.findByText('旧缓存摘要')).toBeInTheDocument()
    // Cache hit → analyzeThread NOT called on initial mount.
    expect(analyzeSpy).not.toHaveBeenCalled()
    expect(window.swarm.gmail.getThreadAnalysis).toHaveBeenCalledWith('t1')

    // Click 重新生成.
    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }))

    // The fix: the cache entry for this thread is nulled (keyed on the thread),
    // forcing the hook's effect into its cache-miss branch. That branch then
    // re-subscribes, resets its accumulator, AND re-calls analyzeThread — so
    // regenerate() only needs to null the cache (no explicit analyzeThread
    // call, which would launch a second, redundant stream).
    await waitFor(() => {
      expect(setQueryDataSpy).toHaveBeenCalledWith(['gmail', 'threadAnalysis', 't1'], null)
    })
    await waitFor(() => expect(analyzeSpy).toHaveBeenCalledTimes(1))
    expect(analyzeSpy).toHaveBeenCalledWith({
      threadId: 't1',
      subject: '下周评审',
      messages: [{ from: 'a@b', dateMs: 1, bodyText: '正文内容' }],
    })

    // The effect's re-run into the cache-miss branch also re-subscribed AND
    // reset the phase to `streaming` (it set `summaryText: ''`). Verify the
    // phase transition done→streaming happened: the 分析中… indicator is now
    // showing and the done-only 采用并回复 / 重新生成 action row is gone. This
    // proves the stale `done` UI was torn down and the new subscription is
    // active — the core of the regression — without depending on Streamdown's
    // debounced markdown rendering (which is unreliable under test sequencing).
    await waitFor(() => expect(screen.getByText(/分析中/)).toBeInTheDocument())
    // The done-phase action buttons (采用并回复 / 重新生成) only render in the
    // `done` phase alongside a suggestion; they must be gone now that we're
    // back in `streaming`.
    expect(screen.queryByRole('button', { name: /采用并回复/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重新生成/ })).not.toBeInTheDocument()

    // And the fresh stream is live: emit a delta and confirm the streaming
    // indicator is still up (the event was accepted by the re-subscribed
    // handler rather than dropped on the floor as it was pre-fix).
    await act(async () => {
      for (const e of emits) e({ kind: 'gmail.threadAnalysisDelta', threadId: 't1', text: '新摘要开头', ts: 10 })
    })
    expect(emits.length).toBeGreaterThan(0)
    expect(screen.getByText(/分析中/)).toBeInTheDocument()
  })
})
