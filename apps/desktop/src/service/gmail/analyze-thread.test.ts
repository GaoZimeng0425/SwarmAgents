// @vitest-environment node

import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'

import type { OneShotRunner } from '../session-agent/one-shot'
import { type AnalyzeThreadDeps, createAnalyzeThread } from './analyze-thread'

// A resolvable custom provider (apiStyle path → 200k default window), so run.ts's
// resolveModel(provider) succeeds and the completed path runs.
const fakeProvider = {
  id: 'p',
  model: 'mystery-model',
  apiKey: 'k',
  apiStyle: 'openai',
} as unknown as import('@swarm/protocol').ProviderInjection

// A fake one-shot runner that drives run.ts's pi-AgentEvent adapter: it streams an
// assistant message then (optionally) a render_ui analysis tool call, exactly as a
// real pi Agent run would, so the analyze-thread broadcast path is exercised end-to-end.
function fakeRunOneShot(opts: { text: string; card?: unknown }): OneShotRunner {
  return async (spec) => {
    const emit = (e: unknown): void => spec.onEvent?.(e as AgentEvent)
    emit({ type: 'message_start', message: { role: 'assistant' } })
    emit({ type: 'message_end', message: { role: 'assistant', content: opts.text } })
    if (opts.card !== undefined) {
      emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'render_ui', args: { type: 'analysis', props: opts.card } })
    }
    return { status: 'completed', summary: opts.text }
  }
}

function run(opts: { text: string; card?: unknown }): Promise<Array<[string, unknown]>> {
  const broadcasts: Array<[string, unknown]> = []
  const analyze = createAnalyzeThread({
    broadcaster: { broadcast: (e, d) => broadcasts.push([e, d]) } as AnalyzeThreadDeps['broadcaster'],
    agentStore: {
      get: () => ({ id: 'gmail-thread-analyst', name: 'x', description: '', systemPrompt: 's', maxIterations: 3 }),
    } as unknown as AnalyzeThreadDeps['agentStore'],
    toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as unknown as AnalyzeThreadDeps['toolRegistry'],
    acquireSlot: async () => () => undefined,
    callMain: async () => undefined,
    runOneShot: fakeRunOneShot(opts),
  })
  const ack = analyze({
    threadId: 't1',
    subject: 's',
    messages: [{ from: 'a@b', dateMs: 0, bodyText: 'body' }],
    provider: fakeProvider,
  })
  expect(ack).toEqual({ ok: true })
  // Two ticks: the analysis IIFE awaits the (async) fake runner before broadcasting.
  return new Promise((r) => setTimeout(() => r(broadcasts), 0))
}

describe('analyzeThread complete handler', () => {
  it('uses streamed markdown as summary and the render_ui card for todos/suggest', async () => {
    const broadcasts = await run({
      text: '## 摘要\n要点一',
      card: { todos: [{ t: '回复', due: true, dueLabel: '今天' }], suggest: '好的' },
    })
    const complete = broadcasts.find(([e]) => e === 'gmail.threadAnalysisComplete')?.[1] as {
      summary: string
      todos: unknown[]
      suggest: string
      threadId: string
    }
    expect(complete.summary).toBe('## 摘要\n要点一') // streamed text once, not doubled
    expect(complete.todos).toEqual([{ t: '回复', due: true, dueLabel: '今天' }])
    expect(complete.suggest).toBe('好的')
    expect(complete.threadId).toBe('t1')
  })

  it('degrades to empty todos/suggest when the agent emits no analysis card', async () => {
    const broadcasts = await run({ text: '摘要正文' })
    const complete = broadcasts.find(([e]) => e === 'gmail.threadAnalysisComplete')?.[1] as {
      summary: string
      todos: unknown[]
      suggest: string
    }
    expect(complete.summary).toBe('摘要正文')
    expect(complete.todos).toEqual([])
    expect(complete.suggest).toBe('')
  })

  it('coerces render_ui props delivered as a JSON string', async () => {
    const broadcasts = await run({ text: '摘要', card: JSON.stringify({ todos: [], suggest: '回复草稿' }) })
    const complete = broadcasts.find(([e]) => e === 'gmail.threadAnalysisComplete')?.[1] as { suggest: string }
    expect(complete.suggest).toBe('回复草稿')
  })
})
