// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ThreadAnalysisState } from '@/hooks/use-thread-analysis'
import { GmailAssistantCard } from './gmail-assistant-card'
import { MessageAnalysis } from './gmail-inbox-view'

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
