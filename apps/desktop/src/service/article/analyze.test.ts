import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { ArticleSummary } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

import type { OneShotRunner } from '../session-agent/one-shot'
import { createAnalyzeArticle } from './analyze'
import type { ArticleStore } from './store'

function fakeStore(): ArticleStore {
  return {
    add: () => ({}) as never,
    list: () => [],
    get: () => ({
      url: 'https://example.com/a',
      title: 'A',
      author: null,
      siteName: null,
      publishedTime: null,
      contentMarkdown: 'body',
      id: '01ID',
      collectedAt: '2026-07-07T00:00:00.000Z',
      excerpt: 'body',
      summary: null,
      analyzedAt: null,
      seq: 0,
    }),
    saveAnalysis: vi.fn(),
    delete: () => undefined,
    watch: () => () => undefined,
  }
}

function fakeBroadcaster() {
  const events: { event: string; data: unknown }[] = []
  return {
    broadcast: vi.fn((event: string, data: unknown) => events.push({ event, data })),
    events,
  }
}

const injection = { id: 'p', apiStyle: 'openai' as const, model: 'gpt-4o', apiKey: 'k' }

const agentStore = {
  get: () => ({ id: 'article-analyst', name: 'A', description: '', systemPrompt: 'x', maxIterations: 2 }),
} as never

const toolRegistry = { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as never

// Drives run.ts's pi-AgentEvent adapter: streams optional assistant text then an
// optional render_ui analysis card, mirroring a real one-shot run.
function fakeRunOneShot(opts: { text?: string; card?: unknown }): OneShotRunner {
  return async (spec) => {
    const emit = (e: unknown): void => spec.onEvent?.(e as AgentEvent)
    if (opts.text) {
      emit({ type: 'message_start', message: { role: 'assistant' } })
      emit({ type: 'message_end', message: { role: 'assistant', content: opts.text } })
    }
    if (opts.card !== undefined) {
      emit({
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'render_ui',
        args: { type: 'analysis', props: opts.card },
      })
    }
    return { status: 'completed', summary: opts.text ?? '' }
  }
}

describe('createAnalyzeArticle early returns', () => {
  it('returns no_provider when provider missing', () => {
    const broadcaster = fakeBroadcaster()
    const analyze = createAnalyzeArticle({
      broadcaster: broadcaster as never,
      agentStore: { get: () => null } as never,
      store: fakeStore(),
      toolRegistry: {} as never,
      acquireSlot: async () => () => undefined,
    })
    const r = analyze({ articleId: '01ID', provider: undefined as never })
    expect(r).toEqual({ ok: false, code: 'no_provider', message: expect.any(String) })
  })
})

describe('createAnalyzeArticle broadcast', () => {
  it('broadcasts analysisComplete with the render_ui card summary on completion', async () => {
    const broadcaster = fakeBroadcaster()
    const summary: ArticleSummary = { gist: 'g', points: ['p'], takeaways: [] }
    const store = fakeStore()
    const analyze = createAnalyzeArticle({
      broadcaster: broadcaster as never,
      agentStore,
      store,
      toolRegistry,
      acquireSlot: async () => () => undefined,
      runOneShot: fakeRunOneShot({ text: 'streamed prose', card: summary }),
    })

    const r = analyze({ articleId: '01ID', provider: injection as never })
    expect(r).toEqual({ ok: true })
    await new Promise((res) => setTimeout(res, 0))
    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'article.analysisComplete',
      expect.objectContaining({ articleId: '01ID' })
    )
    expect(store.saveAnalysis).toHaveBeenCalledWith('01ID', summary)
  })

  it('broadcasts analysisError when the agent emits no valid analysis card', async () => {
    const broadcaster = fakeBroadcaster()
    const store = fakeStore()
    const analyze = createAnalyzeArticle({
      broadcaster: broadcaster as never,
      agentStore,
      store,
      toolRegistry,
      acquireSlot: async () => () => undefined,
      runOneShot: fakeRunOneShot({ text: 'prose without a card' }),
    })
    const r = analyze({ articleId: '01ID', provider: injection as never })
    expect(r).toEqual({ ok: true })
    await new Promise((res) => setTimeout(res, 0))
    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'article.analysisError',
      expect.objectContaining({ articleId: '01ID' })
    )
    expect(store.saveAnalysis).not.toHaveBeenCalled()
  })
})
