import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { RepoResearch } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

import type { OneShotRunner } from '../session-agent/one-shot'
import { createResearchRepo, toRepoCard } from './research'
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
const agent = { id: 'repo-researcher', name: 'R', description: '', systemPrompt: 'x', maxIterations: 2 }
const toolRegistry = { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as never

// Drives run.ts's pi-AgentEvent adapter: streams a markdown briefing then an
// optional render_ui card, mirroring a real one-shot run.
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

describe('toRepoCard', () => {
  it('accepts a well-formed card', () => {
    expect(toRepoCard({ ...research })).toEqual(research)
  })
  it('rejects an unknown verdictTone', () => {
    expect(toRepoCard({ ...research, verdictTone: 'bogus' })).toBeNull()
  })
  it('rejects a card missing fields', () => {
    expect(toRepoCard({ gist: 'g' })).toBeNull()
  })
})

describe('createResearchRepo early returns', () => {
  it('returns no_provider when provider missing', () => {
    const run = createResearchRepo({
      broadcaster: fakeBroadcaster() as never,
      agentStore: { get: () => null } as never,
      store: fakeStore(),
      toolRegistry: {} as never,
      acquireSlot: async () => () => undefined,
    })
    const r = run({ repo, period: 'past_24_hours', provider: undefined as never })
    expect(r).toEqual({ ok: false, code: 'no_provider', message: expect.any(String) })
  })
})

describe('createResearchRepo broadcast', () => {
  it('broadcasts researchComplete (with kept summary) + saves on a valid render_ui card', async () => {
    const broadcaster = fakeBroadcaster()
    const store = fakeStore()
    const run = createResearchRepo({
      broadcaster: broadcaster as never,
      agentStore: { get: () => agent } as never,
      store,
      toolRegistry,
      acquireSlot: async () => () => undefined,
      runOneShot: fakeRunOneShot({ text: '## 简报\n这是一个终端 agent。', card: research }),
    })
    const r = run({ repo, period: 'past_24_hours', provider: injection as never })
    expect(r).toEqual({ ok: true })
    await new Promise((res) => setTimeout(res, 0))
    const researchWithSummary = { ...research, summary: '## 简报\n这是一个终端 agent。' }
    expect(broadcaster.broadcast).toHaveBeenCalledWith('trending.researchDelta', expect.any(Object))
    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'trending.researchComplete',
      expect.objectContaining({
        repoName: 'sst/opencode',
        research: researchWithSummary,
        summary: '## 简报\n这是一个终端 agent。',
      })
    )
    expect(store.save).toHaveBeenCalledWith('sst/opencode', researchWithSummary)
  })

  it('broadcasts researchError when the agent emits no valid card', async () => {
    const broadcaster = fakeBroadcaster()
    const store = fakeStore()
    const run = createResearchRepo({
      broadcaster: broadcaster as never,
      agentStore: { get: () => agent } as never,
      store,
      toolRegistry,
      acquireSlot: async () => () => undefined,
      runOneShot: fakeRunOneShot({ text: '简报但没有卡片' }),
    })
    run({ repo, period: 'past_24_hours', provider: injection as never })
    await new Promise((res) => setTimeout(res, 0))
    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'trending.researchError',
      expect.objectContaining({ repoName: 'sst/opencode' })
    )
    expect(store.save).not.toHaveBeenCalled()
  })
})
