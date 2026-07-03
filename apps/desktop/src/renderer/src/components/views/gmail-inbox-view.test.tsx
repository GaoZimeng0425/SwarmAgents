// @vitest-environment jsdom

import type { AnalyzeEmailResult } from '@swarm/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  const analyzeEmail = vi.fn().mockResolvedValue({ ok: true } as AnalyzeEmailResult)
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

describe('MessageAnalysis', () => {
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

  it('streams deltas into the panel and persists on complete', async () => {
    const { subscriber, analyzeEmail } = mockSwarm()
    render(<MessageAnalysis message={msg()} />)
    ;(window.swarm.analyzeEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })

    fireEvent.click(screen.getByRole('button', { name: /分析/ }))
    await waitFor(() => {
      expect(analyzeEmail).toHaveBeenCalledWith({
        messageId: 'm1',
        subject: 'S',
        from: 'a@b',
        content: 'body',
      })
    })

    // A streamed delta flips the panel into the streaming state (no button while streaming).
    subscriber.current!({ kind: 'gmail.analysisDelta', messageId: 'm1', text: '## 摘要\n流式' })
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull())

    // Completion persists the final markdown and exposes the re-run button.
    subscriber.current!({ kind: 'gmail.analysisComplete', messageId: 'm1', markdown: '## 摘要\n最终' })
    await screen.findByRole('button', { name: /重新分析/ })
    expect(window.swarm.gmail.saveAnalysis as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'm1',
      '## 摘要\n最终'
    )
  })
})
