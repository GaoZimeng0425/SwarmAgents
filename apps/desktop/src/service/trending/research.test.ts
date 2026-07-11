import type { RepoResearch } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

import { createResearchRepo, toRepoResearch } from './research'
import type { RepoResearchStore } from './research-store'

function fakeStore(): RepoResearchStore {
  return {
    get: () => ({ research: null, researchedAt: null }),
    save: vi.fn(),
    names: () => [],
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
const repo = {
  repoName: 'sst/opencode',
  description: 'terminal agent',
  language: 'TypeScript',
  stars: 100,
  forks: 10,
  pullRequests: 5,
  contributorLogins: 'a,b',
}
const research: RepoResearch = {
  gist: 'g',
  why: 'w',
  highlights: ['h1'],
  forWhom: 'devs',
  verdict: 'v',
  verdictTag: '值得关注',
  verdictTone: 'recommend',
}
const agent = {
  id: 'repo-researcher',
  name: 'R',
  systemPrompt: 'x',
  maxIterations: 2,
  role: 'repo-researcher',
  capabilities: [],
  skills: [],
}

describe('toRepoResearch', () => {
  it('accepts a well-formed card', () => {
    expect(toRepoResearch({ ...research })).toEqual(research)
  })
  it('rejects an unknown verdictTone', () => {
    expect(toRepoResearch({ ...research, verdictTone: 'bogus' })).toBeNull()
  })
  it('rejects a card missing fields', () => {
    expect(toRepoResearch({ gist: 'g' })).toBeNull()
  })
})

describe('createResearchRepo early returns', () => {
  it('returns no_provider when provider missing', () => {
    const research = createResearchRepo({
      broadcaster: fakeBroadcaster() as never,
      agentStore: { get: () => null } as never,
      store: fakeStore(),
      toolRegistry: {} as never,
      getBudgetConfig: () => ({ main: {}, sub: {} }) as never,
    })
    const r = research({ repo, period: 'past_24_hours', provider: undefined as never })
    expect(r).toEqual({ ok: false, code: 'no_provider', message: expect.any(String) })
  })
})

describe('createResearchRepo broadcast', () => {
  it('broadcasts researchComplete + saves on a valid render_ui card', async () => {
    const broadcaster = fakeBroadcaster()
    const store = fakeStore()
    const fakeLaunch = vi.fn((_spec: unknown, ports: { emit: { broadcast: (e: unknown) => void } }) => {
      ports.emit.broadcast({
        kind: 'message.progress',
        event: { kind: 'tool.call', server: 'agent', tool: 'render_ui', args: { type: 'analysis', props: research } },
      })
      ports.emit.broadcast({ kind: 'message.complete' })
      return Promise.resolve({ status: 'complete', messageId: 'r' })
    })
    const run = createResearchRepo({
      broadcaster: broadcaster as never,
      agentStore: { get: () => agent } as never,
      store,
      toolRegistry: {} as never,
      getBudgetConfig: () => ({ main: {}, sub: {} }) as never,
      launch: fakeLaunch as never,
    })
    const r = run({ repo, period: 'past_24_hours', provider: injection as never })
    expect(r).toEqual({ ok: true })
    await Promise.resolve()
    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'trending.researchComplete',
      expect.objectContaining({ repoName: 'sst/opencode', research })
    )
    expect(store.save).toHaveBeenCalledWith('sst/opencode', research)
  })

  it('broadcasts researchError when the agent emits no valid card', async () => {
    const broadcaster = fakeBroadcaster()
    const store = fakeStore()
    const fakeLaunch = vi.fn((_spec: unknown, ports: { emit: { broadcast: (e: unknown) => void } }) => {
      ports.emit.broadcast({ kind: 'message.complete' })
      return Promise.resolve({ status: 'complete', messageId: 'r' })
    })
    const run = createResearchRepo({
      broadcaster: broadcaster as never,
      agentStore: { get: () => agent } as never,
      store,
      toolRegistry: {} as never,
      getBudgetConfig: () => ({ main: {}, sub: {} }) as never,
      launch: fakeLaunch as never,
    })
    run({ repo, period: 'past_24_hours', provider: injection as never })
    await Promise.resolve()
    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'trending.researchError',
      expect.objectContaining({ repoName: 'sst/opencode' })
    )
    expect(store.save).not.toHaveBeenCalled()
  })
})
