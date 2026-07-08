import type { ArticleSummary } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

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

describe('createAnalyzeArticle early returns', () => {
  it('returns no_provider when provider missing', () => {
    const broadcaster = fakeBroadcaster()
    const analyze = createAnalyzeArticle({
      broadcaster: broadcaster as never,
      agentStore: { get: () => null } as never,
      store: fakeStore(),
      toolRegistry: {} as never,
      getBudgetConfig: () => ({ main: {}, sub: {} }) as never,
    })
    const r = analyze({ articleId: '01ID', provider: undefined as never })
    expect(r).toEqual({ ok: false, code: 'no_provider', message: expect.any(String) })
  })
})

describe('createAnalyzeArticle broadcast', () => {
  it('broadcasts analysisComplete with the render_ui card summary on run.complete', async () => {
    const broadcaster = fakeBroadcaster()
    const summary: ArticleSummary = { gist: 'g', points: ['p'], takeaways: [] }

    // Fake launch: emits a render_ui analysis card carrying the structured
    // summary, then run.complete — the adapter builds the summary from the card.
    const fakeLaunch = vi.fn((_spec: unknown, ports: { emit: { broadcast: (e: unknown) => void } }) => {
      ports.emit.broadcast({
        kind: 'run.progress',
        event: { kind: 'tool.call', server: 'agent', tool: 'render_ui', args: { type: 'analysis', props: summary } },
      })
      ports.emit.broadcast({ kind: 'run.complete', summary: 'streamed prose' })
      return Promise.resolve({ status: 'complete', runId: 'r' })
    })

    const store = fakeStore()
    const analyze = createAnalyzeArticle({
      broadcaster: broadcaster as never,
      agentStore: {
        get: () => ({
          id: 'article-analyst',
          name: 'A',
          systemPrompt: 'x',
          maxIterations: 2,
          role: 'article-analyst',
          capabilities: [],
          skills: [],
        }),
      } as never,
      store,
      toolRegistry: {} as never,
      getBudgetConfig: () => ({ main: {}, sub: {} }) as never,
      launch: fakeLaunch as never,
    })

    const r = analyze({ articleId: '01ID', provider: injection as never })
    expect(r).toEqual({ ok: true })
    await Promise.resolve() // let the run promise tick
    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'article.analysisComplete',
      expect.objectContaining({ articleId: '01ID' })
    )
    expect(store.saveAnalysis).toHaveBeenCalledWith('01ID', summary)
  })

  it('broadcasts analysisError when the agent emits no valid analysis card', async () => {
    const broadcaster = fakeBroadcaster()
    const fakeLaunch = vi.fn((_spec: unknown, ports: { emit: { broadcast: (e: unknown) => void } }) => {
      ports.emit.broadcast({ kind: 'run.complete', summary: 'prose without a card' })
      return Promise.resolve({ status: 'complete', runId: 'r' })
    })
    const store = fakeStore()
    const analyze = createAnalyzeArticle({
      broadcaster: broadcaster as never,
      agentStore: {
        get: () => ({
          id: 'article-analyst',
          name: 'A',
          systemPrompt: 'x',
          maxIterations: 2,
          role: 'article-analyst',
          capabilities: [],
          skills: [],
        }),
      } as never,
      store,
      toolRegistry: {} as never,
      getBudgetConfig: () => ({ main: {}, sub: {} }) as never,
      launch: fakeLaunch as never,
    })
    const r = analyze({ articleId: '01ID', provider: injection as never })
    expect(r).toEqual({ ok: true })
    await Promise.resolve()
    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'article.analysisError',
      expect.objectContaining({ articleId: '01ID' })
    )
    expect(store.saveAnalysis).not.toHaveBeenCalled()
  })
})
