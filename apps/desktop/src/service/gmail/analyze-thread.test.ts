// @vitest-environment node

import { emptyUsed } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import type { RunEmitInput } from '../run-engine/emit'
import { createRunEmit } from '../run-engine/emit'
import type { launchRun } from '../run-engine/launch'
import { type AnalyzeThreadDeps, createAnalyzeThread } from './analyze-thread'

const fakeProvider = { id: 'p', model: 'm', apiKey: 'k' } as unknown as import('@swarm/protocol').ProviderInjection

// A fake launchRun that drives the real emit adapter: it feeds run.* wire events
// through createRunEmit (the same path the engine uses), so the analyze-thread
// module's broadcast port is exercised end-to-end.
function fakeLaunch(events: RunEmitInput[]): typeof launchRun {
  return (async (spec, ports) => {
    const emit = createRunEmit(ports.emit, { sessionId: spec.sessionId, runId: spec.runId ?? 'r' })
    for (const e of events) emit(e)
    return { runId: spec.runId ?? 'r', status: 'completed' as const, summary: 'ok', messages: [], used: emptyUsed() }
  }) as unknown as typeof launchRun
}

function run(events: RunEmitInput[]): Promise<Array<[string, unknown]>> {
  const broadcasts: Array<[string, unknown]> = []
  const analyze = createAnalyzeThread({
    broadcaster: { broadcast: (e, d) => broadcasts.push([e, d]) } as AnalyzeThreadDeps['broadcaster'],
    agentStore: { get: () => undefined } as AnalyzeThreadDeps['agentStore'],
    toolRegistry: {} as AnalyzeThreadDeps['toolRegistry'],
    getBudgetConfig: () => ({}) as import('@swarm/protocol').BudgetConfig,
    launch: fakeLaunch(events),
  })
  const ack = analyze({
    threadId: 't1',
    subject: 's',
    messages: [{ from: 'a@b', dateMs: 0, bodyText: 'body' }],
    provider: fakeProvider,
  })
  expect(ack).toEqual({ ok: true })
  return new Promise((r) => setTimeout(() => r(broadcasts), 0))
}

const renderUiCall = (props: unknown): RunEmitInput => ({
  kind: 'run.progress',
  event: { kind: 'tool.call', server: 'agent', tool: 'render_ui', args: { type: 'analysis', props }, ts: 1 },
})

describe('analyzeThread complete handler', () => {
  it('uses streamed markdown as summary and the render_ui card for todos/suggest', async () => {
    const broadcasts = await run([
      { kind: 'run.progress', event: { kind: 'llm.message', role: 'assistant', content: '## 摘要\n要点一', ts: 1 } },
      renderUiCall({ todos: [{ t: '回复', due: true, dueLabel: '今天' }], suggest: '好的' }),
      { kind: 'run.complete', summary: '## 摘要\n要点一' },
    ])
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
    const broadcasts = await run([
      { kind: 'run.progress', event: { kind: 'llm.message', role: 'assistant', content: '摘要正文', ts: 1 } },
      { kind: 'run.complete', summary: '摘要正文' },
    ])
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
    const broadcasts = await run([
      { kind: 'run.progress', event: { kind: 'llm.message', role: 'assistant', content: '摘要', ts: 1 } },
      renderUiCall(JSON.stringify({ todos: [], suggest: '回复草稿' })),
      { kind: 'run.complete', summary: '摘要' },
    ])
    const complete = broadcasts.find(([e]) => e === 'gmail.threadAnalysisComplete')?.[1] as { suggest: string }
    expect(complete.suggest).toBe('回复草稿')
  })
})
